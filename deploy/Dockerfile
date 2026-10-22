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

# Run: Node, git for the engines, and the built app.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
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
