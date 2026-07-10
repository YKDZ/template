# syntax=docker/dockerfile:1.7

ARG DEPLOYMENT_BUILD_ID="local"

FROM node:{{NODE_VERSION}}-bookworm-slim AS base
ARG PACKAGE_MANAGER_PIN="{{PACKAGE_MANAGER_PIN}}"
ENV COREPACK_HOME="/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN corepack enable && corepack prepare "$PACKAGE_MANAGER_PIN" --activate

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --offline --frozen-lockfile
COPY . .
RUN pnpm exec turbo prune {{WEB_PACKAGE_NAME}} --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
RUN pnpm --filter ./apps/web run build:run
RUN pnpm --filter ./apps/web deploy --prod --legacy /runtime-deploy \
  && rm -rf /runtime-deploy/node_modules/@*/db \
  && find /runtime-deploy/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '*@file+packages+db' -exec rm -rf '{}' +

FROM node:{{NODE_VERSION}}-bookworm-slim AS application-runtime
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/apps/web/dist ./dist
COPY --chmod=755 --from=build /repo/apps/web/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
ENV DATABASE_FILE="/data/app.sqlite"
USER app

FROM base AS database-preparation
ENV NODE_ENV="production"
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile --prod=false
COPY --from=pruner /repo/out/full/ ./
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --chmod=755 --from=pruner /repo/out/full/apps/web/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
COPY --chmod=755 --from=pruner /repo/out/full/apps/web/scripts/prepare-database.sh /usr/local/bin/prepare-database
ENV DATABASE_FILE="/data/app.sqlite"
USER app

# Final deployment target: standalone
# One-container deployments prepare the database before startup.
FROM database-preparation AS standalone
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
WORKDIR /app
COPY --from=application-runtime --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=application-runtime --chown=app:nodejs /app/dist ./dist
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["prepare-and-start"]

# Final deployment target: runtime
# Start-only image for databases prepared by a matching standalone image.
FROM application-runtime AS runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV CONTAINER_CAPABILITY="start-only"
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["start-only"]
