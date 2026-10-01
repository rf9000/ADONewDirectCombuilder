# Can a follow-up round revise the plan instead of re-planning it?

**Date:** 2026-10-01
**Work item(s):** #83634 (Implement ponto)
**Run IDs:** experiments/runs/83634/20261001-090344 (resumed once after a setup failure)
**Starting plan:** experiments/runs/83634/20260930-190025/opus-high (round 1, 1 blocking question)
**Answers:** three, in experiments/runs/83634/answers.md (local only):

1. The build reserves object IDs in task R-1 with AL Object ID Ninja.
2. account-id is the account's `reference` (IBAN), not the Ponto `id`.
3. client-ip goes only inside `authentication`.

**Samples per variant:** 1
**Auth:** subscription; all costs are API-equivalent USD
**Judge:** claude-sonnet-5-5, blind A/B, with the full re-plan as baseline

## Variants

Both are claude-opus-5-5 at high effort, with Opus subagents. They get the same questions and the
same answers.

| Variant | What it does |
|---|---|
| full-replan (baseline) | Round 2 as before this change: the skill re-runs Phases 0–9 |
| revise | Round 2 in the new revision mode, starting from the round-1 plan |

## Key numbers

| Variant | API-equivalent USD | vs full | Turns | Wall time | Subagents | Verdict | Scores cov/corr/fit/tasks/qs |
|---|---|---|---|---|---|---|---|
| revise | $2.18 | 5% | 29 | 6.4 min | 1 (verifier) | minor-gaps | 5/4/5/4/5 |
| full-replan | $44.69 | 100% | 65 | 71.6 min | many | baseline | — |

The judge cost $0.34. The full re-plan cost more than the original round 1 ($31.98), so today an
answered question costs more than the first plan did.

## What the revision did

It wrote `revisionMode: "incremental"` and a reason naming each answer:

- **Answer 1** resolved the one blocking question. Task R-1 went from Blocked to Ready, and the
  "blocked until R-1" notes on dependent tasks were reworded. No new objects needed IDs.
- **Answer 2** reversed decision D1. Only the assisted-setup domain was re-planned, and one
  `plan-verifier` subagent checked the revised fragment. The other domains were not touched.
- **Answer 3**: the judge confirms that `client-ip` sits only inside `authentication` in the
  revised plan.

The output is complete: 0 blocking questions, 22 ambiguities, 94 tasks with stable ids.

## What the judge found

The verdict was minor-gaps, and no score was below 4. The gaps are decisions carried over
unchanged from the round-1 plan, which the fresh re-plan happened to make differently:

- a 50-page cap on the statement loop
- statement pages archived with `InsertInNewSession`
- `DefaultIsAuthValid` instead of a custom auth-validity check
- the refresh is not serialised with `UpdLock`

None of them came from the revision itself. This is the trade-off revision mode makes on purpose:
what no answer touches stays as it was.

## How far to trust this

- **One sample, one work item, three answers.** Two of the three answers were narrow. An answer
  that reshapes several domains would cost more and would test the full-plan fallback, which this
  run did not exercise.
- **The judge is still shallow.** It ran in under a minute. Its conclusion does match what
  `revisionReason` and the transcript show.
- **MCP servers were off** in both runs, so the planners could not reserve object IDs. That is
  where answer 1 came from.

## Decision

Keep revision mode on branch `planning-revision-mode`. It cuts the cost of a follow-up round from
about $45 to about $2 on this item, without introducing defects. Merge it, then watch the
`revisionMode` / `revisionReason` lines in production logs for the first few real follow-up
rounds.

## Config change made

None. Revision mode is a code and skill change, not a config change.

## How the run went

The `revise` variant failed in setup with `git config remote.origin.fetch … exited 66`. That is the
second time this failure followed a long variant. The cache now writes that refspec only when it
is missing, and the run was resumed.
