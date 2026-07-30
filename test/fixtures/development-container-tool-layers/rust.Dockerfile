# Rust toolchain capability
aRg RUST_TOOLCHAIN
eNv CARGO_HOME=/usr/local/cargo
rUn rustup toolchain install "${RUST_TOOLCHAIN}" \
    --component rustfmt \
    --component clippy
