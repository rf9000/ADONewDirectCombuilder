import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AppConfig, RepoTarget } from '../types/index.ts';
import type { StateStore } from '../state/state-store.ts';
import * as ado from '../sdk/azure-devops-client.ts';
import * as ws from './workspace.ts';
import * as prompts from './prompts.ts';
import {
  branchNameFor,
  defaultDeps as defaultPipelineDeps,
  pathsFor,
  prepareWorkspaces,
  type PipelineDeps,
} from './pipeline.ts';

/** Spend cap for rebuilding the task list: one Phase 8 run, not a plan. */
const SEED_TASKLIST_BUDGET_USD = 15;

export interface SeedDeps {
  getWorkItem: typeof ado.getWorkItem;
  getWorkItemComments: typeof ado.getWorkItemComments;
  downloadAttachment: typeof ado.downloadAttachment;
  remoteBranchExists: typeof ws.remoteBranchExists;
  pipeline: PipelineDeps;
}

export const defaultSeedDeps: SeedDeps = {
  getWorkItem: ado.getWorkItem,
  getWorkItemComments: ado.getWorkItemComments,
  downloadAttachment: ado.downloadAttachment,
  remoteBranchExists: ws.remoteBranchExists,
  pipeline: defaultPipelineDeps,
};

export interface SeedResult {
  branch: string;
  /** Repos whose worktree starts from the work item's existing branch. */
  resumedFromBranch: Array<RepoTarget['key']>;
  taskCount: number;
  costUsd: number;
}

/**
 * Put a finished job back at the start of implement, from the design doc the
 * pipeline attached to its work item, so a lost worktree does not cost a full
 * re-plan.
 *
 * #83634 planned for $98, published a partial build, and its worktree (with
 * tasklist.json) was deleted on `done`. Only the attached design doc survived.
 * This recreates the worktrees on the existing branch (keeping the partial
 * build), writes the design doc, rebuilds the task list with one Phase 8 run,
 * and records the job as failed at `implementing`, with the comment watermark
 * past every existing comment and the spend reset. Re-adding the trigger tag
 * then resumes at implement.
 */
export async function seedPlan(
  config: AppConfig,
  itemId: number,
  store: StateStore,
  deps: SeedDeps = defaultSeedDeps,
): Promise<SeedResult> {
  const existing = Object.values(config.repos).filter((repo) =>
    existsSync(ws.worktreePath(config, repo, itemId)),
  );
  if (existing.length > 0) {
    throw new Error(
      `A worktree for #${itemId} already exists (${existing.map((r) => r.key).join(', ')}). ` +
        `It may hold work a retry can resume; run \`cleanup-worktrees ${itemId}\` first if it ` +
        'should be replaced.',
    );
  }

  const item = await deps.getWorkItem(config, itemId);
  const docName = `${itemId}-design-doc.md`;
  // The newest attachment wins: each finished run attaches its own copy.
  const attachment = [...(item.relations ?? [])]
    .reverse()
    .find((r) => r.rel === 'AttachedFile' && r.attributes?.name === docName);
  if (!attachment) {
    throw new Error(
      `Work item #${itemId} has no '${docName}' attachment, so there is no plan to seed from.`,
    );
  }
  const designDoc = await deps.downloadAttachment(config, attachment.url);

  const branch = branchNameFor(config, item);
  const refs: { banking?: string; setupFiles?: string } = {};
  const resumedFromBranch: Array<RepoTarget['key']> = [];
  for (const repo of Object.values(config.repos)) {
    if (await deps.remoteBranchExists(config, repo, branch)) {
      refs[repo.key] = `refs/remotes/origin/${branch}`;
      resumedFromBranch.push(repo.key);
    }
  }

  const worktrees = await prepareWorkspaces(config, item, branch, deps.pipeline, refs);
  const paths = pathsFor(worktrees.banking);
  writeFileSync(paths.designDocPath, designDoc, 'utf-8');

  const result = await deps.pipeline.runAgent(
    config,
    prompts.buildSeedTaskListPrompt(paths, worktrees.banking, worktrees.setupFiles),
    {
      cwd: worktrees.banking,
      additionalDirectories: [worktrees.setupFiles],
      logFile: join(config.logDir, String(itemId), 'seed-tasklist.log'),
      maxBudgetUsd: Math.min(config.agentMaxBudgetUsd, SEED_TASKLIST_BUDGET_USD),
    },
  );

  // Every existing comment, the bot's own success comment included, predates
  // this plan; without the bump the next run sees "new comments" and re-plans.
  const comments = await deps.getWorkItemComments(config, itemId);
  const lastSeenCommentId = comments.reduce((max, c) => Math.max(max, c.id), 0);

  const taskList = deps.pipeline.readJsonArtifact<{ tasks?: unknown[] }>(paths.taskListPath);
  const taskCount = Array.isArray(taskList?.tasks) ? taskList.tasks.length : 0;
  const job = store.ensure(itemId);

  // Recorded even when the rebuild failed, so its spend is not lost and the
  // worktrees are tracked. With no task list, the entry check falls back to
  // planning on its own.
  store.update(itemId, {
    phase: 'failed',
    failedAtPhase: 'implementing',
    error: `Seeded from ${docName} by seed-plan; re-add the trigger tag to implement.`,
    branch,
    worktrees,
    prs: [],
    designDocPath: paths.designDocPath,
    lastSeenCommentId,
    // Staleness checks only run for a job that has planned.
    plannerSessionId: job.plannerSessionId ?? result.sessionId ?? 'seed-plan',
    spentUsd: result.costUsd,
    planningSpentUsd: result.costUsd,
  });
  store.save();

  if (!result.success || taskCount === 0) {
    throw new Error(
      `Rebuilding the task list ${result.success ? 'wrote no tasks' : 'did not complete'} ` +
        `($${result.costUsd.toFixed(2)} spent). See ${join(config.logDir, String(itemId), 'seed-tasklist.log')}. ` +
        `Run \`cleanup-worktrees ${itemId}\` before trying again.`,
    );
  }

  return { branch, resumedFromBranch, taskCount, costUsd: result.costUsd };
}
