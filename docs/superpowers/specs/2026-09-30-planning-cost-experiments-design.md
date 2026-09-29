# Local A/B experiments for planning cost

**Date:** 2026-09-30
**Status:** approved, not yet implemented

## Problem

Every agent run uses one model, `CLAUDE_MODEL` (default `claude-opus-5`), with no effort
setting, and the planner's subagents inherit it. Planning fans out to domain planners and a
verifier (`bank-integration-planner` dispatches `general-purpose` subagents with no model), and
one planning run has spent ~$50 in 32 turns. We do not know which parts of that spend buy
quality and which could run on a cheaper model or lower effort.

We want to answer "is a cheaper configuration good enough for planning?" with evidence, locally,
before any production config changes — and capture token and USD cost per model along the way.

## Scope

- **In:** the planning phase only; a local `experiment` CLI command; per-run model / effort /
  subagent-model overrides in `runAgent`; per-model usage capture; an LLM judge; a report; an
  `experiments/` folder for variant sets and findings.
- **Out:** implementing and verifying phases (later, once planning has findings); per-phase
  model config in production (`PLANNING_MODEL` etc. — added once a finding says which config
  wins); per-role subagent models via SDK `agents` definitions (only if data points there).
- **Production behaviour does not change**, except one extra per-model usage log line per run.

### v1 is lean

v1 builds only what is needed to get real numbers from one work item: freeze input, run the
variants sequentially, capture per-model cost, judge, report. Any rate-limit rejection stops the
sweep and writes a partial report. Deferred until the harness has proven useful — each is marked
**(later)** where it appears below:

- `--repeat N` and the repeat statistics / noise warning
- `--resume <runId>`
- sleep-until-reset on five-hour limits and re-running the variant
- the preflight query and `--force`

## Design

### 1. Folder layout

```
experiments/
  README.md                how to run, how to read a report
  variants/                committed — reusable variant sets
    planning-baseline.json
  findings/                committed — dated conclusions, written by hand from a template
    TEMPLATE.md
  runs/                    gitignored — raw output
    <workItemId>/<runId>/
      input.json           frozen work item context, comments, answers, repo SHAs
      input/docs/          frozen copies of API docs linked from the description
      <variant>[-<n>]/     transcript log, copied plan artifacts, usage.json
      judge/<variant>.json
      report.md
      results.json
```

`runs/` holds full transcripts and work-item text (bank and customer detail), so it never leaves
the machine. `findings/` is the durable history of cost decisions.

Worktrees do **not** live under `experiments/`. Each variant gets a config copy whose
`worktreeRoot` is `<worktreeRoot>/exp-<runId>-<variant>`, so experiment worktrees sit beside the
production ones without colliding and no checkout nests inside this repo.

### 2. Variant file

Validated with Zod:

```json
{
  "phase": "planning",
  "baseline": "opus-high",
  "judgeModel": "claude-sonnet-5-5",
  "maxUsd": 200,
  "variants": [
    { "name": "opus-high",         "model": "claude-opus-5-5",   "effort": "high" },
    { "name": "opus-med",          "model": "claude-opus-5-5",   "effort": "medium" },
    { "name": "opus-sonnet-subs",  "model": "claude-opus-5-5",   "effort": "high", "subagentModel": "claude-sonnet-5-5" },
    { "name": "opus-haiku-subs",   "model": "claude-opus-5-5",   "effort": "high", "subagentModel": "claude-haiku-4-5-20251001" },
    { "name": "sonnet-high",       "model": "claude-sonnet-5-5", "effort": "high" },
    { "name": "sonnet-haiku-subs", "model": "claude-sonnet-5-5", "effort": "high", "subagentModel": "claude-haiku-4-5-20251001" },
    { "name": "haiku",             "model": "claude-haiku-4-5-20251001" }
  ]
}
```

- `model`, `effort` (`low | medium | high | xhigh | max`) and `subagentModel` are optional; an
  omitted field falls back to production config, so a variant with no overrides is "what runs
  today".
- `baseline` must name a variant. `maxUsd` caps the whole run, judge included.
- Setting `effort` on a Haiku model logs a warning: Haiku 4.5 does not support effort and the
  SDK drops it silently, so the report must not imply an effect that never happened.
- Model strings are not validated against a list; an unknown model fails at SDK call time and is
  recorded as a failed variant.

### 3. Runner changes (`agent-runner.ts`)

`AgentRunOptions` gains:

- `model?: string` — overrides `config.claudeModel`.
- `effort?: EffortLevel` — passed as the SDK `effort` option.
- `subagentModel?: string` — passed as `env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL }`.
  The SDK `env` option replaces the environment, so it must be spread.
- `allowedTools?: string[]` — replaces `ALLOWED_TOOLS` (the judge runs read-only).
- `env?: Record<string, string | undefined>` — base environment for the child, used by
  subscription auth (section 5). Defaults to `process.env`.

`AgentRunResult` gains:

- `modelUsage: Record<string, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }>`
  from the **last** `result` message. Like `total_cost_usd` it is cumulative per query and is
  never summed across results. The first real run checks that per-model costs add up to
  `total_cost_usd`; if they do not, the assumption is wrong and this section gets revised.
- `durationMs` from the last result.
- `rateLimit?: { type, status, resetsAt }` — the last `rate_limit_event` seen.
- `assistantError?: string` — the last `SDKAssistantMessageError` (`rate_limit`,
  `invalid_request`, …), used to classify failures.

At run end `runAgent` logs one line per model, e.g.
`claude-sonnet-5-5: 1.2M in / 40k out / 900k cache-read / 80k cache-write — $3.10`. This is the
only production-visible change, and it makes VM logs show where real jobs spend.

Pipeline plumbing: `PhaseContext` gains optional `agentOverrides: { model?, effort?, subagentModel?, env? }`,
which `runPhaseAgent` forwards to `deps.runAgent`. Production leaves it unset.

`createWorktree` gains an optional `ref` argument (default `refs/remotes/origin/<defaultBranch>`)
so experiment worktrees can be pinned to frozen SHAs.

### 4. Experiment flow

`bun run experiment plan <workItemId> [--variants <file>] [--only a,b]
[--answers <file>] [--questions <file>] [--auth subscription|api-key]`

(later: `--repeat N`, `--resume <runId>`, `--force`)

New module `src/services/experiment.ts` (pure orchestration, dependencies injected like the
pipeline) plus a report module `src/services/experiment-report.ts`.

1. **Preflight (later).** One tiny Haiku query confirms the auth mode actually in use and reads
   current rate-limit utilization. Wrong auth aborts. With subscription auth, utilization above
   80% on any window warns and requires `--force`. v1 only logs the auth mode it selected.
2. **Freeze input** (later: skipped with `--resume`, which reuses the run's `input.json`):
   - Read-only fetch of the work item and comments; build the context with the existing
     `buildWorkItemContext`.
   - Download every `http(s)` link in the description that looks like an API doc (`.json`,
     `.yaml`, `.yml`, or a path containing `swagger`/`openapi`) into `input/docs/`, with a 60 s
     timeout (the Ponto dev container app cold-starts in ~11 s). Append a short section to the
     frozen context listing the local copies, so every variant reads identical docs. A failed
     download is recorded and the run continues.
   - `--answers <file>`: appended to the comments as a synthetic comment, so the planner sees
     local answers exactly as it would see ADO answers. `--questions <file>` (the baseline's
     `plan/questions.json`) makes this a follow-up round: `clarifyRounds = 1` and the file is
     passed as `previousQuestions`, matching the production follow-up prompt.
   - Record the current `origin/<defaultBranch>` SHA of both repos.
3. **Per variant** (sequential; later: × repeat, and skipped when `usage.json` already exists
   under `--resume`):
   - Fresh worktree pair at the frozen SHAs; skills wired and git excludes added as in
     production.
   - `PhaseContext` with an in-memory `StateStore`, `jobMaxBudgetUsd` set to what is left of
     `maxUsd`, and the variant's `agentOverrides`. The existing `runPhaseAgent` cap logic then
     enforces the experiment cap.
   - ADO write deps (`addWorkItemComment`, `swapWorkItemTags`, `createPullRequest`,
     `uploadAttachment`, `linkAttachmentToWorkItem`) and `commitAndPush` are stubs that
     **throw**, so a bug cannot touch the real work item or push.
   - Call the real `runPlanningPhase`.
   - Copy `plan/` artifacts, design doc and task list into `runs/.../<variant>/`.
   - Write `usage.json`: status, cost, `modelUsage`, turns, `durationMs`, rate-limit waits,
     blocking / ambiguity counts, task count, whether a design doc was produced.
     Status is `ok | failed | budget-stopped | rate-limited | context-overflow`;
     `context-overflow` is best-effort, from `assistantError` and the result text.
4. **Judge.** One run per successful non-baseline variant on `judgeModel`, read-only tools
   (`Read`, `Glob`, `Grep`), `cwd` = the run directory. It sees `input.json` plus the two
   variants' plans labelled **A** and **B in random order**, and writes `judge/<variant>.json`:
   - scores 1–5 for **coverage** (auth / export / import / assisted setup all planned),
     **correctness** (matches work item and API docs, no invented endpoints), **pattern fit**
     (reuses the reference bank, no `needless-object` defects), **task actionability** (a builder
     could execute each task), **question quality** (blocking questions are real, not redundant);
   - a verdict of the variant against the baseline:
     `equivalent | minor-gaps | major-gaps | better`;
   - concrete missing or wrong items, each citing the design-doc section.
   The judge's cost is reported separately from variant costs. The orchestrator maps A/B back to
   variant names; the judge never sees them.
5. **Report** (section 6).

### 5. Auth and rate limits

- `--auth subscription` (the default for `experiment`) strips `ANTHROPIC_API_KEY` from the child
  environment, so the Claude Code binary falls back to the logged-in `~/.claude` credentials
  (the user's Team seat). `loadConfig` accepts a missing `ANTHROPIC_API_KEY` for this command
  only. `--auth api-key` behaves like production.
- Production keeps its own `ANTHROPIC_API_KEY`, as `CLAUDE.md` requires.
- USD figures are the SDK's computed cost at API list price whatever the auth is. The report
  labels them **API-equivalent USD** — the number production would pay.
- Rate limits, from `rate_limit_event`:
  - v1: any rejection marks the variant `rate-limited` (not `failed`), stops the sweep and
    writes a partial report naming the limit type and `resetsAt`.
  - later: `five_hour` rejected sleeps until `resetsAt` + 2 min and re-runs the variant from
    scratch, recording the partial run's cost as wasted; `seven_day*` still stops, and
    `--resume` continues.
- Before relying on subscription auth for large sweeps, confirm the Team plan terms allow
  scripted Agent SDK use on a seat. This is an open question, not a settled fact.

### 6. Report

`runs/<id>/<runId>/report.md`:

- Header: work item, frozen SHAs, auth mode, judge model, total spend, rate-limit waits, failed
  doc downloads.
- Summary table, one row per variant, sorted by cost: status, API-equivalent USD, % of baseline
  cost, turns, wall time excluding waits, judge verdict, the five rubric scores.
- Cost breakdown per variant and model: input, output, cache-read and cache-write tokens, USD.
  Shows subagent spend against orchestrator spend.
- Gaps per variant: the judge's concrete items.
- **Cheapest good-enough:** the cheapest variant with verdict `equivalent` or `better` and no
  score below 4. A suggestion; the human decides.
- (later) With `--repeat N`: mean and min–max per metric, and a noise warning when repeats of
  one variant disagree on the verdict.
- A warning when any variant stopped at `questions.json` without a design doc, since then only
  questions were compared.

`results.json` carries the same data machine-readably.

`findings/TEMPLATE.md`: question, work item, run IDs, variants, key numbers, judge verdicts,
decision, and config change made (or "none").

## Accepted limitations

- Single-sample runs are noisy. One work item and one repeat can suggest, not prove; findings
  should say how many samples they rest on.
- An LLM judge can be wrong. Its scores rank; the human reads the gaps before deciding.
- Freezing the linked API docs appends a short section to the prompt that production does not
  have. This is a small, deliberate difference that buys identical inputs.
- v1 has no `--repeat`, so every finding rests on one sample per variant until repeats land.
- v1 stops at the first rate-limit rejection; a long sweep on subscription auth may need to be
  split with `--only` across sessions until sleep-and-retry lands. When it does, a variant that
  hits a five-hour limit is re-run from scratch rather than resumed, because resuming a
  half-finished planner session would not be comparable.

## Testing

- `agent-runner`: overrides reach `query()` options (`model`, `effort`, `env` with
  `CLAUDE_CODE_SUBAGENT_MODEL`, `allowedTools`); `modelUsage` is taken from the last result, not
  summed; rate-limit events and assistant errors are captured. The `query` import is made
  injectable for this.
- `config`: variant schema accepts the example, rejects an unknown `baseline`, warns on
  Haiku + effort; `ANTHROPIC_API_KEY` is optional only in subscription mode.
- `experiment`: with fake deps — input is frozen once and every variant receives the same
  context and SHAs; `--only` filters variants; ADO write stubs throw when called; the budget
  passed down shrinks as variants spend; a rate-limit rejection stops the sweep with a partial
  report; `--answers` becomes a comment and `--questions` sets `clarifyRounds = 1`.
- `experiment-report`: table ordering, % of baseline, cheapest good-enough selection,
  questions-only warning, partial-report header.
- `pipeline`: `agentOverrides` is forwarded; unset in production paths.
- Manual: one real two-variant run on work item 83634 with `--only opus-high,opus-haiku-subs`,
  checking that per-model costs sum to `total_cost_usd`.

## Files touched

- `src/services/agent-runner.ts` — overrides, usage capture, per-model log line
- `src/services/pipeline.ts` — `agentOverrides` on `PhaseContext`, forwarded in `runPhaseAgent`
- `src/services/workspace.ts` — optional `ref` on `createWorktree`
- `src/services/experiment.ts` — new, orchestration
- `src/services/experiment-report.ts` — new, report and results
- `src/config/experiment.ts` — new, variant schema
- `src/config/index.ts` — optional API key for subscription mode
- `src/types/index.ts` — result and override types
- `src/cli/index.ts` — `experiment` command
- `package.json` — `experiment` script
- `.gitignore` — `experiments/runs/`
- `experiments/README.md`, `experiments/variants/planning-baseline.json`,
  `experiments/findings/TEMPLATE.md` — new
- `CLAUDE.md`, `README.md` — document the command and folder
- `tests/services/agent-runner.test.ts`, `tests/services/experiment.test.ts`,
  `tests/services/experiment-report.test.ts`, `tests/config/experiment.test.ts`,
  `tests/services/pipeline.test.ts`
