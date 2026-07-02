ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG PACKAGE_MANAGER_PIN
RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate
