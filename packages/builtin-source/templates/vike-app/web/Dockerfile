# syntax=docker/dockerfile:1.7

FROM node:{{NODE_VERSION}}-bookworm-slim AS base
ARG PACKAGE_MANAGER_PIN="{{PACKAGE_MANAGER_PIN}}"
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

FROM base AS database-preparation
ENV NODE_ENV="production"
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
CMD ["pnpm", "--dir", "packages/db", "run", "db:prepare:deploy"]

FROM node:{{NODE_VERSION}}-bookworm-slim AS runtime
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app
COPY --from=build --chown=app:nodejs /repo/apps/web/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "dist/server/index.mjs"]
