# syntax=docker/dockerfile:1.7

ARG DEPLOYMENT_BUILD_ID="local"

FROM node:{{NODE_VERSION}}-bookworm-slim AS base
ARG PACKAGE_MANAGER_PIN="{{PACKAGE_MANAGER_PIN}}"
ENV COREPACK_HOME="/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN install -d -m 0755 "$COREPACK_HOME" "$PNPM_HOME" \
  && corepack enable --install-directory "$PNPM_HOME" \
  && corepack prepare "$PACKAGE_MANAGER_PIN" --activate \
  && chmod -R a+rX "$COREPACK_HOME" "$PNPM_HOME"

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cts ./
RUN pnpm fetch
COPY package.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db-migrations/package.json packages/db-migrations/package.json
RUN pnpm install --offline --frozen-lockfile
COPY . .
RUN pnpm exec turbo prune {{WEB_PACKAGE_NAME}} {{DB_MIGRATIONS_PACKAGE_NAME}} --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/.pnpmfile.cts ./.pnpmfile.cts
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
RUN pnpm --filter ./packages/db run build:run
RUN pnpm --filter ./apps/web run build:run
RUN pnpm --filter ./apps/web deploy --prod /runtime-deploy
RUN pnpm --filter ./packages/db-migrations deploy --prod /migration-deploy

FROM node:{{NODE_VERSION}}-bookworm-slim AS application-runtime
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/apps/web/dist ./dist
ENV DATABASE_FILE="/data/app.sqlite"
USER app

# Final deployment target: standalone
# One-container deployments prepare the database before startup.
FROM application-runtime AS standalone
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV PATH="/migration/node_modules/.bin:$PATH"
ENV DATABASE_PACKAGE_NAME="{{DB_PACKAGE_NAME}}"
COPY --from=build --chown=app:nodejs /migration-deploy /migration
COPY --chmod=755 --from=build /repo/apps/web/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
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
