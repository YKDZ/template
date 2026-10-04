ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main \
    && install -d -m 0755 "$PNPM_HOME" "$PNPM_HOME/bin" \
    && corepack enable --install-directory "$PNPM_HOME" \
    && chmod -R a+rX "$PNPM_HOME"
