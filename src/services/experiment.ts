import { randomBytes } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { AgentRunResult, AppConfig, AuthMode, PlanQuestions } from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as ado from '../sdk/azure-devops-client.ts';
import * as ws from './workspace.ts';
import {
  defaultDeps,
  pathsFor,
  prepareWorkspaces,
  runPlanningPhase,
  type PhaseContext,
  type PipelineDeps,
} from './pipeline.ts';
import {
  loadVariantSet,
  selectVariants,
  type Variant,
  type VariantSet,
} from '../config/experiment.ts';
import {
  fetchDocOverHttp,
  freezeInput,
  LOCAL_DOCS_DIR,
  type FreezeDeps,
  type FrozenInput,
} from './experiment-input.ts';
import {
  buildJudgePrompt,
  JUDGE_OUTPUT,
  JUDGE_TOOLS,
  PLAN_CONTRACT_FILES,
  parseJudgeOutput,
  type JudgeResult,
} from './experiment-judge.ts';
import {
  classifyStatus,
  countTasks,
  renderReport,
  type ExperimentResults,
  type VariantUsage,
} from './experiment-report.ts';

export interface ExperimentOptions {
  workItemId: number;
  variantsFile: string;
  only?: string[];
  answersFile?: string;
  questionsFile?: string;
  auth: AuthMode;
  /** Root of the experiments folder; runs land in <dir>/runs/<id>/<runId>/. */
  experimentsDir: string;
  runId?: string;
  /**
   * Continue an earlier run: reuse its frozen input, keep variants that
   * already succeeded and judge verdicts that are still valid.
   */
  resumeRunId?: string;
  /** Start every variant from this earlier plan folder, as a follow-up round. */
  fromPlan?: string;
}

export interface ExperimentDeps {
  pipeline: PipelineDeps;
  freeze: FreezeDeps;
  random(): number;
  now(): Date;
}

export const defaultExperimentDeps: ExperimentDeps = {
  pipeline: defaultDeps,
  freeze: {
    getWorkItem: ado.getWorkItem,
    getWorkItemComments: ado.getWorkItemComments,
    resolveRemoteSha: async (config, repo) =>
      ws.revParse(
        config,
        await ws.ensureRepoCache(config, repo),
        `refs/remotes/origin/${repo.defaultBranch}`,
      ),
    fetchDoc: fetchDocOverHttp,
  },
  random: Math.random,
  now: () => new Date(),
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export function formatRunId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Child environment for an experiment agent.
 *
 * Subscription auth removes the Anthropic key: without one, the Claude Code
 * binary falls back to the logged-in ~/.claude credentials. Bun loads .env into
 * process.env, so the key has to be removed explicitly.
 *
 * Either way the agent gets no ADO credentials and git cannot find any: it has
 * Bash, and blocking our own commitAndPush means nothing if the agent can
 * `git push` through the PAT or the machine's credential manager. A stray
 * CLAUDE_CODE_SUBAGENT_MODEL is dropped so only the variant decides it.
 */
export function authEnv(
  auth: AuthMode,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    AZURE_DEVOPS_PAT: _pat,
    ADO_MCP_PAT_B64: _mcpPat,
    CLAUDE_CODE_SUBAGENT_MODEL: _subagentModel,
    ...rest
  } = env;
  return {
    ...rest,
    ...(auth === 'api-key' ? { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN } : {}),
    GIT_TERMINAL_PROMPT: '0',
    // An empty credential.helper resets the helper list, so no stored
    // credential is offered for any remote.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/** Opaque per-variant directory tag, so no path the judge sees names a variant. */
function opaqueSlot(): string {
  return randomBytes(3).toString('hex');
}

function refuse(name: string): never {
  throw new Error(`experiment must not call ${name}`);
}

/** Production deps with every ADO and git write replaced by a throw. */
export function experimentDeps(base: PipelineDeps): PipelineDeps {
  return {
    ...base,
    addWorkItemComment: () => refuse('addWorkItemComment'),
    swapWorkItemTags: () => refuse('swapWorkItemTags'),
    createPullRequest: () => refuse('createPullRequest'),
    uploadAttachment: () => refuse('uploadAttachment'),
    linkAttachmentToWorkItem: () => refuse('linkAttachmentToWorkItem'),
    commitAndPush: () => refuse('commitAndPush'),
    removeAllWorktrees: () => refuse('removeAllWorktrees'),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function copyIfExists(from: string, to: string): void {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

interface RunContext {
  config: AppConfig;
  set: VariantSet;
  frozen: FrozenInput;
  runId: string;
  runDir: string;
  auth: AuthMode;
  deps: ExperimentDeps;
}

async function runVariant(
  rc: RunContext,
  variant: Variant,
  remainingUsd: number,
): Promise<VariantUsage> {
  const { config, frozen, runId, runDir, auth, deps } = rc;
  const variantDir = join(runDir, variant.name);
  // A resumed variant starts clean; a failed attempt's files would mix in.
  rmSync(variantDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(variantDir, { recursive: true });
  const startedAt = deps.now().getTime();

  // Planner artifacts embed absolute worktree paths, so the directory and
  // branch must not name the variant or the blind judge could read it back.
  const slot = opaqueSlot();
  const worktreeRoot = join(config.worktreeRoot, `exp-${runId}-${slot}`);
  const vConfig: AppConfig = {
    ...config,
    worktreeRoot,
    logDir: variantDir,
    jobMaxBudgetUsd: remainingUsd,
  };
  const branch = `experiment/${runId}-${slot}`;

  let last: AgentRunResult | undefined;
  const pipelineDeps: PipelineDeps = {
    ...experimentDeps(deps.pipeline),
    runAgent: async (...args) => (last = await deps.pipeline.runAgent(...args)),
  };

  let error: string | undefined;
  let questions: PlanQuestions = { blocking: [], ambiguities: [] };
  let banking: string | undefined;

  log(
    `  Variant ${variant.name}: model=${variant.model ?? config.claudeModel} ` +
      `effort=${variant.effort ?? 'default'} subagents=${variant.subagentModel ?? 'inherit'}`,
  );

  try {
    const worktrees = await prepareWorkspaces(
      vConfig,
      frozen.item,
      branch,
      pipelineDeps,
      frozen.shas,
    );
    banking = worktrees.banking;
    const paths = pathsFor(worktrees.banking);
    copyIfExists(join(runDir, 'input', 'docs'), join(worktrees.banking, LOCAL_DOCS_DIR));

    const store = new StateStore(join(variantDir, 'state'));
    store.ensure(frozen.workItemId);
    if (variant.revise && frozen.fromPlan) {
      // The earlier round's plan sits where the pipeline expects the previous
      // round's output, so runPlanningPhase takes the revision path.
      copyIfExists(frozen.fromPlan, dirname(paths.questionsPath));
    }
    if (frozen.previousQuestions) {
      // runPlanningPhase reads the previous round's questions from the worktree.
      store.update(frozen.workItemId, { clarifyRounds: 1 });
      mkdirSync(dirname(paths.questionsPath), { recursive: true });
      writeFileSync(
        paths.questionsPath,
        JSON.stringify(frozen.previousQuestions, null, 2),
        'utf-8',
      );
    }

    const ctx: PhaseContext = {
      config: vConfig,
      item: frozen.item,
      job: store.ensure(frozen.workItemId),
      store,
      deps: pipelineDeps,
      branch,
      worktrees,
      paths,
      comments: frozen.comments,
      workItemContext: frozen.context,
      agentOverrides: {
        model: variant.model,
        effort: variant.effort,
        subagentModel: variant.subagentModel,
        env: authEnv(auth),
        mcp: false,
        lsp: variant.lsp ?? false,
      },
    };

    questions = await runPlanningPhase(ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let taskCount: number | undefined;
  let designDoc = false;
  let revisionMode: string | undefined;
  if (banking) {
    const paths = pathsFor(banking);
    copyIfExists(join(banking, '.agent', 'plan'), join(variantDir, 'plan'));
    taskCount = countTasks(readJson(paths.taskListPath));
    revisionMode = (readJson(paths.artifactsPath) as { revisionMode?: string } | undefined)?.revisionMode;
    designDoc = existsSync(paths.designDocPath);
  }

  const usage: VariantUsage = {
    variant: variant.name,
    model: variant.model ?? config.claudeModel,
    effort: variant.effort,
    subagentModel: variant.subagentModel,
    status: classifyStatus(last, error),
    error,
    costUsd: last?.costUsd ?? 0,
    modelUsage: last?.modelUsage ?? {},
    numTurns: last?.numTurns ?? 0,
    // Wall clock: the SDK's duration_ms covers only the last result's stretch
    // when background subagents woke the session up again.
    durationMs: deps.now().getTime() - startedAt,
    blocking: questions.blocking.length,
    ambiguities: questions.ambiguities.length,
    taskCount,
    designDoc,
    rateLimit: last?.rateLimit,
    worktreeRoot,
    revisionMode,
  };
  writeFileSync(join(variantDir, 'usage.json'), JSON.stringify(usage, null, 2), 'utf-8');
  log(`  Variant ${variant.name}: ${usage.status}, $${usage.costUsd.toFixed(2)}`);
  return usage;
}

async function runJudge(
  rc: RunContext,
  variant: string,
  remainingUsd: number,
): Promise<JudgeResult> {
  const { config, set, frozen, runDir, auth, deps } = rc;
  // The judge works in a neutral temp directory: its cwd shows in its system
  // prompt, and from inside the run directory the variant folders are one
  // Glob away. The finished directory is copied back for inspection.
  const judgeDir = mkdtempSync(join(tmpdir(), 'exp-judge-'));
  const keptDir = join(runDir, 'judge', variant);

  const variantIsA = deps.random() < 0.5;
  const [a, b] = variantIsA ? [variant, set.baseline] : [set.baseline, variant];
  for (const [side, source] of [['A', a], ['B', b]] as const) {
    mkdirSync(join(judgeDir, side), { recursive: true });
    for (const file of PLAN_CONTRACT_FILES) {
      copyIfExists(join(runDir, source, 'plan', file), join(judgeDir, side, file));
    }
  }
  copyIfExists(join(runDir, 'input', 'docs'), join(judgeDir, 'docs'));
  writeFileSync(join(judgeDir, 'work-item.md'), frozen.context, 'utf-8');

  let costUsd = 0;
  let result: JudgeResult;
  try {
    const run = await deps.pipeline.runAgent(config, buildJudgePrompt(), {
      cwd: judgeDir,
      logFile: join(judgeDir, 'judge.log'),
      model: set.judgeModel,
      allowedTools: JUDGE_TOOLS,
      maxBudgetUsd: Math.min(config.agentMaxBudgetUsd, remainingUsd),
      env: authEnv(auth),
      mcp: false,
    });
    costUsd = run.costUsd;
    result = parseJudgeOutput(
      readJson(join(judgeDir, JUDGE_OUTPUT)),
      variantIsA,
      variant,
      costUsd,
    );
  } catch (err) {
    result = {
      variant,
      costUsd,
      gaps: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  mkdirSync(keptDir, { recursive: true });
  cpSync(judgeDir, keptDir, { recursive: true });
  rmSync(judgeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

  writeFileSync(
    join(runDir, 'judge', `${variant}.json`),
    JSON.stringify({ ...result, planA: a, planB: b }, null, 2),
    'utf-8',
  );
  log(`  Judge ${variant}: ${result.error ? `failed — ${result.error}` : result.verdict}`);
  return result;
}

export async function runExperiment(
  config: AppConfig,
  opts: ExperimentOptions,
  deps: ExperimentDeps = defaultExperimentDeps,
): Promise<ExperimentResults> {
  const { set, warnings } = loadVariantSet(opts.variantsFile);
  for (const w of warnings) log(`  Warning: ${w}`);
  const variants = selectVariants(set, opts.only);
  const revising = variants.find((v) => v.revise);
  if (revising && !opts.fromPlan && !opts.resumeRunId) {
    throw new Error(`variant '${revising.name}' has revise: true and needs --from-plan`);
  }

  const runId = opts.resumeRunId ?? opts.runId ?? formatRunId(deps.now());
  const runDir = join(opts.experimentsDir, 'runs', String(opts.workItemId), runId);
  log(
    `Experiment ${runId} on #${opts.workItemId}: auth=${opts.auth}, ` +
      `${variants.length} variant(s), cap $${set.maxUsd}${opts.resumeRunId ? ' (resumed)' : ''}`,
  );

  let frozen: FrozenInput;
  if (opts.resumeRunId) {
    const inputPath = join(runDir, 'input.json');
    if (!existsSync(inputPath)) {
      throw new Error(`Cannot resume ${runId}: no input.json at ${inputPath}`);
    }
    if (opts.answersFile || opts.questionsFile) {
      log('  Warning: --answers/--questions are ignored on --resume; the frozen input is reused');
    }
    frozen = JSON.parse(readFileSync(inputPath, 'utf-8')) as FrozenInput;
  } else {
    mkdirSync(runDir, { recursive: true });
    frozen = await freezeInput(
      config,
      opts.workItemId,
      runDir,
      { answersFile: opts.answersFile, questionsFile: opts.questionsFile, fromPlan: opts.fromPlan },
      deps.freeze,
    );
  }

  const rc: RunContext = { config, set, frozen, runId, runDir, auth: opts.auth, deps };
  const usages: VariantUsage[] = [];
  const notes: string[] = [];
  let spent = 0;
  let stoppedReason: string | undefined;

  // Variants that ran in this invocation; their judge verdicts are stale.
  const ranNow = new Set<string>();

  for (const variant of variants) {
    const previous = opts.resumeRunId
      ? (readJson(join(runDir, variant.name, 'usage.json')) as VariantUsage | undefined)
      : undefined;
    if (previous?.status === 'ok') {
      log(`  Variant ${variant.name}: kept from earlier attempt, $${previous.costUsd.toFixed(2)}`);
      usages.push(previous);
      spent += previous.costUsd;
      continue;
    }

    const remaining = set.maxUsd - spent;
    if (remaining <= 0) {
      stoppedReason = `experiment budget of $${set.maxUsd} was used up before '${variant.name}'`;
      break;
    }
    const usage = await runVariant(rc, variant, remaining);
    ranNow.add(variant.name);
    usages.push(usage);
    spent += usage.costUsd;
    if (usage.status === 'rate-limited') {
      const resets = usage.rateLimit?.resetsAt
        ? `; resets ${new Date(usage.rateLimit.resetsAt * 1000).toISOString()}`
        : '';
      const limit = ['rate limit', usage.rateLimit?.type, 'rejected'].filter(Boolean).join(' ');
      stoppedReason = `${limit} during '${variant.name}'${resets}`;
      break;
    }
  }

  const judges: JudgeResult[] = [];
  if (stoppedReason) {
    notes.push('Judge skipped: the sweep stopped early.');
  } else if (!usages.some((u) => u.variant === set.baseline && u.status === 'ok')) {
    notes.push(`Judge skipped: baseline '${set.baseline}' did not run successfully.`);
  } else {
    for (const usage of usages) {
      if (usage.variant === set.baseline || usage.status !== 'ok') continue;

      const stale = ranNow.has(usage.variant) || ranNow.has(set.baseline);
      const previous =
        opts.resumeRunId && !stale
          ? (readJson(join(runDir, 'judge', `${usage.variant}.json`)) as
              | (JudgeResult & { planA?: string; planB?: string })
              | undefined)
          : undefined;
      if (previous?.verdict && !previous.error) {
        const { planA: _a, planB: _b, ...kept } = previous;
        judges.push(kept);
        spent += kept.costUsd;
        continue;
      }

      const remaining = set.maxUsd - spent;
      if (remaining <= 0) {
        notes.push('Judge stopped: the experiment budget was used up.');
        break;
      }
      const judge = await runJudge(rc, usage.variant, remaining);
      judges.push(judge);
      spent += judge.costUsd;
    }
  }

  const results: ExperimentResults = {
    workItemId: opts.workItemId,
    title: frozen.title,
    runId,
    auth: opts.auth,
    judgeModel: set.judgeModel,
    baseline: set.baseline,
    shas: frozen.shas,
    docs: frozen.docs,
    variants: usages,
    judges,
    notes,
    stoppedReason,
    totalUsd: spent,
  };

  writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2), 'utf-8');
  writeFileSync(join(runDir, 'report.md'), renderReport(results), 'utf-8');
  log(`Experiment ${runId}: $${spent.toFixed(2)} spent — report at ${join(runDir, 'report.md')}`);
  return results;
}
