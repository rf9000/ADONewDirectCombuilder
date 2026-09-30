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

Do not set `CLAUDE_CODE_SUBAGENT_MODEL` in `.env`: each variant sets it for its own runs, and a
global value would leak into the baseline.

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

Experiment worktrees are kept for inspection under `$WORKTREE_ROOT/exp-<runId>-<tag>/`. The tag is
random so the blind judge cannot tell variants apart; each variant's `usage.json` records its
`worktreeRoot`.
Delete those directories, then run `git -C "$REPO_CACHE_DIR/banking.git" worktree prune` and
the same for `setupFiles.git`.
