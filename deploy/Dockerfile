# A Shared workspace server: the Colonie server and its web app, with the
# Claude and Codex engines it runs, for Linux. No Electron: people use the web
# app in their browser, or the desktop app connected to this server. HTTPS is
# Caddy's job (deploy/compose.yaml); this server only listens on loopback.

# Build: install everything, build the web app, then drop what only building needs.
FROM node:24-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1
RUN corepack enable
WORKDIR /app
# Dependencies first, so a code change does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY cloud/package.json cloud/package.json
# The desktop build installs engines for both Mac CPUs; a server needs only
# its own, which is what pnpm picks when the list is gone.
RUN node -e 'const fs=require("fs");const f="pnpm-workspace.yaml";fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^supportedArchitectures:\n(?:  .*\n)+/m,""))' \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild esbuild
COPY . .
# COPY brought the two-CPU list back; without removing it again, prune
# reinstalls every other CPU's engines (about 750 MB of ARM binaries).
RUN node -e 'const fs=require("fs");const f="pnpm-workspace.yaml";fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^supportedArchitectures:\n(?:  .*\n)+/m,""))' \
    && pnpm build \
    && pnpm prune --prod --ignore-scripts

# Run: Node, git for the engines, the bots' browser, and the built app.
FROM node:24-bookworm-slim
# Chrome's Bookworm libraries, installed here: agent-browser's --with-deps
# would call sudo, which this image does not ship.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*
# Every Shared server carries the bots' browser (owner, October 28): the
# pinned agent-browser and a Chrome for Testing, before the app files so a
# code-only update does not download them again. Pin here and in
# server/colonie/computer/browser-engine-release.ts together.
ARG AGENT_BROWSER_VERSION=0.37.0
RUN npm install -g --cache /tmp/npm-cache agent-browser@${AGENT_BROWSER_VERSION} \
    && HOME=/opt/colonie-browser agent-browser install \
    && ln -s /opt/colonie-browser/.agent-browser/browsers/chrome-*/chrome /opt/colonie-browser/chrome \
    && native="$(readlink -f "$(command -v agent-browser)")" \
    && case "$native" in */agent-browser/bin/agent-browser-linux-*) ;; *) echo "agent-browser is not a native binary: $native" >&2; exit 1;; esac \
    && [ "$(head -c 4 "$native")" = "$(printf '\177ELF')" ] \
    && for binary in "${native%/*}"/agent-browser-*; do [ "$binary" = "$native" ] || rm "$binary"; done \
    && agent-browser --version \
    && rm -rf /tmp/npm-cache /tmp/node-compile-cache
# The browser stays outside /data, which may be an existing volume; each
# bot's browser sessions and logins live under HOME, in /data.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/colonie-browser/chrome
WORKDIR /app
COPY --from=build /app /app
# Everything the workspace keeps lives in one volume.
ENV HOME=/data/home \
    COLONIE_DATA_DIR=/data/workspace \
    COLONIE_STATIC_DIR=/app/dist \
    COLONIE_PROFILE=1 \
    COLONIE_PORT=8799 \
    COLONIE_WORKSPACE_KIND=shared
VOLUME ["/data"]
CMD ["node", "server/index.ts"]
