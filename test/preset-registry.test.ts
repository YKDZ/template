import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  builtInPresets,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { validateProjectBlueprint } from "@ykdz/template-core/declarations";
import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import { PackageAdditionSupport } from "@ykdz/template-core/package-addition-support";
import {
  blueprintForPresetSourcePreset,
  defaultPackagePathForPresetSourcePackageAddition,
} from "@ykdz/template-core/projection-capabilities";
import * as v from "valibot";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;

const packageJsonSchema = v.object({
  name: v.optional(v.string()),
  engines: v.object({ node: v.string() }),
  packageManager: v.string(),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  scripts: v.record(v.string(), v.string()),
});
const packageJsonWithScriptsSchema = v.object({
  name: v.string(),
  version: v.optional(v.string()),
  private: v.optional(v.boolean()),
  engines: v.optional(v.object({ node: v.string() })),
  scripts: v.record(v.string(), v.string()),
});
const generationRecordSchema = v.object({
  command: v.optional(v.string()),
  toolchain: v.object({
    nodeLtsMajor: v.string(),
    packageManagerPin: v.string(),
    source: v.optional(v.string()),
  }),
});
const devcontainerSchema = v.looseObject({
  name: v.optional(v.string()),
  build: v.optional(
    v.object({
      dockerfile: v.optional(v.string()),
      args: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: v.record(v.string(), v.unknown()),
    }),
  }),
  features: v.optional(v.unknown()),
  mounts: v.optional(v.array(v.string())),
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

describe("Preset Registry", () => {
  it("advertises only workspace monorepo Project Shape metadata for built-in presets", () => {
    expect(
      builtInPresets.map((preset) => ({
        name: preset.name,
        supportedProjectKinds: preset.supportedProjectKinds,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: "ts-lib", supportedProjectKinds: ["multi-package"] },
        { name: "hono-api", supportedProjectKinds: ["multi-package"] },
        { name: "vue-app", supportedProjectKinds: ["multi-package"] },
        { name: "vue-hono-app", supportedProjectKinds: ["multi-package"] },
        { name: "rust-bin", supportedProjectKinds: ["multi-package"] },
      ]),
    );
    expect(
      builtInPresets.flatMap((preset) => preset.supportedProjectKinds),
    ).not.toContain("single-package");
  });

  it("declares Package Addition Support consistently with Projection Declarations", () => {
    const supportedPresets = loadBuiltInPresetSourceManifest().presets.filter(
      (preset) => preset.generation === "supported",
    );

    expect(
      supportedPresets.map((preset) => ({
        name: preset.name,
        packageAdditionSupport: preset.packageAdditionSupport,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          name: "ts-lib",
          packageAdditionSupport: PackageAdditionSupport.Supported,
        },
        {
          name: "hono-api",
          packageAdditionSupport: PackageAdditionSupport.Supported,
        },
        {
          name: "vue-app",
          packageAdditionSupport: PackageAdditionSupport.Supported,
        },
        {
          name: "vue-hono-app",
          packageAdditionSupport: PackageAdditionSupport.Unsupported,
        },
        {
          name: "rust-bin",
          packageAdditionSupport: PackageAdditionSupport.Unsupported,
        },
      ]),
    );

    for (const preset of supportedPresets) {
      if (preset.packageAdditionSupport === PackageAdditionSupport.Supported) {
        expect(
          defaultPackagePathForPresetSourcePackageAddition(
            preset,
            "example",
            builtInPresetProjectionSourceRoots(),
          ),
        ).toMatch(/^(apps|packages)\/example$/);
        continue;
      }

      expect(preset.projection).toBeDefined();
    }
  });

  it("generates valid workspace monorepo Project Blueprints for supported presets", async () => {
    const supportedPresets = loadBuiltInPresetSourceManifest().presets.filter(
      (preset) => preset.generation === "supported",
    );

    for (const preset of supportedPresets) {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-preset-blueprint-"),
      );
      const targetDir = path.join(workspace, `demo-${preset.name}`);
      const blueprint = blueprintForPresetSourcePreset(preset, {
        targetDir,
        scope: "acme",
      });
      const validation = validateProjectBlueprint(blueprint, {
        presets: builtInPresets,
      });

      expect(validation).toMatchObject({ ok: true });
      expect(blueprint.projectKind).toBe("multi-package");
    }
  });

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
    ).toEqual([
      "oxc-format-check",
      "oxc-lint",
      "typescript-typecheck",
      "turbo-package-typecheck",
      "turbo-package-check",
    ]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
      "turbo-package-fix",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './packages/*' && turbo run check --filter './packages/*'",
    );

    const packageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const libraryPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/demo-lib/package.json"),
      packageJsonWithScriptsSchema,
    );
    const generationRecord = await readJsonWithSchema(
      path.join(targetDir, ".template/generated-by.json"),
      generationRecordSchema,
    );

    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(libraryPackageJson.name).toBe("@demo-lib/demo-lib");
    expect(libraryPackageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );
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
    const devcontainer = v.parse(
      devcontainerSchema,
      JSON.parse(devcontainerText) as unknown,
    );
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
        PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
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
      /^\{\n  "name": "demo-vue-app",\n  "build": \{/,
    );
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).toContain(
      'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
    );
    expect(dockerfile).not.toContain(
      "npx --yes playwright install-deps chromium",
    );
    expect(dockerfile).toContain(
      "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
    );
    expect(dockerfile).not.toContain("libnss3");
    expect(dockerfile).not.toContain("libgbm1");
    expect(dockerfile).not.toContain("xvfb");
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

    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = v.parse(
      devcontainerSchema,
      JSON.parse(devcontainerText) as unknown,
    );
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
        PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
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
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.configPath",
      "./oxlint.config.ts",
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-vue-hono",\n  "build": \{/,
    );
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).toContain(
      'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
    );
    expect(dockerfile).not.toContain(
      "npx --yes playwright install-deps chromium",
    );
    expect(dockerfile).not.toContain("libnss3");
    expect(dockerfile).not.toContain("libgbm1");
    expect(dockerfile).not.toContain("xvfb");
    expect(dockerfile).not.toMatch(/\b(?:npm|pnpm|corepack)\s+.*-g\s+turbo\b/);
    expect(rootPackageJson.devDependencies?.turbo).toBe("catalog:");
    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './apps/*' && turbo run build --filter './apps/*' && turbo run test --filter './apps/*' && turbo run test:e2e --filter './apps/*' && turbo run check --filter './apps/*'",
    );
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

      const packageJson = await readJsonWithSchema(
        path.join(targetDir, "package.json"),
        packageJsonSchema,
      );
      const generationRecord = await readJsonWithSchema(
        path.join(targetDir, ".template/generated-by.json"),
        generationRecordSchema,
      );
      const devcontainerText = await readFile(
        path.join(targetDir, ".devcontainer/devcontainer.json"),
        "utf8",
      );
      const devcontainer = v.parse(
        devcontainerSchema,
        JSON.parse(devcontainerText) as unknown,
      );
      const dockerfile = await readFile(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );

      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.packageManager).toBe("pnpm@11.2.3");
      expect(generationRecord.toolchain).toEqual({
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.2.3",
        source: "online",
      });
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
          ...(preset === "hono-api"
            ? {}
            : { PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage }),
        },
      });
      expect(devcontainer).not.toHaveProperty("features");
      if (preset === "hono-api") {
        expect(dockerfile).toContain("ARG NODE_VERSION");
        expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
        expect(dockerfile).toContain(
          "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
        );
        expect(devcontainerText).toMatch(
          /^\{\n  "name": "demo-hono-api",\n  "build": \{/,
        );
        expect(dockerfile).not.toContain("typescript-node");
        expect(dockerfile).not.toContain("libnss3");
        expect(dockerfile).not.toContain("xvfb");
        expect(dockerfile).not.toContain("PLAYWRIGHT_CLI_PACKAGE");
      } else {
        expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
        expect(dockerfile).toContain(
          "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
        );
        expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
        expect(dockerfile).toContain(
          'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
        );
        expect(dockerfile).not.toContain(
          "npx --yes playwright install-deps chromium",
        );
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
    ).toEqual(["turbo-package-check"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "turbo-package-fix",
    ]);
    expect(plan.packageScripts).toEqual({
      check: "turbo run check --filter './packages/*'",
      fix: "turbo run fix --filter './packages/*'",
    });
    expect(plan.dependencyMaintenancePolicy.ecosystems).toEqual([
      "npm",
      "cargo",
      "github-actions",
      "docker",
      "rust-toolchain",
    ]);

    const packageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const rustPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/demo-rust/package.json"),
      packageJsonWithScriptsSchema,
    );
    const generationRecord = await readJsonWithSchema(
      path.join(targetDir, ".template/generated-by.json"),
      generationRecordSchema,
    );
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = v.parse(
      devcontainerSchema,
      JSON.parse(devcontainerText) as unknown,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const rustToolchain = await readFile(
      path.join(targetDir, "rust-toolchain.toml"),
      "utf8",
    );
    const cargoToml = await readFile(
      path.join(targetDir, "packages/demo-rust/Cargo.toml"),
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
    expect(packageJson.devDependencies).toEqual({ turbo: "catalog:" });
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(rustPackageJson).toEqual({
      name: "demo-rust-native",
      version: "0.0.0",
      private: true,
      scripts: {
        check:
          "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
        fix: "cargo fmt --all",
      },
      engines: {
        node: "24",
      },
    });
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
    expect(devcontainer.name).toBe("Demo Rust!");
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
      /^\{\n  "name": "Demo Rust!",\n  "build": \{/,
    );
    expect(devcontainer.mounts).toEqual([
      "source=${localWorkspaceFolderBasename}-cargo-registry,target=/usr/local/cargo/registry,type=volume",
      "source=${localWorkspaceFolderBasename}-cargo-git,target=/usr/local/cargo/git,type=volume",
      "source=${localWorkspaceFolderBasename}-target,target=${containerWorkspaceFolder}/target,type=volume",
    ]);
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain(
      "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
    );
    expect(dockerfile).toContain("ARG RUST_TOOLCHAIN");
    expect(dockerfile).toContain("rustup toolchain install");
    expect(dockerfile).toContain("rustfmt");
    expect(dockerfile).toContain("clippy");
    expect(dockerfile).toContain("gcc");
    expect(dockerfile).toContain("libc6-dev");
    expect(dockerfile).not.toContain("typescript-node");
    expect(dockerfile).not.toMatch(
      /\b(build-essential|pkg-config|libssl-dev)\b/,
    );
    expect(rustToolchain).toContain('[toolchain]\nchannel = "stable"\n');
    expect(rustToolchain).toContain('components = ["rustfmt", "clippy"]');
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(checkWorkflow).toContain("uses: Swatinem/rust-cache@v2");
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain(
      'package-ecosystem: cargo\n    directory: "/packages/demo-rust"',
    );
    expect(dependabot).toContain("package-ecosystem: github-actions");
  });
});
