import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { seedPlan, type SeedDeps } from '../../src/services/seed-plan.ts';
import { defaultDeps as pipelineDefaults } from '../../src/services/pipeline.ts';
import { resolveEntryPhase } from '../../src/services/entry-phase.ts';
import type { AppConfig, WorkItemResponse } from '../../src/types/index.ts';

let root: string;
let store: StateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seed-plan-'));
  store = new StateStore(join(root, 'state'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function config(): AppConfig {
  return mockConfig({
    worktreeRoot: join(root, 'worktrees'),
    repoCacheDir: join(root, 'repos'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
  });
}

const DOC_URL = 'https://dev.azure.com/my-org/_apis/wit/attachments/doc-2';

function itemWithDoc(): WorkItemResponse {
  return mockWorkItem({
    relations: [
      { rel: 'AttachedFile', url: 'https://old/doc-1', attributes: { name: '42-design-doc.md' } },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/x' },
      { rel: 'AttachedFile', url: DOC_URL, attributes: { name: '42-design-doc.md' } },
    ],
  });
}

interface FakeOptions {
  item?: WorkItemResponse;
  branchIn?: Array<'banking' | 'setupFiles'>;
  tasks?: unknown[] | null;
  success?: boolean;
}

function makeDeps(fake: FakeOptions = {}): SeedDeps {
  const branchIn = new Set(fake.branchIn ?? ['banking', 'setupFiles']);
  return {
    getWorkItem: mock(async () => fake.item ?? itemWithDoc()),
    getWorkItemComments: mock(async () => [
      { id: 10, text: 'answers' },
      { id: 31, text: 'Bank integration implemented' },
    ]),
    downloadAttachment: mock(async (_cfg, url: string) => `# Ponto design (${url})`),
    remoteBranchExists: mock(async (_cfg, repo) => branchIn.has(repo.key)),
    pipeline: {
      ...pipelineDefaults,
      createWorktree: mock(async (_cfg, repo, _branch, itemId) => {
        const path = join(root, 'worktrees', String(itemId), repo.key);
        mkdirSync(path, { recursive: true });
        return path;
      }),
      wireSkills: mock(() => undefined),
      addGitExcludes: mock(() => undefined),
      setGitIdentity: mock(async () => undefined),
      runAgent: mock(async (_cfg, _prompt, options: { cwd: string }) => {
        if (fake.tasks !== null) {
          writeFileSync(
            join(options.cwd, '.agent', 'plan', 'tasklist.json'),
            JSON.stringify({ waves: [], tasks: fake.tasks ?? [{ id: 1 }, { id: 2 }, { id: 3 }] }),
            'utf-8',
          );
        }
        return { text: '3 tasks', success: fake.success ?? true, costUsd: 2.5, numTurns: 4, sessionId: 'seed-sess' };
      }),
    },
  } as unknown as SeedDeps;
}

describe('seedPlan', () => {
  test('writes the newest attached design doc and rebuilds the task list', async () => {
    const deps = makeDeps();

    const result = await seedPlan(config(), 42, store, deps);

    expect(deps.downloadAttachment).toHaveBeenCalledWith(expect.anything(), DOC_URL);
    const doc = readFileSync(join(root, 'worktrees', '42', 'banking', '.agent', 'plan', 'design-doc.md'), 'utf-8');
    expect(doc).toContain(DOC_URL);
    expect(result.taskCount).toBe(3);
    expect(result.costUsd).toBe(2.5);

    const prompt = String((deps.pipeline.runAgent as ReturnType<typeof mock>).mock.calls[0]![1]);
    expect(prompt).toContain('Phase 8 only');
    expect(prompt).toContain('Do not reserve new IDs');
    expect(prompt).toContain('run_in_background: false');
  });

  test('starts each worktree from the existing branch where it exists', async () => {
    const deps = makeDeps({ branchIn: ['banking'] });

    const result = await seedPlan(config(), 42, store, deps);

    const calls = (deps.pipeline.createWorktree as ReturnType<typeof mock>).mock.calls;
    const branch = 'Userstory/agent/42-add-acme-bank-communication';
    expect(calls[0]![4]).toBe(`refs/remotes/origin/${branch}`);
    expect(calls[1]![4]).toBeUndefined();
    expect(result.resumedFromBranch).toEqual(['banking']);
  });

  test('records the job so the next run resumes at implement, not planning', async () => {
    store.update(42, { phase: 'done', spentUsd: 99.46, planningSpentUsd: 98.31, lastSeenCommentId: 10 });

    await seedPlan(config(), 42, store, makeDeps());

    const job = store.get(42)!;
    expect(job.phase).toBe('failed');
    expect(job.failedAtPhase).toBe('implementing');
    // Past the bot's own success comment, so it does not force a re-plan.
    expect(job.lastSeenCommentId).toBe(31);
    expect(job.plannerSessionId).toBe('seed-sess');
    expect(job.spentUsd).toBe(2.5);
    expect(job.planningSpentUsd).toBe(2.5);
    expect(job.prs).toEqual([]);

    // Saved, so a watcher that reloads the file sees it.
    expect(new StateStore(join(root, 'state')).get(42)?.failedAtPhase).toBe('implementing');

    const entry = resolveEntryPhase(
      job,
      { taskList: true, implementSummary: false, verifyResult: false },
      false,
    );
    expect(entry.phase).toBe('implementing');
  });

  test('refuses to touch an existing worktree', async () => {
    mkdirSync(join(root, 'worktrees', '42', 'banking'), { recursive: true });
    const deps = makeDeps();

    await expect(seedPlan(config(), 42, store, deps)).rejects.toThrow('cleanup-worktrees 42');
    expect(deps.getWorkItem).not.toHaveBeenCalled();
  });

  test('fails without a design doc attachment', async () => {
    const deps = makeDeps({ item: mockWorkItem({ relations: [] }) });
    await expect(seedPlan(config(), 42, store, deps)).rejects.toThrow("no '42-design-doc.md' attachment");
    expect(deps.pipeline.runAgent).not.toHaveBeenCalled();
  });

  test('a rebuild with no tasks fails, but its spend is still recorded', async () => {
    const deps = makeDeps({ tasks: [] });

    await expect(seedPlan(config(), 42, store, deps)).rejects.toThrow('wrote no tasks');
    expect(store.get(42)?.spentUsd).toBe(2.5);
    expect(existsSync(join(root, 'worktrees', '42', 'banking'))).toBe(true);
  });
});
