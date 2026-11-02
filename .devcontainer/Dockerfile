ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# @template-mirror pnpm-bootstrap
COPY --from=ghcr.io/pnpm/pnpm:12.9.1 /opt/pnpm /opt/pnpm
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

ARG PLAYWRIGHT_CLI_PACKAGE
RUN npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install --with-deps chromium

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ARG RUST_TOOLCHAIN
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain none \
    && "${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy \
    && "${CARGO_HOME}/bin/rustup" default ${RUST_TOOLCHAIN} \
    && find "${CARGO_HOME}/bin" -maxdepth 1 -type f -exec ln -sf {} /usr/local/bin/ \; \
    && chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}

RUN apt-get update \
    && apt-get install -y --no-install-recommends shellcheck \
    && rm -rf /var/lib/apt/lists/*

ENV SHELL=/bin/bash
ENV RUST_BACKTRACE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git-lfs \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system
