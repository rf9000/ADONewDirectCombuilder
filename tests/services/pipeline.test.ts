import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { StateStore } from '../../src/state/state-store.ts';
import {
  runJob,
  slugify,
  branchNameFor,
  buildPrDescription,
  buildSuccessComment,
  failedPhaseLog,
  prTitle,
  type PipelineDeps,
} from '../../src/services/pipeline.ts';
import type {
  AppConfig,
  PlanQuestions,
  PullRequestRef,
  VerifyResult,
} from '../../src/types/index.ts';

let root: string;
let store: StateStore;

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
  rmSync(root, { recursive: true, force: true });
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
      return JSON.parse(fs.readFileSync(path, 'utf-8'));
    },
    tailLog: () => '(log)',
  } as unknown as PipelineDeps;
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

  test('reports a failed agent run, tags the item, and cleans up', async () => {
    const deps = makeDeps({ failPhase: 'implement' });
    const cfg = config();

    const result = await runJob(cfg, mockWorkItem(), store, deps);

    expect(result.phase).toBe('failed');
    expect(store.get(42)?.phase).toBe('failed');
    expect(store.get(42)?.error).toContain('implementing');

    const swap = (deps.swapWorkItemTags as ReturnType<typeof mock>).mock.calls.at(-1)!;
    expect(swap[3]).toEqual([cfg.failedTag]);
    expect(deps.removeAllWorktrees).toHaveBeenCalled();
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
