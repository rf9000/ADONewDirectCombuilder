# Can planning subagents run on a cheaper model than the orchestrator?

**Date:** 2026-10-01
**Work item(s):** #83634 (Implement ponto, reference bank ABN AMRO)
**Run IDs:** experiments/runs/83634/20260930-190025 (resumed three times; see "How the run went")
**Samples per variant:** 1
**Auth:** subscription (Team seat); all costs are API-equivalent USD
**Judge:** claude-sonnet-5-5, blind A/B against the baseline

## Variants

| Variant | Model | Effort | Subagents |
|---|---|---|---|
| opus-high (baseline) | claude-opus-5-5 | high | inherit (Opus) |
| opus-haiku-subs | claude-opus-5-5 | high | claude-haiku-4-5-20251001 |
| opus-sonnet-subs | claude-opus-5-5 | high | claude-sonnet-5-5 |

## Key numbers

| Variant | API-equivalent USD | vs baseline | Subagent spend | Turns | Wall time | Verdict | Scores cov/corr/fit/tasks/qs |
|---|---|---|---|---|---|---|---|
| opus-haiku-subs | $13.72 | 43% | Haiku $4.90 | 131 | 44.7 min | major-gaps | 4/3/4/4/3 |
| opus-high | $31.98 | 100% | inside Opus $31.97 | 90 | 54.2 min | baseline | — |
| opus-med (effort medium) | $33.49 | 105% | inside Opus | 64 | 53.0 min | incomplete | — |
| opus-sonnet-subs | $44.79 | 140% | Sonnet $39.25 | 83 | 82.9 min | better | 5/4/4/4/2 |

Judging cost $0.31–0.32 per verdict. Total experiment spend: $91.12.

Per-model breakdown:

- **opus-high:** Opus 482k output, 49.7M cache-read, 2.3M cache-write. Fourteen subagent dispatches.
- **opus-haiku-subs:** Opus $8.81 (121k output, 20.0M cache-read). Haiku $4.90 (242k output, 19.2M
  cache-read).
- **opus-sonnet-subs:** Opus $5.54. Sonnet $39.25 (1.0M output, 84.8M cache-read, 4.8M
  cache-write). Eighteen subagent dispatches.

## What the judge found

**opus-haiku-subs: major gaps.** It contradicts explicit work-item requirements:

- It advances the import cursor when the page is archived. The work item says to store it only
  after the statement lines are committed. The plan admits this and builds it anyway.
- It sends `client-ip` through a Request Header Mapping. The schema allows it only inside
  `authentication` (`additionalProperties: false`).
- It overwrites the stored authentication items on refresh, which can drop
  `ponto-organization-id`.

A developer following this plan would write wrong code. The first, shallower judge run graded the
same plan `minor-gaps` but listed the same three defects.

**opus-sonnet-subs: better than the baseline.** It follows the endpoint order and account handling
more closely, and it maps `reference` to account-id where the baseline used `id`. Its
weaknesses:

- Two blocking questions that the work item already answers.
- A heavier plan: it changes the shared `IAccStmtMarker` interface and adds conditional objects.
- Some invented conventions, such as the `file-name` format.

**opus-med: incomplete.** At medium effort, the orchestrator ended its session after the test
plan ("Enough verified. Writing the test plan.") and never wrote the design doc, task list or
`questions.json`. It still spent $33.49. The pipeline counted the missing `questions.json` as
"no questions", so the variant first showed as `ok` and was judged against an empty folder. In
production the job would have gone on to implement with no task list. Planning now fails when
`questions.json` is missing, or when an unblocked plan has no task list. The experiment reports
such a variant as `incomplete`.

## How far to trust this

- **One sample per variant.** Agent runs are noisy, and these differences may not reproduce.
- **The judge is still shallow.** The stricter prompt made it open the task lists and API docs,
  but it grepped them instead of reading them, and each verdict took under a minute.
- **The two verdicts disagree about the baseline.** One says the baseline handles the nested
  status-entry-id rigorously; the other says it invents it. Treat individual scores as rough. The
  concrete defects listed above were checked against the work item text and hold.
- **MCP servers were off** in every experiment run. Production planning loads `.mcp.json`.

## Decision

- **Do not switch planning subagents to Haiku.** It saves 57%, but the plan breaks explicit
  requirements.
- **Do not switch to Sonnet subagents for cost.** They cost 40% more than Opus subagents on this
  item. Sonnet's subagents produced about twice the output of Opus's (1.0M against 482k tokens for
  the whole baseline run), which more than cancels the lower per-token price. Fan-out volume, not
  model price, drives planning cost.
- **Do not lower the orchestrator's effort.** `opus-med` cost the same and did not finish.
- **Next experiments:**
  - A cap on subagent fan-out in the planner skill.
  - A second sample of `opus-high` and `opus-haiku-subs`, to size the noise before any decision.

## Config change made

None.

## How the run went

The run needed three resumes, and each one fixed something in the harness:

- **Failed clone.** The first attempt failed on a misspelled `SETUP_FILES_REPO_NAME`. It also
  printed the ADO PAT in the git error. The PAT was rotated, and the error text is now redacted.
- **Old SDK.** The SDK's bundled CLI (2.1.222) was too old for claude-opus-5-5, so the SDK was
  bumped to 0.3.285.
- **Transient setup failure.** `opus-haiku-subs` failed once in setup with
  `git config … exited 66`. `--resume` was added to reuse the frozen input.
- **Misclassified status.** `opus-sonnet-subs` finished, but a five-hour rejection event arrived at
  the end. It was recorded as rate-limited until the classifier was fixed, and its `usage.json`
  carries a note.
- **Wrong turns and time.** The baseline's turns and wall time were recomputed from its
  transcript, because the first runner kept only the last result.
