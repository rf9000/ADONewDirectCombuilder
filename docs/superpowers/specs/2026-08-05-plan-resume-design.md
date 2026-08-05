# Resume at the recorded phase instead of re-planning

**Date:** 2026-08-05
**Status:** approved, not yet implemented

## Problem

`CLAUDE.md` states that "every transition is persisted to the job record so a container
restart resumes rather than repeats." That is not what happens. `processItem` calls
`runPlanningPhase` unconditionally at `pipeline.ts:429`, before consulting the recorded
phase. The phase is written faithfully and then ignored on re-entry.

So planning re-runs on every one of these:

- each clarify round (intended — new answers arrived)
- a container restart or VM stop mid-implement (waste)
- a verification failure followed by a retry (waste)
- `reset-item` (intended)

Measured cost on work item 80969: a full four-domain planning pass with adversarial
verification takes roughly 40 minutes and produces a 136 KB design doc and a 191 KB task
list. A VM stop during round 2 cost that twice.

A second, compounding defect: the failure path deletes the worktrees
(`pipeline.ts:521`, *"Leave nothing behind: a retry re-clones from the current default
branch"*). The plan artifacts live inside those worktrees, so the failure that records
where to resume also destroys what resuming needs.

## Scope

In scope: resume at the recorded phase. The clarify loop is untouched — round N still
re-plans in full, because new answers should produce a fresh plan. Making clarification
incremental is a separate, larger question that touches the planner skill's contract
rather than the orchestrator, and is deliberately excluded here.

## Design

### 1. Dispatch on the recorded phase

A pure function replaces the unconditional planning call:

```
resolveEntryPhase(job, available) → JobPhase
```

| Recorded phase | Enters at | Reason |
|---|---|---|
| none / `new` | `planning` | fresh job |
| `awaiting-answers` | `planning` | the clarify loop, unchanged |
| `planning` | `planning` | never completed |
| `implementing` | `implementing` | resume forward |
| `verifying` | `verifying` | resume forward |
| `publishing` | `publishing` | resume forward |
| `failed` | `job.failedAtPhase ?? 'planning'` | retry where it broke |
| `done` | not reached — `shouldProcess` excludes it |

`failedAtPhase` is a new field on the job record, written in the existing `catch`
alongside `phase: 'failed'`. Today a failed job re-plans on retry; this resumes it where
it actually failed.

Once entered, the remaining phases run in the existing order with the existing logic.

### 2. Input availability and self-healing fallback

Each phase declares what it needs before it can be entered:

| Phase | Requires |
|---|---|
| `planning` | nothing beyond the work item and the worktrees |
| `implementing` | `plan/tasklist.json` |
| `verifying` | `implement/summary.json` |
| `publishing` | `implement/summary.json` and `verify/result.json` |

Resolution walks **backwards** from the resolved phase to the first phase whose inputs
are all present, logging each downgrade and naming the missing artifact. A job recorded
at `publishing` whose volume was pruned degrades to `planning` and says so in the log.

Availability is computed by the caller — `processItem` stats the artifact paths after
`prepareWorkspaces` and passes the result in. `resolveEntryPhase` itself touches no
filesystem, which is what makes the dispatch table testable as a pure function.

Rationale: the bot's premise is unattended operation. Halting because a directory
vanished trades a known cost for an unbounded delay. Corrupt artifacts need no separate
path — `readJsonArtifact` returns undefined, so they are indistinguishable from missing.

### 3. `changeSummary` becomes an artifact

`runImplementPhase` returns `changeSummary` in memory and `runPublishPhase` takes it as
an argument. Resuming at `publishing` is therefore impossible without it.

It moves to `.agent/implement/summary.json`, written by implement and read by publish.
This brings implement in line with plan and verify, which already hand off through files,
and satisfies the project's stated "JSON artifact handoff, not prose parsing" pattern.

### 4. Worktree lifetime: delete only after the PRs exist

The success path already removes worktrees after publish, the comment and the tag swap
(`pipeline.ts:503`). No change there.

**The failure-path removal at `pipeline.ts:521` is deleted.** Re-cloning from a fresh base
on retry was buying cleanliness by destroying the state that makes resume possible.

This yields the behaviour we want in both failure modes, without a separate artifact
store:

| Mode | What happens | Resume behaviour |
|---|---|---|
| **Interrupted** — VM stop, container kill | the `catch` never runs; worktree survives | continue on the partial worktree |
| **Failed** — a phase threw | `catch` runs; worktree now retained | resume that phase on the existing worktree |

The filesystem is the progress record. Phase-level granularity is sufficient; per-task
progress tracking inside implement is explicitly not part of this design.

Consequence: failed jobs retain two checkouts each. `cleanup-worktrees <id>` already
exists for this. The failure comment must name it alongside the retry instruction, so a
human reading the failure sees both options — retry, or reclaim the space.

### 5. Attach the design doc to the work item

Two SDK functions, following `DevOpsdocsWriter/src/sdk/azure-devops-client.ts:327-364`:

```
uploadAttachment(config, fileName, content) → { id, url }   // POST wit/attachments
linkAttachmentToWorkItem(config, id, url, name, comment)     // PATCH /relations/-
```

Both injected through `PipelineDeps`.

`op: 'add'` on `/relations/-` is correct — it appends to an array, which is real JSON
Patch semantics. This needs a code comment, because it is the opposite of the
`System.Tags` case where `add` merges instead of replacing. Someone who remembers that
bug will otherwise "fix" this one and break it.

Attach the design doc only. On success the PRs are the artifact and the task list has
served its purpose; on failure the worktree survives, so it remains on disk.

Call site: success path, after the PR comment and tag swap, immediately before
`removeAllWorktrees`. Wrapped in `.catch` with a log, as `reportFailure` already is — the
PRs exist by that point, and an attachment hiccup must not fail a job that succeeded.

## Accepted limitations

**Stale base commit.** A resumed worktree is based on `origin/main` as of its creation.
Resumed weeks later, the PR may conflict. Not bounded: a conflicting PR is loud rather
than silent, and bounding it means tracking base commits for a case the tag handshake
makes rare.

**No runaway retries**, by existing mechanism rather than new code: the failure path swaps
the trigger tag for `failedTag`, so the WIQL stops matching and the watcher will not
re-pick the job. A retry happens only when a human re-adds the trigger tag — which is
exactly when resuming at `failedAtPhase` is wanted.

## Testing

`resolveEntryPhase` is pure, so the dispatch table and the backwards fallback walk are a
table-driven unit test.

Against the existing mocked `PipelineDeps`:

- entering at `verifying` does not call `runImplementPhase`
- entering at `publishing` calls neither implement nor verify
- `failedAtPhase` is written when a phase throws
- `removeAllWorktrees` is **not** called on the failure path, and **is** on success
- implement writes `implement/summary.json`; publish reads it rather than receiving an
  argument
- attachment functions are called on success with the design doc; a throw from either
  leaves the job `done`

Existing tests assert today's behaviour — that failure removes worktrees — and will need
inverting. That is the change being real, not an obstacle to route around.

## Files touched

| File | Change |
|---|---|
| `src/services/pipeline.ts` | dispatch, `failedAtPhase`, drop failure-path worktree removal, attachment call, read `changeSummary` from artifact |
| `src/services/workspace.ts` | none — `createWorktree` is already idempotent (`:183`) |
| `src/sdk/azure-devops-client.ts` | `uploadAttachment`, `linkAttachmentToWorkItem` |
| `src/state/state-store.ts` | `failedAtPhase` on the job record |
| `src/types/index.ts` | `failedAtPhase` on `JobRecord` |
| `tests/services/pipeline.test.ts` | dispatch tests; invert the worktree-removal assertions |
| `tests/sdk/azure-devops-client.test.ts` | attachment tests |
| `CLAUDE.md` | the resume claim becomes true; note the worktree-retention rule |
| `docs/vm-bringup.md` | Phase J restart steps reflect real resume behaviour |
