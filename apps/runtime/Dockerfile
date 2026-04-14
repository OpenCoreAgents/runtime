# Build from repository root, e.g.:
#   docker build -f apps/runtime/Dockerfile .
FROM node:22-bookworm-slim

# Pull security fixes for Debian packages not yet in the frozen base layer (addresses many scanner “high” findings).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages packages
COPY examples examples
COPY apps apps

# OpenClaw: bake apps/runtime/skills into config/skills so skillsDirs: [./skills] matches the stack file in config/
# (same target as docker-compose ./skills bind mount; Compose overrides this directory on the host).
COPY apps/runtime/skills /app/apps/runtime/config/skills

# `@opencoreagents/core` is built with `external: ["@opencoreagents/dynamic-definitions"]`; Node then
# resolves that package from `packages/core/dist/…`, which only sees `node_modules` above `packages/core/`.
# pnpm links workspace deps under `apps/runtime/node_modules`, not under `packages/core/`, so add a
# workspace-local link (avoids a Turbo build cycle: core must not depend on dynamic-definitions in package.json).
RUN pnpm install --frozen-lockfile \
  && mkdir -p /app/packages/core/node_modules/@opencoreagents \
  && ln -sfn /app/packages/dynamic-definitions /app/packages/core/node_modules/@opencoreagents/dynamic-definitions \
  && pnpm turbo run build --filter=@opencoreagents/runtime...

COPY apps/runtime/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV RUNTIME_CONFIG=/app/apps/runtime/config/docker.stack.yaml

ENTRYPOINT ["/entrypoint.sh"]
WORKDIR /app/apps/runtime
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
