# syntax=docker/dockerfile:1.7

ARG DEPLOYMENT_BUILD_ID="local"

# @template-mirror NODE_VERSION
ARG NODE_VERSION="{{NODE_VERSION}}"
# @end-template-mirror

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV COREPACK_HOME="/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
WORKDIR /repo
COPY package.json /root-manifest.json
RUN install -d -m 0755 "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_HOME/bin" \
  && corepack enable --install-directory "$PNPM_HOME" \
  && package_manager="$(node -p "require('/root-manifest.json').packageManager")" \
  && rm /root-manifest.json \
  && for attempt in 1 2 3; do \
    if corepack prepare "$package_manager" --activate; then break; fi; \
    [ "$attempt" -lt 3 ] || exit 1; \
    sleep 2; \
  done \
  && chmod -R a+rX "$COREPACK_HOME" "$PNPM_HOME"

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json turbo.json ./
COPY {{APPLICATION_PACKAGE_PATH}}/package.json {{APPLICATION_PACKAGE_PATH}}/package.json
COPY {{DATABASE_PACKAGE_PATH}}/package.json {{DATABASE_PACKAGE_PATH}}/package.json
COPY {{MIGRATION_PACKAGE_PATH}}/package.json {{MIGRATION_PACKAGE_PATH}}/package.json
COPY {{TYPESCRIPT_CONFIG_PACKAGE_PATH}}/package.json {{TYPESCRIPT_CONFIG_PACKAGE_PATH}}/package.json
# 冻结安装会校验 lockfile 的每个 importer，加包会产生四份初始 manifest 之外的新 importer，故安装前需让完整上下文可见。
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune {{APPLICATION_PACKAGE_NAME}} {{MIGRATION_PACKAGE_NAME}} --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN pnpm --filter {{DATABASE_PACKAGE_NAME}} run build
RUN pnpm --filter {{APPLICATION_PACKAGE_NAME}} run build
RUN pnpm --config.inject-workspace-packages=true --filter {{APPLICATION_PACKAGE_NAME}} deploy --prod /runtime-deploy
RUN pnpm --config.inject-workspace-packages=true --filter {{MIGRATION_PACKAGE_NAME}} deploy --prod /migration-deploy

FROM node:${NODE_VERSION}-bookworm-slim AS application-runtime
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/{{APPLICATION_PACKAGE_PATH}}/dist ./dist
ENV DATABASE_FILE="/data/app.sqlite"
USER app

# Final deployment target: standalone
# One-container deployments prepare the database before startup.
FROM application-runtime AS standalone
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV PATH="/migration/node_modules/.bin:$PATH"
COPY --from=build --chown=app:nodejs /migration-deploy /migration
COPY --chmod=755 --from=build /repo/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["prepare-and-start"]

# Final deployment target: runtime
# Start-only image for databases prepared by a matching standalone image.
FROM application-runtime AS runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
EXPOSE 3000
CMD ["node", "/app/dist/server/index.mjs"]
