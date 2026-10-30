# Dockerfile (TEMPLATE)
#
# Base image must match manifest.docker.baseImage.
# Only needed if the tool builds its own image (e.g. playwright, robot).
# Tools that run from an upstream image directly (e.g. k6 -> grafana/k6) skip this.

FROM node:26-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install task runner
RUN sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin

# Install pnpm (node tools) — adjust for uv (python tools)
RUN npm install -g pnpm@11.23.0 @dotenvx/dotenvx

WORKDIR /workspace/tools/my-tool

# Install this tool's dependencies in isolation (it is NOT a workspace member of
# any parent repo — see the workspace pnpm-workspace.yaml). Each tool ships its
# own lockfile and resolves into its own node_modules.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

# Copy tool source
COPY . .
