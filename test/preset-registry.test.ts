import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("Preset Registry", () => {
  it("projects a ts-lib Generated Repository through the Preset Projection contract", async () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    expect(projection?.metadata).toMatchObject({
      name: "ts-lib",
      title: "TypeScript library",
      generation: "supported",
    });

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "demo-lib");
    const blueprint = projection!.blueprint({ targetDir });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual(["typescript-typecheck", "oxc-lint", "oxc-format-check"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );

    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const generationRecord = await readJson<{
      command: string;
      toolchain: { nodeLtsMajor: string; packageManagerPin: string };
    }>(path.join(targetDir, ".template/generated-by.json"));

    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(generationRecord).toMatchObject({
      command: "template init --preset ts-lib",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.2.3" },
    });
  });

  it("projects vue-app with a Dockerfile-first Development Container for browser checks", async () => {
    const projection = findBuiltInPresetProjection("vue-app");
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "demo-vue-app");
    const blueprint = projection!.blueprint({ targetDir });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = JSON.parse(devcontainerText) as {
      build?: {
        dockerfile: string;
        args?: Record<string, string>;
      };
      features?: unknown;
      customizations: {
        vscode: {
          extensions: string[];
          settings: Record<string, unknown>;
        };
      };
    };
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );

    expect(Object.keys(devcontainer)).toEqual([
      "name",
      "build",
      "customizations",
    ]);
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "Vue.volar",
    );
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.enable",
      true,
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-vue-app Vue development",\n  "build": \{/,
    );
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(dockerfile).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    );
    expect(dockerfile).toContain("libnss3");
    expect(dockerfile).toContain("libgbm1");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).not.toContain("npm install -g");
  });

  it("projects vue-hono-app with browser checks but no globally installed Turbo", async () => {
    const projection = findBuiltInPresetProjection("vue-hono-app");
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "demo-vue-hono");
    const blueprint = projection!.blueprint({
      targetDir,
      scope: "acme",
    });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    const rootPackageJson = await readJson<{
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = JSON.parse(devcontainerText) as {
      build?: {
        dockerfile: string;
        args?: Record<string, string>;
      };
      features?: unknown;
      customizations: {
        vscode: {
          extensions: string[];
          settings: Record<string, unknown>;
        };
      };
    };
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );

    expect(Object.keys(devcontainer)).toEqual([
      "name",
      "build",
      "customizations",
    ]);
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "Vue.volar",
    );
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.enable",
      true,
    );
    expect(devcontainer.customizations.vscode.settings).not.toHaveProperty(
      "oxc.configPath",
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-vue-hono full-stack development",\n  "build": \{/,
    );
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(dockerfile).toContain("libnss3");
    expect(dockerfile).toContain("libgbm1");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).not.toMatch(/\b(?:npm|pnpm|corepack)\s+.*-g\s+turbo\b/);
    expect(rootPackageJson.devDependencies.turbo).toBe("catalog:");
    expect(rootPackageJson.scripts.check).toBe("turbo run check");
    expect(rootPackageJson.scripts.dev).toBe("turbo run dev --parallel");
  });

  it.each(["hono-api", "vue-app", "vue-hono-app"] as const)(
    "projects %s package metadata from the Generation Context toolchain",
    async (preset) => {
      const projection = findBuiltInPresetProjection(preset);
      expect(projection?.metadata).toMatchObject({
        name: preset,
        generation: "supported",
      });

      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-preset-registry-"),
      );
      const targetDir = path.join(workspace, `demo-${preset}`);
      const blueprint = projection!.blueprint({
        targetDir,
        scope: "acme",
      });
      const context = assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      });

      const plan = projection!.project(context);
      await projection!.render({ targetDir, plan });

      const packageJson = await readJson<{
        engines: { node: string };
        packageManager: string;
      }>(path.join(targetDir, "package.json"));
      const generationRecord = await readJson<{
        toolchain: { nodeLtsMajor: string; packageManagerPin: string };
      }>(path.join(targetDir, ".template/generated-by.json"));
      const devcontainer = await readJson<{
        build?: {
          args?: Record<string, string>;
        };
        features?: Record<string, { version: string }>;
      }>(path.join(targetDir, ".devcontainer/devcontainer.json"));

      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.packageManager).toBe("pnpm@11.2.3");
      expect(generationRecord.toolchain).toEqual({
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.2.3",
        source: "online",
      });
      if (preset === "hono-api") {
        expect(
          devcontainer.features?.["ghcr.io/devcontainers/features/node:1"]
            ?.version,
        ).toBe("24");
      } else {
        expect(devcontainer.build?.args?.NODE_VERSION).toBe("24");
        expect(devcontainer).not.toHaveProperty("features");
      }
    },
  );

  it("projects rust-bin Generated Repository behavior through the Preset Projection contract", async () => {
    const projection = findBuiltInPresetProjection("rust-bin");
    expect(projection?.metadata).toMatchObject({
      name: "rust-bin",
      title: "Rust binary",
      generation: "supported",
    });

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "Demo Rust!");
    const blueprint = projection!.blueprint({ targetDir });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual(["rustfmt-check", "cargo-clippy", "cargo-test"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "rustfmt-write",
    ]);
    expect(plan.packageScripts).toEqual({
      check:
        "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
      fix: "cargo fmt --all",
    });
    expect(plan.dependencyMaintenancePolicy.ecosystems).toEqual([
      "npm",
      "cargo",
      "github-actions",
    ]);

    const packageJson = await readJson<{
      name: string;
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const generationRecord = await readJson<{
      command: string;
      toolchain: { nodeLtsMajor: string; packageManagerPin: string };
    }>(path.join(targetDir, ".template/generated-by.json"));
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = JSON.parse(devcontainerText) as {
      build?: {
        dockerfile: string;
        args?: Record<string, string>;
      };
      features?: unknown;
      mounts?: string[];
    };
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const rustToolchain = await readFile(
      path.join(targetDir, "rust-toolchain.toml"),
      "utf8",
    );
    const cargoToml = await readFile(
      path.join(targetDir, "Cargo.toml"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );

    expect(packageJson.name).toBe("demo-rust");
    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(generationRecord).toMatchObject({
      command: "template init --preset rust-bin",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.2.3" },
    });
    expect(cargoToml).toContain('name = "demo-rust"');
    expect(Object.keys(devcontainer)).toEqual([
      "name",
      "build",
      "customizations",
      "mounts",
    ]);
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
        RUST_TOOLCHAIN: "stable",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-rust Rust development",\n  "build": \{/,
    );
    expect(devcontainer.mounts).toEqual([
      "source=${localWorkspaceFolderBasename}-cargo-registry,target=/usr/local/cargo/registry,type=volume",
      "source=${localWorkspaceFolderBasename}-cargo-git,target=/usr/local/cargo/git,type=volume",
      "source=${localWorkspaceFolderBasename}-target,target=${containerWorkspaceFolder}/target,type=volume",
    ]);
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(dockerfile).toContain(
      "RUN corepack enable && corepack prepare pnpm@11.2.3 --activate",
    );
    expect(dockerfile).toContain("ARG RUST_TOOLCHAIN=stable");
    expect(dockerfile).toContain("rustup toolchain install");
    expect(dockerfile).toContain("rustfmt");
    expect(dockerfile).toContain("clippy");
    expect(rustToolchain).toContain('[toolchain]\nchannel = "stable"\n');
    expect(rustToolchain).toContain('components = ["rustfmt", "clippy"]');
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(checkWorkflow).toContain("uses: Swatinem/rust-cache@v2");
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: github-actions");
  });
});
