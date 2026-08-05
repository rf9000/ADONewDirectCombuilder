# Plan Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pipeline resume at the recorded phase instead of re-running planning on every entry.

**Why it pays:** measured on work item 80969, a planning pass costs $2.31 and implement costs **$37.77**. Today a VM stop 25 minutes into implement re-enters at planning and walks forward through implement again, so the redo is the $37.77 — not the $2.31 the visible symptom suggests. Tasks 5 and 6 are where that saving lands.

**Architecture:** `processItem` currently calls `runPlanningPhase` unconditionally. A pure `resolveEntryPhase` decides where to enter from the recorded phase, artifact availability, and whether unmarked comments arrived since the plan. Worktrees survive failure so resume has something to resume from, and `changeSummary` moves into an artifact so `publishing` can be entered directly.

**Tech Stack:** Bun + TypeScript, Zod for env config, `bun:test` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-plan-resume-design.md`

## Global Constraints

- Runtime is Bun; tests are `bun:test`. Run with `bun test`, typecheck with `bun run typecheck`.
- Every service dependency goes through the `PipelineDeps` interface so tests need no network, git, or Claude. Add new deps there and to `defaultDeps`.
- Never claim tests passed without `verify/result.json` saying so — a missing artifact is a failure.
- Never open a pull request when verification failed.
- The agent contract is unchanged: agents read and write `.agent/` in their cwd. Only the orchestrator's use of those files changes.
- `JobPhase` is `'new' | 'planning' | 'awaiting-answers' | 'implementing' | 'verifying' | 'publishing' | 'done' | 'failed'`.
- Bot comment marker is exactly `<!-- new-comm-builder -->`.
- Artifact paths live on `PhasePaths` (`src/services/prompts.ts`); add new ones there rather than hardcoding strings.

---

### Task 1: Bot comment marker and predicate

**Files:**
- Modify: `src/services/prompts.ts`
- Test: `tests/services/prompts.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `BOT_COMMENT_MARKER: string`, `isBotComment(text: string): boolean`. Task 5 uses both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/services/prompts.test.ts`:

```ts
describe('bot comment marker', () => {
  test('every comment the pipeline posts carries the marker', () => {
    const questions: PlanQuestions = {
      blocking: [{ question: 'Which auth flow?' }],
      ambiguities: [],
    };

    // A new comment type added without a marker would make staleness
    // detection permanently re-plan, so assert on every builder.
    expect(buildQuestionsComment(mockConfig(), questions, 1, false)).toContain(
      BOT_COMMENT_MARKER,
    );
    expect(buildQuestionsComment(mockConfig(), questions, 3, true)).toContain(
      BOT_COMMENT_MARKER,
    );
  });

  test('isBotComment matches only marked text', () => {
    expect(isBotComment(`<!-- new-comm-builder -->\n<b>hi</b>`)).toBe(true);
    expect(isBotComment('I answered your questions')).toBe(false);
    expect(isBotComment('')).toBe(false);
  });

  test('the marker is stripped from prompt text', () => {
    expect(htmlToText(`${BOT_COMMENT_MARKER}\nplain`)).toBe('plain');
  });
});
```

Add `BOT_COMMENT_MARKER` and `isBotComment` to the existing import block from `../../src/services/prompts.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/prompts.test.ts`
Expected: FAIL — `BOT_COMMENT_MARKER` is not exported.

- [ ] **Step 3: Implement**

In `src/services/prompts.ts`, above `buildQuestionsComment`:

```ts
/**
 * Hidden sentinel on every comment this pipeline posts.
 *
 * Staleness detection has to ignore our own comments, or every retry sees
 * "new comments" and resume never engages. Author is not usable as the
 * discriminator: `createdBy.uniqueName` is the PAT owner, who is also likely
 * to be the person answering, and it breaks outright once the agent gets its
 * own service account or several people take turns re-triggering a job.
 *
 * `htmlToText` strips `<[^>]+>`, so this reaches neither the agent's prompt
 * nor the ADO comment editor.
 */
export const BOT_COMMENT_MARKER = '<!-- new-comm-builder -->';

export function isBotComment(text: string): boolean {
  return text.includes(BOT_COMMENT_MARKER);
}
```

Then make `buildQuestionsComment` emit it as the first line — change its opening array from:

```ts
  const lines: string[] = [
    `<b>Bank integration planner — round ${round}: input needed</b>`,
```

to:

```ts
  const lines: string[] = [
    BOT_COMMENT_MARKER,
    `<b>Bank integration planner — round ${round}: input needed</b>`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/services/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Find every other comment builder and mark it**

Run: `grep -n "export function build.*Comment" src/services/prompts.ts src/services/pipeline.ts`

For each builder found (expect `buildSuccessComment` and the failure comment builder in `pipeline.ts`), add `BOT_COMMENT_MARKER` as the first line of its output the same way, and add a `toContain(BOT_COMMENT_MARKER)` assertion for it to the test from Step 1.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/prompts.ts src/services/pipeline.ts tests/services/prompts.test.ts
git commit -m "Mark every pipeline-authored comment with a hidden sentinel

Staleness detection must ignore our own comments or resume never engages.
Author is not a usable discriminator: the PAT owner is also the likely
answerer, and it breaks when the agent gets its own account or several
people take turns re-triggering."
```

---

### Task 2: `failedAtPhase` on the job record

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/state/state-store.ts` (only if it constructs `JobRecord` literals)
- Test: `tests/state/state-store.test.ts`

**Interfaces:**
- Consumes: `JobPhase` from `src/types/index.ts`
- Produces: `JobRecord.failedAtPhase?: JobPhase`. Tasks 3 and 5 read it; Task 6 writes it.

- [ ] **Step 1: Write the failing test**

Append to `tests/state/state-store.test.ts`:

```ts
test('persists failedAtPhase across a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const store = new StateStore(dir);
  store.ensure(42);
  store.update(42, { phase: 'failed', failedAtPhase: 'implementing' });
  store.save();

  const reloaded = new StateStore(dir);
  expect(reloaded.get(42)?.failedAtPhase).toBe('implementing');

  rmSync(dir, { recursive: true, force: true });
});
```

Match the existing imports and helper style in that file; if it already has a temp-dir helper, use it instead of inlining `mkdtempSync`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/state/state-store.test.ts`
Expected: FAIL — `failedAtPhase` is not a property of the update type.

- [ ] **Step 3: Implement**

In `src/types/index.ts`, inside `interface JobRecord`, after the `error` field:

```ts
  /**
   * Phase that threw, when phase is 'failed'. A retry resumes here instead of
   * re-planning from scratch.
   */
  failedAtPhase?: JobPhase;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/state/state-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts tests/state/state-store.test.ts
git commit -m "Record which phase failed on the job record"
```

---

### Task 3: `resolveEntryPhase`

**Files:**
- Create: `src/services/entry-phase.ts`
- Test: `tests/services/entry-phase.test.ts`

**Interfaces:**
- Consumes: `JobPhase`, `JobRecord` from `src/types/index.ts`
- Produces:

```ts
export interface PhaseInputs {
  taskList: boolean;        // plan/tasklist.json present
  implementSummary: boolean; // implement/summary.json present
  verifyResult: boolean;     // verify/result.json present
}

export interface EntryDecision {
  phase: JobPhase;          // always one of planning|implementing|verifying|publishing
  reason: string;           // one line, for the log
  cleanWorkspace: boolean;  // true when phase === 'planning'
}

export function resolveEntryPhase(
  job: Pick<JobRecord, 'phase' | 'failedAtPhase'>,
  inputs: PhaseInputs,
  hasNewComments: boolean,
): EntryDecision;
```

Task 5 calls this. Keep it free of filesystem and config access so the table stays testable.

- [ ] **Step 1: Write the failing tests**

Create `tests/services/entry-phase.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { resolveEntryPhase } from '../../src/services/entry-phase.ts';
import type { PhaseInputs } from '../../src/services/entry-phase.ts';

const all: PhaseInputs = {
  taskList: true,
  implementSummary: true,
  verifyResult: true,
};
const none: PhaseInputs = {
  taskList: false,
  implementSummary: false,
  verifyResult: false,
};

describe('resolveEntryPhase', () => {
  test('a fresh job plans', () => {
    const d = resolveEntryPhase({ phase: 'new' }, none, false);
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(true);
  });

  test('awaiting-answers re-plans — the clarify loop is unchanged', () => {
    expect(resolveEntryPhase({ phase: 'awaiting-answers' }, all, false).phase).toBe(
      'planning',
    );
  });

  test('resumes forward from a mid-flight phase', () => {
    expect(resolveEntryPhase({ phase: 'implementing' }, all, false).phase).toBe(
      'implementing',
    );
    expect(resolveEntryPhase({ phase: 'verifying' }, all, false).phase).toBe('verifying');
    expect(resolveEntryPhase({ phase: 'publishing' }, all, false).phase).toBe(
      'publishing',
    );
  });

  test('resuming forward does not clean the workspace', () => {
    expect(resolveEntryPhase({ phase: 'implementing' }, all, false).cleanWorkspace).toBe(
      false,
    );
  });

  test('a failed job resumes where it failed', () => {
    const d = resolveEntryPhase(
      { phase: 'failed', failedAtPhase: 'verifying' },
      all,
      false,
    );
    expect(d.phase).toBe('verifying');
  });

  test('a failed job with no recorded phase plans', () => {
    expect(resolveEntryPhase({ phase: 'failed' }, all, false).phase).toBe('planning');
  });

  test('new unmarked comments force a re-plan over any recorded phase', () => {
    const d = resolveEntryPhase({ phase: 'publishing' }, all, true);
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(true);
    expect(d.reason).toContain('comment');
  });

  test('falls back to the first phase whose inputs exist', () => {
    // Recorded at publishing, but the volume was pruned.
    const d = resolveEntryPhase({ phase: 'publishing' }, none, false);
    expect(d.phase).toBe('planning');
    expect(d.reason).toContain('tasklist.json');
  });

  test('falls back only as far as needed', () => {
    const d = resolveEntryPhase(
      { phase: 'publishing' },
      { taskList: true, implementSummary: true, verifyResult: false },
      false,
    );
    expect(d.phase).toBe('verifying');
    expect(d.reason).toContain('result.json');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/entry-phase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/services/entry-phase.ts`:

```ts
import type { JobPhase, JobRecord } from '../types/index.ts';

/** Which phase artifacts exist on disk right now. */
export interface PhaseInputs {
  /** plan/tasklist.json */
  taskList: boolean;
  /** implement/summary.json */
  implementSummary: boolean;
  /** verify/result.json */
  verifyResult: boolean;
}

export interface EntryDecision {
  phase: JobPhase;
  reason: string;
  cleanWorkspace: boolean;
}

/** Phases the pipeline can be entered at, in run order. */
const ORDER: JobPhase[] = ['planning', 'implementing', 'verifying', 'publishing'];

/** What each entry point needs, and what to say when it is missing. */
const REQUIRES: Partial<Record<JobPhase, Array<[keyof PhaseInputs, string]>>> = {
  implementing: [['taskList', 'plan/tasklist.json']],
  verifying: [['implementSummary', 'implement/summary.json']],
  publishing: [
    ['implementSummary', 'implement/summary.json'],
    ['verifyResult', 'verify/result.json'],
  ],
};

function decide(phase: JobPhase, reason: string): EntryDecision {
  return { phase, reason, cleanWorkspace: phase === 'planning' };
}

/**
 * Decide where to enter the pipeline.
 *
 * Pure by design: availability is computed by the caller and passed in, so the
 * whole table is testable without a filesystem.
 */
export function resolveEntryPhase(
  job: Pick<JobRecord, 'phase' | 'failedAtPhase'>,
  inputs: PhaseInputs,
  hasNewComments: boolean,
): EntryDecision {
  // A human answered something since we planned, so the plan is stale
  // regardless of how far the job had got.
  if (hasNewComments) {
    return decide('planning', 'a new comment arrived since the plan was made');
  }

  let wanted: JobPhase;
  switch (job.phase) {
    case 'implementing':
    case 'verifying':
    case 'publishing':
      wanted = job.phase;
      break;
    case 'failed':
      wanted = job.failedAtPhase ?? 'planning';
      break;
    default:
      // new, planning, awaiting-answers, done
      wanted = 'planning';
  }

  // Walk backwards to the first phase whose inputs are all present.
  for (let i = ORDER.indexOf(wanted); i > 0; i -= 1) {
    const phase = ORDER[i]!;
    const missing = (REQUIRES[phase] ?? []).find(([key]) => !inputs[key]);
    if (!missing) {
      return decide(
        phase,
        phase === wanted ? `resuming at ${phase}` : `resuming at ${phase} after fallback`,
      );
    }
    return decide(
      ORDER[i - 1]!,
      `cannot enter ${phase}: ${missing[1]} is missing — falling back`,
    );
  }

  return decide('planning', wanted === 'planning' ? 'planning' : 'falling back to planning');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/services/entry-phase.test.ts`
Expected: PASS. If the two fallback tests disagree with the loop, fix the loop rather than the tests — the spec's rule is "walk backwards to the first phase whose inputs are all present", one step at a time.

- [ ] **Step 5: Commit**

```bash
git add src/services/entry-phase.ts tests/services/entry-phase.test.ts
git commit -m "Add resolveEntryPhase: decide where to enter the pipeline

Pure function over the recorded phase, artifact availability and whether
unmarked comments arrived. Availability is passed in so the dispatch table
is testable without a filesystem."
```

---

### Task 4: `changeSummary` becomes an artifact

**Files:**
- Modify: `src/services/prompts.ts` (add `implementSummaryPath` to `PhasePaths`)
- Modify: `src/services/pipeline.ts` (`pathsFor`, `runImplementPhase`, `runPublishPhase`)
- Test: `tests/services/pipeline.test.ts`

**Interfaces:**
- Consumes: `PhasePaths` from `src/services/prompts.ts`
- Produces: `PhasePaths.implementSummaryPath`. `runPublishPhase` no longer takes a `changeSummary` argument; it reads `{ summary: string }` from that path. Task 5 relies on that signature.

- [ ] **Step 1: Write the failing test**

Add to `tests/services/pipeline.test.ts`:

```ts
test('publish reads the change summary from the artifact, not an argument', async () => {
  const deps = makeDeps();
  // The implement phase writes summary.json; publish must pick it up.
  deps.readJsonArtifact = mock((path: string) =>
    path.endsWith('summary.json') ? { summary: 'from artifact' } : undefined,
  );

  // Drive a job that is already past implement so publish runs on its own.
  // (Use the harness's existing helper for running processItem with a phase.)
  const result = await runProcessItemAtPhase('publishing', deps);

  expect(result.phase).toBe('done');
  const prBody = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls[0]?.[1];
  expect(JSON.stringify(prBody)).toContain('from artifact');
});
```

If `tests/services/pipeline.test.ts` has no `runProcessItemAtPhase` helper, add one that seeds the store with a phase and calls `processItem` with mocked deps — it is needed by Task 5 as well, so build it here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/services/pipeline.test.ts`
Expected: FAIL — publish still requires the argument.

- [ ] **Step 3: Add the path**

In `src/services/prompts.ts`, inside `interface PhasePaths`:

```ts
  /** Where the implement phase records what it changed, for publish to read. */
  implementSummaryPath: string;
```

In `src/services/pipeline.ts`, in `pathsFor`, add alongside the existing entries:

```ts
    implementSummaryPath: join(banking, AGENT_DIR, 'implement', 'summary.json'),
```

and extend the existing `mkdirSync` calls in `prepareWorkspaces` so the directory exists:

```ts
  mkdirSync(join(banking, AGENT_DIR, 'implement'), { recursive: true });
```

- [ ] **Step 4: Write the summary in implement, read it in publish**

At the end of `runImplementPhase`, after the agent run succeeds, write the artifact rather than only returning the value:

```ts
  writeFileSync(
    ctx.paths.implementSummaryPath,
    JSON.stringify({ summary }, null, 2),
    'utf-8',
  );
  return summary;
```

Change `runPublishPhase`'s signature from `(ctx, changeSummary, verify)` to `(ctx, verify)` and read the summary at the top:

```ts
  const summary =
    ctx.deps.readJsonArtifact<{ summary?: string }>(ctx.paths.implementSummaryPath)
      ?.summary ?? '(no change summary recorded)';
```

Update the call site in `processItem` to `runPublishPhase(ctx, verify)` and delete the now-unused `changeSummary` local if nothing else reads it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/prompts.ts src/services/pipeline.ts tests/services/pipeline.test.ts
git commit -m "Hand the change summary to publish through an artifact

Publish took it as an in-memory argument from implement, which made
entering at publishing impossible. Brings implement in line with plan and
verify, which already hand off through files."
```

---

### Task 5: Dispatch in `processItem`

**Files:**
- Modify: `src/services/pipeline.ts`
- Test: `tests/services/pipeline.test.ts`

**Interfaces:**
- Consumes: `resolveEntryPhase`, `PhaseInputs` (Task 3); `isBotComment` (Task 1); `PhasePaths.implementSummaryPath` (Task 4)
- Produces: nothing new — `processItem` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Add to `tests/services/pipeline.test.ts`:

```ts
test('entering at verifying skips implement', async () => {
  const deps = makeDeps();
  await runProcessItemAtPhase('verifying', deps);
  expect((deps.runAgent as ReturnType<typeof mock>).mock.calls.map((c) => c[2]?.logFile))
    .not.toContain(expect.stringContaining('implement'));
});

test('entering at planning cleans the workspace first', async () => {
  const deps = makeDeps();
  await runProcessItemAtPhase('new', deps);
  expect(deps.removeAllWorktrees).toHaveBeenCalled();
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
  // lastSeenCommentId is 10; the only newer comment is ours.
  const result = await runProcessItemAtPhase('failed', deps, {
    failedAtPhase: 'implementing',
    lastSeenCommentId: 10,
  });
  expect(result.phase).toBe('done');
  expect((deps.runAgent as ReturnType<typeof mock>).mock.calls.map((c) => c[2]?.logFile))
    .not.toContain(expect.stringContaining('plan-'));
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
  });
  expect((deps.runAgent as ReturnType<typeof mock>).mock.calls.map((c) => c[2]?.logFile))
    .toContain(expect.stringContaining('plan-'));
});
```

Extend `runProcessItemAtPhase` to accept an optional partial `JobRecord` for seeding `failedAtPhase` and `lastSeenCommentId`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/pipeline.test.ts`
Expected: FAIL — planning still runs unconditionally.

- [ ] **Step 3: Implement the dispatch**

In `src/services/pipeline.ts`, add imports:

```ts
import { resolveEntryPhase } from './entry-phase.ts';
import type { PhaseInputs } from './entry-phase.ts';
```

Replace the `// ---- plan, and loop back to the human ----` block. Before `prepareWorkspaces`, compute comment staleness:

```ts
    const comments = await deps.getWorkItemComments(config, item.id);
    const existing = store.get(item.id);
    const newestHumanCommentId = comments
      .filter((c) => !prompts.isBotComment(c.text ?? ''))
      .reduce((max, c) => Math.max(max, c.id), 0);
    const hasNewComments =
      existing !== undefined && newestHumanCommentId > existing.lastSeenCommentId;
```

After `prepareWorkspaces` returns the worktrees and `paths` is available, resolve and act:

```ts
    const paths = pathsFor(worktrees.banking);
    const inputs: PhaseInputs = {
      taskList: existsSync(paths.taskListPath),
      implementSummary: existsSync(paths.implementSummaryPath),
      verifyResult: existsSync(paths.verifyResultPath),
    };

    const entry = resolveEntryPhase(
      existing ?? { phase: 'new' },
      inputs,
      hasNewComments,
    );
    log(`  Item #${item.id}: entering at ${entry.phase} — ${entry.reason}`);
```

When `entry.cleanWorkspace` is true, wipe and rebuild before continuing — `createWorktree` returns an existing directory untouched (`workspace.ts:183`), so without this a "fresh" run inherits the previous plan's artifacts and partial code:

```ts
    if (entry.cleanWorkspace && Object.keys(existing?.worktrees ?? {}).length > 0) {
      await deps.removeAllWorktrees(config, item.id);
      worktrees = await prepareWorkspaces(config, item, branch, deps);
    }
```

Then guard each phase on the entry point. Use an index comparison so "run forward from here" stays obvious:

```ts
    const order: JobPhase[] = ['planning', 'implementing', 'verifying', 'publishing'];
    const from = order.indexOf(entry.phase);
    const runs = (phase: JobPhase) => order.indexOf(phase) >= from;

    if (runs('planning')) {
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
    }

    if (runs('implementing')) {
      await runImplementPhase(ctx);
      const anyChanges =
        (await deps.hasChanges(config, worktrees.banking)) ||
        (await deps.hasChanges(config, worktrees.setupFiles));
      if (!anyChanges) {
        throw new Error(
          'The implement phase produced no file changes — nothing to review, so no PR was opened.',
        );
      }
    }
```

Keep the verify and publish blocks as they are, wrapped in `runs('verifying')` and `runs('publishing')`. Verify still reads its result from `verify/result.json`, so a resumed `publishing` needs no special case.

Ensure `worktrees` is declared with `let` rather than `const` so the clean-workspace branch can reassign it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/pipeline.ts tests/services/pipeline.test.ts
git commit -m "Dispatch to the recorded phase instead of always planning

processItem called runPlanningPhase unconditionally, so the persisted phase
was written faithfully and ignored on re-entry. Measured on work item 80969,
that means an interruption 25 minutes into implement redoes a \$37.77 phase,
not the \$2.31 planning pass the symptom points at. Entry is now resolved from the phase,
artifact availability, and whether an unmarked comment arrived since the
plan. Landing on planning wipes the worktrees first, because createWorktree
reuses an existing directory and a fresh run would otherwise inherit the
previous plan's artifacts."
```

---

### Task 6: Keep worktrees on failure, record `failedAtPhase`

**Files:**
- Modify: `src/services/pipeline.ts`
- Test: `tests/services/pipeline.test.ts`

**Interfaces:**
- Consumes: `JobRecord.failedAtPhase` (Task 2)
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

```ts
test('a failed job keeps its worktrees so a retry can resume', async () => {
  const deps = makeDeps();
  deps.runAgent = mock(async () => {
    throw new Error('kaboom');
  });
  await runProcessItemAtPhase('new', deps);
  // Only the pre-dispatch clean for a fresh job — never a post-failure wipe.
  expect((deps.removeAllWorktrees as ReturnType<typeof mock>).mock.calls.length).toBeLessThanOrEqual(1);
});

test('records the phase that failed', async () => {
  const deps = makeDeps();
  deps.runAgent = mock(async () => {
    throw new Error('kaboom');
  });
  const store = await runProcessItemAtPhaseReturningStore('implementing', deps);
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
```

Existing tests that assert worktrees are removed on failure must be inverted here rather than deleted — the behaviour is deliberately reversed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/pipeline.test.ts`
Expected: FAIL — the catch block still removes worktrees and records no phase.

- [ ] **Step 3: Implement**

In the `catch` block of `processItem`, record the phase and stop deleting:

```ts
    store.update(item.id, {
      phase: 'failed',
      failedAtPhase: store.get(item.id)?.phase,
      error: message,
    });
    store.save();
```

Delete these three lines and the comment above them:

```ts
    // Leave nothing behind: a retry re-clones from the current default branch.
    await deps.removeAllWorktrees(config, item.id).catch(() => undefined);
    store.update(item.id, { worktrees: {} });
    store.save();
```

Replace with a comment recording why:

```ts
    // Worktrees are deliberately kept: the plan artifacts and any partial build
    // live in them, and a retry resumes at failedAtPhase rather than re-planning.
    // `cleanup-worktrees <id>` reclaims the disk when a job is abandoned.
```

In the failure comment builder, add the reclaim instruction next to the retry line:

```ts
    `If you do not intend to retry, run <code>cleanup-worktrees ${item.id}</code> ` +
      'on the host to reclaim the disk — the worktrees are kept so a retry can resume.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/pipeline.ts tests/services/pipeline.test.ts
git commit -m "Keep worktrees on failure so a retry can resume

The failure path deleted the worktrees the plan artifacts live in, so the
failure that recorded where to resume destroyed what resuming needs.
Re-cloning from a fresh base was buying cleanliness at that cost. The
failure comment now names cleanup-worktrees for abandoned jobs."
```

---

### Task 7: Attachment SDK functions

**Files:**
- Modify: `src/sdk/azure-devops-client.ts`
- Test: `tests/sdk/azure-devops-client.test.ts`

**Interfaces:**
- Consumes: `adoFetchWithRetry`, `AppConfig`
- Produces:

```ts
export interface UploadedAttachment { id: string; url: string }
export function uploadAttachment(config, fileName: string, content: string | Buffer): Promise<UploadedAttachment>
export function linkAttachmentToWorkItem(config, workItemId: number, attachmentUrl: string, name: string, comment: string): Promise<WorkItemResponse>
```

Task 8 calls both. Shapes follow `DevOpsdocsWriter/src/sdk/azure-devops-client.ts:321-364`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('attachments', () => {
  test('uploadAttachment posts the file name in the query', async () => {
    setMockFetch({ id: 'att-1', url: 'https://example/att-1' });
    const result = await uploadAttachment(mockConfig(), 'design doc.md', 'body');

    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/attachments');
    expect(url).toContain('fileName=design%20doc.md');
    expect(result.url).toBe('https://example/att-1');
  });

  test('linkAttachmentToWorkItem appends a relation', async () => {
    setMockFetch(mockWorkItem());
    await linkAttachmentToWorkItem(
      mockConfig(),
      42,
      'https://example/att-1',
      'design-doc.md',
      'Planning output',
    );

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: { rel: string };
    }>;
    // `add` on /relations/- is an array append — genuine JSON Patch, unlike
    // System.Tags where `add` merges. Do not "fix" this to replace.
    expect(body[0]!.op).toBe('add');
    expect(body[0]!.path).toBe('/relations/-');
    expect(body[0]!.value.rel).toBe('AttachedFile');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/sdk/azure-devops-client.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `src/sdk/azure-devops-client.ts`:

```ts
export interface UploadedAttachment {
  id: string;
  url: string;
}

/** Upload a file to the project's attachment store. Returns its id + url. */
export async function uploadAttachment(
  config: AppConfig,
  fileName: string,
  content: string | Buffer,
): Promise<UploadedAttachment> {
  const path = `wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.0`;
  return adoFetchWithRetry<UploadedAttachment>(config, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  });
}

/**
 * Link an uploaded attachment to a work item.
 *
 * `op: 'add'` on `/relations/-` appends to an array — real JSON Patch
 * semantics. This is the opposite of `System.Tags`, where `add` merges with the
 * existing value instead of replacing it. Do not "correct" this one to
 * `replace`.
 */
export async function linkAttachmentToWorkItem(
  config: AppConfig,
  workItemId: number,
  attachmentUrl: string,
  name: string,
  comment: string,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([
      {
        op: 'add',
        path: '/relations/-',
        value: { rel: 'AttachedFile', url: attachmentUrl, attributes: { name, comment } },
      },
    ]),
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/azure-devops-client.ts tests/sdk/azure-devops-client.test.ts
git commit -m "Add work item attachment upload and link

Shapes follow the docs-writer bot, which already does this."
```

---

### Task 8: Attach the design doc on success

**Files:**
- Modify: `src/services/pipeline.ts`
- Test: `tests/services/pipeline.test.ts`

**Interfaces:**
- Consumes: `uploadAttachment`, `linkAttachmentToWorkItem` (Task 7)
- Produces: nothing new

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/pipeline.test.ts`
Expected: FAIL — deps do not exist.

- [ ] **Step 3: Add the deps**

In `PipelineDeps`:

```ts
  uploadAttachment: typeof ado.uploadAttachment;
  linkAttachmentToWorkItem: typeof ado.linkAttachmentToWorkItem;
```

In `defaultDeps`:

```ts
  uploadAttachment: ado.uploadAttachment,
  linkAttachmentToWorkItem: ado.linkAttachmentToWorkItem,
```

In the test harness's `makeDeps()`:

```ts
    uploadAttachment: mock(async () => ({ id: 'att-1', url: 'https://example/att-1' })),
    linkAttachmentToWorkItem: mock(async () => undefined),
```

- [ ] **Step 4: Implement the call**

In `processItem`, on the success path after the tag swap and `store.setPhase(item.id, 'done')`, before `removeAllWorktrees`:

```ts
    // The design doc is the most valuable output of a run and the worktree is
    // about to be deleted, so put it somewhere durable and reviewable first.
    // Never fail a job for this: the PRs already exist by now.
    await (async () => {
      const docPath = ctx.paths.designDocPath;
      if (!existsSync(docPath)) return;
      const uploaded = await deps.uploadAttachment(
        config,
        `${item.id}-design-doc.md`,
        readFileSync(docPath, 'utf-8'),
      );
      await deps.linkAttachmentToWorkItem(
        config,
        item.id,
        uploaded.url,
        `${item.id}-design-doc.md`,
        'Planning output for this change',
      );
    })().catch((err) => {
      log(`  Item #${item.id}: could not attach the design doc — ${err}`);
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/pipeline.ts tests/services/pipeline.test.ts
git commit -m "Attach the design doc to the work item on success

Hours of adversarially-verified planning lived only in a worktree that
cleanup deletes. Attaching it first makes it durable and gives a reviewer
the reasoning behind the PR. Wrapped so an upload hiccup never fails a job
whose PRs already exist."
```

---

### Task 9: Update the claims in the docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/vm-bringup.md`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Correct `CLAUDE.md`**

The phase-machine bullet currently claims resume behaviour the code did not have. Replace it with:

```markdown
- **Phase machine** in `src/services/pipeline.ts`; every transition is persisted, and
  `resolveEntryPhase` dispatches to the recorded phase so a restart resumes rather than
  repeats. Entering at `planning` wipes the worktrees first; resuming forward reuses them.
  A newer comment the pipeline did not write forces a re-plan.
```

Add to the non-negotiables:

```markdown
- Never delete a worktree before its pull requests exist — the plan artifacts and any
  partial build live there, and a retry resumes from them
```

- [ ] **Step 2: Correct Phase J in the runbook**

Find the restart-behaviour step in `docs/vm-bringup.md` and state the expected outcome: a job killed mid-implement resumes at `implementing` and does **not** re-plan, verifiable by `plan-N.log` gaining no new run block while `implement.log` does.

- [ ] **Step 3: Run the full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/vm-bringup.md
git commit -m "Make the documented resume behaviour match the code"
```

---

## Verification (next session, on the VM)

These need the real pipeline and cost real money, so they are deliberately separate from the tasks above.

- [ ] Rebuild: `docker compose build new-comm-builder`
- [ ] Interrupt a job mid-implement (`Ctrl-C`), then re-run — confirm the log says `entering at implementing` and `plan-N.log` gains no new run block
- [ ] Post a comment on the work item, re-trigger — confirm the log says a new comment forced a re-plan
- [ ] Re-trigger with no new comment — confirm it resumes rather than re-planning
- [ ] Confirm a failed job's worktrees survive under `/data/worktrees/<WI>/`
- [ ] Confirm the design doc appears as an attachment on a successfully completed work item
