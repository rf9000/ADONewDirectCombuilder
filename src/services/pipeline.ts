import { mkdirSync } from 'fs';
import { join } from 'path';
import type {
  AgentRunResult,
  AppConfig,
  ItemProcessResult,
  JobRecord,
  PlanArtifacts,
  PlanQuestions,
  PullRequestRef,
  RepoTarget,
  VerifyResult,
  WorkItemComment,
  WorkItemResponse,
} from '../types/index.ts';
import type { StateStore } from '../state/state-store.ts';
import * as ado from '../sdk/azure-devops-client.ts';
import * as ws from './workspace.ts';
import * as runner from './agent-runner.ts';
import * as prompts from './prompts.ts';

/** Artifacts live here inside the banking worktree; git-excluded, never committed. */
const AGENT_DIR = '.agent';

const COMMIT_AUTHOR = {
  name: 'Continia Bank Comm Agent',
  email: 'noreply@continia.com',
};

export interface PipelineDeps {
  getWorkItemComments: typeof ado.getWorkItemComments;
  addWorkItemComment: typeof ado.addWorkItemComment;
  swapWorkItemTags: typeof ado.swapWorkItemTags;
  createPullRequest: typeof ado.createPullRequest;
  createWorktree: typeof ws.createWorktree;
  removeAllWorktrees: typeof ws.removeAllWorktrees;
  wireSkills: typeof ws.wireSkills;
  addGitExcludes: typeof ws.addGitExcludes;
  commitAndPush: typeof ws.commitAndPush;
  hasChanges: typeof ws.hasChanges;
  runAgent: typeof runner.runAgent;
  readJsonArtifact: typeof runner.readJsonArtifact;
  tailLog: typeof runner.tailLog;
}

export const defaultDeps: PipelineDeps = {
  getWorkItemComments: ado.getWorkItemComments,
  addWorkItemComment: ado.addWorkItemComment,
  swapWorkItemTags: ado.swapWorkItemTags,
  createPullRequest: ado.createPullRequest,
  createWorktree: ws.createWorktree,
  removeAllWorktrees: ws.removeAllWorktrees,
  wireSkills: ws.wireSkills,
  addGitExcludes: ws.addGitExcludes,
  commitAndPush: ws.commitAndPush,
  hasChanges: ws.hasChanges,
  runAgent: runner.runAgent,
  readJsonArtifact: runner.readJsonArtifact,
  tailLog: runner.tailLog,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48)
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'new-bank-comm'
  );
}

export function branchNameFor(config: AppConfig, item: WorkItemResponse): string {
  const title = String(item.fields['System.Title'] ?? '');
  return `${config.branchPrefix}/${item.id}-${slugify(title)}`;
}

function pathsFor(bankingWorktree: string): prompts.PhasePaths {
  const agentDir = join(bankingWorktree, AGENT_DIR);
  return {
    agentDir,
    questionsPath: join(agentDir, 'plan', 'questions.json'),
    artifactsPath: join(agentDir, 'plan', 'artifacts.json'),
    designDocPath: join(agentDir, 'plan', 'design-doc.md'),
    taskListPath: join(agentDir, 'plan', 'tasklist.json'),
    verifyResultPath: join(agentDir, 'verify', 'result.json'),
  };
}

function logPath(config: AppConfig, itemId: number, phase: string): string {
  return join(config.logDir, String(itemId), `${phase}.log`);
}

/**
 * Create both worktrees, wire the skills into each, and exclude our artifacts.
 *
 * Planning needs this too: the planner reads real reference-bank AL code and the
 * reference bank's setup JSON, and it reaches them through
 * `.claude/repo-paths.json`. Nothing is pushed until the publishing phase, so an
 * existing worktree never implies an existing branch on the server.
 */
async function prepareWorkspaces(
  config: AppConfig,
  item: WorkItemResponse,
  branch: string,
  deps: PipelineDeps,
): Promise<{ banking: string; setupFiles: string }> {
  const banking = await deps.createWorktree(config, config.repos.banking, branch, item.id);
  const setupFiles = await deps.createWorktree(
    config,
    config.repos.setupFiles,
    branch,
    item.id,
  );

  const repoPaths = {
    'continia-banking': banking,
    'setup-files': setupFiles,
  };

  deps.wireSkills(config, banking, repoPaths);
  deps.wireSkills(config, setupFiles, repoPaths);
  deps.addGitExcludes(banking, [`/${AGENT_DIR}/`]);
  deps.addGitExcludes(setupFiles, [`/${AGENT_DIR}/`]);

  mkdirSync(join(banking, AGENT_DIR, 'plan'), { recursive: true });
  mkdirSync(join(banking, AGENT_DIR, 'verify'), { recursive: true });

  return { banking, setupFiles };
}

function assertAgentSucceeded(result: AgentRunResult, phase: string): void {
  if (!result.success) {
    throw new Error(`Agent run for phase '${phase}' did not complete successfully`);
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export interface PhaseContext {
  config: AppConfig;
  item: WorkItemResponse;
  job: JobRecord;
  store: StateStore;
  deps: PipelineDeps;
  branch: string;
  worktrees: { banking: string; setupFiles: string };
  paths: prompts.PhasePaths;
  comments: WorkItemComment[];
  workItemContext: string;
}

/** Returns the planner's questions, or undefined when the plan came back clean. */
export async function runPlanningPhase(ctx: PhaseContext): Promise<PlanQuestions> {
  const { config, item, job, store, deps, paths } = ctx;

  store.setPhase(item.id, 'planning');
  store.save();
  log(`  Item #${item.id}: planning (round ${job.clarifyRounds + 1})`);

  const previousQuestions = deps.readJsonArtifact<PlanQuestions>(paths.questionsPath);

  const prompt = prompts.buildPlanningPrompt(
    config,
    ctx.workItemContext,
    paths,
    ctx.worktrees.banking,
    ctx.worktrees.setupFiles,
    job.clarifyRounds > 0 ? previousQuestions : undefined,
  );

  const result = await deps.runAgent(config, prompt, {
    cwd: ctx.worktrees.banking,
    additionalDirectories: [ctx.worktrees.setupFiles],
    logFile: logPath(config, item.id, `plan-${job.clarifyRounds + 1}`),
  });
  assertAgentSucceeded(result, 'planning');

  const artifacts = deps.readJsonArtifact<PlanArtifacts>(paths.artifactsPath);
  const questions =
    deps.readJsonArtifact<PlanQuestions>(paths.questionsPath) ?? {
      blocking: [],
      ambiguities: [],
    };

  store.update(item.id, {
    plannerSessionId: result.sessionId,
    designDocPath: artifacts?.designDocPath ?? paths.designDocPath,
    lastSeenCommentId: ctx.comments.at(-1)?.id ?? job.lastSeenCommentId,
  });
  store.save();

  return {
    blocking: questions.blocking ?? [],
    ambiguities: questions.ambiguities ?? [],
  };
}

/** Post the questions, hand the item back to the human, and stop. */
export async function runAwaitingAnswersPhase(
  ctx: PhaseContext,
  questions: PlanQuestions,
): Promise<void> {
  const { config, item, store, deps } = ctx;

  const round = ctx.job.clarifyRounds + 1;
  const isFinalRound = round >= config.maxClarifyRounds;

  const comment = prompts.buildQuestionsComment(config, questions, round, isFinalRound);
  await deps.addWorkItemComment(config, item.id, comment);

  // Swap the trigger tag for the waiting tag: re-adding the trigger tag is how
  // the human says "I answered, go again".
  await deps.swapWorkItemTags(config, item, [config.triggerTag], [config.waitingTag]);

  store.update(item.id, {
    phase: 'awaiting-answers',
    clarifyRounds: round,
  });
  store.save();

  log(
    `  Item #${item.id}: asked ${questions.blocking.length} question(s) and flagged ` +
      `${questions.ambiguities.length} decision(s) — waiting for answers`,
  );
}

export async function runImplementPhase(ctx: PhaseContext): Promise<string> {
  const { config, item, store, deps, paths } = ctx;

  store.setPhase(item.id, 'implementing');
  store.save();
  log(`  Item #${item.id}: implementing`);

  const prompt = prompts.buildImplementPrompt(
    config,
    ctx.workItemContext,
    paths,
    ctx.worktrees.banking,
    ctx.worktrees.setupFiles,
  );

  const result = await deps.runAgent(config, prompt, {
    cwd: ctx.worktrees.banking,
    additionalDirectories: [ctx.worktrees.setupFiles],
    logFile: logPath(config, item.id, 'implement'),
  });
  assertAgentSucceeded(result, 'implementing');

  return result.text;
}

export async function runVerifyPhase(ctx: PhaseContext): Promise<VerifyResult> {
  const { config, item, store, deps, paths } = ctx;

  if (config.skipBuildTest) {
    log(`  Item #${item.id}: verify skipped (SKIP_BUILD_TEST=true)`);
    return {
      passed: true,
      summary: 'Build and test skipped by configuration (SKIP_BUILD_TEST=true).',
    };
  }

  store.setPhase(item.id, 'verifying');
  store.save();
  log(`  Item #${item.id}: verifying (env, deploy, test)`);

  const prompt = prompts.buildVerifyPrompt(config, paths, ctx.worktrees.banking);

  const result = await deps.runAgent(config, prompt, {
    cwd: ctx.worktrees.banking,
    additionalDirectories: [ctx.worktrees.setupFiles],
    logFile: logPath(config, item.id, 'verify'),
  });
  assertAgentSucceeded(result, 'verifying');

  const verify = deps.readJsonArtifact<VerifyResult>(paths.verifyResultPath);
  if (!verify) {
    // No artifact means we cannot claim the tests passed.
    return {
      passed: false,
      summary:
        'The verify phase finished without writing verify/result.json, so the ' +
        'test outcome is unknown.',
    };
  }
  return verify;
}

/** Push both branches; open a draft PR per repo that actually changed. */
export async function runPublishPhase(
  ctx: PhaseContext,
  changeSummary: string,
  verify: VerifyResult,
): Promise<PullRequestRef[]> {
  const { config, item, store, deps } = ctx;

  store.setPhase(item.id, 'publishing');
  store.save();
  log(`  Item #${item.id}: publishing`);

  const title = prTitle(item);
  const description = buildPrDescription(item, changeSummary, verify);
  const prs: PullRequestRef[] = [];

  for (const repo of [config.repos.banking, config.repos.setupFiles]) {
    const worktree = ctx.worktrees[repo.key];
    const pushed = await deps.commitAndPush(
      config,
      worktree,
      ctx.branch,
      `${title}\n\nWork item #${item.id}`,
      COMMIT_AUTHOR,
    );

    if (!pushed) {
      log(`  Item #${item.id}: ${repo.name} unchanged — no branch, no PR`);
      continue;
    }

    const pr = await deps.createPullRequest(config, repo, {
      title,
      description,
      sourceBranch: ctx.branch,
      targetBranch: repo.defaultBranch,
      isDraft: config.draftPr,
      workItemIds: [item.id],
      reviewerIds: config.reviewerIds,
    });
    prs.push(pr);
    log(`  Item #${item.id}: ${repo.name} PR !${pr.pullRequestId} — ${pr.url}`);
  }

  store.update(item.id, { prs });
  store.save();
  return prs;
}

export function prTitle(item: WorkItemResponse): string {
  const title = String(item.fields['System.Title'] ?? `Work item ${item.id}`);
  return title.length > 140 ? `${title.slice(0, 137)}...` : title;
}

export function buildPrDescription(
  item: WorkItemResponse,
  changeSummary: string,
  verify: VerifyResult,
): string {
  const lines = [changeSummary.trim(), '', '---', '', '**Verification**', ''];

  lines.push(verify.passed ? `- ${verify.summary}` : `- NOT PASSING: ${verify.summary}`);
  if (verify.failedTests && verify.failedTests.length > 0) {
    lines.push(`- Failing tests: ${verify.failedTests.join(', ')}`);
  }
  if (verify.envUrl) {
    lines.push(`- Test environment: ${verify.envUrl}`);
  }
  if (verify.envId) {
    lines.push(`- Environment id: \`${verify.envId}\``);
  }

  lines.push(
    '',
    `Planned and implemented automatically from work item #${item.id}. Opened as a draft for human review.`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Job orchestration
// ---------------------------------------------------------------------------

export async function runJob(
  config: AppConfig,
  item: WorkItemResponse,
  store: StateStore,
  deps: PipelineDeps = defaultDeps,
): Promise<ItemProcessResult> {
  const job = store.ensure(item.id);
  const branch = job.branch ?? branchNameFor(config, item);
  store.update(item.id, { branch });

  log(`Processing #${item.id}: ${String(item.fields['System.Title'] ?? '(untitled)')}`);

  if (config.dryRun) {
    const comments = await deps.getWorkItemComments(config, item.id);
    const context = prompts.buildWorkItemContext(item, comments);
    log(`  Item #${item.id}: [DRY RUN] read ${comments.length} comment(s)`);
    console.log(context);
    return { itemId: item.id, processed: true, phase: job.phase };
  }

  let ctx: PhaseContext | undefined;

  try {
    const comments = await deps.getWorkItemComments(config, item.id);
    const worktrees = await prepareWorkspaces(config, item, branch, deps);

    ctx = {
      config,
      item,
      job: store.ensure(item.id),
      store,
      deps,
      branch,
      worktrees,
      paths: pathsFor(worktrees.banking),
      comments,
      workItemContext: prompts.buildWorkItemContext(item, comments),
    };

    // ---- plan, and loop back to the human while anything is unresolved ----
    const questions = await runPlanningPhase(ctx);
    const unresolved = questions.blocking.length + questions.ambiguities.length;

    if (unresolved > 0 && ctx.job.clarifyRounds < config.maxClarifyRounds) {
      await runAwaitingAnswersPhase(ctx, questions);
      return { itemId: item.id, processed: true, phase: 'awaiting-answers' };
    }

    if (unresolved > 0) {
      log(
        `  Item #${item.id}: ${unresolved} item(s) still open after ` +
          `${config.maxClarifyRounds} round(s) — proceeding on documented defaults`,
      );
    }

    // ---- build ----
    const changeSummary = await runImplementPhase(ctx);

    const anyChanges =
      (await deps.hasChanges(config, worktrees.banking)) ||
      (await deps.hasChanges(config, worktrees.setupFiles));
    if (!anyChanges) {
      throw new Error(
        'The implement phase produced no file changes — nothing to review, so no PR was opened.',
      );
    }

    // ---- verify ----
    const verify = await runVerifyPhase(ctx);

    if (!verify.passed) {
      // Push the work so it is not lost, but do not put red code in a PR.
      await deps.commitAndPush(
        config,
        worktrees.banking,
        branch,
        `${prTitle(item)} (tests not passing)\n\nWork item #${item.id}`,
        COMMIT_AUTHOR,
      );
      await deps.commitAndPush(
        config,
        worktrees.setupFiles,
        branch,
        `${prTitle(item)} (tests not passing)\n\nWork item #${item.id}`,
        COMMIT_AUTHOR,
      );
      throw new Error(
        `Verification failed, so no pull request was opened. ${verify.summary}` +
          (verify.failedTests?.length
            ? ` Failing: ${verify.failedTests.join(', ')}`
            : '') +
          ` The work is pushed to branch \`${branch}\` for inspection.`,
      );
    }

    // ---- publish ----
    const prs = await runPublishPhase(ctx, changeSummary, verify);

    await deps.addWorkItemComment(
      config,
      item.id,
      buildSuccessComment(config, prs, verify),
    );
    await deps.swapWorkItemTags(
      config,
      item,
      [config.triggerTag, config.waitingTag, config.failedTag],
      [config.doneTag],
    );

    store.setPhase(item.id, 'done');
    store.save();

    // ---- clean up the worktrees; the BC environment is deliberately left running ----
    await deps.removeAllWorktrees(config, item.id);
    store.update(item.id, { worktrees: {} });
    store.save();

    log(`  Item #${item.id}: done — ${prs.length} draft PR(s)`);
    return { itemId: item.id, processed: true, phase: 'done' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  Item #${item.id}: failed — ${message}`);

    store.update(item.id, { phase: 'failed', error: message });
    store.save();

    await reportFailure(config, item, message, deps).catch((reportErr) => {
      log(`  Item #${item.id}: could not report failure — ${reportErr}`);
    });

    // Leave nothing behind: a retry re-clones from the current default branch.
    await deps.removeAllWorktrees(config, item.id).catch(() => undefined);
    store.update(item.id, { worktrees: {} });
    store.save();

    return { itemId: item.id, processed: false, phase: 'failed', error: message };
  }
}

/**
 * Pick the log worth quoting in a failure comment: the latest phase that
 * actually ran. Phases run in order, so the last one with a log is the one that
 * broke.
 */
export function failedPhaseLog(
  config: AppConfig,
  itemId: number,
  deps: PipelineDeps,
): string {
  const candidates = ['verify', 'implement', 'plan-3', 'plan-2', 'plan-1'];
  for (const phase of candidates) {
    const path = logPath(config, itemId, phase);
    if (deps.tailLog(path, 1) !== '(no log)') return path;
  }
  return logPath(config, itemId, 'plan-1');
}

export function buildSuccessComment(
  config: AppConfig,
  prs: PullRequestRef[],
  verify: VerifyResult,
): string {
  const lines = ['<b>Bank integration implemented</b>', ''];

  if (prs.length === 0) {
    lines.push('No pull request was needed — no files changed.');
  } else {
    lines.push(`${config.draftPr ? 'Draft pull requests' : 'Pull requests'} created:`, '<ul>');
    for (const pr of prs) {
      lines.push(
        `<li><a href="${prompts.escapeHtml(pr.url)}">${prompts.escapeHtml(pr.repoName)} !${pr.pullRequestId}</a></li>`,
      );
    }
    lines.push('</ul>');
  }

  lines.push('', `<b>Verification:</b> ${prompts.escapeHtml(verify.summary)}`);
  if (verify.envUrl) {
    lines.push(
      `<b>Test environment (left running):</b> <a href="${prompts.escapeHtml(verify.envUrl)}">${prompts.escapeHtml(verify.envUrl)}</a>`,
    );
  }

  return lines.join('\n');
}

async function reportFailure(
  config: AppConfig,
  item: WorkItemResponse,
  message: string,
  deps: PipelineDeps,
): Promise<void> {
  const tail = deps.tailLog(failedPhaseLog(config, item.id, deps), 25);

  const comment = [
    '<b>Bank integration run failed</b>',
    '',
    `<pre>${prompts.escapeHtml(message)}</pre>`,
    '',
    '<b>Last log lines</b>',
    `<pre>${prompts.escapeHtml(tail)}</pre>`,
    '',
    `Fix the cause (or add a clarifying comment) and re-add the <code>${prompts.escapeHtml(config.triggerTag)}</code> tag to retry.`,
  ].join('\n');

  await deps.addWorkItemComment(config, item.id, comment);
  await deps.swapWorkItemTags(
    config,
    item,
    [config.triggerTag, config.waitingTag],
    [config.failedTag],
  );
}
