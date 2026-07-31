# New Bank Communication Builder

An unattended agent that turns an Azure DevOps work item into two draft pull requests
implementing a new bank communication for Continia Banking.

## What it does

Every `POLL_INTERVAL_MINUTES` (default 5) it queries Azure DevOps for work items tagged
`create-new-comm`, and for each one:

1. **Reads** the work item title, description and the whole comment thread.
2. **Plans** by invoking the `bank-integration-planner` skill, which produces a design doc,
   a wave-grouped task list, and a machine-readable `questions.json`.
3. **Asks, if anything is unclear.** Any blocking question — or any ambiguity where the
   planner had to make a call — is posted as a work item comment. The bot then swaps the
   `create-new-comm` tag for `create-new-comm-waiting` and stops. Answer in a comment, re-add
   `create-new-comm`, and the next poll resumes the loop. This repeats until the plan comes
   back clean or `MAX_CLARIFY_ROUNDS` is reached.
4. **Implements** the plan in a git worktree per repo: AL objects in **Continia Banking**,
   configuration JSON in the **setup-files** repo.
5. **Verifies** on a real BC environment — `continia-env-setup` → `continia-deps` →
   `continia-deploy` → `continia-test`. The environment is deliberately **left running**.
6. **Publishes** a **draft** pull request on each repo that changed, linked to the work item,
   and comments with the links.
7. **Cleans up** the worktrees. Nothing is opened if verification fails; the branch is still
   pushed so the work can be inspected.

## Getting started

```bash
bun install
cp .env.example .env    # then fill in the required values
bun test
bun run src/cli/index.ts help
```

Required in `.env`: `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`,
`ANTHROPIC_API_KEY`, `CONTINIA_API_TOKEN`, `BANKING_REPO_ID`, `SETUP_FILES_REPO_ID`.
The PAT needs **Work Items (Read & Write)** and **Code (Read, Write & Manage)**.

Every tag, repo id, model, interval and path is configurable — see `.env.example`.

## Running on the Linux VM

```bash
docker compose build
docker compose run --rm agent bun run src/cli/index.ts status      # config sanity check
docker compose run --rm agent continia env list --json             # CLI auth check
docker compose up -d
docker compose logs -f
```

State, repo mirrors, worktrees, logs and the AL compiler cache all live in the `agent-data`
volume, so restarts and image rebuilds resume rather than restart.

**The build context must contain `.tools/continia-linux`** (the ELF build of the Continia CLI) —
the Dockerfile copies it to `/usr/local/bin/continia`. The Windows `continia.exe` is excluded
from the image.

### MCP servers

`fw-create-pr` and the planner's object-ID reservation use MCP tools. Drop a `.mcp.json` with
an `mcpServers` object in the repo root; the agent runner picks it up automatically and grants
each configured server to the agent. Branch, pull request, comment and tag operations do **not**
depend on MCP — they go through the Azure DevOps REST client in `src/sdk/`.

## CLI

| Command | Purpose |
|---|---|
| `watch` | Long-running watcher (this is what the container runs) |
| `run-once` | One poll cycle, then exit |
| `run-item <id>` | Run one work item regardless of its tags |
| `status` | Config summary plus every tracked job and its phase |
| `reset-state` / `reset-item <id>` | Forget job state so an item runs from scratch |
| `cleanup-worktrees <id>` | Remove leftover worktrees for a work item |

Add `--dry-run` to `run-once` / `run-item` to read the work item and its comments and stop
before any writes.

## Project structure

```
src/
├── cli/index.ts               # CLI entry point
├── config/index.ts            # Zod env validation; tag-derived WIQL
├── sdk/azure-devops-client.ts # ADO REST: work items, comments, tags, branches, PRs
├── services/
│   ├── watcher.ts             # Polling loop, one job at a time, job timeout
│   ├── processor.ts           # Thin seam between watcher and pipeline
│   ├── pipeline.ts            # Phase machine: plan → clarify → build → verify → publish
│   ├── prompts.ts             # Work item context and per-phase prompts
│   ├── agent-runner.ts        # Claude Agent SDK wrapper; JSON artifact handoff
│   └── workspace.ts           # Repo cache, worktrees, skill symlinking
├── state/state-store.ts       # Per-work-item job records (JSON)
└── types/index.ts             # Shared interfaces
```

### How the skills reach the agent

`.claude/skills/*` and `.claude/commands/*` are **symlinked** into each worktree's `.claude/`,
and the agent runs with `settingSources: ['project']` and `cwd` set to that worktree — which is
how the Agent SDK discovers them. `wireSkills` also writes `.claude/repo-paths.json` (which
`setup-files-investigate` and the planner use to find sibling repos) and registers everything it
adds in `.git/info/exclude`, so none of it can appear in a pull request diff. Symlinks rather
than copies mean editing a skill here takes effect on the next job.

## Testing

```bash
bun run typecheck
bun test                  # unit tests; no network
bun run test:integration  # live ADO calls, skipped unless credentials are present
```
