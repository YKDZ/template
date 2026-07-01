import {
  dockerfileFirstRustPnpmDevcontainer,
  dockerfileFirstNodePnpmDevcontainer,
  nodePnpmToolLayer,
  rustToolLayer,
} from "../src/devcontainer.js";

describe("Development Container planning", () => {
  it("plans a Dockerfile-first Node pnpm tool layer from the toolchain baseline", () => {
    const plan = dockerfileFirstNodePnpmDevcontainer({
      name: "demo development",
      layer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.0.0",
      }),
      extensions: ["oxc.oxc-vscode"],
      settings: { "oxc.enable": true },
    });

    expect(plan.devcontainer).toEqual({
      name: "demo development",
      build: {
        dockerfile: "Dockerfile",
        args: {
          NODE_VERSION: "24",
          PACKAGE_MANAGER_PIN: "pnpm@10.0.0",
        },
      },
      customizations: {
        vscode: {
          extensions: ["oxc.oxc-vscode"],
          settings: { "oxc.enable": true },
        },
      },
    });
    expect(plan.devcontainer).not.toHaveProperty("features");
    expect(plan.dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(plan.dockerfile).toContain(
      "RUN corepack enable && corepack prepare pnpm@10.0.0 --activate",
    );
    expect(plan.dockerfile).not.toContain("libnss3");
    expect(plan.dockerfile).not.toContain("xvfb");
  });

  it("plans a Dockerfile-first Rust tool layer with Node pnpm task tooling", () => {
    const plan = dockerfileFirstRustPnpmDevcontainer({
      name: "demo Rust development",
      nodeLayer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.0.0",
      }),
      rustLayer: rustToolLayer({ toolchain: "stable" }),
      extensions: ["rust-lang.rust-analyzer"],
      settings: { "rust-analyzer.check.command": "clippy" },
    });

    expect(plan.devcontainer).toEqual({
      name: "demo Rust development",
      build: {
        dockerfile: "Dockerfile",
        args: {
          NODE_VERSION: "24",
          PACKAGE_MANAGER_PIN: "pnpm@10.0.0",
          RUST_TOOLCHAIN: "stable",
        },
      },
      customizations: {
        vscode: {
          extensions: ["rust-lang.rust-analyzer"],
          settings: { "rust-analyzer.check.command": "clippy" },
        },
      },
      mounts: [
        "source=${localWorkspaceFolderBasename}-cargo-registry,target=/usr/local/cargo/registry,type=volume",
        "source=${localWorkspaceFolderBasename}-cargo-git,target=/usr/local/cargo/git,type=volume",
        "source=${localWorkspaceFolderBasename}-target,target=${containerWorkspaceFolder}/target,type=volume",
      ],
    });
    expect(plan.devcontainer).not.toHaveProperty("features");
    expect(plan.dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(plan.dockerfile).toContain(
      "RUN corepack enable && corepack prepare pnpm@10.0.0 --activate",
    );
    expect(plan.dockerfile).toContain("ARG RUST_TOOLCHAIN=stable");
    expect(plan.dockerfile).toContain(
      "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
    );
  });
});
