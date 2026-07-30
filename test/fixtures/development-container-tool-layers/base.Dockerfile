# syntax=docker/dockerfile:1

ARG NODE_VERSION
FROM mcr.microsoft.com/devcontainers/typescript-node:${NODE_VERSION}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV PNPM_HOME=/pnpm
RUN corepack enable
