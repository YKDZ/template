ARG RUST_TOOLCHAIN
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    git \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain none \
    && "${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy \
    && "${CARGO_HOME}/bin/rustup" default ${RUST_TOOLCHAIN} \
    && find "${CARGO_HOME}/bin" -maxdepth 1 -type f -exec ln -sf {} /usr/local/bin/ \; \
    && chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}
