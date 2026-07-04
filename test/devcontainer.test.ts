import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import {
  browserTestToolLayer,
  checkedDockerfileFirstNodePnpmDevcontainer,
  composeDevelopmentContainerDockerfile,
  dockerfileFirstNodePnpmDevcontainer,
  dockerfileFirstRustPnpmDevcontainer,
  nodePnpmToolLayer,
  rustToolLayer,
} from "@ykdz/template-core/devcontainer";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;

const devcontainerBuildSchema = v.object({
  args: v.optional(v.record(v.string(), v.string())),
});
const devcontainerSchema = v.looseObject({
  build: v.optional(devcontainerBuildSchema),
  mounts: v.optional(v.array(v.string())),
});
const packageJsonWithScriptsSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string())),
});

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return v.parse(
    schema,
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
  );
}

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
        packageManagerPin: "pnpm@10.34.4",
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
          PACKAGE_MANAGER_PIN: "pnpm@10.34.4",
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

  it("plans a checked browser-test Dockerfile layer through Playwright dependency installation", () => {
    const plan = checkedDockerfileFirstNodePnpmDevcontainer({
      name: "demo",
      layer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.34.4",
      }),
      additionalLayers: [browserTestToolLayer()],
      extensions: [],
    });

    expect(plan.dockerfile).toContain(
      "FROM node:${NODE_VERSION}-bookworm-slim",
    );
    expect(plan.devcontainer).toMatchObject({
      build: {
        args: {
          PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
        },
      },
    });
    expect(plan.dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(plan.dockerfile).toContain(
      'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
    );
    expect(plan.dockerfile).not.toContain(
      "npx --yes playwright install-deps chromium",
    );
    expect(plan.dockerfile).not.toContain("libnss3");
    expect(plan.dockerfile).not.toContain("xvfb");
    expect(plan.dockerfileOperation).toEqual({
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      fragments: [
        {
          sourceRoot: "sharedDevcontainer",
          from: "node-pnpm.Dockerfile",
        },
        {
          sourceRoot: "sharedDevcontainer",
          from: "browser-test.Dockerfile",
        },
      ],
    });
  });

  it("keeps the legacy Node pnpm helper free of browser-test apt package ownership", () => {
    const legacyCall = {
      name: "demo",
      layer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.34.4",
      }),
      additionalLayers: [browserTestToolLayer()],
      extensions: [],
    } as Parameters<typeof dockerfileFirstNodePnpmDevcontainer>[0] & {
      readonly additionalLayers: readonly ReturnType<
        typeof browserTestToolLayer
      >[];
    };
    const plan = dockerfileFirstNodePnpmDevcontainer(legacyCall);

    expect(plan.dockerfile).not.toContain("libnss3");
    expect(plan.dockerfile).not.toContain("libgbm1");
    expect(plan.dockerfile).not.toContain("xvfb");
    expect(plan.dockerfile).not.toContain("playwright install-deps chromium");
  });

  it("plans a Dockerfile-first Rust tool layer with Node pnpm task tooling", () => {
    const plan = dockerfileFirstRustPnpmDevcontainer({
      name: "demo",
      nodeLayer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.34.4",
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
          PACKAGE_MANAGER_PIN: "pnpm@10.34.4",
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
      "FROM node:${NODE_VERSION}-bookworm-slim",
    );
    expect(plan.dockerfile).toContain(
      "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
    );
    expect(plan.dockerfile).toContain("ARG RUST_TOOLCHAIN");
    expect(plan.dockerfile).toContain(
      "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
    );
    expect(plan.dockerfile).toContain("ENV CARGO_HOME=/usr/local/cargo");
    expect(plan.dockerfile).toContain("gcc");
    expect(plan.dockerfile).toContain("libc6-dev");
    expect(plan.dockerfile).not.toContain("typescript-node");
    expect(plan.dockerfile).not.toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(plan.dockerfile).not.toContain("playwright install-deps chromium");
    expect(plan.dockerfile).not.toMatch(
      /\b(build-essential|pkg-config|libssl-dev)\b/,
    );
    expect(plan.dockerfileOperation).toEqual({
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      fragments: [
        {
          sourceRoot: "sharedDevcontainer",
          from: "node-pnpm.Dockerfile",
        },
        {
          sourceRoot: "sharedDevcontainer",
          from: "rust.Dockerfile",
        },
      ],
    });
  });

  it("renders the rust-bin preset with the Rust layer on the shared Node pnpm base", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "rust-bin-preset-"));
    const projection = findBuiltInPresetProjection("rust-bin")!;
    const blueprint = projection.blueprint({ targetDir });
    const plan = projection.project(
      assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@10.34.4",
          },
          source: "bundled-fallback",
          diagnostics: [],
        },
      }),
    );

    await projection.render({ targetDir, plan });

    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonWithScriptsSchema,
    );
    const rustPackagePath = blueprint.packages?.[0]?.path;

    if (rustPackagePath === undefined) {
      throw new Error("rust-bin blueprint must include a workspace package.");
    }

    const rustPackageJson = await readJsonWithSchema(
      path.join(targetDir, rustPackagePath, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG RUST_TOOLCHAIN");
    expect(dockerfile).toContain(
      "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
    );
    expect(dockerfile).not.toContain("typescript-node");
    expect(dockerfile).not.toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).not.toContain("playwright install-deps chromium");
    expect(devcontainer.build?.args).toMatchObject({
      NODE_VERSION: "24",
      PACKAGE_MANAGER_PIN: "pnpm@10.34.4",
      RUST_TOOLCHAIN: "stable",
    });
    expect(devcontainer.build?.args).not.toHaveProperty(
      "PLAYWRIGHT_CLI_PACKAGE",
    );
    expect(devcontainer.mounts).toEqual(
      expect.arrayContaining([
        "source=${localWorkspaceFolderBasename}-cargo-registry,target=/usr/local/cargo/registry,type=volume",
        "source=${localWorkspaceFolderBasename}-cargo-git,target=/usr/local/cargo/git,type=volume",
        "source=${localWorkspaceFolderBasename}-target,target=${containerWorkspaceFolder}/target,type=volume",
      ]),
    );
    expect(rootPackageJson.scripts?.check).toContain("turbo run check");
    expect(rustPackageJson.scripts?.check).toContain("cargo clippy");
  });
});
