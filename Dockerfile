# syntax=docker/dockerfile:1

# Node.js 22, copied from the official image rather than installed from a distro
# repo (Debian trixie ships 20.x) or a downloaded tarball (a pinned patch version
# goes stale and rots). Bun runs this project's own code, but Node is still
# required: the Agent SDK spawns it, and both MCP servers in .mcp.json launch via
# `npx` — without it they fail to spawn and loadMcpServers reports nothing.
FROM node:22-bookworm-slim AS node

FROM oven/bun:1-debian

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version && npx --version

# git         — mirror clones and worktrees
# ca-certs    — HTTPS to dev.azure.com and api.anthropic.com
# libicu      — the self-contained .NET AL compiler dlopens ICU at runtime, so it
#               never appears in `ldd alc`; without it .NET aborts with "Couldn't
#               find a valid ICU package installed on the system". Resolved by name
#               rather than pinned: the oven/bun:1-debian tag moved from bookworm
#               (libicu72) to trixie (libicu76) and a pinned version fails the build.
# libssl/c++  — also for the compiler; continia-linux itself is statically linked
# unzip/curl  — general tooling
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        unzip \
        libssl3 \
        libstdc++6 \
    && apt-get install -y --no-install-recommends \
        "$(apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -1 | cut -d' ' -f1)" \
    && rm -rf /var/lib/apt/lists/*

# The Linux build of the Continia CLI. The continia-* skills document it as
# `.tools/continia.exe`; on PATH as `continia` it works the same headless.
COPY .tools/continia-linux /usr/local/bin/continia
RUN chmod +x /usr/local/bin/continia

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# .claude/ ships in the image: the skills here are symlinked into each worktree.
COPY . .

# /data is the mounted volume: repo cache, worktrees, state, logs, alc cache.
RUN mkdir -p /data/repos /data/worktrees /data/state /data/logs \
    && chown -R bun:bun /data /app

USER bun

# CONTINIA_AUTO_INSTALL_ALC is deliberately 0. continia-linux 0.22.0 looks for the
# downloaded compiler at lib/net10.0/alc while the package ships lib/net8.0/alc, so
# auto-install fails on every compile. The compose file bind-mounts the host's AL
# extension at /opt/al/bin instead — see docs/known-issues.md.
ENV NODE_ENV=production \
    REPO_CACHE_DIR=/data/repos \
    WORKTREE_ROOT=/data/worktrees \
    STATE_DIR=/data/state \
    LOG_DIR=/data/logs \
    SKILLS_SOURCE_DIR=/app/.claude \
    CONTINIA_CLI_PATH=/usr/local/bin/continia \
    CONTINIA_ALC_PATH=/opt/al/bin/linux/alc \
    CONTINIA_AUTO_INSTALL_ALC=0

# The agent SDK shells out to git; make sure it never blocks on a credential prompt.
ENV GIT_TERMINAL_PROMPT=0

CMD ["bun", "run", "src/cli/index.ts", "watch"]
