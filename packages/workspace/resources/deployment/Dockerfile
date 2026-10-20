# syntax=docker/dockerfile:1.27

ARG DEPLOYMENT_BUILD_ID="local"

ARG NODE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG APPLICATION_PACKAGE_NAME
ARG DATABASE_PACKAGE_NAME
ARG MIGRATION_PACKAGE_NAME
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
# 冻结安装校验全部 importer，完整上下文同时保留新增包的声明。
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune "$APPLICATION_PACKAGE_NAME" "$MIGRATION_PACKAGE_NAME" --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN pnpm --filter "$DATABASE_PACKAGE_NAME" run build
RUN pnpm --filter "$APPLICATION_PACKAGE_NAME" run build
RUN pnpm --config.inject-workspace-packages=true --filter "$APPLICATION_PACKAGE_NAME" deploy --prod /runtime-deploy
RUN pnpm --config.inject-workspace-packages=true --filter "$MIGRATION_PACKAGE_NAME" deploy --prod /migration-deploy

FROM node:${NODE_VERSION}-bookworm-slim AS application-runtime
ARG APPLICATION_PACKAGE_PATH
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/${APPLICATION_PACKAGE_PATH}/dist ./dist
ENV DATABASE_FILE="/data/app.sqlite"
USER app

# 单容器部署先准备数据库，再启动应用。
FROM application-runtime AS standalone
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV PATH="/migration/node_modules/.bin:$PATH"
COPY --from=build --chown=app:nodejs /migration-deploy /migration
COPY --chmod=755 --from=build /repo/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["prepare-and-start"]

# 仅启动应用，数据库必须先由配套 standalone 镜像准备。
FROM application-runtime AS runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
EXPOSE 3000
CMD ["node", "/app/dist/server/index.mjs"]
