# VM bring-up and manual test guide

Step-by-step deployment of `new-comm-builder` into the shared `~/teams/continia-banking` stack,
then end-to-end verification.

**One action per step. Do them in order and don't skip a red one** — a failure at step 40 is
painful to diagnose if step 22 was never confirmed.

Every step is tagged with where it runs:

- **[WIN]** — your Windows workstation, in `C:\GeneralDev\DevOpsPullers\ADONewDirectCombuilder`
- **[VM]** — the Linux VM, in `~/teams/continia-banking` unless stated otherwise

Unit tests already cover the phase machine, tag-handshake logic, state transitions and the
"no PR when verification failed" invariant using fakes. Everything here targets the four
boundaries fakes can't reach: **ADO REST**, **git worktrees + skill wiring**, **Agent SDK skill
discovery**, and **the BC/Continia CLI chain**.

Shorthand used throughout:

```bash
# [VM] paste once per shell session
S="docker compose run --rm new-comm-builder bun run src/cli/index.ts"
```

---

# PHASE A — Get the files onto the VM (steps 1–12)

### 1. [VM] Confirm the stack directory exists

```bash
cd ~/teams/continia-banking && ls -d */ | head -20
```
- [ ] The six existing bot directories are listed

### 2. [VM] Confirm no old copy of this bot is present

```bash
ls -d ADONewDirectCombuilder 2>/dev/null && echo "ALREADY EXISTS" || echo "clean"
```
- [ ] Prints `clean`. If it exists, back it up or `git pull` in it instead of step 3

### 3. [VM] Clone the repo

```bash
git clone https://github.com/rf9000/ADONewDirectCombuilder.git
```
- [ ] Clone succeeded

### 4. [VM] Confirm you're on main at the right commit

```bash
git -C ADONewDirectCombuilder log --oneline -1
```
- [ ] Shows the VM bring-up commit or later

### 5. [VM] Create the `.tools` directory

It's gitignored, so the clone has no such directory.

```bash
mkdir -p ~/teams/continia-banking/ADONewDirectCombuilder/.tools
```
- [ ] Directory created

### 6. [WIN] Copy the Continia Linux CLI over

90 MB. **Required** — the build fails outright without it (`Dockerfile:22`).

```powershell
$vm  = "azureuser@<vm-host>"
$dst = "~/teams/continia-banking/ADONewDirectCombuilder"
scp .tools/continia-linux "${vm}:${dst}/.tools/"
```
- [ ] Transfer completed

Do **not** copy `continia.exe` (112 MB, Windows-only) and do **not** copy your local `.env` —
step 14 writes a fresh one.

### 7. [VM] Make the CLI executable

```bash
chmod +x ~/teams/continia-banking/ADONewDirectCombuilder/.tools/continia-linux
```
- [ ] No error

### 8. [VM] Verify the binary actually runs on this host

The single highest-value early check: a Node SEA build that has never run on Linux in this
project.

```bash
~/teams/continia-banking/ADONewDirectCombuilder/.tools/continia-linux --version
```
- [ ] Prints a version, **not** a linker error

`command not found` on a bare `continia-linux` just means `.` isn't on `PATH` — use `./` or the
absolute path above. `Permission denied` means step 7 didn't take.

The binary is statically linked (`ldd` shows no ICU, OpenSSL or libstdc++), so a missing `.so`
here would be surprising. The `libicu`/`libssl3`/`libstdc++6` packages in the Dockerfile are for
the AL compiler, not for this.

### 9. [WIN] Copy `.mcp.json` (optional)

Gitignored because it holds a PAT. Without it the bot runs fine — branch, PR, comment and tag
operations all go through `src/sdk/`. You lose the planner's AL object-ID reservation and
`fw-create-pr`, and the loss is **silent** (`loadMcpServers` returns `{}` quietly).

```powershell
scp .mcp.json "${vm}:${dst}/"
```
- [ ] Copied, or consciously skipped

### 10. [VM] Confirm the banking repo is on the host

This is the clone seed — it turns the ADO object fetch into a local copy (~217 MiB for Banking,
so a convenience rather than a prerequisite).

```bash
ls -d ~/repos/continia-banking && git -C ~/repos/continia-banking rev-parse --is-inside-work-tree
```
- [ ] Path exists and prints `true`

### 11. [VM] Find the setup-files repo's real directory name

```bash
ls -d ~/repos/*setup* ~/repos/*Setup* 2>/dev/null
```
- [ ] Note the exact path — used in steps 14 and 20

If nothing matches, leave `SETUP_FILES_SEED_REPO` unset. That repo is small, so a plain clone
is fine.

### 12. [VM] Record both seed paths

Write them down; steps 14 and 20 both need them.
- [ ] Banking seed path noted
- [ ] Setup-files seed path noted (or "none")

---

# PHASE B — Configuration (steps 13–20)

### 13. [VM] Confirm the env file doesn't already exist

```bash
ls -l ~/teams/continia-banking/.env.new-comm-builder 2>/dev/null && echo EXISTS || echo clean
```
- [ ] Prints `clean`

### 14. [VM] Write the env file

At the **stack root**, not inside the service directory. Fill in the four secrets.

```bash
cd ~/teams/continia-banking
cat > .env.new-comm-builder <<'EOF'
# --- Azure DevOps ---
AZURE_DEVOPS_PAT=<pat: Work Items R/W + Code R/W/Manage>
AZURE_DEVOPS_ORG=continia-software
AZURE_DEVOPS_PROJECT=Continia Software

# --- This bot's OWN key, deliberately not shared with the other services ---
ANTHROPIC_API_KEY=<sk-ant-...>

# --- Continia CLI (DemoPortal) ---
CONTINIA_API_TOKEN=<demoportal token>

# --- Repositories ---
BANKING_REPO_NAME=Continia Banking
BANKING_REPO_ID=a838fce3-3b9c-4c78-beec-cb4cf5983144
SETUP_FILES_REPO_NAME=Continia Banking - Setup Files
SETUP_FILES_REPO_ID=0507b34a-7d81-4cfa-affb-f8081de4765e

# --- Clone seeds: container-side paths, matching the mounts from step 20 ---
BANKING_SEED_REPO=/repos/continia-banking
SETUP_FILES_SEED_REPO=/repos/setup-files

# --- Only if you copied .mcp.json (step 9) ---
# ADO_MCP_PAT_B64=<base64 of "you@continia.com:<pat>">
EOF
```
- [ ] File written

### 15. [VM] Fix the seed paths if step 11 found different names

```bash
grep SEED_REPO .env.new-comm-builder
```
- [ ] Both values match the container-side mount paths you'll set in step 20

### 16. [VM] Lock the file down

```bash
chmod 600 .env.new-comm-builder && ls -l .env.new-comm-builder
```
- [ ] Mode is `-rw-------`

### 17. [VM] Confirm no path variables leaked in

`env_file` takes precedence over the image's `ENV`, so a stray path here would silently
relocate the repo cache, worktrees or state.

```bash
grep -E '^(REPO_CACHE_DIR|WORKTREE_ROOT|STATE_DIR|LOG_DIR|SKILLS_SOURCE_DIR)=' \
  .env.new-comm-builder && echo "REMOVE THESE" || echo "clean"
```
- [ ] Prints `clean`

### 18. [VM] Generate the MCP credential (only if you did step 9)

It's used verbatim as the Basic auth value, so it must be pre-encoded — not the raw PAT.

```bash
printf '%s:%s' "rf@continia.com" "<pat>" | base64 -w0
```
- [ ] Output pasted into `ADO_MCP_PAT_B64` in the env file

### 19. [VM] Open the shared compose file

```bash
cp docker-compose.yml docker-compose.yml.bak
$EDITOR docker-compose.yml
```
- [ ] Backup taken before editing

### 20. [VM] Add the service block and volume

Copy the `new-comm-builder:` block from
[README](../README.md#running-on-the-linux-vm) into `services:`, and add
`new-comm-builder-data:` to the top-level `volumes:`. Adjust the two repo bind-mount host paths
to the real ones from steps 10–11.

Change only the **left** side of `host:container:ro`. `BANKING_SEED_REPO` and
`SETUP_FILES_SEED_REPO` in the env file are container-side paths and must keep matching the
right-hand side. Where the stack already mounts a repo under a given container-side name (e.g.
`investigate-work-items` uses `/repos/setup-files`), reuse that name.

- [ ] Service block added under `services:`
- [ ] `new-comm-builder-data:` added under `volumes:`
- [ ] Repo bind-mount host paths match steps 10–11
- [ ] AL compiler mount present: `/home/azureuser/tools/al/al-ext/extension/bin:/opt/al/bin:ro`
- [ ] All three bind mounts end in `:ro`; only the `new-comm-builder-data:/data` volume is writable

---

# PHASE C — Build (steps 21–26)

### 21. [VM] Validate the merged compose parses

```bash
docker compose config --services
```
- [ ] All seven services listed, including `new-comm-builder`
- [ ] No YAML error

### 22. [VM] Confirm the resolved config picked up your env file

```bash
docker compose config new-comm-builder | grep -E 'REPO_CACHE|STATE_DIR|SKILLS_SOURCE|SEED_REPO|/repos'
```
- [ ] Paths are `/data/...` and `/app/.claude`
- [ ] Seed paths and `:ro` mounts appear as expected

### 23. [VM] Check RAM headroom

The container limit is `2G`, against a **measured** peak of 0.57 GiB — see
[the spike below](#appendix--measuring-the-real-alc-peak). Local memory is dominated by one
scoped `alc` invocation; tests execute remotely on the BC environment, so they cost waiting,
not RAM.

```bash
free -h && docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
cat /proc/pressure/memory
```
- [ ] At least ~1.5 GiB in `available`
- [ ] `avg10`/`avg60` are 0.00 — the host is not already contending

A `Standard_B2als_v2` (2 vCPU, 4 GiB) carries this alongside six other watchers. If the limit is
ever raised above physical RAM it stops binding, and an overrun becomes the kernel's choice of
victim rather than this container's problem — keep it under host RAM.

Optional but cheap on a swapless host: `SwapTotal: 0` means `CommitLimit` is only 50% of RAM.
Under the default `vm.overcommit_memory=0` that's advisory, but a small swapfile removes the
question and gives a spill target.

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 24. [VM] Check disk headroom

Budget ~5 GB: the two mirrors are ~290 MiB of packed objects and `--dissociate` copies them, so
count them twice; the rest is worktree checkouts, the image, and BC symbol packages.

```bash
df -h / /var/lib/docker
du -sh ~/repos/continia-banking/.git ~/repos/setup-files/.git
```
- [ ] At least 5 GB free, plus room for a swapfile if step 23 added one
- [ ] `/` and `/var/lib/docker` may be the same filesystem — if so, everything above shares it

### 25. [VM] Build the image

```bash
docker compose build new-comm-builder
```
- [ ] Build succeeded

If it fails at the `COPY .tools/continia-linux` line, redo steps 5–7.

### 26. [VM] Confirm the image exists

```bash
docker images | grep -i comm-builder
```
- [ ] Image listed

Then prove the AL compiler resolves **inside** the container, before anything long-running
depends on it:

```bash
docker compose run --rm --entrypoint sh new-comm-builder -c \
  '/opt/al/bin/linux/alc /? 2>&1 | head -3'
```
- [ ] Prints `Microsoft (R) AL Compiler version …`

A "Couldn't find a valid ICU package" error means the Dockerfile's `libicu` install didn't
resolve; a "No such file" means the `/opt/al/bin` mount from step 20 is missing. Either way this
fails in two seconds instead of forty minutes into a verify phase.

---

# PHASE D — Pre-flight, no writes anywhere (steps 27–33)

### 27. [VM] Set the shorthand

```bash
S="docker compose run --rm new-comm-builder bun run src/cli/index.ts"
```
- [ ] Set

### 28. [VM] Config loads and credentials validate

```bash
$S status
```
- [ ] Org/project print as `continia-software/Continia Software`
- [ ] Both repo GUIDs shown — **not** `ID NOT SET`
- [ ] `Build/test: enabled`
- [ ] `0 tracked job(s): {}`

A missing `ANTHROPIC_API_KEY` or `CONTINIA_API_TOKEN` fails here naming the variable, rather
than surviving to burn a planning run.

Then confirm the two repo **names** are exact. They build the clone URLs, and everything up to
this point resolves repos by GUID instead — so a name typo passes `status`, passes the integration
tests, and fails only at step 41 with `TF401019`:

```bash
docker compose run --rm new-comm-builder sh -c \
  'curl -s -u :$AZURE_DEVOPS_PAT \
    "https://dev.azure.com/$AZURE_DEVOPS_ORG/_apis/git/repositories?api-version=7.1" \
   | grep -o "\"name\":\"[^\"]*Banking[^\"]*\""'
```
- [ ] `Continia Banking` appears exactly as configured
- [ ] `Continia Banking - Setup Files` appears exactly as configured — note the hyphen

### 29. [VM] Confirm container paths and mounts

```bash
docker compose run --rm new-comm-builder sh -c \
  'echo "$REPO_CACHE_DIR | $STATE_DIR | $SKILLS_SOURCE_DIR"; ls /repos'
```
- [ ] Paths are `/data/repos | /data/state | /app/.claude`
- [ ] `/repos` lists both host repos

### 30. [VM] Continia CLI runs inside the container

```bash
docker compose run --rm new-comm-builder continia env list --json
```
- [ ] Returns JSON, not a linker error
- [ ] DemoPortal token accepted

This is the check that saves the most time — if it fails, it fails in seconds instead of 40
minutes into a verify phase.

### 31. [VM] Skills are present in the image

```bash
docker compose run --rm new-comm-builder \
  sh -c 'ls /app/.claude/skills | wc -l; ls /app/.claude/skills | head -5'
```
- [ ] Count is `15`
- [ ] `bank-integration-planner` among them

### 32. [VM] Test suite passes in the image

```bash
docker compose run --rm new-comm-builder bun test
```
- [ ] 189 pass, 0 fail

### 33. [VM] Git can authenticate to ADO from inside the container

Cheapest possible check of the PAT's Code scope, before a real clone.

```bash
docker compose run --rm new-comm-builder sh -c \
  'bun run src/cli/index.ts status >/dev/null && echo "config ok"'
```
- [ ] Prints `config ok`

Real git auth is exercised at step 41.

---

# PHASE E — Throwaway work item (steps 34–37)

### 34. [ADO] Create a scrap work item

**Never point this at a real work item.** The pipeline comments on it, re-tags it, and can open
pull requests against whatever it's given.

In `Continia Software`, create a User Story titled e.g. `TEST — Acme Bank communication`.
- [ ] Created

### 35. [ADO] Give it a deliberately underspecified description

Name a bank and an auth method. **Omit** the reference bank, the payment methods and the
statement format.

- [ ] Description is vague on purpose

The vagueness is the point: it makes the planner stop and ask, which exercises the entire ADO
write path for one planning run instead of a whole job.

### 36. [ADO] Add the trigger tag

Add tag `create-new-comm`.
- [ ] Tag added

### 37. Note the work item ID

Referred to as `<WI>` below.
- [ ] ID recorded

---

# PHASE F — Rung 2: ADO read path, zero writes (steps 38–40)

### 38. [VM] Dry-run the item

Returns before any worktree or agent work, so this isolates one thing.

```bash
$S run-item <WI> --dry-run
```
- [ ] Title and description print
- [ ] Comment count matches ADO

### 39. [ADO] Confirm nothing was written

- [ ] No new comment on the item
- [ ] Tags unchanged — `create-new-comm` still there

### 40. [VM] Confirm no job state was persisted

```bash
$S status
```
- [ ] Still `0 tracked job(s)`

---

# PHASE G — Rung 3: clarify handshake and skill wiring (steps 41–52)

One planning run. Expect 10–20 minutes and a few dollars.

### 41. [VM] Run the item for real

```bash
$S run-item <WI>
```
- [ ] Completes without a fatal error
- [ ] Log shows the clone finishing in seconds/low minutes, **not** a multi-GB download

That second box is the seed working. If it downloaded everything, recheck steps 15 and 22.

### 42. [VM] Confirm the bare clones exist

```bash
docker compose run --rm new-comm-builder \
  sh -c 'ls /data/repos && git -C /data/repos/banking.git count-objects -vH | tail -3'
```
- [ ] `banking.git` and `setupFiles.git` present
- [ ] Object count is non-trivial

### 43. [VM] Confirm the seed left no dangling dependency

`--dissociate` should have copied the objects and dropped the alternate.

```bash
docker compose run --rm new-comm-builder \
  sh -c 'cat /data/repos/banking.git/objects/info/alternates 2>/dev/null || echo "no alternates — correct"'
```
- [ ] Prints `no alternates — correct`

### 44. [ADO] Questions were posted

- [ ] A comment lists blocking questions
- [ ] It renders as formatted HTML, not raw tags

### 45. [ADO] Tags were swapped

- [ ] `create-new-comm` is **gone**
- [ ] `create-new-comm-waiting` is present

### 46. [VM] State reflects the pause

```bash
$S status
```
- [ ] Phase `awaiting-answers`
- [ ] `rounds=1`
- [ ] Branch shown as `Userstory/agent/<WI>-<slug>`

### 47. [VM] Skills are symlinked into the worktree

```bash
docker compose run --rm new-comm-builder \
  sh -c 'ls -l /data/worktrees/<WI>/banking/.claude/skills/ | head -5'
```
- [ ] Entries are **symlinks** (`l` in the mode, arrows into `/app/.claude/...`)

### 48. [VM] Sibling repo paths were written

```bash
docker compose run --rm new-comm-builder \
  cat /data/worktrees/<WI>/banking/.claude/repo-paths.json
```
- [ ] Both worktree paths listed

### 49. [VM] The worktree is clean — the most important check

```bash
docker compose run --rm new-comm-builder \
  sh -c 'cd /data/worktrees/<WI>/banking && git status --porcelain'
```
- [ ] Output is **completely empty**

This proves `.git/info/exclude` is holding and that no `.agent/` or `.claude/` scaffolding can
ever reach a pull request diff. If anything shows up here, stop and fix it before rung 4.

### 50. [VM] The planner wrote its artifact

```bash
docker compose run --rm new-comm-builder \
  cat /data/worktrees/<WI>/banking/.agent/plan/questions.json
```
- [ ] Valid JSON with `blocking` and/or `ambiguities`

### 51. [ADO] Answer and re-trigger

1. Answer the questions in a work item comment.
2. Re-add the `create-new-comm` tag.

- [ ] Answer posted
- [ ] Trigger tag re-added

### 52. [VM] The loop resumes and sees your answer

```bash
$S run-once
```
- [ ] The item is picked up (it's `awaiting-answers`, so `shouldProcess` returns true)
- [ ] Round 2 references your answer
- [ ] `rounds=2`

---

# PHASE H — Rung 4: full job, no BC (steps 53–61)

### 53. Point at scratch repos

This rung really pushes branches and opens pull requests. Swap `BANKING_REPO_ID` and
`SETUP_FILES_REPO_ID` in `.env.new-comm-builder` for scratch repo GUIDs.

- [ ] Both IDs now point at scratch repos

Pointing this at the real Continia Banking repo before rung 3 is green is the one mistake in
this sequence that's genuinely annoying to undo.

### 54. [VM] Reset the item so it runs from scratch

```bash
$S reset-item <WI>
```
- [ ] State cleared

### 55. [ADO] Put the trigger tag back

- [ ] `create-new-comm` present, `create-new-comm-waiting` removed

### 56. [VM] Run the full pipeline with BC skipped

```bash
docker compose run --rm -e SKIP_BUILD_TEST=true -e MAX_CLARIFY_ROUNDS=0 \
  new-comm-builder bun run src/cli/index.ts run-item <WI>
```

`MAX_CLARIFY_ROUNDS=0` forces it past the clarify loop into implement; `SKIP_BUILD_TEST=true`
makes verify return passed without touching BC. So this isolates implement → commit → push →
draft PRs → comment → done tag → cleanup.

- [ ] Finishes with `phase=done`

### 57. [ADO] Draft PRs exist

- [ ] One draft PR per repo that changed, each linked to `<WI>`
- [ ] Both are **drafts**

### 58. [ADO] The PR description is honest about verification

- [ ] It says verification was **skipped** — it must not claim tests passed

### 59. [ADO] The PR diffs are clean

- [ ] No `.claude/` files in either diff
- [ ] No `.agent/` files in either diff

### 60. [ADO] Work item was closed out correctly

- [ ] Success comment links both PRs
- [ ] Tag is now `create-new-comm-done`

### 61. [VM] Worktrees cleaned up, caches kept

```bash
docker compose run --rm new-comm-builder \
  sh -c 'ls /data/worktrees/ ; echo "--- repos ---" ; ls /data/repos/'
```
- [ ] No `<WI>` directory under worktrees
- [ ] Both `*.git` mirrors still present

---

# PHASE I — Rung 5: the real thing (steps 62–68)

### 62. Restore the real repo IDs

- [ ] `BANKING_REPO_ID` and `SETUP_FILES_REPO_ID` back to the real GUIDs
- [ ] `SKIP_BUILD_TEST` not set (or `false`)
- [ ] `DRAFT_PR` not set (defaults true)

### 63. [VM] Reset the item and re-tag

```bash
$S reset-item <WI>
```
Then re-add `create-new-comm` in ADO, and abandon the scratch PRs from rung 4.
- [ ] State cleared, trigger tag back, scratch PRs abandoned

### 64. [VM] Start the watcher

```bash
docker compose up -d new-comm-builder
docker compose logs -f new-comm-builder
```
- [ ] Watcher starts and logs its poll interval

### 65. [VM] Verify phase reaches BC

Expect hours. Watch the log.

```bash
docker compose exec new-comm-builder tail -f /data/logs/<WI>/verify.log
```
- [ ] `continia-env-setup` finds or starts an environment
- [ ] Deploy and test steps run

### 66. [VM] The verify artifact exists and matches the claim

```bash
docker compose exec new-comm-builder \
  cat /data/worktrees/<WI>/banking/.agent/verify/result.json
```
- [ ] File exists
- [ ] Its verdict **matches what the PR description claims**

The core non-negotiable: a missing artifact must be treated as failure, never as a pass.

### 67. [VM] The BC environment is still running

Cleanup must never stop or delete it.

```bash
docker compose run --rm new-comm-builder continia env list --json
```
- [ ] The environment used for verification is still up

### 68. [ADO] Outcome is correct for the result

On success:
- [ ] Draft PR per changed repo, linked to `<WI>`
- [ ] Tag `create-new-comm-done`

On test failure:
- [ ] **No PR opened**
- [ ] Branch still pushed for inspection
- [ ] Failure comment with the last log lines
- [ ] Tag `create-new-comm-failed`

---

# PHASE J — Probe the two unverified behaviours (steps 69–72)

Neither is covered by unit tests.

### 69. Restart mid-flight

A restart resumes rather than repeats: `resolveEntryPhase` (`src/services/entry-phase.ts`) reads
the job's recorded phase and which artifacts already exist on disk, and `runJob` runs forward
from whatever it returns — it does not re-plan by default. Expect a job killed mid-implement to
come back at `implementing`, not `planning`.

Once `docker compose logs -f new-comm-builder` shows `Item #<WI>: implementing`, kill it before it
finishes:

```bash
docker compose restart new-comm-builder
docker compose logs -f new-comm-builder
```
- [ ] Log says `entering at implementing`, not `entering at planning`
- [ ] The last `plan-N.log` gains no new `===== run started` block (no re-plan)
- [ ] `implement.log` gains a new `===== run started` block (implement re-ran)

### 70. Job timeout orphan

`withTimeout` (`src/services/watcher.ts:41`) rejects the race, but nothing cancels the in-flight
`query()`.

```bash
docker compose run --rm -e JOB_TIMEOUT_MINUTES=1 \
  new-comm-builder bun run src/cli/index.ts run-item <WI>
```
- [ ] Does `/data/logs/<WI>/plan-1.log` keep growing after the timeout is logged?

### 71. BC contention with the rest of the stack

The one-job-at-a-time design only serializes *within* this bot.

```bash
cd ~/teams/continia-banking
grep -rl 'continia env\|CONTINIA_API_TOKEN' --include='*.ts' --include='*.md' \
  DevOps* AzureDevops* CreateScripts* 2>/dev/null
```
- [ ] Established whether any other service drives BC environments

If another one does, they will contend during verify and a cross-service lock is needed.

### 72. Confirm the healthcheck is passing

```bash
docker compose ps new-comm-builder
```
- [ ] Status shows `healthy`

---

# Reference

## Reset commands

```bash
S="docker compose run --rm new-comm-builder bun run src/cli/index.ts"

$S status                  # config + every tracked job
$S reset-item <WI>         # forget one item so it runs from scratch
$S reset-state             # forget everything
$S cleanup-worktrees <WI>  # remove leftover worktrees
```

Nuke the cache entirely, forcing a fresh seeded clone:

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

## Progress summary

| Phase | Steps | What it proves | Done |
|---|---|---|:---:|
| A | 1–12 | Files on the VM, CLI binary runs, seed paths known | [ ] |
| B | 13–20 | Env file correct, service wired into the stack | [ ] |
| C | 21–26 | Compose parses, headroom exists, image builds | [ ] |
| D | 27–33 | Config, paths, Continia CLI, skills, tests | [ ] |
| E | 34–37 | Throwaway work item ready | [ ] |
| F | 38–40 | ADO read path, zero writes | [ ] |
| G | 41–52 | Clone seeding, comments, tag swap, skill symlinks, clean worktree | [ ] |
| H | 53–61 | Implement → push → draft PRs → done tag → cleanup | [ ] |
| I | 62–68 | Real BC verify; artifact matches the PR's claim | [ ] |
| J | 69–72 | Restart behaviour, timeout orphan, BC contention | [ ] |

---

## Appendix — measuring the real `alc` peak

The `2G` container limit in step 23 is measured, not guessed. Re-run this when the codebase grows
enough that the number might have moved, or when a new app becomes the largest.

The measurement is one scoped `continia compile` of the largest app, run under a systemd scope so
an overrun kills only the spike rather than a sibling watcher on the shared host.

```bash
export CLI=~/teams/continia-banking/ADONewDirectCombuilder/.tools/continia-linux
export ALC=~/tools/al/al-ext/extension/bin/linux/alc
export CONTINIA_API_TOKEN=$(grep '^CONTINIA_API_TOKEN=' ~/teams/continia-banking/.env.new-comm-builder | cut -d= -f2-)

# 1. Pick the worst case
du -sh ~/repos/continia-banking/*/ | sort -h | tail -5
export APP=base-application

# 2. Symbols need a running environment; compiling without them measures a failure
$CLI env list --json | grep -B2 Running
export ENVID=<a running env id>

# 3. Work on a copy — the source repo is bind-mounted into other services
rm -rf /tmp/spike-$APP && cp -r ~/repos/continia-banking/$APP /tmp/spike-$APP
$CLI deps download $ENVID /tmp/spike-$APP --json | tail -3
ls /tmp/spike-$APP/.alpackages | wc -l    # must be non-zero

# 4. Measure
sudo systemd-run --scope -p MemoryMax=3G -p MemorySwapMax=4G \
  --uid=$(id -u) --gid=$(id -g) \
  --setenv=HOME=$HOME \
  --setenv=CONTINIA_ALC_PATH=$ALC \
  --setenv=CONTINIA_AUTO_INSTALL_ALC=0 \
  --setenv=CONTINIA_API_TOKEN="$CONTINIA_API_TOKEN" \
  /usr/bin/time -v $CLI compile /tmp/spike-$APP --json 2>&1 | tee /tmp/spike.log

grep -oE '"success": *[a-z]+|"errorCount": *[0-9]+' /tmp/spike.log
awk '/Maximum resident/{printf "peak = %.2f GiB\n", $NF/1048576}' /tmp/spike.log
```

`sudo` starts a clean environment, so the `--setenv` flags are load-bearing — without them the
run silently loses `CONTINIA_ALC_PATH` and falls back to the broken auto-install path.

Only trust a run reporting `"success": true` with `"errorCount": 0`. A failed compile stops before
code emission and packaging and under-reports the peak; a missing `.alpackages` under-reports it
by an order of magnitude.

### Baseline, 2026-08-05

| | |
|---|---|
| App | `base-application`, 1040 files, 33 MB of source |
| Compiler | AL 18.0.35.20, mounted from the host AL extension |
| Peak RSS | **0.57 GiB** |
| Wall clock | 14.2 s at 143% CPU |
| Swap used | 0 |
| Host | `Standard_B2als_v2`, 2 vCPU / 4 GiB, six other watchers running |
