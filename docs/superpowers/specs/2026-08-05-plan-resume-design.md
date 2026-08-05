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
resolveEntryPhase(job, available, hasNewComments) → JobPhase
```

Two preconditions are evaluated before the table below, because both override it.

**New human comments force a re-plan.** `runPlanningPhase` already writes
`lastSeenCommentId` (`pipeline.ts:204`) and nothing reads it. If a newer comment exists
that the pipeline did not write, the plan was made without that input, so entry is forced
to `planning` whatever the recorded phase says. "I read the failure, answered it, and
re-triggered" gets the re-plan the human expects; a bare re-trigger stays a true resume.

This only works if the pipeline's own comments don't count. `reportFailure`, the questions
comment and the success comment all post *after* planning, so their IDs necessarily exceed
`lastSeenCommentId` — left unhandled, every retry would see "new comments" and
`failedAtPhase` would be dead code.

**The discriminator is a marker, not an author.** Every comment the pipeline posts carries
a hidden sentinel:

```html
<!-- new-comm-builder -->
```

Comments carrying it are excluded when computing the newest comment, and
`lastSeenCommentId` records the newest *unmarked* comment at plan time. Posting therefore
requires no bookkeeping — the pipeline's own comments can never advance the watermark
because they are never counted.

Author-based filtering was considered and rejected. `createdBy.uniqueName` is the PAT
owner, which today is a real person who is also likely to be the one answering questions,
so it cannot separate the two. It also breaks the moment the agent moves to its own
service account, or when several different people take turns re-triggering a job — both of
which are expected. A marker is independent of identity and survives both.

`htmlToText` strips `<[^>]+>`, which includes HTML comments, so the marker never reaches
the agent's prompt. It is invisible in the ADO comment editor too.

*Accepted edge case:* a human who quote-replies to a bot comment could carry the marker
into their own text, and that reply would then be ignored for staleness. Unlikely — the
marker is invisible in the editor, so it would have to survive a copy-paste of raw HTML —
and the cost is one missed re-plan, recoverable with `reset-item`.

**Entering at `planning` means a clean workspace.** Whenever resolution lands on
`planning` — new job, `reset-item`, `awaiting-answers`, a fallback downgrade, or the
comment rule above — the worktrees are removed before `prepareWorkspaces` recreates them.
Resume forward reuses the directory; start over starts over. Partial implement work built
against a superseded plan is discarded, which is the point.

That rule also fixes a pre-existing bug independent of this design. `createWorktree`
returns early when the worktree exists (`workspace.ts:183`), so `reset-item` clears the
job record and leaves the directory. Observed on work item 80969: after a reset, the
"fresh" planning run began in a worktree still holding the previous round's design doc,
task list and questions file. Harmless there because the plan was regenerated anyway —
not harmless once a retry can inherit half-built AL objects.

Neither precondition creates a collision risk *between* work items: `worktreePath` and
`branchNameFor` are both keyed on the item ID, and jobs are serialized. The hazard is
always the same item's stale state.

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

The two preconditions need their own tests, and the third of these is the one that would
catch the mistake that makes the whole feature inert:

- a newer unmarked comment forces entry at `planning` even when the phase is `publishing`
- entering at `planning` calls `removeAllWorktrees` first; entering at `implementing` does
  not
- a job whose only newer comments carry the marker resumes at `failedAtPhase` — it does
  **not** re-plan
- every comment the pipeline posts contains the marker (assert on the builders in
  `prompts.ts`, so a new comment type can't be added without one)

Existing tests assert today's behaviour — that failure removes worktrees — and will need
inverting. That is the change being real, not an obstacle to route around.

## Files touched

| File | Change |
|---|---|
| `src/services/pipeline.ts` | dispatch, the two preconditions, `failedAtPhase`, drop failure-path worktree removal, attachment call, read `changeSummary` from artifact |
| `src/services/prompts.ts` | emit the `<!-- new-comm-builder -->` marker in every comment builder; export the constant and a predicate for filtering |
| `src/services/workspace.ts` | none — `createWorktree` is already idempotent (`:183`) |
| `src/sdk/azure-devops-client.ts` | `uploadAttachment`, `linkAttachmentToWorkItem` |
| `src/state/state-store.ts` | `failedAtPhase` on the job record |
| `src/types/index.ts` | `failedAtPhase` on `JobRecord` |
| `tests/services/pipeline.test.ts` | dispatch tests; invert the worktree-removal assertions |
| `tests/sdk/azure-devops-client.test.ts` | attachment tests |
| `CLAUDE.md` | the resume claim becomes true; note the worktree-retention rule |
| `docs/vm-bringup.md` | Phase J restart steps reflect real resume behaviour |
