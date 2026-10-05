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
  runPlanningPhase,
  prepareWorkspaces,
  shouldPauseForAnswers,
  pathsFor,
  type PipelineDeps,
  type PhaseContext,
} from '../../src/services/pipeline.ts';
import { BOT_COMMENT_MARKER } from '../../src/services/prompts.ts';
import type { PhasePaths } from '../../src/services/prompts.ts';
import type {
  AppConfig,
  ImplementResult,
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
/** A two-task plan; implement must report both before the build counts as finished. */
const TASK_LIST = {
  waves: [{ wave: 1 }],
  tasks: [
    { id: 1, wave: 1, title: 'Create codeunit Acme Auth' },
    { id: 2, wave: 1, title: 'Register Acme in CommunicationType enum' },
  ],
};
const DONE_REPORT: ImplementResult = {
  summary: '- continia-banking: Acme codeunits',
  tasks: [
    { id: 1, status: 'done' },
    { id: 2, status: 'done' },
  ],
};

/** Write implement/result.json the way the implement agent is told to. */
function writeImplementReport(cwd: string, report: ImplementResult): void {
  const dir = join(cwd, '.agent', 'implement');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report), 'utf-8');
}

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
  /** Plan files the fake planner leaves out, as a planner that stopped early would. */
  omitPlanFiles?: string[];
  /**
   * What the n-th implement run (first run, then each nudge) leaves in
   * implement/result.json; `null` leaves the file as it was. Runs past the
   * end of the list repeat its last entry. Default: every task done.
   */
  implementReports?: Array<ImplementResult | null>;
}

function makeDeps(fake: FakeOptions = {}): PipelineDeps {
  const changed = new Set(fake.changedRepos ?? ['banking', 'setupFiles']);
  const implementReports = fake.implementReports ?? [DONE_REPORT];
  let implementRuns = 0;

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
        artifactId: `vstfs:///Git/PullRequestId/proj%2F${repo.key}%2F1`,
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
        writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify(TASK_LIST), 'utf-8');
        for (const file of fake.omitPlanFiles ?? []) rmSync(join(planDir, file), { force: true });
      }

      if (!isPlan && !isVerify) {
        const report =
          implementReports[Math.min(implementRuns, implementReports.length - 1)];
        implementRuns += 1;
        if (report) writeImplementReport(options.cwd, report);
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
    linkPullRequestToWorkItem: mock(async () => mockWorkItem()),
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
    writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify(TASK_LIST), 'utf-8');
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
    // The human sees these decisions once; the comment says it will not pause for them again.
    expect(comment).toContain('Last review of these decisions');
  });

  test('ambiguities alone do not pause a second time — the job proceeds on the defaults', async () => {
    // #83634 paused on 43, 33, 25 and 7 ambiguities with no blocking question.
    const AMBIGUOUS: PlanQuestions = {
      blocking: [],
      ambiguities: [{ question: 'Format?', decisionTaken: 'CAMT.053' }],
    };
    await runJob(config(), mockWorkItem(), store, makeDeps({ questions: AMBIGUOUS }));
    expect(store.get(42)?.clarifyRounds).toBe(1);

    const deps = makeDeps({ questions: AMBIGUOUS });
    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('done');
    expect(deps.createPullRequest).toHaveBeenCalledTimes(2);
  });

  test('a blocking question still pauses after the ambiguity rounds are used up', async () => {
    await runJob(
      config(),
      mockWorkItem(),
      store,
      makeDeps({ questions: { blocking: [], ambiguities: [{ question: 'Format?' }] } }),
    );

    const result = await runJob(config(), mockWorkItem(), store, makeDeps({ questions: OPEN_PLAN }));

    expect(result.phase).toBe('awaiting-answers');
    expect(store.get(42)?.clarifyRounds).toBe(2);
  });
});

describe('shouldPauseForAnswers', () => {
  const amb: PlanQuestions = { blocking: [], ambiguities: [{ question: 'Format?' }] };
  const cfg = (maxClarifyRounds: number, maxAmbiguityRounds: number) =>
    config({ maxClarifyRounds, maxAmbiguityRounds });

  test('a clean plan never pauses', () => {
    expect(shouldPauseForAnswers(cfg(3, 1), CLEAN_PLAN, 0)).toBe(false);
  });

  test('blocking questions pause up to MAX_CLARIFY_ROUNDS', () => {
    expect(shouldPauseForAnswers(cfg(3, 1), OPEN_PLAN, 2)).toBe(true);
    expect(shouldPauseForAnswers(cfg(3, 1), OPEN_PLAN, 3)).toBe(false);
  });

  test('ambiguities alone pause up to MAX_AMBIGUITY_ROUNDS', () => {
    expect(shouldPauseForAnswers(cfg(3, 1), amb, 0)).toBe(true);
    expect(shouldPauseForAnswers(cfg(3, 1), amb, 1)).toBe(false);
    expect(shouldPauseForAnswers(cfg(3, 2), amb, 1)).toBe(true);
  });

  test('the ambiguity cap never exceeds MAX_CLARIFY_ROUNDS', () => {
    expect(shouldPauseForAnswers(cfg(1, 5), amb, 1)).toBe(false);
  });

  test('zero ambiguity rounds never pauses for ambiguities', () => {
    expect(shouldPauseForAnswers(cfg(3, 0), amb, 0)).toBe(false);
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
          // A complete plan; without it planning itself now fails, before verify.
          writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify(TASK_LIST), 'utf-8');
          writeFileSync(join(planDir, 'artifacts.json'), '{}', 'utf-8');
        } else if (!prompt.includes('Build and test the changes')) {
          writeImplementReport(options.cwd, DONE_REPORT);
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

describe('runJob — spend caps', () => {
  const budgets = (deps: PipelineDeps) =>
    (deps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (call) => (call[2] as { maxBudgetUsd?: number }).maxBudgetUsd,
    );

  test('records the spend of every agent run on the job', async () => {
    // The fake agent reports $0.50 per run: plan + implement + verify.
    await runJob(config({ skipBuildTest: false }), mockWorkItem(), store, makeDeps());
    expect(store.get(42)?.spentUsd).toBeCloseTo(1.5);
  });

  test('passes the per-run cap to the agent while the job has budget to spare', async () => {
    const deps = makeDeps();
    await runJob(
      config({ agentMaxBudgetUsd: 60, jobMaxBudgetUsd: 150 }),
      mockWorkItem(),
      store,
      deps,
    );
    expect(budgets(deps)[0]).toBe(60);
  });

  test('lowers the run cap to what is left of the job budget', async () => {
    store.update(42, { spentUsd: 140 });
    const deps = makeDeps();
    await runJob(
      config({ agentMaxBudgetUsd: 60, jobMaxBudgetUsd: 150 }),
      mockWorkItem(),
      store,
      deps,
    );
    expect(budgets(deps)[0]).toBeCloseTo(10);
  });

  test('an exhausted job budget fails before starting the agent', async () => {
    store.update(42, { spentUsd: 150 });
    const deps = makeDeps();

    const result = await runJob(config({ jobMaxBudgetUsd: 150 }), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('Job budget exhausted');
    expect(result.error).toContain('reset-budget 42');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  test('a run stopped at its cap fails with the cap in the message and still counts', async () => {
    const deps = makeDeps();
    deps.runAgent = mock(async () => ({
      text: '',
      success: false,
      subtype: 'error_max_budget_usd',
      costUsd: 61.2,
      numTurns: 20,
    }));

    const result = await runJob(config({ agentMaxBudgetUsd: 60 }), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('spend cap');
    expect(result.error).toContain('AGENT_MAX_BUDGET_USD');
    expect(store.get(42)?.spentUsd).toBeCloseTo(61.2);
    // Same rule as any failure: the worktrees stay so a retry can resume.
    expect(deps.removeAllWorktrees).not.toHaveBeenCalled();
  });

  test('spend accumulates across retries', async () => {
    await runJob(config(), mockWorkItem(), store, makeDeps({ failPhase: 'plan' }));
    await runJob(config(), mockWorkItem(), store, makeDeps());
    // Failed plan ($0) + plan + implement ($0.50 each); verify skipped.
    expect(store.get(42)?.spentUsd).toBeCloseTo(1);
  });

  test('records planning spend separately from the job total', async () => {
    await runJob(config(), mockWorkItem(), store, makeDeps());
    expect(store.get(42)?.planningSpentUsd).toBeCloseTo(0.5);
    expect(store.get(42)?.spentUsd).toBeCloseTo(1);
  });

  test('lowers a planning run cap to what is left of the planning budget', async () => {
    store.update(42, { spentUsd: 50, planningSpentUsd: 50 });
    const deps = makeDeps();
    await runJob(
      config({ agentMaxBudgetUsd: 60, jobMaxBudgetUsd: 150, planningMaxBudgetUsd: 60 }),
      mockWorkItem(),
      store,
      deps,
    );
    expect(budgets(deps)[0]).toBeCloseTo(10);
    // Implement is not held to the planning cap.
    expect(budgets(deps)[1]).toBeCloseTo(60);
  });

  test('an exhausted planning budget fails before starting the planner', async () => {
    store.update(42, { spentUsd: 60, planningSpentUsd: 60 });
    const deps = makeDeps();

    const result = await runJob(
      config({ jobMaxBudgetUsd: 150, planningMaxBudgetUsd: 60 }),
      mockWorkItem(),
      store,
      deps,
    );

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('Planning budget exhausted');
    expect(result.error).toContain('PLANNING_MAX_BUDGET_USD');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  test('implement does not start on less than its minimum, and the job stays resumable', async () => {
    // #83634: planning left $1.69 of $100, and implement built a third of the plan.
    // Here $30 of $150 is left, under the $40 default minimum.
    const deps = makeDeps();

    const result = await runProcessItemAtPhase('implementing', deps, {
      spentUsd: 120,
      lastSeenCommentId: 3,
    });

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('IMPLEMENT_MIN_BUDGET_USD');
    expect(result.error).toContain('reset-budget 42');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(store.get(42)?.failedAtPhase).toBe('implementing');
    expect(deps.removeAllWorktrees).not.toHaveBeenCalled();
  });
});

describe('runJob — implement completeness', () => {
  const PARTIAL: ImplementResult = { summary: 'partial', tasks: [{ id: 1, status: 'done' }] };
  const implementCalls = (deps: PipelineDeps) =>
    (deps.runAgent as ReturnType<typeof mock>).mock.calls.filter(
      (call) =>
        !String(call[1]).includes('bank-integration-planner') &&
        !String(call[1]).includes('Build and test the changes'),
    );
  const summaryPath = () => join(agentDirFor(TEST_ITEM_ID), 'implement', 'summary.json');

  test('resumes a session that stopped with tasks unfinished, then publishes', async () => {
    const deps = makeDeps({ implementReports: [PARTIAL, DONE_REPORT] });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('done');
    const calls = implementCalls(deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]![2].resumeSessionId).toBe('sess-abc');
    expect(String(calls[1]![1])).toContain('not\nmarked `done`');
    expect(String(calls[1]![1])).toContain(': 2.');
  });

  test('fails after two nudges, without verifying, publishing or a summary', async () => {
    const deps = makeDeps({ implementReports: [PARTIAL] });

    const result = await runJob(config({ skipBuildTest: false }), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('1 of 2 task(s) not done (2)');
    expect(implementCalls(deps)).toHaveLength(3);
    expect(deps.createPullRequest).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
    expect(store.get(42)?.failedAtPhase).toBe('implementing');
    // verify's entry check keys on summary.json, so a retry must land on implement.
    expect(require('fs').existsSync(summaryPath())).toBe(false);
  });

  test('a run that writes no report at all is unfinished', async () => {
    const deps = makeDeps({ implementReports: [null] });
    const result = await runJob(config(), mockWorkItem(), store, deps);
    expect(result.phase).toBe('failed');
    expect(result.error).toContain('2 of 2 task(s) not done');
  });

  test('a blocked task fails at once with its reason, without nudging', async () => {
    const deps = makeDeps({
      implementReports: [
        {
          tasks: [
            { id: 1, status: 'done' },
            { id: 2, status: 'blocked', note: 'enum value already taken' },
          ],
        },
      ],
    });

    const result = await runJob(config(), mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(result.error).toContain('2 (enum value already taken)');
    expect(implementCalls(deps)).toHaveLength(1);
    expect(deps.createPullRequest).not.toHaveBeenCalled();
  });

  test('a task list without tasks fails before the agent runs', async () => {
    const deps = makeDeps();
    seedArtifactsFor('implementing', TEST_ITEM_ID);
    writeFileSync(
      join(agentDirFor(TEST_ITEM_ID), 'plan', 'tasklist.json'),
      JSON.stringify({ waves: [] }),
      'utf-8',
    );
    store.update(TEST_ITEM_ID, { phase: 'implementing', lastSeenCommentId: 3 });

    const result = await runJob(config(), mockWorkItem(), store, deps);
    expect(result.phase).toBe('failed');
    expect(result.error).toContain('has no tasks');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  test('the PR description comes from the report summary', async () => {
    const deps = makeDeps({ implementText: 'Done. Wrote the report.' });
    await runJob(config(), mockWorkItem(), store, deps);
    const prCall = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]!;
    expect(String(prCall[2].description)).toContain('- continia-banking: Acme codeunits');
    expect(String(prCall[2].description)).not.toContain('Wrote the report');
  });
});

describe('runJob — watermark bump on the failure comment', () => {
  test('a marker-stripped failure comment does not force a re-plan on retry', async () => {
    // First run fails at implement and posts the failure comment. The id the
    // mock hands back is distinctive so the second half of this test cannot
    // pass by coincidentally matching some other default.
    const failingDeps = makeDeps({ failPhase: 'implement' });
    failingDeps.addWorkItemComment = mock(() => Promise.resolve({ id: 77, text: '' }));

    await runJob(config(), mockWorkItem(), store, failingDeps);
    expect(store.get(TEST_ITEM_ID)?.phase).toBe('failed');
    expect(store.get(TEST_ITEM_ID)?.failedAtPhase).toBe('implementing');

    // Simulate Azure DevOps' HTML sanitiser stripping BOT_COMMENT_MARKER:
    // the retry's fetch sees the same comment id back, but nothing in its
    // text lets isBotComment recognise it as our own.
    const retryDeps = makeDeps();
    retryDeps.getWorkItemComments = mock(async () => [
      { id: 77, text: 'Bank integration run failed' },
    ]);

    await runJob(config(), mockWorkItem(), store, retryDeps);

    // Resumed at 'implementing' (no fresh plan-*.log) — only possible
    // because the watermark bump, not the now-absent marker, kept this
    // comment from looking like new human input.
    const logFiles = (retryDeps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (c) => (c[2] as { logFile?: string } | undefined)?.logFile ?? '',
    );
    expect(logFiles.some((f) => f.includes('plan-'))).toBe(false);
  });

  test('the bump never moves the watermark backwards', async () => {
    const deps = makeDeps({ failPhase: 'implement' });
    // A lower id than the job already has — should never happen for a real
    // ADO comment id, but the bump must not trust that and must take the max.
    deps.addWorkItemComment = mock(() => Promise.resolve({ id: 5, text: '' }));

    await runProcessItemAtPhase('implementing', deps, {
      lastSeenCommentId: 50,
      plannerSessionId: 'sess-abc',
    });

    expect(store.get(TEST_ITEM_ID)?.lastSeenCommentId).toBe(50);
  });

  test('a genuine human comment newer than the bumped watermark still forces a re-plan', async () => {
    const failingDeps = makeDeps({ failPhase: 'implement' });
    failingDeps.addWorkItemComment = mock(() => Promise.resolve({ id: 77, text: '' }));

    await runJob(config(), mockWorkItem(), store, failingDeps);

    // The retry's fetch includes both the marker-stripped failure comment
    // (id 77, matching the bump) and a genuinely newer human comment (id 80)
    // that arrived after the failure — that one must still force a re-plan.
    const retryDeps = makeDeps();
    retryDeps.getWorkItemComments = mock(async () => [
      { id: 77, text: 'Bank integration run failed' },
      { id: 80, text: 'actually, use OAuth2 client credentials' },
    ]);

    await runJob(config(), mockWorkItem(), store, retryDeps);

    const logFiles = (retryDeps.runAgent as ReturnType<typeof mock>).mock.calls.map(
      (c) => (c[2] as { logFile?: string } | undefined)?.logFile ?? '',
    );
    expect(logFiles.some((f) => f.includes('plan-'))).toBe(true);
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

  test('links every PR to the work item, not just mentions it', async () => {
    const deps = makeDeps();
    await runProcessItemAtPhase('publishing', deps);

    const calls = (deps.linkPullRequestToWorkItem as ReturnType<typeof mock>).mock.calls;
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      [42, 'vstfs:///Git/PullRequestId/proj%2Fbanking%2F1'],
      [42, 'vstfs:///Git/PullRequestId/proj%2FsetupFiles%2F1'],
    ]);
  });

  test('a link failure does not fail a job whose PRs exist', async () => {
    const deps = makeDeps();
    deps.linkPullRequestToWorkItem = mock(async () => {
      throw new Error('patch exploded');
    });
    const result = await runProcessItemAtPhase('publishing', deps);
    expect(result.phase).toBe('done');
    expect(deps.createPullRequest).toHaveBeenCalledTimes(2);
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
      implementResultPath: join(agentDir, 'implement', 'result.json'),
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

  test('quotes the last nudge of a planning round, not its first run', () => {
    const cfg = config();
    const deps = makeDeps();
    const present = new Set(['plan-1.log', 'plan-1-nudge-1.log', 'plan-1-nudge-2.log']);
    (deps as { tailLog: unknown }).tailLog = (path: string) =>
      present.has(path.split(/[\\/]/).pop()!) ? 'content' : '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toEndWith('plan-1-nudge-2.log');
  });

  test('quotes the last implement nudge, not the first implement run', () => {
    const cfg = config();
    const deps = makeDeps();
    const present = new Set(['plan-1.log', 'implement.log', 'implement-nudge-1.log']);
    (deps as { tailLog: unknown }).tailLog = (path: string) =>
      present.has(path.split(/[\\/]/).pop()!) ? 'content' : '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toEndWith('implement-nudge-1.log');
  });

  test('finds the planning round that runs after the last clarify round', () => {
    const cfg = config({ maxClarifyRounds: 3 });
    const deps = makeDeps();
    const present = new Set(['plan-3.log', 'plan-4.log']);
    (deps as { tailLog: unknown }).tailLog = (path: string) =>
      present.has(path.split(/[\\/]/).pop()!) ? 'content' : '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toEndWith('plan-4.log');
  });

  test('falls back to the first planning log when nothing ran', () => {
    const cfg = config();
    const deps = makeDeps();
    (deps as { tailLog: unknown }).tailLog = () => '(no log)';

    expect(failedPhaseLog(cfg, 42, deps)).toContain('plan-1');
  });
});

describe('experiment hooks', () => {
  test('runPlanningPhase forwards agentOverrides to runAgent', async () => {
    const deps = makeDeps({ questions: CLEAN_PLAN });
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    const ctx: PhaseContext = {
      config: cfg,
      item: mockWorkItem(),
      job: store.ensure(TEST_ITEM_ID),
      store,
      deps,
      branch: 'b',
      worktrees,
      paths: pathsFor(worktrees.banking),
      comments: [],
      workItemContext: 'context',
      agentOverrides: { model: 'm', effort: 'low', subagentModel: 's', mcp: false },
    };

    await runPlanningPhase(ctx);

    const options = (deps.runAgent as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(options).toMatchObject({ model: 'm', effort: 'low', subagentModel: 's', mcp: false });
  });

  test('prepareWorkspaces passes pinned refs to createWorktree', async () => {
    const deps = makeDeps();
    await prepareWorkspaces(config(), mockWorkItem(), 'b', deps, {
      banking: 'aaa111',
      setupFiles: 'bbb222',
    });
    const calls = (deps.createWorktree as ReturnType<typeof mock>).mock.calls;
    expect(calls[0]![4]).toBe('aaa111');
    expect(calls[1]![4]).toBe('bbb222');
  });

  test('prepareWorkspaces leaves the ref unset in production', async () => {
    const deps = makeDeps();
    await prepareWorkspaces(config(), mockWorkItem(), 'b', deps);
    const calls = (deps.createWorktree as ReturnType<typeof mock>).mock.calls;
    expect(calls[0]![4]).toBeUndefined();
  });
});


describe('planning artifact guards', () => {
  async function planningCtx(fake: FakeOptions, clarifyRounds = 0): Promise<PhaseContext> {
    const deps = makeDeps(fake);
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    store.update(TEST_ITEM_ID, { clarifyRounds });
    return {
      config: cfg,
      item: mockWorkItem(),
      job: store.ensure(TEST_ITEM_ID),
      store,
      deps,
      branch: 'b',
      worktrees,
      paths: pathsFor(worktrees.banking),
      comments: [],
      workItemContext: 'context',
    };
  }

  test('fails when the planner wrote no questions.json', async () => {
    const ctx = await planningCtx({ omitPlanFiles: ['questions.json'] });
    await expect(runPlanningPhase(ctx)).rejects.toThrow('wrote no questions.json');
  });

  test('fails when a follow-up round leaves only an earlier questions.json', async () => {
    const ctx = await planningCtx({ omitPlanFiles: ['questions.json'] }, 1);
    mkdirSync(join(ctx.worktrees.banking, '.agent', 'plan'), { recursive: true });
    writeFileSync(ctx.paths.questionsPath, JSON.stringify(OPEN_PLAN), 'utf-8');
    await expect(runPlanningPhase(ctx)).rejects.toThrow('wrote no questions.json');
  });

  test('fails when a plan with no blocking questions has no task list', async () => {
    const ctx = await planningCtx({ questions: CLEAN_PLAN, omitPlanFiles: ['tasklist.json'] });
    await expect(runPlanningPhase(ctx)).rejects.toThrow('no task list');
  });

  test('accepts a Phase 1 gate: blocking questions and no plan yet', async () => {
    const ctx = await planningCtx({
      questions: OPEN_PLAN,
      omitPlanFiles: ['tasklist.json', 'design-doc.md'],
    });
    const questions = await runPlanningPhase(ctx);
    expect(questions.blocking).toHaveLength(1);
  });
});

describe('follow-up rounds', () => {
  async function roundCtx(clarifyRounds: number, existingDesignDoc: boolean) {
    const deps = makeDeps({ questions: CLEAN_PLAN });
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    const paths = pathsFor(worktrees.banking);
    mkdirSync(join(worktrees.banking, '.agent', 'plan'), { recursive: true });
    writeFileSync(paths.questionsPath, JSON.stringify(OPEN_PLAN), 'utf-8');
    if (existingDesignDoc) writeFileSync(paths.designDocPath, '# Earlier plan', 'utf-8');
    store.update(TEST_ITEM_ID, { clarifyRounds });
    const ctx: PhaseContext = {
      config: cfg,
      item: mockWorkItem(),
      job: store.ensure(TEST_ITEM_ID),
      store,
      deps,
      branch: 'b',
      worktrees,
      paths,
      comments: [],
      workItemContext: 'context',
    };
    await runPlanningPhase(ctx);
    return String((deps.runAgent as ReturnType<typeof mock>).mock.calls[0]![1]);
  }

  test('revises the existing plan when a design doc is already there', async () => {
    const prompt = await roundCtx(1, true);
    expect(prompt).toContain('revision mode');
    expect(prompt).not.toContain('run it to completion');
    expect(prompt).toContain('"revisionMode"');
  });

  test('plans in full when the previous round stopped at the Phase 1 gate', async () => {
    const prompt = await roundCtx(1, false);
    expect(prompt).toContain('run it to completion');
    expect(prompt).toContain('This is a follow-up round');
    expect(prompt).not.toContain('revision mode');
  });

  test('plans in full on the first round even if a stale design doc exists', async () => {
    const prompt = await roundCtx(0, true);
    expect(prompt).toContain('run it to completion');
    expect(prompt).not.toContain('revision mode');
  });
});

describe('planning with the AL language server', () => {
  async function planPrompt(cfgOverrides: Partial<AppConfig>, lsp?: boolean): Promise<string> {
    const deps = makeDeps({ questions: CLEAN_PLAN });
    const cfg = config(cfgOverrides);
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    const ctx: PhaseContext = {
      config: cfg,
      item: mockWorkItem(),
      job: store.ensure(TEST_ITEM_ID),
      store,
      deps,
      branch: 'b',
      worktrees,
      paths: pathsFor(worktrees.banking),
      comments: [],
      workItemContext: 'context',
      ...(lsp === undefined ? {} : { agentOverrides: { lsp } }),
    };
    await runPlanningPhase(ctx);
    return String((deps.runAgent as ReturnType<typeof mock>).mock.calls[0]![1]);
  }

  test('tells the planner, and every subagent it dispatches, how to use LSP', async () => {
    const prompt = await planPrompt({ alLspPluginDir: '/opt/al-lsp' });
    expect(prompt).toContain('## AL language server');
    expect(prompt).toContain('Pass this section on to every subagent');
    expect(prompt).toContain('goToImplementation');
    expect(prompt).toContain('interface member');
  });

  test('makes the orchestrator warm the server up before any grep or dispatch', async () => {
    const prompt = await planPrompt({ alLspPluginDir: '/opt/al-lsp' });
    expect(prompt).toContain('Before your first Grep, Bash search or subagent dispatch');
    expect(prompt).toContain('until it returns results');
    // documentSymbol is what loads the project; workspaceSymbol alone never warms it.
    expect(prompt.indexOf('documentSymbol` on')).toBeGreaterThan(-1);
    expect(prompt.indexOf('documentSymbol` on')).toBeLessThan(prompt.indexOf('Then `workspaceSymbol`'));
  });

  test('says nothing about LSP when it is not configured', async () => {
    expect(await planPrompt({})).not.toContain('AL language server');
  });

  test('says nothing about LSP when the run opts out', async () => {
    expect(await planPrompt({ alLspPluginDir: '/opt/al-lsp' }, false)).not.toContain('AL language server');
  });
});

describe('planning that stops before its output phase', () => {
  /** A planner that ends its session early `stopsFor` times, then finishes when nudged. */
  function stoppingDeps(stopsFor: number) {
    const deps = makeDeps({ questions: CLEAN_PLAN });
    let calls = 0;
    (deps as { runAgent: unknown }).runAgent = mock(
      (_cfg: unknown, _prompt: string, options: { cwd: string; resumeSessionId?: string }) => {
        calls += 1;
        if (calls > stopsFor) {
          const planDir = join(options.cwd, '.agent', 'plan');
          mkdirSync(planDir, { recursive: true });
          writeFileSync(join(planDir, 'questions.json'), JSON.stringify(CLEAN_PLAN), 'utf-8');
          writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify({ waves: [] }), 'utf-8');
          writeFileSync(join(planDir, 'artifacts.json'), '{}', 'utf-8');
        }
        // Like the SDK: a resumed session reports its cumulative cost.
        const cumulative = calls * 2;
        const baseline = (options as { costBaselineUsd?: number }).costBaselineUsd ?? 0;
        return Promise.resolve({ text: 'Writing the test plan now.', success: true, costUsd: cumulative - baseline, numTurns: 5, sessionId: 'sess-1' });
      },
    );
    return deps;
  }

  async function ctxFor(deps: PipelineDeps): Promise<PhaseContext> {
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    return {
      config: cfg,
      item: mockWorkItem(),
      job: store.ensure(TEST_ITEM_ID),
      store,
      deps,
      branch: 'b',
      worktrees,
      paths: pathsFor(worktrees.banking),
      comments: [],
      workItemContext: 'context',
    };
  }

  test('resumes the same session with a nudge and accepts the finished plan', async () => {
    const deps = stoppingDeps(1);
    await runPlanningPhase(await ctxFor(deps));
    const calls = (deps.runAgent as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![2].resumeSessionId).toBe('sess-1');
    expect(calls[1]![2].costBaselineUsd).toBe(2);
    expect(String(calls[1]![1])).toContain('You stopped before finishing');
    // Both runs count against the job's budget.
    expect(store.get(TEST_ITEM_ID)!.spentUsd).toBe(4);
  });

  test('gives up after two nudges', async () => {
    const deps = stoppingDeps(99);
    await expect(runPlanningPhase(await ctxFor(deps))).rejects.toThrow('wrote no questions.json');
    expect((deps.runAgent as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
  });

  test('does not nudge a run that already wrote its artifacts', async () => {
    const deps = stoppingDeps(0);
    await runPlanningPhase(await ctxFor(deps));
    expect((deps.runAgent as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});

describe('planning artifacts on follow-up rounds', () => {
  test('fails when the planner wrote no artifacts.json', async () => {
    const deps = makeDeps({ questions: CLEAN_PLAN, omitPlanFiles: ['artifacts.json'] });
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    const ctx: PhaseContext = {
      config: cfg, item: mockWorkItem(), job: store.ensure(TEST_ITEM_ID), store, deps, branch: 'b',
      worktrees, paths: pathsFor(worktrees.banking), comments: [], workItemContext: 'context',
    };
    await expect(runPlanningPhase(ctx)).rejects.toThrow('wrote no artifacts.json');
  });

  test('a revision round cannot pass on the previous round\'s task list and artifacts', async () => {
    // The planner answers the questions but never patches the plan.
    const deps = makeDeps({ questions: CLEAN_PLAN, omitPlanFiles: ['artifacts.json', 'tasklist.json', 'design-doc.md'] });
    const cfg = config();
    const worktrees = await prepareWorkspaces(cfg, mockWorkItem(), 'b', deps);
    const paths = pathsFor(worktrees.banking);
    mkdirSync(join(worktrees.banking, '.agent', 'plan'), { recursive: true });
    writeFileSync(paths.designDocPath, '# Round 1 plan', 'utf-8');
    writeFileSync(paths.taskListPath, JSON.stringify({ waves: [] }), 'utf-8');
    writeFileSync(paths.artifactsPath, '{}', 'utf-8');
    writeFileSync(paths.questionsPath, JSON.stringify(OPEN_PLAN), 'utf-8');
    store.update(TEST_ITEM_ID, { clarifyRounds: 1 });
    const ctx: PhaseContext = {
      config: cfg, item: mockWorkItem(), job: store.ensure(TEST_ITEM_ID), store, deps, branch: 'b',
      worktrees, paths, comments: [], workItemContext: 'context',
    };
    await expect(runPlanningPhase(ctx)).rejects.toThrow('wrote no artifacts.json');
  });
});
