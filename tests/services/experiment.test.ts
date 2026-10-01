import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { defaultDeps, type PipelineDeps } from '../../src/services/pipeline.ts';
import {
  authEnv,
  experimentDeps,
  formatRunId,
  runExperiment,
  type ExperimentDeps,
} from '../../src/services/experiment.ts';
import type { AgentRunResult, AppConfig } from '../../src/types/index.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'experiment-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const COST: Record<string, number> = { 'claude-opus-5-5': 50, 'claude-sonnet-5-5': 10 };

function config(): AppConfig {
  return mockConfig({
    worktreeRoot: join(root, 'worktrees'),
    repoCacheDir: join(root, 'repos'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    skipBuildTest: true,
  });
}

function writeVariants(extra: Record<string, unknown> = {}): string {
  const path = join(root, 'variants.json');
  writeFileSync(
    path,
    JSON.stringify({
      phase: 'planning',
      baseline: 'opus',
      judgeModel: 'claude-sonnet-5-5',
      maxUsd: 100,
      variants: [
        { name: 'opus', model: 'claude-opus-5-5', effort: 'high' },
        { name: 'sonnet', model: 'claude-sonnet-5-5', subagentModel: 'claude-haiku-4-5-20251001' },
      ],
      ...extra,
    }),
  );
  return path;
}

interface Fake {
  rateLimitOn?: string;
  noPlanDirFor?: string;
  /** Model whose planner stops at the Phase 1 gate: blocking questions, no plan. */
  gateFor?: string;
  worktreeFailsOnFirstCall?: boolean;
  judgeWritesNothing?: boolean;
  revisionMode?: string;
}

function deps(fake: Fake = {}): ExperimentDeps & {
  runAgent: ReturnType<typeof mock>;
  createWorktree: ReturnType<typeof mock>;
} {
  let worktreeCalls = 0;
  const createWorktree = mock((cfg: AppConfig, repo: { key: string }) => {
    worktreeCalls += 1;
    if (fake.worktreeFailsOnFirstCall && worktreeCalls === 1) {
      return Promise.reject(new Error('git worktree add failed'));
    }
    const path = join(cfg.worktreeRoot, '42', repo.key);
    mkdirSync(path, { recursive: true });
    return Promise.resolve(path);
  });

  const runAgent = mock((_cfg: AppConfig, prompt: string, options: any): Promise<AgentRunResult> => {
    const model = options.model as string;
    const cost = COST[model] ?? 1;
    const base = {
      text: 'done',
      success: true,
      costUsd: cost,
      numTurns: 5,
      durationMs: 60_000,
      modelUsage: {
        [model]: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost },
      },
    };

    if (prompt.includes('You are reviewing two independent plans')) {
      if (!fake.judgeWritesNothing) {
        const scores = { coverage: 4, correctness: 4, patternFit: 4, taskActionability: 4, questionQuality: 4 };
        writeFileSync(
          join(options.cwd, 'judge.json'),
          JSON.stringify({
            A: { scores, gapSeverity: 'none', gaps: [] },
            B: { scores, gapSeverity: 'none', gaps: [] },
            better: 'equivalent',
            summary: 'same',
          }),
        );
      }
      return Promise.resolve({ ...base, costUsd: 0.5 });
    }

    if (fake.rateLimitOn === model) {
      return Promise.resolve({
        ...base,
        success: false,
        subtype: 'error_during_execution',
        rateLimit: { status: 'rejected' as const, type: 'five_hour', resetsAt: 1700000000 },
      });
    }

    if (fake.gateFor === model) {
      const planDir = join(options.cwd, '.agent', 'plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'questions.json'), JSON.stringify({ blocking: [{ question: 'Where is the signing URL?' }], ambiguities: [] }));
      return Promise.resolve(base);
    }

    if (fake.noPlanDirFor !== model) {
      const planDir = join(options.cwd, '.agent', 'plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'questions.json'), JSON.stringify({ blocking: [], ambiguities: [{ question: 'q' }] }));
      writeFileSync(join(planDir, 'design-doc.md'), '# plan');
      writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify({ tasks: [1, 2, 3] }));
      writeFileSync(join(planDir, 'artifacts.json'), JSON.stringify(fake.revisionMode ? { revisionMode: fake.revisionMode } : {}));
      // Planner scratch that only some runs leave behind.
      mkdirSync(join(planDir, 'fragments'), { recursive: true });
      writeFileSync(join(planDir, 'fragments', 'auth.md'), 'scratch');
    }
    return Promise.resolve(base);
  });

  const pipeline: PipelineDeps = {
    ...defaultDeps,
    createWorktree: createWorktree as never,
    wireSkills: mock(() => undefined),
    addGitExcludes: mock(() => undefined),
    setGitIdentity: mock(async () => undefined),
    runAgent: runAgent as never,
  };

  return {
    pipeline,
    freeze: {
      getWorkItem: async () => mockWorkItem(),
      getWorkItemComments: async () => [],
      resolveRemoteSha: async (_c, repo) => (repo.key === 'banking' ? 'sha-bank' : 'sha-setup'),
      fetchDoc: async () => '{}',
    },
    random: () => 0.1,
    now: () => new Date('2026-09-30T10:15:00Z'),
    runAgent,
    createWorktree,
  };
}

function opts(extra: Record<string, unknown> = {}) {
  return {
    workItemId: 42,
    // Only write the default file when the test did not: both use one path,
    // and writing it here would overwrite the test's own variant set.
    variantsFile: (extra.variantsFile as string | undefined) ?? writeVariants(),
    auth: 'subscription' as const,
    experimentsDir: join(root, 'experiments'),
    ...extra,
  };
}

describe('helpers', () => {
  test('formatRunId is UTC and sortable', () => {
    expect(formatRunId(new Date('2026-09-30T10:15:07Z'))).toBe('20260930-101507');
  });

  const GIT_LOCKDOWN = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  const fullEnv = {
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    AZURE_DEVOPS_PAT: 'pat',
    ADO_MCP_PAT_B64: 'b64',
    CLAUDE_CODE_SUBAGENT_MODEL: 'leaked',
    PATH: '/bin',
  };

  test('authEnv strips Anthropic credentials for subscription, plus ADO and git credentials', () => {
    expect(authEnv('subscription', fullEnv)).toEqual({ PATH: '/bin', ...GIT_LOCKDOWN });
  });

  test('authEnv keeps the API key for api-key auth but still strips ADO and git credentials', () => {
    expect(authEnv('api-key', fullEnv)).toEqual({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin', ...GIT_LOCKDOWN });
  });

  test('experimentDeps turns every ADO and git write into a throw', () => {
    const d = experimentDeps(defaultDeps);
    for (const name of [
      'addWorkItemComment',
      'swapWorkItemTags',
      'createPullRequest',
      'uploadAttachment',
      'linkAttachmentToWorkItem',
      'commitAndPush',
      'removeAllWorktrees',
    ] as const) {
      expect(() => (d[name] as () => unknown)()).toThrow(`experiment must not call ${name}`);
    }
  });
});

describe('runExperiment', () => {
  test('runs every variant on the frozen SHAs and writes the report', async () => {
    const d = deps();
    const r = await runExperiment(config(), opts(), d);

    expect(r.variants.map((v) => [v.variant, v.status, v.costUsd, v.taskCount])).toEqual([
      ['opus', 'ok', 50, 3],
      ['sonnet', 'ok', 10, 3],
    ]);
    const refs = d.createWorktree.mock.calls.map((c) => c[4]);
    expect(refs).toEqual(['sha-bank', 'sha-setup', 'sha-bank', 'sha-setup']);

    const planCalls = d.runAgent.mock.calls.filter((c) => String(c[1]).includes('bank-integration-planner'));
    // Prompts differ only in worktree paths; both carry the same frozen context.
    for (const call of planCalls) expect(String(call[1])).toContain('Add Acme Bank communication');
    expect(planCalls[1]![2]).toMatchObject({
      model: 'claude-sonnet-5-5',
      subagentModel: 'claude-haiku-4-5-20251001',
      mcp: false,
    });
    expect(planCalls[1]![2].env.ANTHROPIC_API_KEY).toBeUndefined();

    const runDir = join(root, 'experiments', 'runs', '42', '20260930-101500');
    expect(existsSync(join(runDir, 'input.json'))).toBe(true);
    expect(existsSync(join(runDir, 'opus', 'plan', 'design-doc.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, 'sonnet', 'usage.json'), 'utf-8')).status).toBe('ok');
    expect(readFileSync(join(runDir, 'report.md'), 'utf-8')).toContain('# Planning experiment — work item #42');
    expect(JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf-8')).totalUsd).toBe(60.5);
  });

  test('judges non-baseline variants blind and maps the verdict back', async () => {
    const d = deps();
    const r = await runExperiment(config(), opts(), d);
    expect(r.judges).toHaveLength(1);
    expect(r.judges[0]).toMatchObject({ variant: 'sonnet', verdict: 'equivalent', costUsd: 0.5 });

    const judgeCall = d.runAgent.mock.calls.find((c) => String(c[1]).includes('You are reviewing'))!;
    expect(judgeCall[2]).toMatchObject({ model: 'claude-sonnet-5-5', allowedTools: ['Read', 'Glob', 'Grep', 'Write'] });
    const kept = join(root, 'experiments', 'runs', '42', '20260930-101500', 'judge', 'sonnet');
    expect(existsSync(join(kept, 'A', 'design-doc.md'))).toBe(true);
    expect(existsSync(join(kept, 'B', 'design-doc.md'))).toBe(true);
    expect(existsSync(join(kept, 'work-item.md'))).toBe(true);
    expect(existsSync(join(kept, 'judge.json'))).toBe(true);
  });

  test('gives the judge only the plan contract files, not planner scratch', async () => {
    await runExperiment(config(), opts(), deps());
    const kept = join(root, 'experiments', 'runs', '42', '20260930-101500', 'judge', 'sonnet');
    for (const side of ['A', 'B']) {
      expect(readdirSync(join(kept, side)).sort()).toEqual([
        'artifacts.json',
        'design-doc.md',
        'questions.json',
        'tasklist.json',
      ]);
    }
  });

  test('keeps variant names out of everything the judge can see', async () => {
    const d = deps();
    await runExperiment(config(), opts(), d);
    const runDir = join(root, 'experiments', 'runs', '42', '20260930-101500');

    for (const call of d.createWorktree.mock.calls) {
      expect(call[0].worktreeRoot).not.toMatch(/opus|sonnet/);
      expect(call[2]).not.toMatch(/opus|sonnet/);
    }
    const judgeCall = d.runAgent.mock.calls.find((c) => String(c[1]).includes('You are reviewing'))!;
    const judgeDir = judgeCall[2].cwd as string;
    expect(judgeDir).not.toMatch(/opus|sonnet/);
    expect(judgeDir.startsWith(runDir)).toBe(false);
    expect(judgeDir.startsWith(join(root, 'experiments'))).toBe(false);
  });

  test('records each variant worktree for inspection', async () => {
    const r = await runExperiment(config(), opts(), deps());
    expect(r.variants[0]!.worktreeRoot).toStartWith(join(root, 'worktrees', 'exp-20260930-101500-'));
    expect(r.variants[0]!.worktreeRoot).not.toBe(r.variants[1]!.worktreeRoot);
  });

  test('--only filters variants', async () => {
    const r = await runExperiment(config(), opts({ only: ['opus'] }), deps());
    expect(r.variants.map((v) => v.variant)).toEqual(['opus']);
  });

  test('skips the judge with a note when --only leaves out the baseline', async () => {
    const r = await runExperiment(config(), opts({ only: ['sonnet'] }), deps());
    expect(r.judges).toEqual([]);
    expect(r.notes).toContain("Judge skipped: baseline 'opus' did not run successfully.");
  });

  test('passes the remaining experiment budget down to later variants', async () => {
    const d = deps();
    await runExperiment(config(), opts(), d);
    const planCalls = d.runAgent.mock.calls.filter((c) => String(c[1]).includes('bank-integration-planner'));
    expect(planCalls[0]![2].maxBudgetUsd).toBe(60); // min(AGENT_MAX_BUDGET_USD 60, 100 left)
    expect(planCalls[1]![2].maxBudgetUsd).toBe(50); // 100 - 50 spent
  });

  test('stops the sweep on a rate-limit rejection and skips the judge', async () => {
    const r = await runExperiment(
      config(),
      opts({
        variantsFile: writeVariants({
          variants: [
            { name: 'opus', model: 'claude-opus-5-5' },
            { name: 'sonnet', model: 'claude-sonnet-5-5' },
            { name: 'third', model: 'claude-opus-5-5' },
          ],
        }),
      }),
      deps({ rateLimitOn: 'claude-sonnet-5-5' }),
    );
    expect(r.variants.map((v) => v.status)).toEqual(['ok', 'rate-limited']);
    expect(r.stoppedReason).toContain("rate limit five_hour rejected during 'sonnet'");
    expect(r.judges).toEqual([]);
  });

  test('records a variant that fails before any agent call and continues', async () => {
    const r = await runExperiment(config(), opts(), deps({ worktreeFailsOnFirstCall: true }));
    expect(r.variants[0]).toMatchObject({ variant: 'opus', status: 'failed', costUsd: 0, error: 'git worktree add failed' });
    expect(r.variants[1]!.status).toBe('ok');
  });

  test('marks a planner that left no plan as incomplete and does not judge it', async () => {
    const r = await runExperiment(config(), opts(), deps({ noPlanDirFor: 'claude-sonnet-5-5' }));
    const sonnet = r.variants.find((v) => v.variant === 'sonnet')!;
    expect(sonnet).toMatchObject({ status: 'incomplete', designDoc: false, costUsd: 10 });
    expect(r.judges).toEqual([]);
  });

  test('records a judge that writes nothing', async () => {
    const r = await runExperiment(config(), opts(), deps({ judgeWritesNothing: true }));
    expect(r.judges[0]).toMatchObject({ variant: 'sonnet', error: 'judge wrote no judge.json' });
  });

  test('measures each variant by wall clock, not by the last result', async () => {
    const d = deps();
    let t = Date.parse('2026-09-30T10:15:00Z');
    d.now = () => new Date((t += 90_000));
    const r = await runExperiment(config(), opts({ only: ['opus'] }), d);
    expect(r.variants[0]!.durationMs).toBe(90_000);
  });

  test('--resume reuses the frozen input and skips variants that already succeeded', async () => {
    const first = deps({ worktreeFailsOnFirstCall: true });
    const r1 = await runExperiment(config(), opts(), first);
    expect(r1.variants.map((v) => v.status)).toEqual(['failed', 'ok']);

    const d = deps();
    let froze = 0;
    d.freeze.getWorkItem = async () => {
      froze += 1;
      return mockWorkItem();
    };
    const r = await runExperiment(config(), opts({ resumeRunId: r1.runId }), d);

    expect(froze).toBe(0);
    expect(r.runId).toBe(r1.runId);
    expect(r.variants.map((v) => [v.variant, v.status])).toEqual([
      ['opus', 'ok'],
      ['sonnet', 'ok'],
    ]);
    const planCalls = d.runAgent.mock.calls.filter((c) => String(c[1]).includes('bank-integration-planner'));
    expect(planCalls.map((c) => c[2].model)).toEqual(['claude-opus-5-5']);
    expect(r.judges.map((j) => j.variant)).toEqual(['sonnet']);
    // 10 (reused sonnet) + 50 (opus now) + 0.5 (judge)
    expect(r.totalUsd).toBe(60.5);
  });

  test('--resume keeps a judge verdict that already succeeded', async () => {
    const r1 = await runExperiment(config(), opts(), deps());
    const d = deps();
    const r = await runExperiment(config(), opts({ resumeRunId: r1.runId }), d);
    expect(d.runAgent.mock.calls).toHaveLength(0);
    expect(r.judges[0]).toMatchObject({ variant: 'sonnet', verdict: 'equivalent' });
    expect(r.totalUsd).toBe(60.5);
  });

  test('--resume of an unknown run fails with the path it looked for', async () => {
    await expect(runExperiment(config(), opts({ resumeRunId: 'nope' }), deps())).rejects.toThrow(
      'no input.json',
    );
  });

  test('--from-plan starts revise variants from the earlier plan in revision mode', async () => {
    const earlier = join(root, 'earlier-plan');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'design-doc.md'), '# Earlier plan');
    writeFileSync(join(earlier, 'tasklist.json'), JSON.stringify({ tasks: [1] }));
    writeFileSync(join(earlier, 'questions.json'), JSON.stringify({ blocking: [{ question: 'Sandbox?' }], ambiguities: [] }));
    writeFileSync(join(root, 'answers.md'), 'Use the sandbox.');

    const d = deps();
    const r = await runExperiment(
      config(),
      opts({
        only: ['opus'],
        answersFile: join(root, 'answers.md'),
        fromPlan: earlier,
        variantsFile: writeVariants({ variants: [{ name: 'opus', model: 'claude-opus-5-5', revise: true }] }),
      }),
      d,
    );

    const prompt = String(d.runAgent.mock.calls[0]![1]);
    expect(prompt).toContain('revision mode');
    expect(prompt).toContain('Sandbox?');
    expect(prompt).toContain('Use the sandbox.');
    const input = JSON.parse(readFileSync(join(root, 'experiments', 'runs', '42', r.runId, 'input.json'), 'utf-8'));
    expect(input.fromPlan).toBe(earlier);
  });

  test('records the revision mode the planner reported', async () => {
    const earlier = join(root, 'earlier-plan');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'design-doc.md'), '# Earlier plan');
    writeFileSync(join(earlier, 'questions.json'), JSON.stringify({ blocking: [], ambiguities: [] }));
    const d = deps({ revisionMode: 'incremental' });
    const r = await runExperiment(
      config(),
      opts({
        only: ['opus'],
        fromPlan: earlier,
        variantsFile: writeVariants({ variants: [{ name: 'opus', model: 'claude-opus-5-5', revise: true }] }),
      }),
      d,
    );
    expect(r.variants[0]!.revisionMode).toBe('incremental');
  });

  test('--from-plan re-plans other variants in full on the same questions and answers', async () => {
    const earlier = join(root, 'earlier-plan');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'design-doc.md'), '# Earlier plan');
    writeFileSync(join(earlier, 'questions.json'), JSON.stringify({ blocking: [{ question: 'Sandbox?' }], ambiguities: [] }));
    writeFileSync(join(root, 'answers.md'), 'Use the sandbox.');
    const d = deps();
    await runExperiment(
      config(),
      opts({
        answersFile: join(root, 'answers.md'),
        fromPlan: earlier,
        variantsFile: writeVariants({
          baseline: 'full',
          variants: [
            { name: 'full', model: 'claude-opus-5-5' },
            { name: 'revise', model: 'claude-opus-5-5', revise: true },
          ],
        }),
      }),
      d,
    );
    const plans = d.runAgent.mock.calls.filter((c) => String(c[1]).includes('bank-integration-planner'));
    expect(String(plans[0]![1])).toContain('run it to completion');
    expect(String(plans[0]![1])).toContain('Sandbox?');
    expect(String(plans[0]![1])).toContain('Use the sandbox.');
    expect(String(plans[1]![1])).toContain('revision mode');
  });

  test('a revise variant without --from-plan is refused before anything runs', async () => {
    const d = deps();
    await expect(
      runExperiment(
        config(),
        opts({ variantsFile: writeVariants({ variants: [{ name: 'opus', revise: true }] }) }),
        d,
      ),
    ).rejects.toThrow('needs --from-plan');
    expect(d.runAgent.mock.calls).toHaveLength(0);
  });

  test('turns the AL language server on only for variants that ask for it', async () => {
    const d = deps();
    await runExperiment(
      config(),
      opts({
        variantsFile: writeVariants({
          variants: [
            { name: 'opus', model: 'claude-opus-5-5' },
            { name: 'sonnet', model: 'claude-opus-5-5', lsp: true },
          ],
        }),
      }),
      d,
    );
    const plans = d.runAgent.mock.calls.filter((c) => String(c[1]).includes('bank-integration-planner'));
    expect(plans[0]![2].lsp).toBe(false);
    expect(plans[1]![2].lsp).toBe(true);
  });

  test('marks a variant that stopped at the Phase 1 gate as gated and does not judge it', async () => {
    const d = deps({ gateFor: 'claude-sonnet-5-5' });
    const r = await runExperiment(config(), opts(), d);
    expect(r.variants.find((v) => v.variant === 'sonnet')).toMatchObject({ status: 'gated', blocking: 1, designDoc: false });
    expect(r.judges).toEqual([]);
    expect(d.runAgent.mock.calls.some((c) => String(c[1]).includes('You are reviewing'))).toBe(false);
  });

  test('--resume reruns a variant that was gated', async () => {
    const r1 = await runExperiment(config(), opts(), deps({ gateFor: 'claude-sonnet-5-5' }));
    const d = deps();
    const r = await runExperiment(config(), opts({ resumeRunId: r1.runId }), d);
    expect(r.variants.find((v) => v.variant === 'sonnet')!.status).toBe('ok');
    expect(r.judges.map((j) => j.variant)).toEqual(['sonnet']);
  });

  test('answers and previous questions make it a follow-up round', async () => {
    writeFileSync(join(root, 'answers.md'), 'Use the sandbox.');
    writeFileSync(join(root, 'questions.json'), JSON.stringify({ blocking: [{ question: 'Sandbox?' }], ambiguities: [] }));
    const d = deps();
    await runExperiment(
      config(),
      opts({ only: ['opus'], answersFile: join(root, 'answers.md'), questionsFile: join(root, 'questions.json') }),
      d,
    );
    const prompt = String(d.runAgent.mock.calls[0]![1]);
    expect(prompt).toContain('Use the sandbox.');
    expect(prompt).toContain('This is a follow-up round');
    expect(prompt).toContain('Sandbox?');
  });
});
