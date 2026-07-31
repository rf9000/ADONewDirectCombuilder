# syntax=docker/dockerfile:1

FROM oven/bun:1-debian

# git         — mirror clones and worktrees
# ca-certs    — HTTPS to dev.azure.com and api.anthropic.com
# libicu/ssl  — the continia CLI is a dynamically linked Node SEA build
# unzip/curl  — CONTINIA_AUTO_INSTALL_ALC downloads the AL compiler on first compile
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        unzip \
        libicu72 \
        libssl3 \
        libstdc++6 \
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
RUN mkdir -p /data/repos /data/worktrees /data/state /data/logs /data/alc-cache \
    && chown -R bun:bun /data /app

USER bun

ENV NODE_ENV=production \
    REPO_CACHE_DIR=/data/repos \
    WORKTREE_ROOT=/data/worktrees \
    STATE_DIR=/data/state \
    LOG_DIR=/data/logs \
    SKILLS_SOURCE_DIR=/app/.claude \
    CONTINIA_CLI_PATH=/usr/local/bin/continia \
    CONTINIA_ALC_CACHE=/data/alc-cache \
    CONTINIA_AUTO_INSTALL_ALC=1

# The agent SDK shells out to git; make sure it never blocks on a credential prompt.
ENV GIT_TERMINAL_PROMPT=0

CMD ["bun", "run", "src/cli/index.ts", "watch"]
