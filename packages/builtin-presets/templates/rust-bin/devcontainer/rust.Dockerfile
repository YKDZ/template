ARG RUST_TOOLCHAIN
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain none \
    && rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy \
    && rustup default ${RUST_TOOLCHAIN} \
    && chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}
