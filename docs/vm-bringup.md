# VM bring-up and manual test guide

Getting `new-comm-builder` running in the shared `~/teams/continia-banking` stack, then
verifying it end to end.

**The test steps are a ladder: cheapest and most reversible first, each rung isolating one
boundary.** Don't climb past a red rung — a failure at rung 4 is much harder to diagnose if
rung 2 was never confirmed.

Unit tests already cover the phase machine, tag-handshake logic, state transitions and the
"no PR when verification failed" invariant with fakes. Everything below targets the four
things fakes can't reach: **ADO REST**, **git worktrees + skill wiring**, **Agent SDK skill
discovery**, and **the BC/Continia CLI chain**.

---

# PART 1 — One-time setup

All paths assume the stack lives at `~/teams/continia-banking`.

## Step 1: Clone into the stack

```bash
cd ~/teams/continia-banking
git clone https://github.com/rf9000/ADONewDirectCombuilder.git
```

## Step 2: Copy the three gitignored files from your workstation

None of these arrive with the clone. Run from `C:\GeneralDev\DevOpsPullers\ADONewDirectCombuilder`
on the Windows box:

```powershell
$vm = "azureuser@<vm-host>"
$dst = "~/teams/continia-banking/ADONewDirectCombuilder"

ssh $vm "mkdir -p $dst/.tools"
scp .tools/continia-linux "${vm}:${dst}/.tools/"     # 90 MB — REQUIRED, build fails without it
scp .mcp.json             "${vm}:${dst}/"            # optional, see Step 5
```

Do **not** copy `continia.exe` (112 MB, Windows-only) and do **not** copy your local `.env` —
Step 4 writes a fresh one with container paths.

```bash
ssh $vm "chmod +x $dst/.tools/continia-linux"
```

- [ ] `.tools/continia-linux` present and executable

## Step 3: Confirm the host repo paths for clone seeding

The seed turns a multi-gigabyte ADO fetch into a local object copy. Verify the real directory
names — the setup-files one is a guess:

```bash
ls -d ~/repos/continia-banking ~/repos/continia-banking-setup-files
```

If the second path differs, use the real one in Steps 4 and 6. If it doesn't exist at all,
leave `SETUP_FILES_SEED_REPO` unset — that repo is small, so a plain clone is fine.

- [ ] Banking repo path confirmed
- [ ] Setup-files repo path confirmed (or deliberately skipped)

## Step 4: Write the env file

At the **stack root**, not inside the service directory:

```bash
cd ~/teams/continia-banking
cat > .env.new-comm-builder <<'EOF'
# --- Azure DevOps ---
AZURE_DEVOPS_PAT=<pat with Work Items R/W + Code R/W/Manage>
AZURE_DEVOPS_ORG=continia-software
AZURE_DEVOPS_PROJECT=Continia Software

# --- This bot's OWN key, not shared with the other services ---
ANTHROPIC_API_KEY=sk-ant-...

# --- Continia CLI (DemoPortal) ---
CONTINIA_API_TOKEN=<demoportal token>

# --- Repositories ---
BANKING_REPO_NAME=Continia Banking
BANKING_REPO_ID=a838fce3-3b9c-4c78-beec-cb4cf5983144
SETUP_FILES_REPO_NAME=Continia Banking Setup Files
SETUP_FILES_REPO_ID=0507b34a-7d81-4cfa-affb-f8081de4765e

# --- Seed the first clone from the read-only mounts (Step 3) ---
BANKING_SEED_REPO=/repos/continia-banking
SETUP_FILES_SEED_REPO=/repos/continia-banking-setup-files

# --- Optional: only if you copied .mcp.json ---
# ADO_MCP_PAT_B64=<base64 of "you@continia.com:<pat>">
EOF
chmod 600 .env.new-comm-builder
```

**Put no path variables in here.** `REPO_CACHE_DIR`, `WORKTREE_ROOT`, `STATE_DIR`, `LOG_DIR`
and `SKILLS_SOURCE_DIR` are pinned in the compose `environment:` block, because `env_file`
takes precedence over the image's `ENV` and a stray path would silently relocate the cache.

- [ ] `.env.new-comm-builder` written, mode 600

## Step 5: MCP (optional)

`.mcp.json` is gitignored and holds a PAT. Without it the bot still runs — branch, PR, comment
and tag operations all go through the REST client in `src/sdk/`. What you lose is the planner's
AL object-ID reservation and the `fw-create-pr` command, and the loss is **silent**:
`loadMcpServers` returns `{}` without complaint.

If you copied it, generate the credential (it's used verbatim as the Basic auth value, so it
must be pre-encoded — not the raw PAT):

```bash
printf '%s:%s' "rf@continia.com" "<pat>" | base64 -w0
```

Put the result in `ADO_MCP_PAT_B64` in `.env.new-comm-builder`.

- [ ] MCP configured, or consciously skipped

## Step 6: Add the service to the shared compose

Append to `~/teams/continia-banking/docker-compose.yml` — the full block is in this repo's
[README](../README.md#running-on-the-linux-vm). Adjust the two bind-mount paths to match
Step 3. Also add `new-comm-builder-data:` to the top-level `volumes:` block.

Then validate the merged file parses before building:

```bash
cd ~/teams/continia-banking
docker compose config --services | grep new-comm-builder
```

- [ ] `new-comm-builder` appears in the service list
- [ ] `new-comm-builder-data` declared under `volumes:`

## Step 7: Check headroom

An 8G limit alongside six long-running watchers:

```bash
free -h
docker stats --no-stream
df -h /var/lib/docker
```

The first clone plus an AL compile is the peak. Budget ~10 GB of disk for the volume.

- [ ] Enough free RAM for an 8G peak
- [ ] Enough disk for repo mirrors + worktrees + ALC cache

## Step 8: Build

```bash
docker compose build new-comm-builder
```

Fails immediately and loudly if `.tools/continia-linux` is missing (`Dockerfile:22`).

- [ ] Image built

---

# PART 2 — Pre-flight (rung 1)

No writes anywhere. All from `~/teams/continia-banking`.

### 1a — Config loads

```bash
docker compose run --rm new-comm-builder bun run src/cli/index.ts status
```

- [ ] Org/project print as `continia-software/Continia Software`
- [ ] Both repo GUIDs shown — **not** `ID NOT SET`
- [ ] `Build/test: enabled`
- [ ] `0 tracked job(s): {}`

A missing `ANTHROPIC_API_KEY` or `CONTINIA_API_TOKEN` fails here with the variable named,
rather than surviving to burn a planning run.

### 1b — Continia CLI runs

```bash
docker compose run --rm new-comm-builder continia env list --json
```

This is the one thing never exercised on Windows: the Linux CLI is a dynamically linked Node
SEA build. If `libicu72`/`libssl3` don't satisfy it, it fails **here** rather than 40 minutes
into a verify phase.

- [ ] Returns JSON, not a linker error
- [ ] DemoPortal token accepted

### 1c — Tests pass inside the image

```bash
docker compose run --rm new-comm-builder bun test
```

- [ ] 189 pass, 0 fail

### 1d — Paths landed inside the container

```bash
docker compose run --rm new-comm-builder sh -c 'echo $REPO_CACHE_DIR $STATE_DIR $SKILLS_SOURCE_DIR; ls /repos'
```

- [ ] Paths are `/data/...` and `/app/.claude`, not Windows paths
- [ ] `/repos` lists the read-only mounts

---

# PART 3 — Manual test ladder

## Prepare a throwaway work item

**Use a scrap work item, never a real one.** The pipeline comments on it, re-tags it, and can
open pull requests against whatever it's pointed at.

1. Create a User Story in `Continia Software`, title e.g. `TEST — Acme Bank communication`.
2. Give it a deliberately **underspecified** description: name a bank and an auth method, but
   omit the reference bank, the payment methods and the statement format.
3. Add the tag `create-new-comm`.
4. Note the ID — `<WI>` below.

The vagueness is the point: it makes the planner stop and ask, which is the cheap way to
exercise the whole ADO write path for one planning run instead of a full job.

---

### Rung 2 — ADO read path, zero writes

```bash
docker compose run --rm new-comm-builder \
  bun run src/cli/index.ts run-item <WI> --dry-run
```

Returns before any worktree or agent work, so this tests exactly one thing.

- [ ] Title and description print
- [ ] Comment count matches what's on the item in ADO
- [ ] No comment added, no tag changed (**check the item in ADO**)
- [ ] `status` still shows the job as unprocessed

### Rung 3 — Clarify handshake, worktrees, skill discovery

Drop `--dry-run`. One planning run; expect 10–20 minutes and a few dollars.

```bash
docker compose run --rm new-comm-builder \
  bun run src/cli/index.ts run-item <WI>
```

**On the work item in ADO:**
- [ ] A comment appears listing blocking questions, rendered as HTML (not raw tags)
- [ ] Tag `create-new-comm` is gone, `create-new-comm-waiting` present

**In state:**
```bash
docker compose run --rm new-comm-builder bun run src/cli/index.ts status
```
- [ ] Phase `awaiting-answers`, `rounds=1`
- [ ] Branch recorded as `Userstory/agent/<WI>-<slug>`

**In the worktree** — the load-bearing wiring:
```bash
docker compose run --rm new-comm-builder sh -c '
  cd /data/worktrees/<WI>/banking &&
  ls -l .claude/skills/ | head &&
  cat .claude/repo-paths.json &&
  echo "--- git status (must be clean) ---" &&
  git status --porcelain'
```
- [ ] `.claude/skills/*` are **symlinks** (`l` in the mode, arrow to `/app/.claude/...`)
- [ ] `repo-paths.json` names both worktree paths
- [ ] `git status --porcelain` is **empty** — no `.agent/`, no `.claude/`

That last box is the one that matters: it proves `.git/info/exclude` is doing its job and none
of our scaffolding can reach a pull request diff.

**Seed worked:**
- [ ] Clone finished in seconds/low minutes, not a multi-GB download (`docker compose logs`)
- [ ] `git -C /data/repos/banking.git count-objects -vH` shows real objects

**Then resume the loop:**
1. Answer the questions in a work item comment.
2. Re-add the `create-new-comm` tag.
3. ```bash
   docker compose run --rm new-comm-builder bun run src/cli/index.ts run-once
   ```

- [ ] The item is picked up (it's `awaiting-answers`, so `shouldProcess` returns true)
- [ ] The planner's second round references your answer
- [ ] `rounds=2`

### Rung 4 — Full job, no BC, scratch repos

**Point `BANKING_REPO_ID` / `SETUP_FILES_REPO_ID` at scratch repos first.** This rung really
pushes branches and opens pull requests.

```bash
docker compose run --rm \
  -e SKIP_BUILD_TEST=true -e MAX_CLARIFY_ROUNDS=0 \
  new-comm-builder bun run src/cli/index.ts run-item <WI>
```

`MAX_CLARIFY_ROUNDS=0` forces it past the clarify loop straight into implement;
`SKIP_BUILD_TEST=true` makes verify return passed without touching BC. So this isolates
implement → commit → push → two draft PRs → success comment → done tag → cleanup.

- [ ] A draft PR exists on each repo that changed, linked to `<WI>`
- [ ] PR description says verification was **skipped** — it must not claim a pass
- [ ] Success comment on the work item links both PRs
- [ ] Tag is now `create-new-comm-done`
- [ ] `status` shows phase `done`
- [ ] `/data/worktrees/<WI>` is gone, `/data/repos/*.git` remain
- [ ] No `.claude/` or `.agent/` files in either PR's diff

Reset before re-running: `reset-item <WI>`, delete the pushed branches, abandon the PRs, and
put the `create-new-comm` tag back.

### Rung 5 — The real thing

Real repo IDs, `SKIP_BUILD_TEST` unset, `DRAFT_PR=true`. Slow (hours) and the only rung that
exercises `continia-env-setup → deps → deploy → test`.

```bash
docker compose up -d new-comm-builder
docker compose logs -f new-comm-builder
```

- [ ] Verify phase reaches a real BC environment
- [ ] `/data/logs/<WI>/verify.log` shows the deploy and test run
- [ ] `.agent/verify/result.json` exists and its verdict **matches what the PR claims**
- [ ] The BC environment is still running afterwards (cleanup must not stop it)
- [ ] On a test failure: **no PR**, but the branch is pushed and a failure comment posted

That third box is the core non-negotiable: a missing artifact must be treated as failure, never
as a pass.

---

# PART 4 — Two behaviours to probe

Neither is covered by unit tests, and I'd expect the first to disagree with the docs.

### Restart mid-flight

`CLAUDE.md` says a container restart "resumes rather than repeats", but `runJob` runs
planning → implement → verify → publish unconditionally, regardless of the stored phase. So a
restart probably **re-plans from scratch**, reusing only the branch name and worktree.

Cheapest probe, during rung 3: once `.agent/plan/questions.json` is written, `docker compose
restart new-comm-builder`, then watch whether the next cycle re-runs the planner.

- [ ] Confirmed: does it resume, or re-plan?

### Job timeout orphan

`withTimeout` (`src/services/watcher.ts:41`) rejects the race, but nothing cancels the in-flight
`query()`. Set `JOB_TIMEOUT_MINUTES=1` against a real planning run:

```bash
docker compose run --rm -e JOB_TIMEOUT_MINUTES=1 \
  new-comm-builder bun run src/cli/index.ts run-item <WI>
```

- [ ] Does `/data/logs/<WI>/plan-1.log` keep growing after the timeout is logged?

### BC contention

Before rung 5, establish whether any other service in the stack drives BC environments
(`create-scripts-for-videos` needs the AL toolchain). The one-job-at-a-time design only
serializes *within* this bot; if another service also spins up environments they will contend,
and a cross-service lock is needed.

- [ ] Checked whether other services touch BC

---

# PART 5 — Reference

## Reset commands

```bash
S="docker compose run --rm new-comm-builder bun run src/cli/index.ts"

$S status                      # config + every tracked job
$S reset-item <WI>             # forget one item so it runs from scratch
$S reset-state                 # forget everything
$S cleanup-worktrees <WI>      # remove leftover worktrees
```

Nuke the cache entirely (forces a fresh seeded clone):

```bash
docker compose down new-comm-builder
docker volume rm continia-banking_new-comm-builder-data
```

## Where things live inside the container

| Path | Contents |
|---|---|
| `/data/repos/{banking,setupFiles}.git` | Bare clones, fetched each job |
| `/data/worktrees/<WI>/{banking,setupFiles}` | Per-item worktrees, removed on completion |
| `/data/worktrees/<WI>/banking/.agent/` | `plan/questions.json`, `verify/result.json` |
| `/data/logs/<WI>/{plan-N,implement,verify}.log` | Full agent transcripts |
| `/data/state/jobs.json` | Job records |
| `/app/.claude/skills/` | Skills baked into the image |
| `/repos/*` | Host repos, read-only, seed source |

## Summary checklist

| Rung | What it proves | Done |
|---|---|:---:|
| 1a | Config + credentials load | [ ] |
| 1b | Linux Continia CLI runs, DemoPortal auth works | [ ] |
| 1c | 189 tests pass in the image | [ ] |
| 1d | Container paths correct, `/repos` mounted | [ ] |
| 2 | ADO read path, no writes | [ ] |
| 3 | Comments, tag swap, worktrees, skill symlinks, clean `git status` | [ ] |
| 3b | Answer + re-tag resumes the loop | [ ] |
| 4 | Implement → push → draft PRs → done tag → cleanup | [ ] |
| 5 | Real BC verify; artifact matches the PR's claim | [ ] |
| — | Restart behaviour: resume or re-plan? | [ ] |
| — | Timeout orphan: log keeps growing? | [ ] |
| — | BC contention with other services | [ ] |
