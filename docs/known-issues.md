# Known issues in external dependencies

Defects outside this repo that the deployment works around. Each entry says what breaks, how it
presents, and what to remove once the upstream fix lands.

---

## `continia-linux` auto-install resolves `alc` at the wrong target framework

**Versions:** CLI `0.22.0`, package `microsoft.dynamics.businesscentral.development.tools.linux`
`17.0.34.45391`. Confirmed 2026-08-05.

With `CONTINIA_AUTO_INSTALL_ALC=1`, the CLI downloads and extracts the compiler package
successfully, then looks for the binary at a path that doesn't exist in it:

```
Error: alc not found at /root/.continia/alc/17.0.34.45391/lib/net10.0/alc
       after extracting microsoft.dynamics.businesscentral.development.tools.linux 17.0.34.45391
```

The package ships `lib/net8.0/alc`. The CLI derives `net10.0`. There is no `net10.0` directory.

A second defect sits behind it: the extracted `alc` is mode `644`, so even at the correct path it
would fail with `Permission denied`.

**Why it matters here.** The verify phase is the only thing that compiles AL, so this fails every
job at the same point — and per the project's non-negotiables a missing `verify/result.json` means
no pull request. Nothing earlier in the pipeline touches it, so it surfaces only after a full plan
and implement have already run and been paid for.

**Workaround, as deployed.** `CONTINIA_AUTO_INSTALL_ALC=0` plus the host's AL extension bind-
mounted read-only, which is what `create-scripts-for-videos` in the same stack already does:

```yaml
    environment:
      CONTINIA_ALC_PATH: /opt/al/bin/linux/alc
      CONTINIA_AUTO_INSTALL_ALC: "0"
    volumes:
      - /home/azureuser/tools/al/al-ext/extension/bin:/opt/al/bin:ro
```

Pointing `CONTINIA_ALC_PATH` into the auto-install cache is **not** a viable alternative: the
version directory name changes with every download, so no static value can target it.

The mounted compiler is self-contained .NET, so the image needs no dotnet runtime — but it does
`dlopen` ICU, which is why the Dockerfile installs `libicu`. That dependency is invisible to
`ldd`; without it .NET aborts with *"Couldn't find a valid ICU package installed on the system"*.

**To remove:** once the CLI resolves the shipped TFM and marks the binary executable, drop the
mount and the two env vars and set `CONTINIA_AUTO_INSTALL_ALC=1`. Verify with the `alc /?` check
in step 26 of the bring-up runbook.

---

## AL source paths whose case doesn't match disk fail only on Linux

**Class of bug, not a single instance.** AL file references are resolved literally. On Windows,
NTFS is case-insensitive, so a declaration like `ControlAddIns/Javascript/Popup.js` resolves
against an on-disk `javascript/` folder. On a case-sensitive filesystem it does not, and `alc`
reports:

```
error AL0327: Missing file 'ControlAddIns/Javascript/Popup.js'.
```

**Found instance:** `base-application/ControlAddIns/PopupLogin.ControlAddin.al` in Continia
Banking. Fixed upstream by PR 52622 (2026-08-05), which lower-cased the three declared paths.

**Why it matters here.** It compiles, ships and works on every developer machine and on Windows
CI, so nothing flags it. This bot is the first Linux consumer of that source, and
`base-application` holds the bank-system assisted-setup pages — so a new bank communication is
very likely to touch it. Every job would have failed with three errors unrelated to the agent's
own work.

**Detection.** A clean-clone compile on Linux is the only reliable signal. `git ls-files` versus
the paths declared in `.al` sources would catch new instances at the source, but that belongs in
Continia Banking's CI, not here.

**No workaround is deployed.** A case-alias symlink in the worktree — registered in
`.git/info/exclude` the way `wireSkills` handles its symlinks, so it can never reach a PR diff —
would work if this recurs and an upstream fix isn't immediately available. It was not needed for
the found instance.

---

## A pinned Agent SDK plus a newer model is a 400 on every job

**Found 2026-08-05 with `@anthropic-ai/claude-agent-sdk@0.2.63` and `CLAUDE_MODEL=claude-opus-5`.**

Every planning run failed one turn in:

```
API Error: 400 "thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

`src/services/agent-runner.ts` passes no thinking parameter — the SDK sends
`thinking: {type: "enabled", budget_tokens: N}` itself. That shape was removed on
`claude-opus-5` (and Opus 4.8/4.7, Sonnet 5, Fable 5) and returns a 400; only the 4.6 family
still accepts it. Fixed by updating the SDK to `0.3.222`.

**Why it wasn't caught earlier.** `package.json` declares `"latest"`, but `bun.lock` pinned
`0.2.63` and the Dockerfile installs `--frozen-lockfile` — correct for reproducibility, and it
means the image stays on whatever the lockfile says no matter what `package.json` claims. With
`CLAUDE_MODEL` defaulting to `claude-opus-5`, the checked-in default was the broken combination,
so a clean-clone deploy failed identically. Nothing before the agent phase touches the model, so
it surfaced only after clone, worktree and skill wiring had all succeeded.

**Treat `bun.lock` as a rebuild trigger.** When bumping `CLAUDE_MODEL` to a newer model, update
the SDK in the same change:

```bash
bun update @anthropic-ai/claude-agent-sdk && bun run typecheck && bun test
```

On a host without bun, run it in the base image with the repo mounted:

```bash
docker run --rm --user $(id -u):$(id -g) \
  -v <repo>:/src -w /src oven/bun:1-debian bun update @anthropic-ai/claude-agent-sdk
```

---

## The image needs Node.js even though the app runs on Bun

`oven/bun:1-debian` ships no Node. Bun runs this project's own code, but Node is required for
two things that fail *silently* without it: the Agent SDK spawns `node` for subprocesses, and
both MCP servers in `.mcp.json` (`@azure-devops/mcp`, `@vjeko.com/al-object-id-ninja-mcp`) are
declared as `command: "npx"`. A missing `npx` means neither server spawns, and the loss is
invisible — `loadMcpServers` returns the definitions regardless, so you lose AL object-ID
reservation and `fw-create-pr` with no error anywhere.

The Dockerfile copies Node 22 from `node:22-bookworm-slim` in a build stage rather than
installing from apt (Debian trixie ships 20.x) or a tarball (a pinned patch version rots). The
`node --version && npm --version && npx --version` at the end of that `RUN` is deliberate: it
turns a broken copy into a build failure instead of a runtime surprise.

Verify after any base-image change:

```bash
docker compose run --rm --entrypoint sh new-comm-builder -c 'node --version; npx --version'
```

---

## `oven/bun:1-debian` moves between Debian releases

Not a defect, but it broke the build once and will again. The tag tracks the current Debian
stable: it moved from bookworm (`libicu72`) to trixie (`libicu76`), and the Dockerfile's pinned
`libicu72` failed with `E: Unable to locate package libicu72`.

The Dockerfile now resolves the ICU package by name rather than pinning a version, so a future
base bump doesn't break it:

```dockerfile
    && apt-get install -y --no-install-recommends \
        "$(apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -1 | cut -d' ' -f1)"
```

The alternative — pinning the base image by digest — is more reproducible but freezes the distro
and defers the same failure to whenever someone unpins it.
