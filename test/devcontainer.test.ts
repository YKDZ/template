import {
  checkedDockerfileFirstNodePnpmDevcontainer,
  composeDevelopmentContainerDockerfile,
  dockerfileFirstRustPnpmDevcontainer,
  nodePnpmToolLayer,
  rustToolLayer,
} from "../src/devcontainer.js";

describe("Development Container planning", () => {
  it("validates that exactly one Dockerfile base layer supplies the base image", () => {
    expect(() =>
      composeDevelopmentContainerDockerfile({
        layers: [
          { kind: "base", name: "node", text: "FROM node:24-bookworm-slim\n" },
          { kind: "base", name: "other", text: "FROM debian:bookworm-slim\n" },
        ],
      }),
    ).toThrow("exactly one base layer");
  });

  it("rejects a Dockerfile base fragment with multiple base image instructions", () => {
    expect(() =>
      composeDevelopmentContainerDockerfile({
        layers: [
          {
            kind: "base",
            name: "node",
            text:
              "FROM node:24-bookworm-slim\n" +
              "RUN corepack enable\n" +
              "FROM debian:bookworm-slim\n",
          },
        ],
      }),
    ).toThrow("exactly one base layer");
  });

  it("rejects runtime service instructions in Dockerfile capability layers", () => {
    expect(() =>
      composeDevelopmentContainerDockerfile({
        layers: [
          { kind: "base", name: "node", text: "FROM node:24-bookworm-slim\n" },
          { kind: "capability", name: "service", text: "EXPOSE 3000\n" },
        ],
      }),
    ).toThrow("service must not use runtime Dockerfile instruction EXPOSE");
  });

  it("plans a Dockerfile-first Node pnpm tool layer from the toolchain baseline", () => {
    const plan = checkedDockerfileFirstNodePnpmDevcontainer({
      name: "demo",
      layer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.0.0",
      }),
      extensions: ["oxc.oxc-vscode"],
      settings: { "oxc.enable": true },
    });

    expect(plan.devcontainer).toEqual({
      name: "demo",
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
    expect(plan.dockerfile).toContain("ARG NODE_VERSION");
    expect(plan.dockerfile).toContain(
      "FROM node:${NODE_VERSION}-bookworm-slim",
    );
    expect(plan.dockerfile).toContain(
      "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
    );
    expect(plan.dockerfile).not.toContain("typescript-node");
    expect(plan.dockerfile).not.toMatch(
      /npm install -g|pnpm add -g|corepack prepare (?!\$\{PACKAGE_MANAGER_PIN\})/,
    );
    expect(plan.dockerfile).not.toContain("turbo");
    expect(plan.dockerfile).not.toContain("typescript");
    expect(plan.dockerfile).not.toContain("eslint");
    expect(plan.dockerfile).not.toContain("vitest");
    expect(plan.dockerfile).not.toContain("libnss3");
    expect(plan.dockerfile).not.toContain("xvfb");
  });

  it("plans a Dockerfile-first Rust tool layer with Node pnpm task tooling", () => {
    const plan = dockerfileFirstRustPnpmDevcontainer({
      name: "demo",
      nodeLayer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.0.0",
      }),
      rustLayer: rustToolLayer({ toolchain: "stable" }),
      extensions: ["rust-lang.rust-analyzer"],
      settings: { "rust-analyzer.check.command": "clippy" },
    });

    expect(plan.devcontainer).toEqual({
      name: "demo",
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
