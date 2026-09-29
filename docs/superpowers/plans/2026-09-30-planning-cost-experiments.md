# Planning Cost Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `bun run experiment plan <workItemId>` command that runs the real planning phase under several model / effort / subagent-model variants on frozen input, captures per-model token and USD cost, has an LLM judge compare each plan with the baseline, and writes a report.

**Architecture:** `runAgent` gains per-run overrides and returns per-model usage. `runPhaseAgent` forwards an optional `agentOverrides` from `PhaseContext`. A new experiment layer (input freeze → per-variant `runPlanningPhase` in its own worktrees → blind A/B judge → report) reuses the production pipeline functions and replaces every ADO/git write dependency with a stub that throws.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), Zod, `@anthropic-ai/claude-agent-sdk` 0.3.222, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-30-planning-cost-experiments-design.md` — lean v1. Everything the spec marks **(later)** is out of scope: `--repeat`, `--resume`, `--force`, preflight query, sleep-and-retry on rate limits.

## Global Constraints

- Production behaviour does not change, except one per-model usage log line per agent run.
- Production keeps its own `ANTHROPIC_API_KEY`. `loadConfig` accepts a missing key only when a caller passes `{ requireApiKey: false }`, and only the `experiment` command does.
- `experiment` defaults to `--auth subscription`: `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child environment.
- USD figures are the SDK's computed cost. The report labels them "API-equivalent USD".
- `modelUsage` and `total_cost_usd` are cumulative per query. Take them from the **last** `result` message. Never sum across results.
- Experiment runs never call `addWorkItemComment`, `swapWorkItemTags`, `createPullRequest`, `uploadAttachment`, `linkAttachmentToWorkItem` or `commitAndPush`. The experiment deps replace them with stubs that throw.
- Experiment agent runs load no MCP servers (`mcp: false`). This repo's `.mcp.json` holds an ADO PAT, and a planner or judge with the ADO MCP server could write to the real work item. This is a deliberate difference from production; the report states it.
- Experiment worktrees live under `<WORKTREE_ROOT>/exp-<runId>-<variant>/`, never inside this repo.
- `experiments/runs/` is gitignored. It holds work-item text and transcripts.
- Variant names match `/^[a-z0-9][a-z0-9-]*$/i`. They are used in paths and branch names.
- The judge sees plans only as `A/` and `B/`, never variant names.
- Any rate-limit rejection marks the variant `rate-limited`, stops the sweep, skips the judge and writes a partial report.
- Commit subjects follow repo style: plain imperative sentence, no `feat:` prefix.
- Run tests with `bun test --preload ./tests/setup.ts <file>`; full suite `bun test`; types `bun run typecheck`.

## Review Focus

- `--only` that leaves out the baseline: variants still run; the report says the judge was skipped because the baseline did not run. Pinned in Task 7.
- An API doc link that times out or returns 500: recorded in `input.json` with its error, left out of the local-docs section, and the sweep continues. Pinned in Task 4.
- The judge writes no `judge.json`, or invalid JSON: that variant's judge entry carries an `error`, the report shows "judge failed", nothing crashes. Pinned in Task 5 and Task 7.
- A variant fails before any agent call (for example `createWorktree` throws): status `failed` with the error, cost 0, and the next variant still runs. Pinned in Task 7.
- The planner run succeeds but leaves no `plan/` directory: the copy step skips it, `usage.json` is still written with `designDoc: false`. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types/index.ts` (modify) | `EffortLevel`, `AuthMode`, `AgentOverrides`, `ModelUsageSummary`, `RateLimitInfo`; optional new fields on `AgentRunResult` |
| `src/services/agent-runner.ts` (modify) | Overrides into `query()`, usage/rate-limit/error capture, per-model log line, injectable `query` |
| `src/services/workspace.ts` (modify) | Optional `ref` on `createWorktree`; new `revParse` |
| `src/services/pipeline.ts` (modify) | `agentOverrides` on `PhaseContext`; export `prepareWorkspaces` (with optional refs) and `pathsFor` |
| `src/config/index.ts` (modify) | `loadConfig(env, { requireApiKey })` |
| `src/config/experiment.ts` (create) | Variant-set schema, loading, selection, Haiku warning |
| `src/services/experiment-input.ts` (create) | Freeze work item, comments, answers, docs, SHAs into `input.json` |
| `src/services/experiment-judge.ts` (create) | Judge prompt, blind A/B order, parse and map the judge output |
| `src/services/experiment-report.ts` (create) | Result types, status classification, task counting, cheapest-good-enough, `report.md` rendering |
| `src/services/experiment.ts` (create) | Orchestration: variants, write stubs, auth env, budget, judge loop, output files |
| `src/cli/experiment-args.ts` (create) | Parse `experiment plan …` arguments |
| `src/cli/index.ts` (modify) | `experiment` command and help |
| `package.json`, `.gitignore` (modify) | `experiment` script; ignore `experiments/runs/` |
| `experiments/README.md`, `experiments/variants/planning-baseline.json`, `experiments/findings/TEMPLATE.md` (create) | Folder docs, starter variants, findings template |
| `CLAUDE.md`, `README.md` (modify) | Document the command and folder |

---

### Task 1: Runner overrides and usage capture

**Files:**
- Modify: `src/types/index.ts` (add types; extend `AgentRunResult`)
- Modify: `src/services/agent-runner.ts`
- Test: `tests/services/agent-runner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
  - `type AuthMode = 'subscription' | 'api-key'`
  - `interface ModelUsageSummary { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }`
  - `interface RateLimitInfo { status: 'allowed' | 'allowed_warning' | 'rejected'; type?: string; resetsAt?: number }`
  - `interface AgentOverrides { model?: string; effort?: EffortLevel; subagentModel?: string; env?: Record<string, string | undefined>; mcp?: boolean }`
  - `AgentRunResult` gains optional `modelUsage?: Record<string, ModelUsageSummary>`, `durationMs?: number`, `rateLimit?: RateLimitInfo`, `assistantError?: string`
  - `AgentRunOptions` gains `model?`, `effort?`, `subagentModel?`, `env?`, `mcp?` (all as in `AgentOverrides`) and `allowedTools?: string[]`
  - `runAgent(config, prompt, options, queryFn: typeof query = query): Promise<AgentRunResult>`
  - `buildChildEnv(options: Pick<AgentRunOptions, 'env' | 'subagentModel'>): Record<string, string | undefined> | undefined`
  - `formatTokens(n: number): string`, `formatModelUsage(usage: Record<string, ModelUsageSummary>): string[]`

- [ ] **Step 1: Add the types**

In `src/types/index.ts`, directly above `/** Outcome of one agent SDK run. */`, add:

```ts
/** Reasoning effort accepted by the Agent SDK. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How a local experiment authenticates the Claude Code child process. */
export type AuthMode = 'subscription' | 'api-key';

/** Tokens and cost one model spent during an agent run. */
export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Last plan rate-limit state the SDK reported (subscription auth only). */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: string;
  resetsAt?: number;
}

/**
 * Per-run changes to how an agent runs. Production never sets these; the
 * experiment command uses them to try cheaper configurations.
 */
export interface AgentOverrides {
  model?: string;
  effort?: EffortLevel;
  /** Model for subagents the agent dispatches, via CLAUDE_CODE_SUBAGENT_MODEL. */
  subagentModel?: string;
  /** Base environment for the Claude Code child process. */
  env?: Record<string, string | undefined>;
  /** False loads no MCP servers. Defaults to true. */
  mcp?: boolean;
}
```

Then in `AgentRunResult`, after `numTurns: number;`, add:

```ts
  /** Per-model usage from the last result message — cumulative, never summed. */
  modelUsage?: Record<string, ModelUsageSummary>;
  durationMs?: number;
  /** Last rate-limit event, or the first rejection if one happened. */
  rateLimit?: RateLimitInfo;
  /** Last assistant-message error the SDK reported, e.g. 'rate_limit'. */
  assistantError?: string;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/services/agent-runner.test.ts` (add `buildChildEnv`, `formatModelUsage`, `formatTokens`, `runAgent` to the existing import from `../../src/services/agent-runner.ts`, and add `import { mockConfig } from '../helpers.ts';` at the top):

```ts
describe('buildChildEnv', () => {
  test('returns undefined when nothing overrides the environment', () => {
    expect(buildChildEnv({})).toBeUndefined();
  });

  test('adds CLAUDE_CODE_SUBAGENT_MODEL on top of the given env', () => {
    const env = buildChildEnv({ env: { PATH: '/bin' }, subagentModel: 'claude-haiku-4-5-20251001' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' });
  });

  test('spreads process.env when only the subagent model is set', () => {
    const env = buildChildEnv({ subagentModel: 'm' });
    expect(env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('m');
    expect(env?.PATH).toBe(process.env.PATH);
  });
});

describe('formatModelUsage', () => {
  test('prints one line per model with compact token counts', () => {
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(40_100)).toBe('40k');
    expect(formatTokens(512)).toBe('512');
    expect(
      formatModelUsage({
        'claude-sonnet-5-5': {
          inputTokens: 1_200_000,
          outputTokens: 40_000,
          cacheReadTokens: 900_000,
          cacheWriteTokens: 80_000,
          costUsd: 3.1,
        },
      }),
    ).toEqual([
      'claude-sonnet-5-5: 1.2M in / 40k out / 900k cache-read / 80k cache-write — $3.10',
    ]);
  });
});

describe('runAgent with an injected query', () => {
  function usage(cost: number) {
    return {
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: cost,
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      },
    };
  }

  function result(total: number) {
    return {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 's1',
      total_cost_usd: total,
      num_turns: 3,
      duration_ms: 1234,
      usage: { input_tokens: 100, output_tokens: 10 },
      modelUsage: usage(total),
    };
  }

  function fakeQuery(messages: unknown[], seen: { params?: any }) {
    return ((params: unknown) => {
      seen.params = params;
      return (async function* () {
        for (const m of messages) yield m;
      })();
    }) as never;
  }

  test('passes model, effort, env, allowedTools and skips MCP when asked', async () => {
    const seen: { params?: any } = {};
    await runAgent(
      mockConfig(),
      'hi',
      {
        cwd: dir,
        logFile: join(dir, 'run.log'),
        model: 'claude-sonnet-5-5',
        effort: 'low',
        subagentModel: 'claude-haiku-4-5-20251001',
        env: { PATH: '/bin' },
        allowedTools: ['Read'],
        mcp: false,
      },
      fakeQuery([result(1)], seen),
    );
    const options = seen.params.options;
    expect(options.model).toBe('claude-sonnet-5-5');
    expect(options.effort).toBe('low');
    expect(options.env).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' });
    expect(options.allowedTools).toEqual(['Read']);
    expect(options.mcpServers).toBeUndefined();
  });

  test('leaves model, effort and env at production defaults without overrides', async () => {
    const seen: { params?: any } = {};
    const config = mockConfig();
    await runAgent(config, 'hi', { cwd: dir, logFile: join(dir, 'run.log') }, fakeQuery([result(1)], seen));
    const options = seen.params.options;
    expect(options.model).toBe(config.claudeModel);
    expect(options.effort).toBeUndefined();
    expect(options.env).toBeUndefined();
  });

  test('takes modelUsage from the last result instead of summing', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      fakeQuery([result(1), result(3)], {}),
    );
    expect(res.costUsd).toBe(3);
    expect(res.durationMs).toBe(1234);
    expect(res.modelUsage).toEqual({
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        costUsd: 3,
      },
    });
  });

  test('keeps a rate-limit rejection and the assistant error', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      fakeQuery(
        [
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1700000000 } },
          { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
          { type: 'assistant', error: 'rate_limit', message: { content: [] } },
          { ...result(0.5), subtype: 'error_during_execution' },
        ],
        {},
      ),
    );
    expect(res.success).toBe(false);
    expect(res.rateLimit).toEqual({ status: 'rejected', type: 'five_hour', resetsAt: 1700000000 });
    expect(res.assistantError).toBe('rate_limit');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/agent-runner.test.ts`
Expected: FAIL — `buildChildEnv`, `formatTokens`, `formatModelUsage` are not exported; `runAgent` ignores the fourth argument.

- [ ] **Step 4: Implement**

In `src/services/agent-runner.ts`:

1. Change the type import to:

```ts
import type {
  AgentOverrides,
  AgentRunResult,
  AppConfig,
  ModelUsageSummary,
  RateLimitInfo,
} from '../types/index.ts';
```

2. Make `AgentRunOptions` extend the overrides and add `allowedTools`:

```ts
export interface AgentRunOptions extends AgentOverrides {
```

and inside it, after `appendSystemPrompt`:

```ts
  /** Replaces the default tool allowlist (the experiment judge runs read-only). */
  allowedTools?: string[];
```

3. Add after `withMcpTools`:

```ts
/**
 * Environment for the Claude Code child process, or undefined to let the SDK
 * inherit ours. The SDK's `env` option replaces the environment rather than
 * merging, so an override must carry everything else along with it.
 */
export function buildChildEnv(
  options: Pick<AgentRunOptions, 'env' | 'subagentModel'>,
): Record<string, string | undefined> | undefined {
  if (!options.env && !options.subagentModel) return undefined;
  const env = { ...(options.env ?? process.env) };
  if (options.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = options.subagentModel;
  return env;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** One line per model, so a log shows where a run's money went. */
export function formatModelUsage(usage: Record<string, ModelUsageSummary>): string[] {
  return Object.entries(usage).map(
    ([model, u]) =>
      `${model}: ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out / ` +
      `${formatTokens(u.cacheReadTokens)} cache-read / ${formatTokens(u.cacheWriteTokens)} cache-write — ` +
      `$${u.costUsd.toFixed(2)}`,
  );
}
```

4. Change the `runAgent` signature to:

```ts
export async function runAgent(
  config: AppConfig,
  prompt: string,
  options: AgentRunOptions,
  queryFn: typeof query = query,
): Promise<AgentRunResult> {
```

5. Replace the two lines that load MCP servers and tools with:

```ts
  // A caller that restricts tools (the experiment judge) or opts out gets no
  // MCP servers: this repo's .mcp.json carries an ADO PAT.
  const useMcp = options.mcp !== false && options.allowedTools === undefined;
  const mcpServers = useMcp ? loadMcpServers(options.cwd) : {};
  const allowedTools = withMcpTools(options.allowedTools ?? ALLOWED_TOOLS, mcpServers);
  const env = buildChildEnv(options);
```

6. After `let numTurns = 0;` add:

```ts
  let modelUsage: Record<string, ModelUsageSummary> | undefined;
  let durationMs: number | undefined;
  let rateLimit: RateLimitInfo | undefined;
  let assistantError: string | undefined;
```

7. Change `for await (const message of query({` to `for await (const message of queryFn({`, and inside `options: {` replace `model: config.claudeModel,` with:

```ts
        model: options.model ?? config.claudeModel,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(env ? { env } : {}),
```

8. Inside the loop, directly after the `session_id` block, add:

```ts
      // Keep the first rejection: a later 'allowed' event must not hide that
      // the run was cut off by a plan limit.
      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info;
        if (rateLimit?.status !== 'rejected') {
          rateLimit = { status: info.status, type: info.rateLimitType, resetsAt: info.resetsAt };
        }
      }
```

and at the start of the existing `if (message.type === 'assistant') {` block add:

```ts
        if (message.error) assistantError = message.error;
```

9. In the `result` block, after `subtype = message.subtype;`, add:

```ts
        durationMs = message.duration_ms;
        // Cumulative like total_cost_usd, so the last result wins.
        modelUsage = Object.fromEntries(
          Object.entries(message.modelUsage ?? {}).map(([model, u]) => [
            model,
            {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadInputTokens,
              cacheWriteTokens: u.cacheCreationInputTokens,
              costUsd: u.costUSD,
            },
          ]),
        );
```

10. In the `finally` block, before `write(\`===== run ended`, add:

```ts
    for (const line of formatModelUsage(modelUsage ?? {})) {
      log(`  ${line}`);
      write(`[usage] ${line}`);
    }
```

11. Change the return to:

```ts
  return {
    text: text.trim(),
    sessionId,
    success,
    subtype,
    costUsd,
    numTurns,
    modelUsage,
    durationMs,
    rateLimit,
    assistantError,
  };
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/agent-runner.test.ts && bun run typecheck`
Expected: PASS, no type errors. If `message.error` or `message.modelUsage` do not narrow, check the SDK types at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`SDKAssistantMessage.error`, `SDKResultSuccess.modelUsage`) rather than casting blindly.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/services/agent-runner.ts tests/services/agent-runner.test.ts
git commit -m "Let agent runs override model, effort and subagent model and report per-model usage"
```

---

### Task 2: Forward overrides through the pipeline and pin worktrees to a ref

**Files:**
- Modify: `src/services/workspace.ts:174-200` (`createWorktree`), add `revParse`
- Modify: `src/services/pipeline.ts` (`PhaseContext`, `runPhaseAgent`, `prepareWorkspaces`, `pathsFor`)
- Test: `tests/services/pipeline.test.ts`, `tests/services/workspace.test.ts`

**Interfaces:**
- Consumes: `AgentOverrides` (Task 1).
- Produces:
  - `createWorktree(config, repo, branch, itemId, ref?: string): Promise<string>`. The default ref is `refs/remotes/origin/${repo.defaultBranch}`
  - `revParse(config: AppConfig, cwd: string, ref: string): Promise<string>` — trimmed SHA
  - `PhaseContext.agentOverrides?: AgentOverrides`
  - `export async function prepareWorkspaces(config, item, branch, deps, refs?: { banking?: string; setupFiles?: string }): Promise<{ banking: string; setupFiles: string }>`
  - `export function pathsFor(bankingWorktree: string): prompts.PhasePaths`

- [ ] **Step 1: Write the failing tests**

In `tests/services/pipeline.test.ts`, add `runPlanningPhase`, `prepareWorkspaces`, `pathsFor` to the import from `../../src/services/pipeline.ts`, then append:

```ts
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
```

In `tests/services/workspace.test.ts`, add `revParse` to its workspace import and append (reuse that file's temp-dir and `mockConfig` setup if present; otherwise this block is self-contained):

```ts
describe('revParse', () => {
  test('returns the commit a ref points at', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'revparse-'));
    try {
      const { spawnSync } = await import('child_process');
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: repo, encoding: 'utf-8' }).stdout.trim();
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
      const expected = git('rev-parse', 'HEAD');

      expect(await revParse(mockConfig(), repo, 'HEAD')).toBe(expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

(Add `mkdtempSync`, `rmSync`, `join`, `tmpdir`, `mockConfig` imports if the file lacks them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/pipeline.test.ts tests/services/workspace.test.ts`
Expected: FAIL — `prepareWorkspaces`, `pathsFor`, `revParse` not exported; `agentOverrides` not on `PhaseContext`.

- [ ] **Step 3: Implement workspace changes**

In `src/services/workspace.ts`, change `createWorktree`:

```ts
export async function createWorktree(
  config: AppConfig,
  repo: RepoTarget,
  branch: string,
  itemId: number,
  /** Commit or ref to start from; experiments pin this to a frozen SHA. */
  ref: string = `refs/remotes/origin/${repo.defaultBranch}`,
): Promise<string> {
```

and in its `git worktree add` args replace `` `refs/remotes/origin/${repo.defaultBranch}`, `` with `ref,`.

Add after `worktreePath`:

```ts
/** The commit `ref` points at, from inside `cwd` (a worktree or the bare cache). */
export async function revParse(config: AppConfig, cwd: string, ref: string): Promise<string> {
  const result = await git(config, ['rev-parse', ref], { cwd });
  return result.stdout.trim();
}
```

- [ ] **Step 4: Implement pipeline changes**

In `src/services/pipeline.ts`:

1. Add `AgentOverrides` to the type import from `../types/index.ts`.
2. Change `function pathsFor(` to `export function pathsFor(`.
3. Change `prepareWorkspaces` to be exported and accept refs:

```ts
export async function prepareWorkspaces(
  config: AppConfig,
  item: WorkItemResponse,
  branch: string,
  deps: PipelineDeps,
  refs: { banking?: string; setupFiles?: string } = {},
): Promise<{ banking: string; setupFiles: string }> {
  const banking = await deps.createWorktree(
    config,
    config.repos.banking,
    branch,
    item.id,
    refs.banking,
  );
  const setupFiles = await deps.createWorktree(
    config,
    config.repos.setupFiles,
    branch,
    item.id,
    refs.setupFiles,
  );
```

(rest of the function unchanged).

4. In `interface PhaseContext`, after `workItemContext: string;`, add:

```ts
  /** Experiment-only model/effort/env changes; production leaves this unset. */
  agentOverrides?: AgentOverrides;
```

5. In `runPhaseAgent`, change the `deps.runAgent` call to:

```ts
  const result = await deps.runAgent(config, prompt, {
    cwd: ctx.worktrees.banking,
    additionalDirectories: [ctx.worktrees.setupFiles],
    logFile,
    maxBudgetUsd: budgetUsd,
    ...ctx.agentOverrides,
  });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/pipeline.test.ts tests/services/workspace.test.ts && bun run typecheck`
Expected: PASS. The existing `makeDeps().createWorktree` mock ignores the extra argument, so earlier pipeline tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/workspace.ts src/services/pipeline.ts tests/services/pipeline.test.ts tests/services/workspace.test.ts
git commit -m "Forward agent overrides through phases and allow pinning worktrees to a ref"
```

---

### Task 3: Optional API key and the variant-set schema

**Files:**
- Modify: `src/config/index.ts`
- Create: `src/config/experiment.ts`
- Test: `tests/config/config.test.ts`, `tests/config/experiment.test.ts`

**Interfaces:**
- Consumes: `EffortLevel` (Task 1).
- Produces:
  - `loadConfig(env?, options?: { requireApiKey?: boolean }): AppConfig` — `requireApiKey` defaults to `true`
  - `type Variant = { name: string; model?: string; effort?: EffortLevel; subagentModel?: string }`
  - `type VariantSet = { phase: 'planning'; baseline: string; judgeModel: string; maxUsd: number; variants: Variant[] }`
  - `parseVariantSet(raw: unknown): { set: VariantSet; warnings: string[] }`
  - `loadVariantSet(path: string): { set: VariantSet; warnings: string[] }`
  - `selectVariants(set: VariantSet, only?: string[]): Variant[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/config/config.test.ts` inside `describe("loadConfig", …)`:

```ts
  it("accepts a missing ANTHROPIC_API_KEY when the caller opts out", () => {
    const env = { ...validEnv };
    delete env.ANTHROPIC_API_KEY;
    expect(() => loadConfig(env, { requireApiKey: false })).not.toThrow();
  });
```

Create `tests/config/experiment.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { parseVariantSet, selectVariants } from '../../src/config/experiment.ts';

const valid = {
  phase: 'planning',
  baseline: 'opus-high',
  judgeModel: 'claude-sonnet-5-5',
  maxUsd: 200,
  variants: [
    { name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' },
    { name: 'opus-haiku-subs', model: 'claude-opus-5-5', effort: 'high', subagentModel: 'claude-haiku-4-5-20251001' },
    { name: 'haiku', model: 'claude-haiku-4-5-20251001' },
  ],
};

describe('parseVariantSet', () => {
  test('accepts the starter set without warnings', () => {
    const { set, warnings } = parseVariantSet(valid);
    expect(set.variants).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  test('rejects a baseline that is not a variant', () => {
    expect(() => parseVariantSet({ ...valid, baseline: 'nope' })).toThrow("baseline 'nope'");
  });

  test('rejects duplicate variant names', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [...valid.variants, { name: 'haiku' }] }),
    ).toThrow("duplicate variant name 'haiku'");
  });

  test('rejects a variant name unsafe for paths', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [...valid.variants, { name: 'a/b' }] }),
    ).toThrow('letters, digits and hyphens');
  });

  test('rejects an unknown effort level', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [{ name: 'opus-high', effort: 'extreme' }] }),
    ).toThrow('Invalid variant file');
  });

  test('warns when effort is set on a Haiku model', () => {
    const { warnings } = parseVariantSet({
      ...valid,
      variants: [...valid.variants, { name: 'haiku-high', model: 'claude-haiku-4-5-20251001', effort: 'high' }],
    });
    expect(warnings).toEqual([
      "variant 'haiku-high': Haiku models do not support effort — 'high' will be ignored by the SDK",
    ]);
  });
});

describe('selectVariants', () => {
  const { set } = parseVariantSet(valid);

  test('returns every variant without a filter', () => {
    expect(selectVariants(set).map((v) => v.name)).toEqual(['opus-high', 'opus-haiku-subs', 'haiku']);
  });

  test('keeps file order for --only', () => {
    expect(selectVariants(set, ['haiku', 'opus-high']).map((v) => v.name)).toEqual(['opus-high', 'haiku']);
  });

  test('rejects an unknown --only name', () => {
    expect(() => selectVariants(set, ['nope'])).toThrow("unknown variant 'nope'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/config/`
Expected: FAIL — `loadConfig` rejects the missing key; `src/config/experiment.ts` does not exist.

- [ ] **Step 3: Implement `loadConfig` option**

In `src/config/index.ts`:

1. Replace the `ANTHROPIC_API_KEY` schema line with:

```ts
  // Required for the watcher; the local experiment command may run on the
  // developer's Claude login instead, so the check lives in loadConfig.
  ANTHROPIC_API_KEY: z.string().default(""),
```

2. Change the signature:

```ts
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireApiKey?: boolean } = {},
): AppConfig {
```

3. After `const parsed = result.data;`, add:

```ts
  if ((options.requireApiKey ?? true) && parsed.ANTHROPIC_API_KEY.trim() === "") {
    throw new Error(
      "Invalid configuration:\n  - ANTHROPIC_API_KEY: ANTHROPIC_API_KEY is required",
    );
  }
```

- [ ] **Step 4: Create `src/config/experiment.ts`**

```ts
import { readFileSync } from 'fs';
import { z } from 'zod';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const variantSchema = z.object({
  // Used in directory and branch names.
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'variant name must be letters, digits and hyphens'),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  subagentModel: z.string().min(1).optional(),
});

const variantSetSchema = z
  .object({
    phase: z.literal('planning'),
    baseline: z.string().min(1),
    judgeModel: z.string().min(1),
    maxUsd: z.number().positive(),
    variants: z.array(variantSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const names = set.variants.map((v) => v.name);
    if (!names.includes(set.baseline)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline'],
        message: `baseline '${set.baseline}' is not one of the variants`,
      });
    }
    const duplicate = names.find((name, i) => names.indexOf(name) !== i);
    if (duplicate) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: `duplicate variant name '${duplicate}'`,
      });
    }
  });

export type Variant = z.infer<typeof variantSchema>;
export type VariantSet = z.infer<typeof variantSetSchema>;

export function parseVariantSet(raw: unknown): { set: VariantSet; warnings: string[] } {
  const result = variantSetSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid variant file:\n${messages}`);
  }

  // Haiku 4.5 has no effort parameter and the SDK drops it silently, so a
  // report would otherwise imply an effect that never happened.
  const warnings = result.data.variants
    .filter((v) => v.effort !== undefined && /haiku/i.test(v.model ?? ''))
    .map(
      (v) =>
        `variant '${v.name}': Haiku models do not support effort — '${v.effort}' will be ignored by the SDK`,
    );

  return { set: result.data, warnings };
}

export function loadVariantSet(path: string): { set: VariantSet; warnings: string[] } {
  return parseVariantSet(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Variants to run, in file order; `only` filters by name. */
export function selectVariants(set: VariantSet, only?: string[]): Variant[] {
  if (!only || only.length === 0) return set.variants;
  const known = new Set(set.variants.map((v) => v.name));
  for (const name of only) {
    if (!known.has(name)) throw new Error(`unknown variant '${name}' in --only`);
  }
  return set.variants.filter((v) => only.includes(v.name));
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/config/ && bun run typecheck`
Expected: PASS, including the two existing `ANTHROPIC_API_KEY` tests.

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/config/experiment.ts tests/config/config.test.ts tests/config/experiment.test.ts
git commit -m "Add the experiment variant-set schema and an opt-out for the API key check"
```

---

### Task 4: Freeze experiment input

**Files:**
- Create: `src/services/experiment-input.ts`
- Test: `tests/services/experiment-input.test.ts`

**Interfaces:**
- Consumes: `prompts.buildWorkItemContext`, `prompts.field`, `prompts.escapeHtml`.
- Produces:
  - `const LOCAL_DOCS_DIR = '.agent/input-docs'` (relative to the banking worktree)
  - `interface FrozenDoc { url: string; file?: string; error?: string }`
  - `interface FrozenInput { workItemId: number; title: string; frozenAt: string; item: WorkItemResponse; comments: WorkItemComment[]; context: string; shas: { banking: string; setupFiles: string }; docs: FrozenDoc[]; previousQuestions?: PlanQuestions }`
  - `interface FreezeDeps { getWorkItem(config: AppConfig, id: number): Promise<WorkItemResponse>; getWorkItemComments(config: AppConfig, id: number): Promise<WorkItemComment[]>; resolveRemoteSha(config: AppConfig, repo: RepoTarget): Promise<string>; fetchDoc(url: string): Promise<string> }`
  - `extractDocLinks(html: string): string[]`
  - `answersComment(text: string, when: string): WorkItemComment`
  - `freezeInput(config, itemId, runDir, opts: { answersFile?: string; questionsFile?: string }, deps: FreezeDeps): Promise<FrozenInput>`
  - `fetchDocOverHttp(url: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/experiment-input.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import {
  answersComment,
  extractDocLinks,
  freezeInput,
  type FreezeDeps,
} from '../../src/services/experiment-input.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exp-input-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const SWAGGER = 'https://example.azurecontainerapps.io/swagger/v1/swagger.json';

function deps(overrides: Partial<FreezeDeps> = {}): FreezeDeps {
  return {
    getWorkItem: async () =>
      mockWorkItem({
        fields: {
          ...mockWorkItem().fields,
          'System.Description': `<div>Docs: ${SWAGGER}</div><div>Portal: https://ponto.com/en</div>`,
        },
      }),
    getWorkItemComments: async () => [{ id: 7, text: 'first comment' }],
    resolveRemoteSha: async (_cfg, repo) => (repo.key === 'banking' ? 'aaa111' : 'bbb222'),
    fetchDoc: async () => '{"openapi":"3.0.0"}',
    ...overrides,
  };
}

describe('extractDocLinks', () => {
  test('keeps API doc links and drops ordinary pages', () => {
    expect(
      extractDocLinks(
        `<a href="${SWAGGER}">x</a> see ${SWAGGER}. and https://ponto.com/en and https://x.io/api.yaml`,
      ),
    ).toEqual([SWAGGER, 'https://x.io/api.yaml']);
  });
});

describe('answersComment', () => {
  test('survives htmlToText with angle brackets and newlines intact', () => {
    const c = answersComment('Use <iban>\nas key', '2026-09-30T00:00:00Z');
    expect(c.text).toBe('Use &lt;iban&gt;<br>as key');
    expect(c.createdBy?.displayName).toBe('Local answers (experiment)');
  });
});

describe('freezeInput', () => {
  test('writes input.json with context, SHAs and the downloaded doc', async () => {
    const frozen = await freezeInput(mockConfig(), 42, dir, {}, deps());

    expect(frozen.shas).toEqual({ banking: 'aaa111', setupFiles: 'bbb222' });
    expect(frozen.docs).toEqual([{ url: SWAGGER, file: 'doc-1.json' }]);
    expect(readFileSync(join(dir, 'input', 'docs', 'doc-1.json'), 'utf-8')).toBe('{"openapi":"3.0.0"}');
    expect(frozen.context).toContain('first comment');
    expect(frozen.context).toContain(`- ${SWAGGER} → \`.agent/input-docs/doc-1.json\``);
    expect(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf-8')).shas.banking).toBe('aaa111');
  });

  test('records a failed download and leaves it out of the context', async () => {
    const frozen = await freezeInput(
      mockConfig(),
      42,
      dir,
      {},
      deps({ fetchDoc: async () => { throw new Error('timeout'); } }),
    );
    expect(frozen.docs).toEqual([{ url: SWAGGER, error: 'timeout' }]);
    expect(frozen.context).not.toContain('Local copies of linked API documentation');
    expect(existsSync(join(dir, 'input.json'))).toBe(true);
  });

  test('appends local answers as a comment and loads previous questions', async () => {
    writeFileSync(join(dir, 'answers.md'), 'Auth uses the Ponto sandbox.', 'utf-8');
    writeFileSync(
      join(dir, 'questions.json'),
      JSON.stringify({ blocking: [{ question: 'Sandbox?' }], ambiguities: [] }),
      'utf-8',
    );

    const frozen = await freezeInput(
      mockConfig(),
      42,
      dir,
      { answersFile: join(dir, 'answers.md'), questionsFile: join(dir, 'questions.json') },
      deps(),
    );

    expect(frozen.comments.at(-1)?.createdBy?.displayName).toBe('Local answers (experiment)');
    expect(frozen.context).toContain('Auth uses the Ponto sandbox.');
    expect(frozen.previousQuestions?.blocking[0]?.question).toBe('Sandbox?');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-input.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/services/experiment-input.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import type {
  AppConfig,
  PlanQuestions,
  RepoTarget,
  WorkItemComment,
  WorkItemResponse,
} from '../types/index.ts';
import * as prompts from './prompts.ts';

/** Where each variant's banking worktree gets the frozen API docs. */
export const LOCAL_DOCS_DIR = '.agent/input-docs';

/** Far above any real ADO comment id, so it always sorts as the newest. */
const ANSWERS_COMMENT_ID = 2_000_000_000;

/** The Ponto dev container app cold-starts in ~11 s; leave generous room. */
const DOC_TIMEOUT_MS = 60_000;

const DOC_LINK = /\.(json|ya?ml)(\?|#|$)|swagger|openapi/i;

export interface FrozenDoc {
  url: string;
  file?: string;
  error?: string;
}

/** Everything every variant must see identically. Written to input.json. */
export interface FrozenInput {
  workItemId: number;
  title: string;
  frozenAt: string;
  item: WorkItemResponse;
  comments: WorkItemComment[];
  context: string;
  shas: { banking: string; setupFiles: string };
  docs: FrozenDoc[];
  previousQuestions?: PlanQuestions;
}

export interface FreezeDeps {
  getWorkItem(config: AppConfig, id: number): Promise<WorkItemResponse>;
  getWorkItemComments(config: AppConfig, id: number): Promise<WorkItemComment[]>;
  resolveRemoteSha(config: AppConfig, repo: RepoTarget): Promise<string>;
  fetchDoc(url: string): Promise<string>;
}

/** Links in a description that look like machine-readable API docs. */
export function extractDocLinks(html: string): string[] {
  const urls = (html.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map((u) =>
    u.replace(/&amp;/g, '&').replace(/[).,;]+$/, ''),
  );
  return [...new Set(urls)].filter((u) => DOC_LINK.test(u));
}

/**
 * Local answers dressed as an ADO comment, so the planner reads them exactly
 * as it would read a human's reply. Escaped because buildWorkItemContext runs
 * comment text through htmlToText.
 */
export function answersComment(text: string, when: string): WorkItemComment {
  return {
    id: ANSWERS_COMMENT_ID,
    text: prompts.escapeHtml(text.trim()).replace(/\r?\n/g, '<br>'),
    createdBy: { displayName: 'Local answers (experiment)' },
    createdDate: when,
  };
}

function docsSection(docs: FrozenDoc[]): string {
  const saved = docs.filter((d) => d.file);
  if (saved.length === 0) return '';
  return [
    '',
    '',
    '## Local copies of linked API documentation',
    'These links were downloaded before this run. Read the local files (relative to your',
    'working directory) instead of fetching the URLs:',
    ...saved.map((d) => `- ${d.url} → \`${LOCAL_DOCS_DIR}/${d.file}\``),
  ].join('\n');
}

function docExtension(url: string): string {
  try {
    return extname(new URL(url).pathname) || '.json';
  } catch {
    return '.json';
  }
}

export async function fetchDocOverHttp(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function freezeInput(
  config: AppConfig,
  itemId: number,
  runDir: string,
  opts: { answersFile?: string; questionsFile?: string },
  deps: FreezeDeps,
): Promise<FrozenInput> {
  const item = await deps.getWorkItem(config, itemId);
  const comments = await deps.getWorkItemComments(config, itemId);
  const frozenAt = new Date().toISOString();

  if (opts.answersFile) {
    comments.push(answersComment(readFileSync(opts.answersFile, 'utf-8'), frozenAt));
  }

  const docsDir = join(runDir, 'input', 'docs');
  mkdirSync(docsDir, { recursive: true });
  const docs: FrozenDoc[] = [];
  const links = extractDocLinks(prompts.field(item, 'System.Description'));
  for (const [i, url] of links.entries()) {
    const file = `doc-${i + 1}${docExtension(url)}`;
    try {
      writeFileSync(join(docsDir, file), await deps.fetchDoc(url), 'utf-8');
      docs.push({ url, file });
    } catch (err) {
      docs.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const frozen: FrozenInput = {
    workItemId: itemId,
    title: prompts.field(item, 'System.Title'),
    frozenAt,
    item,
    comments,
    context: prompts.buildWorkItemContext(item, comments, config) + docsSection(docs),
    shas: {
      banking: await deps.resolveRemoteSha(config, config.repos.banking),
      setupFiles: await deps.resolveRemoteSha(config, config.repos.setupFiles),
    },
    docs,
    previousQuestions: opts.questionsFile
      ? (JSON.parse(readFileSync(opts.questionsFile, 'utf-8')) as PlanQuestions)
      : undefined,
  };

  writeFileSync(join(runDir, 'input.json'), JSON.stringify(frozen, null, 2), 'utf-8');
  return frozen;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-input.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/experiment-input.ts tests/services/experiment-input.test.ts
git commit -m "Freeze a work item, its comments, API docs and repo SHAs for experiments"
```

---

### Task 5: Blind A/B judge

**Files:**
- Create: `src/services/experiment-judge.ts`
- Test: `tests/services/experiment-judge.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `const JUDGE_OUTPUT = 'judge.json'`, `const JUDGE_TOOLS = ['Read', 'Glob', 'Grep', 'Write']`
  - `type JudgeVerdict = 'equivalent' | 'minor-gaps' | 'major-gaps' | 'better'`
  - `interface JudgeScores { coverage: number; correctness: number; patternFit: number; taskActionability: number; questionQuality: number }`
  - `interface JudgeResult { variant: string; costUsd: number; scores?: JudgeScores; verdict?: JudgeVerdict; gaps: Array<{ item: string; section?: string }>; summary?: string; error?: string }`
  - `buildJudgePrompt(): string`
  - `parseJudgeOutput(raw: unknown, variantIsA: boolean, variant: string, costUsd: number): JudgeResult`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/experiment-judge.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { buildJudgePrompt, parseJudgeOutput } from '../../src/services/experiment-judge.ts';

const scores = (n: number) => ({
  coverage: n,
  correctness: n,
  patternFit: n,
  taskActionability: n,
  questionQuality: n,
});

const raw = {
  A: { scores: scores(5), gapSeverity: 'none', gaps: [] },
  B: {
    scores: scores(3),
    gapSeverity: 'major',
    gaps: [{ item: 'No refresh-token rotation', section: 'Authentication' }],
  },
  better: 'A',
  summary: 'A covers token rotation; B does not.',
};

describe('parseJudgeOutput', () => {
  test('maps plan B back to the variant when the variant was B', () => {
    const r = parseJudgeOutput(raw, false, 'haiku', 0.4);
    expect(r).toEqual({
      variant: 'haiku',
      costUsd: 0.4,
      scores: scores(3),
      verdict: 'major-gaps',
      gaps: [{ item: 'No refresh-token rotation', section: 'Authentication' }],
      summary: 'A covers token rotation; B does not.',
    });
  });

  test('reports better when the variant was A and the judge preferred A', () => {
    expect(parseJudgeOutput(raw, true, 'sonnet-high', 0.4).verdict).toBe('better');
  });

  test('maps gap severity when the plans are equal', () => {
    const equal = {
      ...raw,
      better: 'equivalent',
      B: { scores: scores(4), gapSeverity: 'minor', gaps: [] },
    };
    expect(parseJudgeOutput(equal, false, 'v', 0).verdict).toBe('minor-gaps');
  });

  test('returns an error result for a missing file', () => {
    expect(parseJudgeOutput(undefined, true, 'v', 0.2)).toEqual({
      variant: 'v',
      costUsd: 0.2,
      gaps: [],
      error: 'judge wrote no judge.json',
    });
  });

  test('returns an error result for the wrong shape', () => {
    const r = parseJudgeOutput({ A: {}, better: 'maybe' }, true, 'v', 0);
    expect(r.error).toStartWith('judge.json has the wrong shape');
    expect(r.verdict).toBeUndefined();
  });
});

describe('buildJudgePrompt', () => {
  test('never mentions baselines or variants', () => {
    const prompt = buildJudgePrompt();
    expect(prompt).toContain('A/');
    expect(prompt).toContain('judge.json');
    expect(prompt.toLowerCase()).not.toContain('baseline');
    expect(prompt.toLowerCase()).not.toContain('variant');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-judge.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/services/experiment-judge.ts`:

```ts
import { z } from 'zod';

export const JUDGE_OUTPUT = 'judge.json';

/** Read-only apart from writing its own verdict file. */
export const JUDGE_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

export type JudgeVerdict = 'equivalent' | 'minor-gaps' | 'major-gaps' | 'better';

export interface JudgeScores {
  coverage: number;
  correctness: number;
  patternFit: number;
  taskActionability: number;
  questionQuality: number;
}

export interface JudgeResult {
  variant: string;
  costUsd: number;
  scores?: JudgeScores;
  verdict?: JudgeVerdict;
  gaps: Array<{ item: string; section?: string }>;
  summary?: string;
  error?: string;
}

const score = z.number().int().min(1).max(5);

const assessmentSchema = z.object({
  scores: z.object({
    coverage: score,
    correctness: score,
    patternFit: score,
    taskActionability: score,
    questionQuality: score,
  }),
  gapSeverity: z.enum(['none', 'minor', 'major']),
  gaps: z.array(z.object({ item: z.string(), section: z.string().optional() })),
});

const judgeOutputSchema = z.object({
  A: assessmentSchema,
  B: assessmentSchema,
  better: z.enum(['A', 'B', 'equivalent']),
  summary: z.string(),
});

/**
 * The prompt names plans only as A and B. Which one is the reference is the
 * orchestrator's secret, so the judge cannot favour it.
 */
export function buildJudgePrompt(): string {
  return `You are reviewing two independent plans for the same new bank communication in
Continia Banking (Business Central / AL). Neither plan is known to be correct.

Files in your working directory:

- \`work-item.md\` — the work item, its comment thread, and the requirement. Where it refers
  to \`.agent/input-docs/<file>\`, that file is in \`docs/<file>\` here.
- \`A/\` and \`B/\` — one plan each: \`design-doc.md\`, \`tasklist.json\`, \`questions.json\`,
  \`artifacts.json\`. Some files may be missing; a missing design doc is itself a finding.

Read both plans fully and check them against the work item and the API docs.

Score each plan from 1 (poor) to 5 (excellent):

- \`coverage\` — authentication, export, import and assisted setup are all planned where the
  work item asks for them.
- \`correctness\` — endpoints, fields, call order and auth handling match the work item and API
  docs; nothing is invented.
- \`patternFit\` — reuses the reference bank's patterns; no AL object is planned for something
  that is setup-JSON configuration.
- \`taskActionability\` — a developer could execute each task without guessing.
- \`questionQuality\` — blocking questions are real gaps, not things the work item already
  answers. Score 5 when there are no questions and none were needed.

For each plan also give \`gapSeverity\`: \`none\`; \`minor\` (a developer would still build
working code); or \`major\` (a developer would build wrong or incomplete code). Then list
\`gaps\`: concrete things this plan misses or gets wrong that the work item or the other plan
gets right, each with the design-doc section heading it concerns.

Write \`${JUDGE_OUTPUT}\` in your working directory with exactly this shape:

\`\`\`json
{
  "A": { "scores": { "coverage": 1, "correctness": 1, "patternFit": 1, "taskActionability": 1, "questionQuality": 1 },
         "gapSeverity": "none", "gaps": [{ "item": "...", "section": "..." }] },
  "B": { "scores": { "coverage": 1, "correctness": 1, "patternFit": 1, "taskActionability": 1, "questionQuality": 1 },
         "gapSeverity": "none", "gaps": [] },
  "better": "A | B | equivalent",
  "summary": "two or three sentences"
}
\`\`\`

Do not modify any other file.`;
}

/** Map the judge's A/B view back onto the variant being evaluated. */
export function parseJudgeOutput(
  raw: unknown,
  variantIsA: boolean,
  variant: string,
  costUsd: number,
): JudgeResult {
  if (raw === undefined) {
    return { variant, costUsd, gaps: [], error: `judge wrote no ${JUDGE_OUTPUT}` };
  }

  const parsed = judgeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { variant, costUsd, gaps: [], error: `${JUDGE_OUTPUT} has the wrong shape: ${issues}` };
  }

  const out = parsed.data;
  const side = variantIsA ? 'A' : 'B';
  const mine = out[side];
  const verdict: JudgeVerdict =
    out.better === side
      ? 'better'
      : mine.gapSeverity === 'none'
        ? 'equivalent'
        : mine.gapSeverity === 'minor'
          ? 'minor-gaps'
          : 'major-gaps';

  return {
    variant,
    costUsd,
    scores: mine.scores,
    verdict,
    gaps: mine.gaps,
    summary: out.summary,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-judge.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/experiment-judge.ts tests/services/experiment-judge.test.ts
git commit -m "Add a blind A/B judge prompt and parser for experiment plans"
```

---

### Task 6: Results model and report

**Files:**
- Create: `src/services/experiment-report.ts`
- Test: `tests/services/experiment-report.test.ts`

**Interfaces:**
- Consumes: `AgentRunResult`, `ModelUsageSummary`, `RateLimitInfo`, `AuthMode` (Task 1); `formatTokens` (Task 1); `JudgeResult` (Task 5); `FrozenDoc` (Task 4).
- Produces:
  - `type VariantStatus = 'ok' | 'failed' | 'budget-stopped' | 'rate-limited' | 'context-overflow'`
  - `interface VariantUsage { variant: string; model: string; effort?: string; subagentModel?: string; status: VariantStatus; error?: string; costUsd: number; modelUsage: Record<string, ModelUsageSummary>; numTurns: number; durationMs: number; blocking: number; ambiguities: number; taskCount?: number; designDoc: boolean; rateLimit?: RateLimitInfo }`
  - `interface ExperimentResults { workItemId: number; title: string; runId: string; auth: AuthMode; judgeModel: string; baseline: string; shas: { banking: string; setupFiles: string }; docs: FrozenDoc[]; variants: VariantUsage[]; judges: JudgeResult[]; notes: string[]; stoppedReason?: string; totalUsd: number }`
  - `classifyStatus(result: AgentRunResult | undefined, error: string | undefined): VariantStatus`
  - `countTasks(taskList: unknown): number | undefined`
  - `cheapestGoodEnough(results: ExperimentResults): string | undefined`
  - `renderReport(results: ExperimentResults): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/experiment-report.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import {
  cheapestGoodEnough,
  classifyStatus,
  countTasks,
  renderReport,
  type ExperimentResults,
  type VariantUsage,
} from '../../src/services/experiment-report.ts';
import type { JudgeResult } from '../../src/services/experiment-judge.ts';

const scores = (n: number) => ({
  coverage: n,
  correctness: n,
  patternFit: n,
  taskActionability: n,
  questionQuality: n,
});

function usage(variant: string, costUsd: number, extra: Partial<VariantUsage> = {}): VariantUsage {
  return {
    variant,
    model: 'claude-opus-5-5',
    status: 'ok',
    costUsd,
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
    },
    numTurns: 30,
    durationMs: 600_000,
    blocking: 0,
    ambiguities: 2,
    taskCount: 12,
    designDoc: true,
    ...extra,
  };
}

function judge(variant: string, verdict: JudgeResult['verdict'], n: number): JudgeResult {
  return { variant, costUsd: 0.5, scores: scores(n), verdict, gaps: [], summary: 's' };
}

function results(extra: Partial<ExperimentResults> = {}): ExperimentResults {
  return {
    workItemId: 83634,
    title: 'Implement ponto',
    runId: '20260930-101500',
    auth: 'subscription',
    judgeModel: 'claude-sonnet-5-5',
    baseline: 'opus-high',
    shas: { banking: 'aaa', setupFiles: 'bbb' },
    docs: [],
    variants: [usage('opus-high', 40), usage('sonnet-high', 10), usage('haiku', 2)],
    judges: [judge('sonnet-high', 'equivalent', 4), judge('haiku', 'equivalent', 3)],
    notes: [],
    totalUsd: 53,
    ...extra,
  };
}

describe('classifyStatus', () => {
  const ok = { text: '', success: true, costUsd: 1, numTurns: 1 };
  test('ok on success', () => expect(classifyStatus(ok, undefined)).toBe('ok'));
  test('failed without a result', () => expect(classifyStatus(undefined, 'git broke')).toBe('failed'));
  test('rate-limited on a rejection', () =>
    expect(classifyStatus({ ...ok, success: false, rateLimit: { status: 'rejected' } }, 'x')).toBe('rate-limited'));
  test('rate-limited on the assistant error', () =>
    expect(classifyStatus({ ...ok, success: false, assistantError: 'rate_limit' }, 'x')).toBe('rate-limited'));
  test('budget-stopped on the budget subtype', () =>
    expect(classifyStatus({ ...ok, success: false, subtype: 'error_max_budget_usd' }, 'x')).toBe('budget-stopped'));
  test('context-overflow on a too-long prompt', () =>
    expect(classifyStatus({ ...ok, success: false, text: 'Prompt is too long' }, 'x')).toBe('context-overflow'));
  test('failed when the phase threw after a successful agent run', () =>
    expect(classifyStatus(ok, 'artifact missing')).toBe('failed'));
});

describe('countTasks', () => {
  test('counts an array', () => expect(countTasks([1, 2])).toBe(2));
  test('counts a tasks property', () => expect(countTasks({ tasks: [1, 2, 3] })).toBe(3));
  test('counts tasks across waves', () =>
    expect(countTasks({ waves: [{ tasks: [1] }, { tasks: [2, 3] }] })).toBe(3));
  test('undefined for anything else', () => expect(countTasks(undefined)).toBeUndefined());
});

describe('cheapestGoodEnough', () => {
  test('skips a variant with any score below 4', () => {
    expect(cheapestGoodEnough(results())).toBe('sonnet-high');
  });

  test('falls back to the baseline when nothing cheaper qualifies', () => {
    expect(cheapestGoodEnough(results({ judges: [judge('sonnet-high', 'major-gaps', 5)] }))).toBe('opus-high');
  });

  test('undefined when the baseline did not succeed and nothing qualifies', () => {
    expect(
      cheapestGoodEnough(
        results({ variants: [usage('opus-high', 40, { status: 'failed' })], judges: [] }),
      ),
    ).toBeUndefined();
  });
});

describe('renderReport', () => {
  test('sorts the summary by cost and shows % of baseline', () => {
    const md = renderReport(results());
    const rows = md.split('\n').filter((l) => l.startsWith('| haiku') || l.startsWith('| sonnet-high') || l.startsWith('| opus-high'));
    expect(rows.map((r) => r.split('|')[1]!.trim())).toEqual(['haiku', 'sonnet-high', 'opus-high']);
    expect(rows[1]).toContain('25%');
    expect(md).toContain('API-equivalent USD');
    expect(md).toContain('**Cheapest good-enough:** `sonnet-high`');
  });

  test('flags a partial report and a questions-only variant', () => {
    const md = renderReport(
      results({
        stoppedReason: "rate limit five_hour rejected during 'haiku'",
        variants: [usage('opus-high', 40), usage('haiku', 2, { designDoc: false, blocking: 3 })],
        judges: [],
      }),
    );
    expect(md).toContain("> **Partial report.** rate limit five_hour rejected during 'haiku'");
    expect(md).toContain("`haiku` stopped at questions (3 blocking) without a design doc");
  });

  test('shows a failed judge', () => {
    const md = renderReport(
      results({ judges: [{ variant: 'sonnet-high', costUsd: 0.1, gaps: [], error: 'judge wrote no judge.json' }] }),
    );
    expect(md).toContain('judge failed: judge wrote no judge.json');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-report.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/services/experiment-report.ts`:

```ts
import type {
  AgentRunResult,
  AuthMode,
  ModelUsageSummary,
  RateLimitInfo,
} from '../types/index.ts';
import { formatTokens } from './agent-runner.ts';
import type { FrozenDoc } from './experiment-input.ts';
import type { JudgeResult } from './experiment-judge.ts';

export type VariantStatus = 'ok' | 'failed' | 'budget-stopped' | 'rate-limited' | 'context-overflow';

/** What one variant cost and produced. Written to <variant>/usage.json. */
export interface VariantUsage {
  variant: string;
  model: string;
  effort?: string;
  subagentModel?: string;
  status: VariantStatus;
  error?: string;
  costUsd: number;
  modelUsage: Record<string, ModelUsageSummary>;
  numTurns: number;
  durationMs: number;
  blocking: number;
  ambiguities: number;
  taskCount?: number;
  designDoc: boolean;
  rateLimit?: RateLimitInfo;
}

export interface ExperimentResults {
  workItemId: number;
  title: string;
  runId: string;
  auth: AuthMode;
  judgeModel: string;
  baseline: string;
  shas: { banking: string; setupFiles: string };
  docs: FrozenDoc[];
  variants: VariantUsage[];
  judges: JudgeResult[];
  /** Why the judge was skipped or stopped, and similar caveats. */
  notes: string[];
  stoppedReason?: string;
  totalUsd: number;
}

const CONTEXT_OVERFLOW = /prompt is too long|context window|context length/i;

export function classifyStatus(
  result: AgentRunResult | undefined,
  error: string | undefined,
): VariantStatus {
  if (!result) return 'failed';
  if (result.rateLimit?.status === 'rejected' || result.assistantError === 'rate_limit') {
    return 'rate-limited';
  }
  if (result.subtype === 'error_max_budget_usd') return 'budget-stopped';
  if (!result.success && CONTEXT_OVERFLOW.test(`${result.text} ${error ?? ''}`)) {
    return 'context-overflow';
  }
  return result.success && !error ? 'ok' : 'failed';
}

/** The planner's task-list shape is the skill's, not ours; count what we recognise. */
export function countTasks(taskList: unknown): number | undefined {
  if (Array.isArray(taskList)) return taskList.length;
  if (taskList && typeof taskList === 'object') {
    const obj = taskList as { tasks?: unknown; waves?: unknown };
    if (Array.isArray(obj.tasks)) return obj.tasks.length;
    if (Array.isArray(obj.waves)) {
      return obj.waves.reduce<number>(
        (sum, wave) => sum + (countTasks(wave) ?? 0),
        0,
      );
    }
  }
  return undefined;
}

function isGoodEnough(judge: JudgeResult | undefined): boolean {
  if (!judge?.scores || !judge.verdict) return false;
  if (judge.verdict !== 'equivalent' && judge.verdict !== 'better') return false;
  return Object.values(judge.scores).every((s) => s >= 4);
}

/** Cheapest variant the judge found as good as the baseline; the baseline itself qualifies. */
export function cheapestGoodEnough(results: ExperimentResults): string | undefined {
  const candidates = results.variants.filter(
    (v) =>
      v.status === 'ok' &&
      (v.variant === results.baseline ||
        isGoodEnough(results.judges.find((j) => j.variant === v.variant))),
  );
  candidates.sort((a, b) => a.costUsd - b.costUsd);
  return candidates[0]?.variant;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

export function renderReport(r: ExperimentResults): string {
  const baseline = r.variants.find((v) => v.variant === r.baseline);
  const lines: string[] = [
    `# Planning experiment — work item #${r.workItemId}`,
    '',
    `- **Title:** ${r.title}`,
    `- **Run:** ${r.runId}`,
    `- **Auth:** ${r.auth} — all costs are API-equivalent USD`,
    `- **Judge model:** ${r.judgeModel}`,
    `- **Frozen SHAs:** banking \`${r.shas.banking}\`, setup-files \`${r.shas.setupFiles}\``,
    `- **Total spend:** ${usd(r.totalUsd)}`,
    '- **MCP servers:** none loaded (production planning loads `.mcp.json`)',
  ];

  const warnings: string[] = [];
  if (r.stoppedReason) warnings.push(`> **Partial report.** ${r.stoppedReason}`);
  for (const d of r.docs.filter((d) => d.error)) {
    warnings.push(`> API doc download failed: ${d.url} — ${d.error}`);
  }
  for (const note of r.notes) warnings.push(`> ${note}`);
  for (const v of r.variants.filter((v) => v.status === 'ok' && !v.designDoc)) {
    warnings.push(
      `> \`${v.variant}\` stopped at questions (${v.blocking} blocking) without a design doc — only its questions were compared.`,
    );
  }
  if (warnings.length > 0) lines.push('', ...warnings.flatMap((w) => [w, '']));

  lines.push(
    '',
    '## Summary',
    '',
    '| Variant | Model | Effort | Subagents | Status | Cost | vs baseline | Turns | Time | Verdict | Cov | Corr | Fit | Tasks | Qs |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const v of [...r.variants].sort((a, b) => a.costUsd - b.costUsd)) {
    const j = r.judges.find((x) => x.variant === v.variant);
    const pct =
      baseline && baseline.costUsd > 0 ? `${Math.round((v.costUsd / baseline.costUsd) * 100)}%` : '—';
    const verdict =
      v.variant === r.baseline ? 'baseline' : j?.error ? 'judge failed' : (j?.verdict ?? '—');
    const s = j?.scores;
    lines.push(
      `| ${v.variant} | ${v.model} | ${v.effort ?? '—'} | ${v.subagentModel ?? 'inherit'} | ${v.status} | ` +
        `${usd(v.costUsd)} | ${pct} | ${v.numTurns} | ${minutes(v.durationMs)} | ${verdict} | ` +
        `${s?.coverage ?? '—'} | ${s?.correctness ?? '—'} | ${s?.patternFit ?? '—'} | ` +
        `${s?.taskActionability ?? '—'} | ${s?.questionQuality ?? '—'} |`,
    );
  }

  lines.push('', '## Cost by model');
  for (const v of r.variants) {
    lines.push(
      '',
      `### ${v.variant}`,
      '',
      '| Model | Input | Output | Cache read | Cache write | Cost |',
      '|---|---|---|---|---|---|',
    );
    for (const [model, u] of Object.entries(v.modelUsage)) {
      lines.push(
        `| ${model} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.outputTokens)} | ` +
          `${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${usd(u.costUsd)} |`,
      );
    }
    if (v.error) lines.push('', `Error: ${v.error}`);
  }

  if (r.judges.length > 0) {
    lines.push('', '## Gaps found by the judge');
    for (const j of r.judges) {
      lines.push('', `### ${j.variant} — ${j.error ? `judge failed: ${j.error}` : j.verdict}`);
      if (j.summary) lines.push('', j.summary);
      for (const g of j.gaps) lines.push(`- ${g.item}${g.section ? ` (${g.section})` : ''}`);
    }
  }

  const pick = cheapestGoodEnough(r);
  lines.push(
    '',
    '## Suggestion',
    '',
    pick
      ? `**Cheapest good-enough:** \`${pick}\` — verdict equivalent or better and no score below 4. A suggestion; read the gaps before deciding.`
      : 'No variant qualified as good enough.',
    '',
  );

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment-report.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/experiment-report.ts tests/services/experiment-report.test.ts
git commit -m "Render experiment results into a cost and quality report"
```

---

### Task 7: Experiment orchestration

**Files:**
- Create: `src/services/experiment.ts`
- Test: `tests/services/experiment.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspaces`, `pathsFor`, `runPlanningPhase`, `PipelineDeps`, `PhaseContext`, `defaultDeps` (Task 2 / existing); `revParse`, `ensureRepoCache` (Task 2 / existing); `loadVariantSet`, `selectVariants`, `Variant`, `VariantSet` (Task 3); `freezeInput`, `FreezeDeps`, `FrozenInput`, `LOCAL_DOCS_DIR`, `fetchDocOverHttp` (Task 4); `buildJudgePrompt`, `parseJudgeOutput`, `JUDGE_TOOLS`, `JUDGE_OUTPUT`, `JudgeResult` (Task 5); `classifyStatus`, `countTasks`, `renderReport`, `VariantUsage`, `ExperimentResults` (Task 6); `StateStore`.
- Produces:
  - `interface ExperimentOptions { workItemId: number; variantsFile: string; only?: string[]; answersFile?: string; questionsFile?: string; auth: AuthMode; experimentsDir: string; runId?: string }`
  - `interface ExperimentDeps { pipeline: PipelineDeps; freeze: FreezeDeps; random(): number; now(): Date }`
  - `defaultExperimentDeps: ExperimentDeps`
  - `authEnv(auth: AuthMode, env?: Record<string, string | undefined>): Record<string, string | undefined> | undefined`
  - `experimentDeps(base: PipelineDeps): PipelineDeps`
  - `formatRunId(date: Date): string` — `YYYYMMDD-HHMMSS` (UTC)
  - `runExperiment(config: AppConfig, opts: ExperimentOptions, deps?: ExperimentDeps): Promise<ExperimentResults>`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/experiment.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
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
  worktreeFailsFor?: string;
  judgeWritesNothing?: boolean;
}

function deps(fake: Fake = {}): ExperimentDeps & { runAgent: ReturnType<typeof mock>; createWorktree: ReturnType<typeof mock> } {
  const createWorktree = mock((cfg: AppConfig, repo: { key: string }) => {
    if (fake.worktreeFailsFor && cfg.worktreeRoot.includes(fake.worktreeFailsFor)) {
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
      modelUsage: { [model]: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost } },
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

    if (fake.noPlanDirFor !== model) {
      const planDir = join(options.cwd, '.agent', 'plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'questions.json'), JSON.stringify({ blocking: [], ambiguities: [{ question: 'q' }] }));
      writeFileSync(join(planDir, 'design-doc.md'), '# plan');
      writeFileSync(join(planDir, 'tasklist.json'), JSON.stringify({ tasks: [1, 2, 3] }));
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
    variantsFile: writeVariants(),
    auth: 'subscription' as const,
    experimentsDir: join(root, 'experiments'),
    ...extra,
  };
}

describe('helpers', () => {
  test('formatRunId is UTC and sortable', () => {
    expect(formatRunId(new Date('2026-09-30T10:15:07Z'))).toBe('20260930-101507');
  });

  test('authEnv strips API credentials only for subscription', () => {
    const env = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' };
    expect(authEnv('subscription', env)).toEqual({ PATH: '/bin' });
    expect(authEnv('api-key', env)).toBeUndefined();
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
    const judgeDir = judgeCall[2].cwd as string;
    expect(existsSync(join(judgeDir, 'A', 'design-doc.md'))).toBe(true);
    expect(existsSync(join(judgeDir, 'B', 'design-doc.md'))).toBe(true);
    expect(existsSync(join(judgeDir, 'work-item.md'))).toBe(true);
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
      opts({ variantsFile: writeVariants({ variants: [
        { name: 'opus', model: 'claude-opus-5-5' },
        { name: 'sonnet', model: 'claude-sonnet-5-5' },
        { name: 'third', model: 'claude-opus-5-5' },
      ] }) }),
      deps({ rateLimitOn: 'claude-sonnet-5-5' }),
    );
    expect(r.variants.map((v) => v.status)).toEqual(['ok', 'rate-limited']);
    expect(r.stoppedReason).toContain("rate limit five_hour rejected during 'sonnet'");
    expect(r.judges).toEqual([]);
  });

  test('records a variant that fails before any agent call and continues', async () => {
    const r = await runExperiment(config(), opts(), deps({ worktreeFailsFor: 'exp-20260930-101500-opus' }));
    expect(r.variants[0]).toMatchObject({ variant: 'opus', status: 'failed', costUsd: 0, error: 'git worktree add failed' });
    expect(r.variants[1]!.status).toBe('ok');
  });

  test('writes usage.json even when the planner leaves no plan directory', async () => {
    const r = await runExperiment(config(), opts(), deps({ noPlanDirFor: 'claude-sonnet-5-5' }));
    const sonnet = r.variants.find((v) => v.variant === 'sonnet')!;
    expect(sonnet).toMatchObject({ status: 'ok', designDoc: false, blocking: 0, ambiguities: 0 });
  });

  test('records a judge that writes nothing', async () => {
    const r = await runExperiment(config(), opts(), deps({ judgeWritesNothing: true }));
    expect(r.judges[0]).toMatchObject({ variant: 'sonnet', error: 'judge wrote no judge.json' });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/services/experiment.ts`:

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
import { loadVariantSet, selectVariants, type Variant, type VariantSet } from '../config/experiment.ts';
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
 * Child environment for the chosen auth. Without an API key in its env, the
 * Claude Code binary falls back to the logged-in ~/.claude credentials. Bun
 * loads .env into process.env, so the key has to be removed explicitly.
 */
export function authEnv(
  auth: AuthMode,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> | undefined {
  if (auth === 'api-key') return undefined;
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
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

async function runVariant(rc: RunContext, variant: Variant, remainingUsd: number): Promise<VariantUsage> {
  const { config, frozen, runId, runDir, auth, deps } = rc;
  const variantDir = join(runDir, variant.name);
  mkdirSync(variantDir, { recursive: true });

  const vConfig: AppConfig = {
    ...config,
    worktreeRoot: join(config.worktreeRoot, `exp-${runId}-${variant.name}`),
    logDir: variantDir,
    jobMaxBudgetUsd: remainingUsd,
  };
  const branch = `experiment/${runId}-${variant.name}`;

  let last: AgentRunResult | undefined;
  const pipelineDeps: PipelineDeps = {
    ...experimentDeps(deps.pipeline),
    runAgent: async (...args) => (last = await deps.pipeline.runAgent(...args)),
  };

  let error: string | undefined;
  let questions: PlanQuestions = { blocking: [], ambiguities: [] };
  let banking: string | undefined;

  log(`  Variant ${variant.name}: model=${variant.model ?? config.claudeModel} effort=${variant.effort ?? 'default'} subagents=${variant.subagentModel ?? 'inherit'}`);

  try {
    const worktrees = await prepareWorkspaces(vConfig, frozen.item, branch, pipelineDeps, frozen.shas);
    banking = worktrees.banking;
    const paths = pathsFor(worktrees.banking);
    copyIfExists(join(runDir, 'input', 'docs'), join(worktrees.banking, LOCAL_DOCS_DIR));

    const store = new StateStore(join(variantDir, 'state'));
    store.ensure(frozen.workItemId);
    if (frozen.previousQuestions) {
      // runPlanningPhase reads the previous round's questions from the worktree.
      store.update(frozen.workItemId, { clarifyRounds: 1 });
      mkdirSync(dirname(paths.questionsPath), { recursive: true });
      writeFileSync(paths.questionsPath, JSON.stringify(frozen.previousQuestions, null, 2), 'utf-8');
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
      },
    };

    questions = await runPlanningPhase(ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let taskCount: number | undefined;
  let designDoc = false;
  if (banking) {
    const planDir = join(banking, '.agent', 'plan');
    copyIfExists(planDir, join(variantDir, 'plan'));
    const paths = pathsFor(banking);
    taskCount = countTasks(readJson(paths.taskListPath));
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
    durationMs: last?.durationMs ?? 0,
    blocking: questions.blocking.length,
    ambiguities: questions.ambiguities.length,
    taskCount,
    designDoc,
    rateLimit: last?.rateLimit,
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
  const judgeDir = join(runDir, 'judge', variant);
  mkdirSync(judgeDir, { recursive: true });

  const variantIsA = deps.random() < 0.5;
  const [a, b] = variantIsA ? [variant, set.baseline] : [set.baseline, variant];
  copyIfExists(join(runDir, a, 'plan'), join(judgeDir, 'A'));
  copyIfExists(join(runDir, b, 'plan'), join(judgeDir, 'B'));
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
    result = { variant, costUsd, gaps: [], error: err instanceof Error ? err.message : String(err) };
  }

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

  const runId = opts.runId ?? formatRunId(deps.now());
  const runDir = join(opts.experimentsDir, 'runs', String(opts.workItemId), runId);
  mkdirSync(runDir, { recursive: true });
  log(`Experiment ${runId} on #${opts.workItemId}: auth=${opts.auth}, ${variants.length} variant(s), cap $${set.maxUsd}`);

  const frozen = await freezeInput(
    config,
    opts.workItemId,
    runDir,
    { answersFile: opts.answersFile, questionsFile: opts.questionsFile },
    deps.freeze,
  );

  const rc: RunContext = { config, set, frozen, runId, runDir, auth: opts.auth, deps };
  const usages: VariantUsage[] = [];
  const notes: string[] = [];
  let spent = 0;
  let stoppedReason: string | undefined;

  for (const variant of variants) {
    const remaining = set.maxUsd - spent;
    if (remaining <= 0) {
      stoppedReason = `experiment budget of $${set.maxUsd} was used up before '${variant.name}'`;
      break;
    }
    const usage = await runVariant(rc, variant, remaining);
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
```

Notes for the implementer:
- `formatRunId(new Date('2026-09-30T10:15:07Z'))`: `toISOString()` gives `2026-09-30T10:15:07.000Z`; after removing `-` and `:` it is `20260930T101507.000Z`; replacing `T` with `-` and taking 15 chars gives `20260930-101507`.
- `refuse` returns `never`, so each stub satisfies the dependency's type without a cast. If TypeScript complains about parameter counts, write `(..._args: unknown[]) => refuse('name')`.
- In the "no plan directory" test the planner succeeds but writes nothing. `runPlanningPhase` then returns empty questions, which is what the test expects.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test --preload ./tests/setup.ts tests/services/experiment.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: every test passes (248 before this plan, plus the new ones).

- [ ] **Step 6: Commit**

```bash
git add src/services/experiment.ts tests/services/experiment.test.ts
git commit -m "Run planning variants on frozen input, judge them and write the report"
```

---

### Task 8: CLI command, experiments folder and docs

**Files:**
- Create: `src/cli/experiment-args.ts`
- Modify: `src/cli/index.ts`
- Modify: `package.json`, `.gitignore`
- Create: `experiments/README.md`, `experiments/variants/planning-baseline.json`, `experiments/findings/TEMPLATE.md`
- Modify: `CLAUDE.md`, `README.md`
- Test: `tests/cli/experiment-args.test.ts`

**Interfaces:**
- Consumes: `runExperiment`, `ExperimentOptions` (Task 7); `loadConfig` with `requireApiKey` (Task 3); `AuthMode` (Task 1).
- Produces:
  - `interface ExperimentArgs { workItemId: number; variantsFile: string; only?: string[]; answersFile?: string; questionsFile?: string; auth: AuthMode }`
  - `const DEFAULT_VARIANTS_FILE = 'experiments/variants/planning-baseline.json'`
  - `parseExperimentArgs(argv: string[]): ExperimentArgs` — `argv` is everything after `experiment`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/experiment-args.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { DEFAULT_VARIANTS_FILE, parseExperimentArgs } from '../../src/cli/experiment-args.ts';

describe('parseExperimentArgs', () => {
  test('defaults to the baseline variant file and subscription auth', () => {
    expect(parseExperimentArgs(['plan', '83634'])).toEqual({
      workItemId: 83634,
      variantsFile: DEFAULT_VARIANTS_FILE,
      auth: 'subscription',
    });
  });

  test('reads every flag', () => {
    expect(
      parseExperimentArgs([
        'plan', '83634',
        '--variants', 'v.json',
        '--only', 'opus-high, haiku',
        '--answers', 'a.md',
        '--questions', 'q.json',
        '--auth', 'api-key',
      ]),
    ).toEqual({
      workItemId: 83634,
      variantsFile: 'v.json',
      only: ['opus-high', 'haiku'],
      answersFile: 'a.md',
      questionsFile: 'q.json',
      auth: 'api-key',
    });
  });

  test('rejects anything but the plan phase', () => {
    expect(() => parseExperimentArgs(['implement', '1'])).toThrow('Usage:');
  });

  test('rejects a missing or non-numeric id', () => {
    expect(() => parseExperimentArgs(['plan'])).toThrow('Usage:');
    expect(() => parseExperimentArgs(['plan', 'abc'])).toThrow('Usage:');
  });

  test('rejects an unknown flag, a flag without a value, and a bad auth mode', () => {
    expect(() => parseExperimentArgs(['plan', '1', '--repeat', '2'])).toThrow("unknown option '--repeat'");
    expect(() => parseExperimentArgs(['plan', '1', '--only'])).toThrow("'--only' needs a value");
    expect(() => parseExperimentArgs(['plan', '1', '--auth', 'oauth'])).toThrow("--auth must be 'subscription' or 'api-key'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/cli/experiment-args.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the argument parser**

Create `src/cli/experiment-args.ts`:

```ts
import type { AuthMode } from '../types/index.ts';

export const DEFAULT_VARIANTS_FILE = 'experiments/variants/planning-baseline.json';

export const EXPERIMENT_USAGE =
  'Usage: bun run experiment plan <work-item-id> [--variants <file>] [--only a,b] ' +
  '[--answers <file>] [--questions <file>] [--auth subscription|api-key]';

export interface ExperimentArgs {
  workItemId: number;
  variantsFile: string;
  only?: string[];
  answersFile?: string;
  questionsFile?: string;
  auth: AuthMode;
}

const FLAGS = new Set(['--variants', '--only', '--answers', '--questions', '--auth']);

export function parseExperimentArgs(argv: string[]): ExperimentArgs {
  const [phase, id, ...rest] = argv;
  if (phase !== 'plan' || !id || !/^\d+$/.test(id)) throw new Error(EXPERIMENT_USAGE);

  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!FLAGS.has(flag)) throw new Error(`unknown option '${flag}'\n${EXPERIMENT_USAGE}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`'${flag}' needs a value`);
    values.set(flag, value);
  }

  const auth = values.get('--auth') ?? 'subscription';
  if (auth !== 'subscription' && auth !== 'api-key') {
    throw new Error("--auth must be 'subscription' or 'api-key'");
  }

  const args: ExperimentArgs = {
    workItemId: Number(id),
    variantsFile: values.get('--variants') ?? DEFAULT_VARIANTS_FILE,
    auth,
  };
  const only = values.get('--only');
  if (only) args.only = only.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const answers = values.get('--answers');
  if (answers) args.answersFile = answers;
  const questions = values.get('--questions');
  if (questions) args.questionsFile = questions;
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --preload ./tests/setup.ts tests/cli/experiment-args.test.ts`
Expected: PASS. Also confirm `package.json`'s `test` glob `tests/**/*.test.ts` picks up `tests/cli/`.

- [ ] **Step 5: Wire the CLI command**

In `src/cli/index.ts`:

1. Add imports:

```ts
import { parseExperimentArgs } from './experiment-args.ts';
import { runExperiment } from '../services/experiment.ts';
```

2. In `HELP`, after the `reset-budget` line, add:

```
  experiment plan <id> Run planning variants locally on frozen input and compare
                       cost and quality (see experiments/README.md). Flags:
                       --variants <file> --only a,b --answers <file>
                       --questions <file> --auth subscription|api-key
```

3. Before `case 'help':`, add:

```ts
  case 'experiment': {
    let args;
    try {
      args = parseExperimentArgs(process.argv.slice(3));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      break;
    }
    // Planning never reaches verify, so the DemoPortal token is irrelevant here;
    // the API key is only needed when not running on the Claude login.
    const config = loadConfig(
      { ...process.env, SKIP_BUILD_TEST: 'true' },
      { requireApiKey: args.auth === 'api-key' },
    );
    const results = await runExperiment(config, { ...args, experimentsDir: 'experiments' });
    console.log(
      `\n${results.variants.length} variant(s), $${results.totalUsd.toFixed(2)} API-equivalent` +
        `${results.stoppedReason ? ` — stopped: ${results.stoppedReason}` : ''}`,
    );
    break;
  }
```

4. In `package.json` `scripts`, add after `"status"`:

```json
    "experiment": "bun run src/cli/index.ts experiment",
```

5. In `.gitignore`, append:

```
# Experiment runs hold work-item text and agent transcripts — local only.
experiments/runs/
```

- [ ] **Step 6: Create the experiments folder**

`experiments/variants/planning-baseline.json`:

```json
{
  "phase": "planning",
  "baseline": "opus-high",
  "judgeModel": "claude-sonnet-5-5",
  "maxUsd": 200,
  "variants": [
    { "name": "opus-high", "model": "claude-opus-5-5", "effort": "high" },
    { "name": "opus-med", "model": "claude-opus-5-5", "effort": "medium" },
    { "name": "opus-sonnet-subs", "model": "claude-opus-5-5", "effort": "high", "subagentModel": "claude-sonnet-5-5" },
    { "name": "opus-haiku-subs", "model": "claude-opus-5-5", "effort": "high", "subagentModel": "claude-haiku-4-5-20251001" },
    { "name": "sonnet-high", "model": "claude-sonnet-5-5", "effort": "high" },
    { "name": "sonnet-haiku-subs", "model": "claude-sonnet-5-5", "effort": "high", "subagentModel": "claude-haiku-4-5-20251001" },
    { "name": "haiku", "model": "claude-haiku-4-5-20251001" }
  ]
}
```

`experiments/findings/TEMPLATE.md`:

```markdown
# <Question this finding answers>

**Date:** YYYY-MM-DD
**Work item(s):** #
**Run IDs:** experiments/runs/<id>/<runId>
**Samples per variant:** 1

## Variants

| Variant | Model | Effort | Subagents |
|---|---|---|---|

## Key numbers

| Variant | API-equivalent USD | vs baseline | Verdict | Lowest score |
|---|---|---|---|---|

## What the judge found

## Decision

## Config change made

None.
```

`experiments/README.md`:

````markdown
# Experiments

Local A/B runs that answer "is a cheaper configuration good enough?" before any production
config changes. Design: `docs/superpowers/specs/2026-09-30-planning-cost-experiments-design.md`.

## Layout

- `variants/` — committed variant sets (model × effort × subagent model).
- `findings/` — committed, dated conclusions. Copy `findings/TEMPLATE.md`.
- `runs/` — gitignored raw output: frozen input, transcripts, plans, judge verdicts, report.

## Before the first run

The watcher's defaults point at `/data/...` inside the container. Locally, set these in `.env`:

- `REPO_CACHE_DIR`, `WORKTREE_ROOT` — local directories outside this repo.
- `SKILLS_SOURCE_DIR` — this repo's `.claude` directory.
- `BANKING_REPO_ID`, `SETUP_FILES_REPO_ID`, and optionally `BANKING_SEED_REPO` /
  `SETUP_FILES_SEED_REPO` pointing at local clones to make the first clone fast.
- `AZURE_DEVOPS_PAT` — read-only use: the experiment only reads the work item.

With `--auth subscription` (the default), `ANTHROPIC_API_KEY` is removed from the agent's
environment and Claude Code uses your logged-in account. Runs count against your plan's
five-hour and weekly limits. Confirm that your Team plan terms allow scripted Agent SDK use on
a seat before running large sweeps.

## Run

```bash
# Prove the harness on two variants first
bun run experiment plan 83634 --only opus-high,opus-haiku-subs

# Planner asked blocking questions? Answer them locally and re-run as a follow-up round
bun run experiment plan 83634 --answers answers.md \
  --questions experiments/runs/83634/<runId>/opus-high/plan/questions.json
```

Nothing is written to Azure DevOps and nothing is pushed. Agent runs load no MCP servers.

## Read the report

`runs/<id>/<runId>/report.md` lists each variant's API-equivalent cost, its % of the baseline,
the judge's verdict and rubric scores, per-model token usage, and the gaps the judge found.
The "cheapest good-enough" line is a suggestion. Read the gaps before deciding.

A rate-limit rejection stops the sweep and writes a partial report. Re-run the remaining
variants later with `--only`.

## Clean up

Experiment worktrees are kept for inspection under `$WORKTREE_ROOT/exp-<runId>-<variant>/`.
Delete those directories, then run `git -C "$REPO_CACHE_DIR/banking.git" worktree prune` and
the same for `setupFiles.git`.
````

- [ ] **Step 7: Document in CLAUDE.md and README.md**

In `CLAUDE.md` under `## Commands`, add:

```
- `bun run experiment plan <id>` — local A/B of planning variants (see `experiments/README.md`)
```

and under `## File Layout`, add:

```
- `experiments/` — variant sets and findings (committed); `runs/` is local-only output
```

In `README.md`, in the command table after the `reset-budget` row, add:

```
| `experiment plan <id>` | Run planning variants locally on frozen input and compare cost and quality; see `experiments/README.md` |
```

- [ ] **Step 8: Verify everything**

Run: `bun test && bun run typecheck && bun run src/cli/index.ts experiment plan`
Expected: all tests pass; no type errors; the last command prints the usage line and exits 1.

- [ ] **Step 9: Commit**

```bash
git add src/cli/experiment-args.ts src/cli/index.ts tests/cli/experiment-args.test.ts package.json .gitignore experiments CLAUDE.md README.md
git commit -m "Add the experiment command, starter variants and findings template"
```

---

### Task 9: First real run (needs the human's go-ahead)

This task spends real money or seat quota. Do not start it without an explicit yes from the human partner.

- [ ] **Step 1: Check local config**

Ask the human to confirm that `.env` has local `REPO_CACHE_DIR`, `WORKTREE_ROOT` and `SKILLS_SOURCE_DIR` (see `experiments/README.md`). Do not read `.env` yourself.

- [ ] **Step 2: Run two variants**

Run: `bun run experiment plan 83634 --only opus-high,opus-haiku-subs`
Expected: `report.md` path printed; both variants `ok` or a clearly classified status.

- [ ] **Step 3: Check the load-bearing assumptions**

For each variant's `usage.json`:

1. The sum of `modelUsage[*].costUsd` equals `costUsd` to within $0.01. If not, the "last result is cumulative" assumption is wrong: record it and revisit Task 1 before trusting any report.
2. `opus-haiku-subs` lists `claude-haiku-4-5-20251001` in `modelUsage`. If it does not, `CLAUDE_CODE_SUBAGENT_MODEL` is not honoured by this SDK version, and the subagent variants measure nothing. Record it and stop.
3. The transcript `plan-1.log` shows no MCP tool calls and no attempt to fetch the swagger URL instead of reading `.agent/input-docs/`.

- [ ] **Step 4: Report the numbers to the human**

Summarise cost per variant, the judge verdict, and the three checks. Then write the first finding from `experiments/findings/TEMPLATE.md` only if the human wants it recorded.
