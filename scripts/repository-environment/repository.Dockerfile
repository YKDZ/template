ARG PACKAGE_MANAGER_PIN
ENV COREPACK_HOME=/corepack
ENV SHELL=/bin/bash
ENV RUST_BACKTRACE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git-lfs \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system \
    && install -d -m 0755 "$COREPACK_HOME" \
    && corepack prepare "$PACKAGE_MANAGER_PIN" --activate
