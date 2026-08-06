# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An unattended agent that turns an Azure DevOps work item tagged `create-new-comm` into two draft
pull requests implementing a new bank communication for Continia Banking. It polls ADO, plans with
the `bank-integration-planner` skill, loops back to the human via work item comments while anything
is ambiguous, implements the plan in git worktrees of the Continia Banking and setup-files repos,
verifies it on a real BC environment, and opens a draft PR per repo. Runs on a Linux VM under
docker-compose.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for environment config
- **AI:** @anthropic-ai/claude-agent-sdk — full tool access, skills loaded from the worktree
- **Testing:** Bun's built-in test framework

## Key Patterns

- **Phase machine** in `src/services/pipeline.ts`; every transition is persisted, and
  `resolveEntryPhase` walks backwards from the recorded phase to the first phase whose input
  artifacts exist on disk, so a restart resumes rather than repeats. A job awaiting answers
  re-plans in place; any other entry at `planning` — including one forced by a new human comment
  since the plan — wipes an existing worktree first
- **Dependency injection** via interfaces on all services (`PipelineDeps`, `WatcherDeps`,
  `ProcessorDeps`) so the whole pipeline is testable without network, git, or Claude
- **JSON artifact handoff, not prose parsing** — each agent phase writes a known file
  (`plan/questions.json`, `verify/result.json`) that the orchestrator reads
- **Skill symlinking** — `.claude/skills/*` are linked into each worktree and the agent runs with
  `settingSources: ['project']`, which is how the SDK discovers them
- **Exponential backoff retry** on Azure DevOps API calls (5xx/network only; 4xx fails fast)
- **Seeded first clone** — `BANKING_SEED_REPO`/`SETUP_FILES_SEED_REPO` point at the host's
  read-only repo mounts, so the initial bare clone borrows objects locally via
  `--reference … --dissociate`. `--dissociate` is deliberate: it copies the objects and drops
  the alternate, so the cache cannot break when a bind mount disappears
- **Own API key, own skills** — this bot runs in the shared `~/teams/continia-banking` stack but
  deliberately does not mount the host `~/.claude`: it carries its own `ANTHROPIC_API_KEY` so
  spend stays attributable, and bakes skills into the image so the pipeline's artifact contracts
  are version-pinned rather than changing under it when a shared skill is edited
- **Serialized jobs** — one at a time; BC cannot run concurrent test jobs on one environment
- **Tag-swap handshake** — the bot swaps the trigger tag for a waiting tag when it needs answers;
  re-adding the trigger tag resumes the job

## Non-negotiables

- Never claim tests passed without `verify/result.json` saying so — a missing artifact is a failure
- Never open a pull request when verification failed; push the branch instead
- Never leave credentials in `.git/config` — git auth goes through per-invocation
  `-c http.extraHeader`
- Never stop or delete the BC environment during cleanup; only the worktrees are removed
- Never delete a worktree on a failed run — the plan artifacts and any partial build stay there
  so a retry can resume at `failedAtPhase`; `cleanup-worktrees <id>` is the only way to reclaim
  that disk

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher
- `bun run once` — single poll cycle
- `bun run status` — show tracked jobs and their phases

## File Layout

- `src/config/` — Zod env validation, tag-derived WIQL
- `src/sdk/` — Azure DevOps REST client (work items, comments, tags, branches, pull requests)
- `src/services/` — watcher, processor, pipeline, prompts, agent runner, workspace
- `src/state/` — per-work-item job records (JSON)
- `src/types/` — shared interfaces
- `tests/` — mirrors src/ structure; `tests/helpers.ts` builds configs through `loadConfig`
