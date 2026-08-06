import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { StateStore } from '../../src/state/state-store.ts';
import {
  runJob,
  runPublishPhase,
  slugify,
  branchNameFor,
  buildPrDescription,
  buildSuccessComment,
  failedPhaseLog,
  prTitle,
  type PipelineDeps,
  type PhaseContext,
} from '../../src/services/pipeline.ts';
import { BOT_COMMENT_MARKER } from '../../src/services/prompts.ts';
import type { PhasePaths } from '../../src/services/prompts.ts';
import type {
  AppConfig,
  JobRecord,
  PlanQuestions,
  PullRequestRef,
  VerifyResult,
} from '../../src/types/index.ts';

let root: string;
let store: StateStore;

/** mockWorkItem()'s id — every deterministic worktree/.agent path in this file keys on it. */
const TEST_ITEM_ID = 42;

const CLEAN_PLAN: PlanQuestions = { blocking: [], ambiguities: [] };
const OPEN_PLAN: PlanQuestions = {
  blocking: [{ question: 'Which auth flow?' }],
  ambiguities: [],
};
const PASSING_VERIFY: VerifyResult = {
  passed: true,
  envId: 'env-1',
  envUrl: 'https://env.example/1',
  summary: '12 of 12 tests passed',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-'));
  store = new StateStore(join(root, 'state'));
});

afterEach(() => {
  // maxRetries/retryDelay: many nested mkdirSync calls just touched this tree,
  // and on Windows `force: true` suppresses ENOENT but not an intermittent
  // EBUSY/EPERM from a lingering handle or an AV scan.
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return mockConfig({
    worktreeRoot: join(root, 'worktrees'),
    repoCacheDir: join(root, 'repos'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    skipBuildTest: true,
    ...overrides,
  });
}

/**
 * A fake agent: instead of running Claude, it writes the artifacts the phase
 * expects, exactly as the real agent is instructed to.
 */
interface FakeOptions {
  questions?: PlanQuestions;
  verify?: VerifyResult;
  implementText?: string;
  changedRepos?: Array<'banking' | 'setupFiles'>;
  failPhase?: string;
}

function makeDeps(fake: FakeOptions = {}): PipelineDeps {
  const changed = new Set(fake.changedRepos ?? ['banking', 'setupFiles']);

  const worktreeFor = (key: string, itemId: number) =>
    join(root, 'worktrees', String(itemId), key);

  return {
    getWorkItemComments: mock(() => Promise.resolve([{ id: 3, text: 'a comment' }])),
    addWorkItemComment: mock(() => Promise.resolve({ id: 99, text: '' })),
    swapWorkItemTags: mock(() => Promise.resolve(mockWorkItem())),
    createPullRequest: mock((_cfg, repo) =>
      Promise.resolve<PullRequestRef>({
        repoKey: repo.key,
        repoName: repo.name,
        pullRequestId: repo.key === 'banking' ? 100 : 200,
        url: `https://ado/${repo.key}/pullrequest/1`,
        isDraft: true,
      }),
    ),
    createWorktree: mock((_cfg, repo, _branch, itemId) => {
      const path = worktreeFor(repo.key, itemId);
      mkdirSync(path, { recursive: true });
      return Promise.resolve(path);
    }),
    removeAllWorktrees: mock(() => Promise.resolve()),
    wireSkills: mock(() => undefined),
    addGitExcludes: mock(() => undefined),
    setGitIdentity: mock(async () => undefined),
    commitAndPush: mock((_cfg, worktree) =>
      Promise.resolve([...changed].some((key) => worktree.endsWith(key))),
    ),
    hasChanges: mock((_cfg, worktree) =>
      Promise.resolve([...changed].some((key) => worktree.endsWith(key))),
    ),
    runAgent: mock((_cfg, prompt: string, options: { cwd: string }) => {
      const isPlan = prompt.includes('bank-integration-planner');
      const isVerify = prompt.includes('Build and test the changes');

      if (fake.failPhase === 'plan' && isPlan) {
        return Promise.resolve({
          text: '',
          success: false,
          costUsd: 0,
          numTurns: 1,
        });
      }
      if (fake.failPhase === 'implement' && !isPlan && !isVerify) {
        return Promise.resolve({
          text: '',
          success: false,
          costUsd: 0,
          numTurns: 1,
        });
      }

      if (isPlan) {
        const planDir = join(options.cwd, '.agent', 'plan');
        mkdirSync(planDir, { recursive: true });
        writeFileSync(
          join(planDir, 'questions.json'),
          JSON.stringify(fake.questions ?? CLEAN_PLAN),
          'utf-8',
        );
        writeFileSync(
          join(planDir, 'artifacts.json'),
          JSON.stringify({
            bankName: 'AcmeBank',
            designDocPath: join(planDir, 'design-doc.md'),
            taskListPath: join(planDir, 'tasklist.json'),
          }),
          'utf-8',
        );
        // The real planner writes this too — artifacts.json only *names* it.
        // Task 8's attach-on-success call site reads this file directly, so
        // a fake that skipped it would make that call site's tests a no-op.
        writeFileSync(
          join(planDir, 'design-doc.md'),
          '# AcmeBank design\n\nPlausible planning output for test purposes.',
          'utf-8',
        );
        // The real planner writes this too (pathsFor maps taskListPath here).
        // Task 5's dispatch gates entry at 'implementing' on this file's
        // presence, so a real planning run must leave it behind.
        writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify({ waves: [] }), 'utf-8');
      }

      if (isVerify) {
        const verifyDir = join(options.cwd, '.agent', 'verify');
        mkdirSync(verifyDir, { recursive: true });
        writeFileSync(
          join(verifyDir, 'result.json'),
          JSON.stringify(fake.verify ?? PASSING_VERIFY),
          'utf-8',
        );
      }

      return Promise.resolve({
        text: isPlan ? 'planned' : (fake.implementText ?? '- added Acme codeunits'),
        sessionId: 'sess-abc',
        success: true,
        costUsd: 0.5,
        numTurns: 10,
      });
    }),
    readJsonArtifact: (path: string) => {
      const fs = require('fs') as typeof import('fs');
      if (!fs.existsSync(path)) return undefined;
      // Matches the real readJsonArtifact (agent-runner.ts): a parse error is
      // caught and reported as "missing", not thrown. Fix 5 depends on this —
      // dispatch treats a corrupt artifact the same as an absent one.
      try {
        return JSON.parse(fs.readFileSync(path, 'utf-8'));
      } catch {
        return undefined;
      }
    },
    tailLog: () => '(log)',
    uploadAttachment: mock(async () => ({ id: 'att-1', url: 'https://example/att-1' })),
    linkAttachmentToWorkItem: mock(async () => undefined),
  } as unknown as PipelineDeps;
}

/** The `.agent` directory `resolveEntryPhase`'s artifacts live under, for this harness. */
function agentDirFor(itemId: number): string {
  return join(root, 'worktrees', String(itemId), 'banking', '.agent');
}

/**
 * Write to disk whichever artifact `resolveEntryPhase` requires to land at
 * `phase` as requested, rather than silently falling back to an earlier one
 * (see entry-phase.ts's `REQUIRES` table — each phase's own requirement,
 * not the cumulative requirements of every phase before it). Spelled out
 * phase by phase so a reader can tell exactly what a given test had on disk.
 */
function seedArtifactsFor(phase: JobRecord['phase'], itemId: number): void {
  const agentDir = agentDirFor(itemId);

  // A real job resumed at any phase after planning has a design doc on disk
  // from its earlier planning run — planning already ran and wrote it before
  // this run's entry point, even though the entry point itself does not
  // require it (resolveEntryPhase's REQUIRES table has no design-doc
  // precondition). Seed it here so a resumed job's disk state matches that,
  // not just what the entered phase strictly needs.
  if (phase === 'implementing' || phase === 'verifying' || phase === 'publishing') {
    const planDir = join(agentDir, 'plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'design-doc.md'),
      '# AcmeBank design\n\nSeeded for test — resumed past planning.',
      'utf-8',
    );
  }

  if (phase === 'implementing') {
    const planDir = join(agentDir, 'plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify({ waves: [] }), 'utf-8');
  }

  if (phase === 'verifying' || phase === 'publishing') {
    const implementDir = join(agentDir, 'implement');
    mkdirSync(implementDir, { recursive: true });
    writeFileSync(
      join(implementDir, 'summary.json'),
      JSON.stringify({ summary: 'seeded for test' }),
      'utf-8',
    );
  }

  if (phase === 'publishing') {
    const verifyDir = join(agentDir, 'verify');
    mkdirSync(verifyDir, { recursive: true });
    writeFileSync(join(verifyDir, 'result.json'), JSON.stringify(PASSING_VERIFY), 'utf-8');
  }
}

/**
 * Seed the shared `store` with a job already at `phase` (plus any overrides —
 * e.g. `failedAtPhase` and `lastSeenCommentId`), pre-write whichever
 * artifacts that entry point needs so `resolveEntryPhase` actually lands
 * there instead of falling back, and run it through `runJob`.
 *
 * `phase: 'failed'` resolves through `failedAtPhase` (falling back to
 * 'planning', matching entry-phase.ts), since that is what the dispatch
 * actually consults for a failed job.
 */
function runProcessItemAtPhase(
  phase: JobRecord['phase'],
  deps: PipelineDeps,
  jobOverrides: Partial<JobRecord> = {},
) {
  const item = mockWorkItem();
  const targetPhase = phase === 'failed' ? jobOverrides.failedAtPhase ?? 'planning' : phase;
  seedArtifactsFor(targetPhase, item.id);
  store.update(item.id, { phase, ...jobOverrides });
  return runJob(config(), item, store, deps);
}

describe('slugify', () => {
  test('lowercases and dashes a title', () => {
    expect(slugify('Add Acme Bank Communication')).toBe('add-acme-bank-communication');
  });

  test('strips punctuation and collapses separators', () => {
    expect(slugify('Acme  Bank: (v2) -- API!')).toBe('acme-bank-v2-api');
  });

  test('falls back for an unusable title', () => {
    expect(slugify('///')).toBe('new-bank-comm');
    expect(slugify('')).toBe('new-bank-comm');
  });

  test('truncates long titles', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe('branchNameFor', () => {
  test('combines prefix, work item id and slug', () => {
    expect(branchNameFor(config(), mockWorkItem())).toBe(
      'Userstory/agent/42-add-acme-bank-communication',
    );
  });

  test('honours a custom prefix', () => {
    expect(branchNameFor(config({ branchPrefix: 'bot' }), mockWorkItem())).toBe(
      'bot/42-add-acme-bank-communication',
    );
  });
});

describe('runJob — clarification loop', () => {
  test('asks questions, swaps tags, and stops without implementing', async () => {
    const deps = makeDeps({ questions: OPEN_PLAN });
    const cfg = config();

    const result = await runJob(cfg, mockWorkItem(), store, deps);

    expect(result.phase).toBe('awaiting-answers');
    expect(result.processed).toBe(true);

    // Commented and re-tagged for the human.
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(1);
    const comment = (deps.addWorkItemComment as ReturnType<typeof mock>).mock
      .calls[0]![2] as string;
    expect(comment).toContain('Which auth flow?');

    const swap = (deps.swapWorkItemTags as ReturnType<typeof mock>).mock.calls[0]!;
    expect(swap[2]).toEqual([cfg.triggerTag]);
    expect(swap[3]).toEqual([cfg.waitingTag]);

    // Only the planner ran; nothing was built or published.
    expect((deps.runAgent as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect(deps.createPullRequest).not.toHaveBeenCalled();

    const job = store.get(42);
    expect(job?.phase).toBe('awaiting-answers');
    expect(job?.clarifyRounds).toBe(1);
    expect(job?.plannerSessionId).toBe('sess-abc');
  });

  test('counts rounds across re-tags and proceeds once the cap is reached', async () => {
    const cfg = config({ maxClarifyRounds: 2 });

    // Round 1 and 2 both come back with open questions.
    await runJob(cfg, mockWorkItem(), store, makeDeps({ questions: OPEN_PLAN }));
    expect(store.get(42)?.clarifyRounds).toBe(1);

    await runJob(cfg, mockWorkItem(), store, makeDeps({ questions: OPEN_PLAN }));
    expect(store.get(42)?.clarifyRounds).toBe(2);

    // Third pass is at the cap: it must build rather than ask again.
    const deps = makeDeps({ questions: OPEN_PLAN });
    const result = await runJob(cfg, mockWorkItem(), store, deps);

    expect(result.phase).toBe('done');
    expect(deps.createPullRequest).toHaveBeenCalledTimes(2);
  });

  test('a clean plan skips the clarification loop entirely', async () => {
    const deps = makeDeps();
    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('done');
    expect(store.get(42)?.clarifyRounds).toBe(0);
  });

  test('resolved ambiguities alone still pause for review', async () => {
    const deps = makeDeps({
      questions: {
        blocking: [],
        ambiguities: [{ question: 'Format?', decisionTaken: 'CAMT.053' }],
      },
    });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('awaiting-answers');
    const comment = (deps.addWorkItemComment as ReturnType<typeof mock>).mock
      .calls[0]![2] as string;
    expect(comment).toContain('CAMT.053');
  });
});

describe('runJob — happy path', () => {
  test('plans, implements, verifies, opens a draft PR per repo, and cleans up', async () => {
    const deps = makeDeps();
    const cfg = config();

    const result = await runJob(cfg, mockWorkItem(), store, deps);

    expect(result).toMatchObject({ itemId: 42, processed: true, phase: 'done' });

    // Two repos wired with skills, two PRs, worktrees removed at the end.
    expect((deps.wireSkills as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
    expect((deps.createPullRequest as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
    expect(deps.removeAllWorktrees).toHaveBeenCalledTimes(1);

    const prCall = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]!;
    expect(prCall[2]).toMatchObject({
      isDraft: true,
      targetBranch: 'main',
      sourceBranch: 'Userstory/agent/42-add-acme-bank-communication',
      workItemIds: [42],
    });

    const job = store.get(42);
    expect(job?.phase).toBe('done');
    expect(job?.prs).toHaveLength(2);
    expect(job?.worktrees).toEqual({});
  });

  test('tags the item done and posts the PR links', async () => {
    const deps = makeDeps();
    const cfg = config();

    await runJob(cfg, mockWorkItem(), store, deps);

    const swap = (deps.swapWorkItemTags as ReturnType<typeof mock>).mock.calls.at(-1)!;
    expect(swap[2]).toEqual([cfg.triggerTag, cfg.waitingTag, cfg.failedTag]);
    expect(swap[3]).toEqual([cfg.doneTag]);

    const comment = (deps.addWorkItemComment as ReturnType<typeof mock>).mock
      .calls.at(-1)![2] as string;
    expect(comment).toContain('pullrequest');
  });

  test('opens a PR only for the repo that actually changed', async () => {
    const deps = makeDeps({ changedRepos: ['banking'] });

    await runJob(config(), mockWorkItem(), store, deps);

    const calls = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].key).toBe('banking');
  });

  test('gives the agent both worktrees so one run can edit both repos', async () => {
    const deps = makeDeps();
    await runJob(config(), mockWorkItem(), store, deps);

    const options = (deps.runAgent as ReturnType<typeof mock>).mock.calls[0]![2] as {
      cwd: string;
      additionalDirectories: string[];
    };
    expect(options.cwd).toContain('banking');
    expect(options.additionalDirectories[0]).toContain('setupFiles');
  });

  test('runs the verify phase when build/test is enabled', async () => {
    const deps = makeDeps();
    await runJob(config({ skipBuildTest: false }), mockWorkItem(), store, deps);

    const prompts = (deps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (call) => call[1] as string,
    );
    expect(prompts.some((p) => p.includes('Build and test the changes'))).toBe(true);
  });

  test('skips the verify agent when SKIP_BUILD_TEST is set', async () => {
    const deps = makeDeps();
    await runJob(config({ skipBuildTest: true }), mockWorkItem(), store, deps);

    const prompts = (deps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (call) => call[1] as string,
    );
    expect(prompts.some((p) => p.includes('Build and test the changes'))).toBe(false);
  });
});

describe('runJob — failures', () => {
  test('does not open a PR when verification fails', async () => {
    const deps = makeDeps({
      verify: { passed: false, summary: '2 tests failing', failedTests: ['TestA'] },
    });

    const result = await runJob(
      config({ skipBuildTest: false }),
      mockWorkItem(),
      store,
      deps,
    );

    expect(result.processed).toBe(false);
    expect(result.phase).toBe('failed');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(result.error).toContain('TestA');
    // The work is still pushed so it can be inspected.
    expect(deps.commitAndPush).toHaveBeenCalled();
  });

  test('treats a missing verify artifact as a failure, not a pass', async () => {
    const deps = makeDeps();
    // Make the verify agent succeed without writing result.json.
    (deps as { runAgent: unknown }).runAgent = mock(
      (_cfg: unknown, prompt: string, options: { cwd: string }) => {
        if (prompt.includes('bank-integration-planner')) {
          const planDir = join(options.cwd, '.agent', 'plan');
          mkdirSync(planDir, { recursive: true });
          writeFileSync(
            join(planDir, 'questions.json'),
            JSON.stringify(CLEAN_PLAN),
            'utf-8',
          );
        }
        return Promise.resolve({
          text: 'ok',
          success: true,
          costUsd: 0,
          numTurns: 1,
        });
      },
    );

    const result = await runJob(
      config({ skipBuildTest: false }),
      mockWorkItem(),
      store,
      deps,
    );

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('verify/result.json');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  test('fails when the implement phase changed nothing', async () => {
    const deps = makeDeps({ changedRepos: [] });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('no file changes');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  test('reports a failed agent run, tags the item, and keeps the worktrees', async () => {
    const deps = makeDeps({ failPhase: 'implement' });
    const cfg = config();

    const result = await runJob(cfg, mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(store.get(42)?.phase).toBe('failed');
    expect(store.get(42)?.error).toContain('implementing');

    const swap = (deps.swapWorkItemTags as ReturnType<typeof mock>).mock.calls.at(-1)!;
    expect(swap[3]).toEqual([cfg.failedTag]);
    // The plan artifacts and any partial build live in the worktrees, so a
    // retry can resume at failedAtPhase instead of re-planning from scratch.
    expect(deps.removeAllWorktrees).not.toHaveBeenCalled();

    // Marked so staleness detection does not mistake our own failure report
    // for a human comment on the next retry.
    const comment = (deps.addWorkItemComment as ReturnType<typeof mock>).mock
      .calls.at(-1)![2] as string;
    expect(comment).toContain(BOT_COMMENT_MARKER);
  });

  test('a failed job keeps its worktrees so a retry can resume', async () => {
    const deps = makeDeps();
    deps.runAgent = mock(async () => {
      throw new Error('kaboom');
    });
    await runProcessItemAtPhase('new', deps);
    // A brand-new job has no worktree on disk yet, so the pre-dispatch clean
    // (gated on one already existing — pipeline.ts's `worktreeExisted`) never
    // fires here either: zero calls is the only value a post-failure wipe
    // could still hide behind, not a number that merely happens to work.
    expect((deps.removeAllWorktrees as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('records the phase that failed', async () => {
    const deps = makeDeps();
    deps.runAgent = mock(async () => {
      throw new Error('kaboom');
    });
    await runProcessItemAtPhase('implementing', deps);
    expect(store.get(TEST_ITEM_ID)?.failedAtPhase).toBe('implementing');
  });

  test('the failure comment tells the human how to reclaim the disk', async () => {
    const deps = makeDeps();
    deps.runAgent = mock(async () => {
      throw new Error('kaboom');
    });
    await runProcessItemAtPhase('new', deps);
    const body = (deps.addWorkItemComment as ReturnType<typeof mock>).mock.calls.at(-1)?.[2];
    expect(body).toContain('cleanup-worktrees');
  });

  test('a failed job is retried on the next poll', async () => {
    await runJob(config(), mockWorkItem(), store, makeDeps({ failPhase: 'plan' }));
    expect(store.get(42)?.phase).toBe('failed');
    expect(store.shouldProcess(42)).toBe(true);

    const result = await runJob(config(), mockWorkItem(), store, makeDeps());
    expect(result.phase).toBe('done');
  });

  test('a fetch error is recorded without throwing out of runJob', async () => {
    const deps = makeDeps();
    (deps as { getWorkItemComments: unknown }).getWorkItemComments = mock(() =>
      Promise.reject(new Error('ADO is down')),
    );

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.processed).toBe(false);
    expect(result.error).toContain('ADO is down');
  });
});

describe('runJob — dispatch', () => {
  /** `runAgent`'s `logFile` option, per call — the discriminator for which phase(s) ran. */
  function logFiles(deps: PipelineDeps): string[] {
    return (deps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (c) => (c[2] as { logFile?: string } | undefined)?.logFile ?? '',
    );
  }

  test('entering at verifying skips implement', async () => {
    const deps = makeDeps();
    await runProcessItemAtPhase('verifying', deps);
    expect(logFiles(deps).some((f) => f.includes('implement'))).toBe(false);
  });

  test('entering at planning cleans the workspace first', async () => {
    const deps = makeDeps();
    // The real scenario this guards against: reset-item deletes the whole
    // job record (StateStore.remove), not just its phase, so the job record
    // is no signal at all — the only thing that can still say "a previous
    // run happened here" is whatever survived on disk. Simulate exactly
    // that: a banking worktree directory with no job record backing it —
    // store.ensure() inside runJob will hand back a brand-new 'new' record,
    // same as it would the moment after a real reset-item.
    mkdirSync(join(root, 'worktrees', String(TEST_ITEM_ID), 'banking'), { recursive: true });

    await runJob(config(), mockWorkItem(), store, deps);

    // Once for the pre-dispatch wipe, once for the ordinary end-of-run
    // cleanup — proving the wipe is a genuine extra call, not just the
    // cleanup that already happens on every successful run.
    expect((deps.removeAllWorktrees as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test('a surviving setup-files-only worktree also triggers the wipe', async () => {
    // Only the setup-files sibling survived — e.g. a partial
    // removeAllWorktrees or a failed cleanup-worktrees. Probing the banking
    // worktree alone would miss this and let stale setup JSON leak into a
    // "fresh" plan and into the PR.
    const deps = makeDeps();
    mkdirSync(join(root, 'worktrees', String(TEST_ITEM_ID), 'setupFiles'), {
      recursive: true,
    });

    await runJob(config(), mockWorkItem(), store, deps);

    expect((deps.removeAllWorktrees as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test('resuming forward does not clean the workspace', async () => {
    const deps = makeDeps();
    await runProcessItemAtPhase('implementing', deps);
    // Only the success-path cleanup at the end, never before dispatch.
    expect((deps.removeAllWorktrees as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test('a newer marked comment does not force a re-plan', async () => {
    const deps = makeDeps();
    deps.getWorkItemComments = mock(async () => [
      { id: 10, text: 'human question' },
      { id: 11, text: `${BOT_COMMENT_MARKER} our questions` },
    ]);
    // lastSeenCommentId is 10; the only newer comment is ours. plannerSessionId
    // set so this exercises the marked-comment exclusion itself, not just the
    // "never planned" gate that would also return false on its own.
    const result = await runProcessItemAtPhase('failed', deps, {
      failedAtPhase: 'implementing',
      lastSeenCommentId: 10,
      plannerSessionId: 'sess-abc',
    });
    expect(result.phase).toBe('done');
    expect(logFiles(deps).some((f) => f.includes('plan-'))).toBe(false);
  });

  test('a newer unmarked comment does force a re-plan', async () => {
    const deps = makeDeps();
    deps.getWorkItemComments = mock(async () => [
      { id: 10, text: 'human question' },
      { id: 12, text: 'here are your answers' },
    ]);
    await runProcessItemAtPhase('failed', deps, {
      failedAtPhase: 'implementing',
      lastSeenCommentId: 10,
      plannerSessionId: 'sess-abc',
    });
    expect(logFiles(deps).some((f) => f.includes('plan-'))).toBe(true);
  });

  test('a human comment after a plan that saw none still forces a re-plan', async () => {
    // The reachable scenario the review found: the item's description had
    // everything needed, so the planning round watermarked no human comment
    // and `lastSeenCommentId` stayed 0. A human correction posted after the
    // implement failure must not be mistaken for "this job never planned" —
    // gating on the watermark's value alone would do exactly that.
    const deps = makeDeps();
    deps.getWorkItemComments = mock(async () => [
      { id: 7, text: 'use OAuth2 client credentials' },
    ]);
    await runProcessItemAtPhase('failed', deps, {
      failedAtPhase: 'implementing',
      lastSeenCommentId: 0,
      plannerSessionId: 'sess-abc',
    });
    expect(logFiles(deps).some((f) => f.includes('plan-'))).toBe(true);
  });

  test('a corrupt tasklist.json is treated as missing, so implement falls back to planning', async () => {
    // A job recorded at 'implementing' whose plan/tasklist.json exists on
    // disk but is not valid JSON. `existsSync` would see the file and enter
    // directly at 'implementing', handing the agent a plan it cannot really
    // read; `readJsonArtifact` returning undefined for the corrupt file must
    // instead fall the entry point back to 'planning'.
    const deps = makeDeps();
    const agentDir = agentDirFor(TEST_ITEM_ID);
    const planDir = join(agentDir, 'plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'design-doc.md'), '# seeded design doc', 'utf-8');
    writeFileSync(join(planDir, 'tasklist.json'), '{not valid json', 'utf-8');

    store.update(TEST_ITEM_ID, { phase: 'implementing' });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(logFiles(deps).some((f) => f.includes('plan-'))).toBe(true);
    expect(result.phase).toBe('done');
  });

  test('a failing verify read from disk still blocks the PR when entering directly at publishing', async () => {
    const deps = makeDeps();
    // Seed publishing's own prerequisites by hand (rather than through
    // seedArtifactsFor, which always writes PASSING_VERIFY) so the
    // verify/result.json entry actually reads back a failure — pinning the
    // "no PR, push instead" outcome on the disk-read branch specifically,
    // not on runVerifyPhase (which never runs on this path).
    const agentDir = agentDirFor(TEST_ITEM_ID);
    mkdirSync(join(agentDir, 'implement'), { recursive: true });
    writeFileSync(
      join(agentDir, 'implement', 'summary.json'),
      JSON.stringify({ summary: 'seeded for test' }),
      'utf-8',
    );
    mkdirSync(join(agentDir, 'verify'), { recursive: true });
    writeFileSync(
      join(agentDir, 'verify', 'result.json'),
      JSON.stringify({ passed: false, summary: '3 tests failing', failedTests: ['TestX'] }),
      'utf-8',
    );
    store.update(TEST_ITEM_ID, { phase: 'publishing' });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('TestX');
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    // The work is still pushed so it is not lost, same as a verify that
    // fails in-process.
    expect(deps.commitAndPush).toHaveBeenCalled();
  });
});

describe('runJob — change summary hand-off', () => {
  test('publish reads the change summary from the artifact, not an argument', async () => {
    const deps = makeDeps();
    // seedArtifactsFor pre-writes implement/summary.json and
    // verify/result.json for 'publishing', so resolveEntryPhase lands
    // directly at publish and implement never runs in this process at all.
    // The intercepted read below is therefore the *only* way runPublishPhase
    // can see a change summary — proving it goes through
    // deps.readJsonArtifact rather than an in-memory value threaded from a
    // (here, nonexistent) implement call.
    const real = deps.readJsonArtifact;
    deps.readJsonArtifact = mock((path: string) =>
      path.endsWith('summary.json') ? { summary: 'from artifact' } : real(path),
    );

    const result = await runProcessItemAtPhase('publishing', deps);

    expect(result.phase).toBe('done');
    const prCall = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]!;
    expect(JSON.stringify(prCall[2])).toContain('from artifact');
  });
});

describe('runJob — design doc attachment', () => {
  test('attaches the design doc to the work item on success', async () => {
    const deps = makeDeps();
    await runProcessItemAtPhase('publishing', deps);

    expect(deps.uploadAttachment).toHaveBeenCalled();
    const fileName = (deps.uploadAttachment as ReturnType<typeof mock>).mock.calls[0]?.[1];
    expect(fileName).toContain('design-doc');
    expect(deps.linkAttachmentToWorkItem).toHaveBeenCalled();
  });

  test('an attachment failure does not fail a job whose PRs exist', async () => {
    const deps = makeDeps();
    deps.uploadAttachment = mock(async () => {
      throw new Error('upload exploded');
    });
    const result = await runProcessItemAtPhase('publishing', deps);
    expect(result.phase).toBe('done');
  });

  test('a missing design doc is skipped silently, without failing the job', async () => {
    const deps = makeDeps();
    const item = mockWorkItem();

    // Seed only what publishing itself requires (implement summary + a
    // passing verify result) and deliberately leave out the design doc —
    // unlike seedArtifactsFor, which always writes one. Covers a job whose
    // planning round predates this feature, or whose doc was already
    // cleaned up: publish must still succeed with nothing to attach.
    const agentDir = agentDirFor(item.id);
    mkdirSync(join(agentDir, 'implement'), { recursive: true });
    writeFileSync(
      join(agentDir, 'implement', 'summary.json'),
      JSON.stringify({ summary: 'seeded for test' }),
      'utf-8',
    );
    mkdirSync(join(agentDir, 'verify'), { recursive: true });
    writeFileSync(
      join(agentDir, 'verify', 'result.json'),
      JSON.stringify(PASSING_VERIFY),
      'utf-8',
    );
    store.update(item.id, { phase: 'publishing' });

    const result = await runJob(config(), item, store, deps);

    expect(result.phase).toBe('done');
    expect(deps.uploadAttachment).not.toHaveBeenCalled();
    expect(deps.linkAttachmentToWorkItem).not.toHaveBeenCalled();
  });
});

describe('runPublishPhase — direct', () => {
  /**
   * Build a `PhaseContext` by hand so `runPublishPhase` can be exercised
   * without going through `runJob` — the only way to prove the *file* is the
   * channel, since an end-to-end run through `runJob` would have implement
   * write the same summary that publish then reads and could not tell a file
   * read apart from a leftover in-memory value.
   */
  function makeDirectCtx(deps: PipelineDeps, implementSummaryPath: string): PhaseContext {
    const cfg = config();
    const item = mockWorkItem();
    const agentDir = join(root, 'direct', '.agent');
    const paths: PhasePaths = {
      agentDir,
      questionsPath: join(agentDir, 'plan', 'questions.json'),
      artifactsPath: join(agentDir, 'plan', 'artifacts.json'),
      designDocPath: join(agentDir, 'plan', 'design-doc.md'),
      taskListPath: join(agentDir, 'plan', 'tasklist.json'),
      verifyResultPath: join(agentDir, 'verify', 'result.json'),
      implementSummaryPath,
    };

    return {
      config: cfg,
      item,
      job: store.ensure(item.id),
      store,
      deps,
      branch: branchNameFor(cfg, item),
      worktrees: {
        banking: join(root, 'direct', 'banking'),
        setupFiles: join(root, 'direct', 'setupFiles'),
      },
      paths,
      comments: [],
      workItemContext: '',
    };
  }

  test('reads the change summary written to summary.json on disk', async () => {
    const deps = makeDeps();
    const summaryPath = join(root, 'direct', '.agent', 'implement', 'summary.json');
    mkdirSync(join(root, 'direct', '.agent', 'implement'), { recursive: true });
    writeFileSync(
      summaryPath,
      JSON.stringify({ summary: 'distinctive-summary-on-disk' }),
      'utf-8',
    );

    const ctx = makeDirectCtx(deps, summaryPath);
    await runPublishPhase(ctx, PASSING_VERIFY);

    const prCall = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]!;
    expect(prCall[2].description).toContain('distinctive-summary-on-disk');
  });

  test('falls back to a fixed string when summary.json is missing', async () => {
    const deps = makeDeps();
    const summaryPath = join(root, 'direct', '.agent', 'implement', 'summary.json');
    // Deliberately not written.

    const ctx = makeDirectCtx(deps, summaryPath);
    await runPublishPhase(ctx, PASSING_VERIFY);

    const prCall = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]!;
    expect(prCall[2].description).toContain('(no change summary recorded)');
  });
});

describe('runJob — dry run', () => {
  test('reads the item and its comments, then stops', async () => {
    const deps = makeDeps();
    const result = await runJob(config({ dryRun: true }), mockWorkItem(), store, deps);

    expect(result.processed).toBe(true);
    expect(deps.getWorkItemComments).toHaveBeenCalledTimes(1);
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.addWorkItemComment).not.toHaveBeenCalled();
    expect(deps.swapWorkItemTags).not.toHaveBeenCalled();
  });
});

describe('PR content', () => {
  test('prTitle uses the work item title and truncates long ones', () => {
    expect(prTitle(mockWorkItem())).toBe('Add Acme Bank communication');

    const long = mockWorkItem({ fields: { 'System.Title': 'x'.repeat(200) } });
    expect(prTitle(long).length).toBe(140);
    expect(prTitle(long).endsWith('...')).toBe(true);
  });

  test('the description carries the change summary and the verification result', () => {
    const description = buildPrDescription(
      mockWorkItem(),
      '- added Acme codeunits',
      PASSING_VERIFY,
    );

    expect(description).toContain('- added Acme codeunits');
    expect(description).toContain('12 of 12 tests passed');
    expect(description).toContain('https://env.example/1');
    expect(description).toContain('env-1');
    expect(description).toContain('#42');
  });

  test('a long summary is truncated to fit the ADO 4000-character limit', () => {
    const description = buildPrDescription(
      mockWorkItem(),
      'x'.repeat(20000),
      PASSING_VERIFY,
    );

    // ADO returns a 400 above 4000, which cost a $92 run to discover.
    expect(description.length).toBeLessThanOrEqual(4000);
    expect(description).toContain('truncated');
  });

  test('truncation never sacrifices the verification block', () => {
    const description = buildPrDescription(mockWorkItem(), 'x'.repeat(20000), {
      passed: false,
      summary: 'compile error',
      failedTests: ['TestA', 'TestB'],
    });

    // A PR must never look better-tested than it is, however long the summary.
    expect(description.length).toBeLessThanOrEqual(4000);
    expect(description).toContain('NOT PASSING');
    expect(description).toContain('TestA, TestB');
  });

  test('a short summary is left exactly as it was', () => {
    const description = buildPrDescription(
      mockWorkItem(),
      '- added Acme codeunits',
      PASSING_VERIFY,
    );

    expect(description).not.toContain('truncated');
    expect(description.startsWith('- added Acme codeunits')).toBe(true);
  });

  test('a failing verification is called out plainly', () => {
    const description = buildPrDescription(mockWorkItem(), 'summary', {
      passed: false,
      summary: 'compile error',
      failedTests: ['TestA', 'TestB'],
    });

    expect(description).toContain('NOT PASSING');
    expect(description).toContain('TestA, TestB');
  });

  test('the success comment links every PR and names the surviving environment', () => {
    const comment = buildSuccessComment(
      mockConfig(),
      [
        {
          repoKey: 'banking',
          repoName: 'Continia Banking',
          pullRequestId: 1,
          url: 'https://ado/1',
          isDraft: true,
        },
        {
          repoKey: 'setupFiles',
          repoName: 'Setup Files',
          pullRequestId: 2,
          url: 'https://ado/2',
          isDraft: true,
        },
      ],
      PASSING_VERIFY,
    );

    expect(comment).toContain('Draft pull requests');
    expect(comment).toContain('https://ado/1');
    expect(comment).toContain('https://ado/2');
    expect(comment).toContain('left running');
    expect(comment).toContain(BOT_COMMENT_MARKER);
  });

  test('the success comment handles the no-change case', () => {
    const comment = buildSuccessComment(mockConfig(), [], PASSING_VERIFY);
    expect(comment).toContain('No pull request was needed');
  });
});

describe('failedPhaseLog', () => {
  test('picks the latest phase that actually produced a log', () => {
    const cfg = config();
    const deps = makeDeps();
    const present = new Set(['plan-1', 'implement']);
    (deps as { tailLog: unknown }).tailLog = (path: string) =>
      [...present].some((phase) => path.includes(phase)) ? 'content' : '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toContain('implement');
  });

  test('falls back to the first planning log when nothing ran', () => {
    const cfg = config();
    const deps = makeDeps();
    (deps as { tailLog: unknown }).tailLog = () => '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toContain('plan-1');
  });
});
