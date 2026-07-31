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
`ANTHROPIC_API_KEY` is this bot's own — not shared with the other services in the stack.

The three ADO values and `ANTHROPIC_API_KEY` are validated on boot. `CONTINIA_API_TOKEN` is
required only when `SKIP_BUILD_TEST=false`, since the verify phase is the only thing that needs
it. The two repo GUIDs are checked when the repo cache is first built — `status` prints
`ID NOT SET` for a missing one.

Every tag, repo id, model, interval and path is configurable — see `.env.example`.

On a host that already has the product repos checked out, set `BANKING_SEED_REPO` and
`SETUP_FILES_SEED_REPO` to those paths. The first bare clone then borrows objects locally
(`git clone --reference … --dissociate`) instead of pulling gigabytes from Azure DevOps. Objects
are copied and the alternate dropped, so the cache survives the seed disappearing; a path that
isn't a git repo is warned about and ignored rather than fatal.

## Running on the Linux VM

This bot is one service in the shared stack at `~/teams/continia-banking`, alongside the other
Azure DevOps bots. It has no compose file of its own — add this service to the umbrella
`docker-compose.yml`:

```yaml
  new-comm-builder:
    build:
      context: ./ADONewDirectCombuilder
      dockerfile: Dockerfile
    container_name: new-comm-builder
    restart: unless-stopped
    env_file:
      - .env.new-comm-builder
    volumes:
      - new-comm-builder-data:/data
      # Seeds the first bare clone so a multi-gigabyte fetch becomes a local
      # object copy. Read-only is enough: this bot symlinks skills into its own
      # worktrees, never into the source repos, and pushes to ADO over HTTPS.
      - /home/azureuser/repos/continia-banking:/repos/continia-banking:ro
      - /home/azureuser/repos/continia-banking-setup-files:/repos/continia-banking-setup-files:ro
    # Cloning Continia Banking and compiling AL are both memory-hungry.
    deploy:
      resources:
        limits:
          memory: 8G
    healthcheck:
      test: ["CMD", "bun", "run", "src/cli/index.ts", "status"]
      interval: 5m
      timeout: 60s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

Plus `new-comm-builder-data:` in the top-level `volumes:` block. Then from `~/teams/continia-banking`:

```bash
docker compose build new-comm-builder
docker compose run --rm new-comm-builder bun run src/cli/index.ts status   # config check
docker compose run --rm new-comm-builder continia env list --json          # CLI auth check
docker compose up -d new-comm-builder
docker compose logs -f new-comm-builder
```

Unlike the other services in the stack, this one does **not** mount the host's `~/.claude`.
It carries its own `ANTHROPIC_API_KEY` in `.env.new-comm-builder` so spend and rate limits stay
attributable per bot, and its skills are baked into the image rather than shared — the pipeline's
invariants depend on specific skill behaviour, so they are version-pinned with the code.

State, repo mirrors, worktrees, logs and the AL compiler cache all live in the
`new-comm-builder-data` volume, so restarts and image rebuilds resume rather than restart. It is
one large volume rather than the fleet's usual small `/app/.state` because this bot caches bare
clones and the AL compiler.

**The build context must contain `.tools/continia-linux`** (the ELF build of the Continia CLI) —
the Dockerfile copies it to `/usr/local/bin/continia`, so the build fails outright without it.
`.tools/` is gitignored, so copy it in out-of-band. The Windows `continia.exe` is excluded from
the image.

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
