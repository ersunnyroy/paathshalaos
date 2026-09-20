# The API image (M22.2).
#
# NOT BUILT OR RUN ANYWHERE YET. Written against a Docker daemon that neither
# environment this was developed in could reach, so every claim below is a
# claim about the Dockerfile rather than about an image that exists. The first
# `docker build` will find something; that is what a first build is for.
#
# Multi-stage, for one reason that matters and one that does not. The one that
# does: the runtime stage has no compiler, no dev dependencies and no source,
# so a remote-code-execution bug in a dependency lands somewhere with very
# little to work with. The one that does not: image size. A smaller image is
# pleasant and is not a security property.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /repo

# pnpm from corepack rather than a curl-to-shell: corepack ships with Node and
# pins the version from package.json, so the build does not silently change
# when a new pnpm is released.
RUN corepack enable

# Manifests first, so a source change does not re-download the dependency tree.
# The lockfile is copied and `--frozen-lockfile` is used: a build that may
# resolve a different version than the one tested is not a build of what was
# tested.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/offline-queue/package.json packages/offline-queue/
COPY packages/api-client/package.json packages/api-client/
RUN pnpm install --frozen-lockfile --filter @paathshala/api...

COPY . .
RUN pnpm --filter @paathshala/api run build

# Production dependencies only, resolved into a self-contained tree so the
# runtime stage needs no workspace and no package manager.
RUN pnpm --filter @paathshala/api --prod deploy /out

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Node's default heap is a fraction of the container's memory limit, and the
# default is computed from the HOST's memory when the limit is set by cgroups.
# Stated explicitly so a container that is given 512Mi does not try to use 2Gi
# and get killed by the OOM reaper with no log line.
ENV NODE_OPTIONS=--max-old-space-size=384

# The base image ships a `node` user. Running as root inside a container is the
# default nobody chose and everybody inherits.
USER node

COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json

EXPOSE 3001

# No HEALTHCHECK instruction. The orchestrator owns liveness — it is the thing
# that can restart the container, and a Docker-level healthcheck duplicates
# that decision in a place the orchestrator cannot see. /health is there for
# whatever does own it.

# Migrations are NOT run here. A container that migrates on start means every
# replica races to migrate, and a rollback becomes a schema question rather
# than an image question. They run as a separate step before the new version
# is rolled out — and `assertSchemaMatchesCode` at boot refuses to serve if
# that step was skipped.
CMD ["node", "dist/main.js"]
