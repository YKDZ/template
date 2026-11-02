ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# 覆盖镜像支持的两个用户，非交互命令也能直接执行全局工具。
ENV PATH="/root/.local/share/pnpm/bin:/home/node/.local/share/pnpm/bin:$PATH"
# @template-mirror pnpm-bootstrap
COPY --from=ghcr.io/pnpm/pnpm:__PNPM_VERSION__ /opt/pnpm /opt/pnpm
# @end-template-mirror
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        file \
        git \
        iproute2 \
        jq \
        openssh-client \
        procps \
        python-is-python3 \
        python3 \
        ripgrep \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main \
    && for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/pnpm" "/usr/local/bin/$bin"; done \
    && install -d /pnpm/store/root /root/.local/share/pnpm \
    && install -d -o node -g node /pnpm/store/node /home/node/.local/share/pnpm \
    && pnpm config set store-dir /pnpm/store/root --global \
    && su -s /bin/sh node -c 'pnpm config set store-dir /pnpm/store/node --global'
