import { readFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { loadBuiltInPresetSourceManifest } from "../src/preset-source.js";
import {
  interpretPresetProjectionDeclaration,
  type PresetProjectionDeclaration,
  validateProjectionCapabilities,
} from "../src/projection-capabilities.js";
import { renderNewProject } from "../src/renderer.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

const syntheticTsLibDeclaration: PresetProjectionDeclaration = {
  capabilities: [
    {
      kind: "workspace-library-package",
      workspacePackageGlob: "packages/*",
      packageRole: "shared-library",
      packageSourcePreset: "ts-lib",
      sourceFiles: ["src/index.ts", "src/name-schema.ts"],
    },
    { kind: "strict-typescript-root" },
    { kind: "oxc-format-lint" },
    { kind: "node-pnpm-devcontainer" },
    { kind: "github-maintenance" },
  ],
};

async function presetContext(presetName: string) {
  const legacyProjection = findBuiltInPresetProjection(presetName);
  expect(legacyProjection).toBeDefined();

  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-projection-capabilities-"),
  );
  const targetDir = path.join(workspace, `demo-${presetName}`);
  const blueprint = legacyProjection!.blueprint({ targetDir });

  return {
    legacyProjection: legacyProjection!,
    targetDir,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    }),
  };
}

async function tsLibContext() {
  const legacyProjection = findBuiltInPresetProjection("ts-lib");
  expect(legacyProjection).toBeDefined();

  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-projection-capabilities-"),
  );
  const targetDir = path.join(workspace, "demo-lib");
  const blueprint = legacyProjection!.blueprint({ targetDir });

  return {
    legacyProjection: legacyProjection!,
    targetDir,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    }),
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function expectFile(pathName: string): Promise<void> {
  await expect(stat(pathName)).resolves.toMatchObject({
    size: expect.any(Number),
  });
}

describe("Projection Capability declarations", () => {
  it("interprets a synthetic ts-lib declaration into Generated Repository behavior", async () => {
    const { legacyProjection, context } = await tsLibContext();

    const plan = interpretPresetProjectionDeclaration({
      preset: legacyProjection.metadata,
      declaration: syntheticTsLibDeclaration,
      context,
    });

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
    expect(plan.dependencyMaintenancePolicy.ecosystems).toEqual([
      "npm",
      "github-actions",
      "docker",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './packages/*' && turbo run check --filter './packages/*'",
    );
    expect(plan.capabilities).toEqual({
      rootCheck: true,
      fixCommand: true,
      githubActions: true,
      dependabot: true,
      devcontainer: true,
    });
  });

  it("renders the ts-lib built-in declaration into expected public generated files", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await tsLibContext();

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readJson(
      path.join(targetDir, "packages", "demo-lib", "package.json"),
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const generatedByJson = await readJson(
      path.join(targetDir, ".template/generated-by.json"),
    );

    expect(rootPackageJson).toMatchObject({
      name: "demo-lib",
      private: true,
      type: "module",
      scripts: {
        check:
          "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './packages/*' && turbo run check --filter './packages/*'",
        fix: "pnpm run format:write && pnpm run lint:fix && turbo run fix --filter './packages/*'",
      },
      devDependencies: {
        oxfmt: "catalog:",
        oxlint: "catalog:",
        turbo: "catalog:",
        typescript: "catalog:",
      },
      packageManager: "pnpm@11.2.3",
    });
    expect(packageJson).toMatchObject({
      name: "@demo-lib/demo-lib",
      dependencies: {
        valibot: "catalog:",
      },
      scripts: {
        check: "pnpm run typecheck && pnpm run lint && pnpm run format:check",
        fix: "pnpm run format:write && pnpm run lint:fix",
      },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        typescript: "catalog:",
      },
    });
    expect(workspaceYaml).toContain("packages/*");
    expect(workspaceYaml).toContain("valibot:");
    expect(generatedByJson).toMatchObject({
      command: "template init --preset ts-lib",
    });
    await expectFile(path.join(targetDir, "packages/demo-lib/src/index.ts"));
    await expectFile(path.join(targetDir, ".github/workflows/check.yml"));
    await expectFile(path.join(targetDir, ".devcontainer/Dockerfile"));
  });

  it("renders the hono-api built-in declaration into expected public generated files", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "hono-api",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await presetContext("hono-api");

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readJson(
      path.join(targetDir, "apps", "api", "package.json"),
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const generatedByJson = await readJson(
      path.join(targetDir, ".template/generated-by.json"),
    );

    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './apps/*' && turbo run build --filter './apps/*' && turbo run test --filter './apps/*' && turbo run check --filter './apps/*'",
    );
    expect(packageJson).toMatchObject({
      name: "@demo-hono-api/api",
      dependencies: {
        "@hono/node-server": "catalog:",
        hono: "catalog:",
      },
      scripts: {
        build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
        start: "node dist/server.js",
        test: "vitest run",
      },
      devDependencies: {
        "@types/node": "catalog:",
        "tsc-alias": "catalog:",
        vitest: "catalog:",
      },
    });
    expect(workspaceYaml).toContain("apps/*");
    expect(workspaceYaml).toContain('"@hono/node-server":');
    expect(generatedByJson).toMatchObject({
      command: "template init --preset hono-api",
    });
    await expectFile(path.join(targetDir, "apps/api/src/app.ts"));
    await expectFile(path.join(targetDir, "apps/api/test/app.test.ts"));
    await expectFile(path.join(targetDir, ".github/workflows/check.yml"));
    await expectFile(path.join(targetDir, ".devcontainer/Dockerfile"));
  });

  it("renders the vue-app built-in declaration into expected public generated files", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "vue-app",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await presetContext("vue-app");

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readJson(
      path.join(targetDir, "apps", "web", "package.json"),
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer", "Dockerfile"),
      "utf8",
    );

    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './apps/*' && turbo run build --filter './apps/*' && turbo run test --filter './apps/*' && turbo run test:e2e --filter './apps/*' && turbo run check --filter './apps/*'",
    );
    expect(packageJson).toMatchObject({
      name: "@demo-vue-app/web",
      scripts: {
        build: "vite build",
        dev: "vite",
        preview: "vite preview",
        test: "vitest run",
        "test:e2e": "pnpm run build && playwright test",
        typecheck: "vue-tsc --build --noEmit",
      },
      dependencies: {
        "@vueuse/core": "catalog:",
        pinia: "catalog:",
        vue: "catalog:",
      },
      devDependencies: {
        "@playwright/test": "catalog:",
        "@vitejs/plugin-vue": "catalog:",
        "vue-tsc": "catalog:",
      },
    });
    expect(workspaceYaml).toContain("allowBuilds:");
    expect(workspaceYaml).toContain("esbuild: true");
    expect(devcontainerDockerfile).toContain("PLAYWRIGHT_CLI_PACKAGE");
    await expectFile(path.join(targetDir, "apps/web/src/App.vue"));
    await expectFile(path.join(targetDir, "apps/web/test/e2e/app.spec.ts"));
  });

  it("renders the vue-hono-app built-in declaration with package linking", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "vue-hono-app",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await presetContext("vue-hono-app");

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const apiPackageJson = await readJson(
      path.join(targetDir, "apps", "api", "package.json"),
    );
    const webPackageJson = await readJson(
      path.join(targetDir, "apps", "web", "package.json"),
    );
    const turboConfig = await readJson(path.join(targetDir, "turbo.json"));
    const webApiSource = await readFile(
      path.join(targetDir, "apps", "web", "src", "api.ts"),
      "utf8",
    );

    expect(apiPackageJson).toMatchObject({
      name: "@demo-vue-hono-app/api",
      types: "./src/index.ts",
      scripts: {
        dev: "tsx watch src/server.ts",
      },
      devDependencies: {
        tsx: "catalog:",
      },
    });
    expect(webPackageJson).toMatchObject({
      name: "@demo-vue-hono-app/web",
      dependencies: {
        "@demo-vue-hono-app/api": "workspace:*",
        hono: "catalog:",
      },
      scripts: {
        typecheck: "vue-tsc --build",
      },
    });
    expect(turboConfig).toMatchObject({
      tasks: {
        build: {
          dependsOn: ["^build"],
          outputs: ["dist/**"],
        },
      },
    });
    expect(webApiSource).toContain(
      'import type { AppType } from "@demo-vue-hono-app/api";',
    );
    await expectFile(path.join(targetDir, "apps/api/src/index.ts"));
    await expectFile(path.join(targetDir, "apps/web/src/api.ts"));
  });

  it("renders the rust-bin built-in declaration into expected public generated files", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "rust-bin",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await presetContext("rust-bin");

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readJson(
      path.join(targetDir, "packages", "demo-rust-bin", "package.json"),
    );
    const cargoToml = await readFile(
      path.join(targetDir, "packages", "demo-rust-bin", "Cargo.toml"),
      "utf8",
    );
    const cargoLock = await readFile(
      path.join(targetDir, "packages", "demo-rust-bin", "Cargo.lock"),
      "utf8",
    );
    const dependabot = await readFile(
      path.join(targetDir, ".github", "dependabot.yml"),
      "utf8",
    );
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer", "Dockerfile"),
      "utf8",
    );

    expect(rootPackageJson).toMatchObject({
      name: "demo-rust-bin",
      scripts: {
        check: "turbo run check --filter './packages/*'",
        fix: "turbo run fix --filter './packages/*'",
      },
      devDependencies: {
        turbo: "catalog:",
      },
      packageManager: "pnpm@11.2.3",
    });
    expect(packageJson).toMatchObject({
      name: "demo-rust-bin-native",
      scripts: {
        check:
          "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
        fix: "cargo fmt --all",
      },
    });
    expect(cargoToml).toContain('name = "demo-rust-bin"');
    expect(cargoToml).toContain("[workspace.lints.clippy]");
    expect(cargoLock).toContain('name = "demo-rust-bin"');
    expect(dependabot).toContain('directory: "/packages/demo-rust-bin"');
    expect(devcontainerDockerfile).toContain("RUSTUP_HOME");
    await expectFile(
      path.join(targetDir, "packages/demo-rust-bin/src/main.rs"),
    );
    await expectFile(
      path.join(targetDir, "packages/demo-rust-bin/rustfmt.toml"),
    );
    await expectFile(path.join(targetDir, "rust-toolchain.toml"));
  });

  it("rejects unknown Projection Capability kinds with semantic diagnostics", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "write-my-private-file",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].kind",
          message: "Unknown Projection Capability kind: write-my-private-file",
        },
      ],
    });
  });

  it("rejects rust-binary-workspace mixed with companion capabilities", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "rust-binary-workspace",
            workspacePackageGlob: "packages/*",
            sourceFiles: ["src/main.rs"],
          },
          { kind: "github-maintenance" },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities",
          message:
            "rust-binary-workspace is a complete domain capability and must be selected by itself; remove companion Projection Capabilities: github-maintenance",
        },
      ],
    });
  });

  it("rejects packageLinks with extra fields", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "workspace-node-packages",
            workspacePackageGlob: "apps/*",
            packages: [
              {
                kind: "vue-app",
                path: "apps/web",
                sourceFiles: ["src/main.ts"],
              },
              {
                kind: "hono-api",
                path: "apps/api",
                sourceFiles: ["src/server.ts"],
              },
            ],
            packageLinks: [
              {
                consumerPackagePath: "apps/web",
                providerPackagePath: "apps/api",
                relationship: "runtime",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].packageLinks[0].relationship",
          message:
            "workspace-node-packages packageLink does not support property: relationship",
        },
      ],
    });
  });

  it("rejects packageLinks that reference packages outside the same declaration", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "workspace-node-packages",
            workspacePackageGlob: "apps/*",
            packages: [
              {
                kind: "hono-api",
                path: "apps/api",
                sourceFiles: ["src/server.ts"],
              },
            ],
            packageLinks: [
              {
                consumerPackagePath: "apps/web",
                providerPackagePath: "apps/api",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].packageLinks[0].consumerPackagePath",
          message:
            "workspace-node-packages packageLink consumerPackagePath must reference a package declared in the same packages array: apps/web",
        },
      ],
    });

    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "workspace-node-packages",
            workspacePackageGlob: "apps/*",
            packages: [
              {
                kind: "vue-app",
                path: "apps/web",
                sourceFiles: ["src/main.ts"],
              },
            ],
            packageLinks: [
              {
                consumerPackagePath: "apps/web",
                providerPackagePath: "apps/api",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].packageLinks[0].providerPackagePath",
          message:
            "workspace-node-packages packageLink providerPackagePath must reference a package declared in the same packages array: apps/api",
        },
      ],
    });
  });

  it("rejects missing Projection Capabilities with semantic diagnostics", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "workspace-library-package",
            workspacePackageGlob: "packages/*",
            packageRole: "shared-library",
            packageSourcePreset: "ts-lib",
            sourceFiles: ["src/index.ts", "src/name-schema.ts"],
          },
          { kind: "strict-typescript-root" },
          { kind: "oxc-format-lint" },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide GitHub Actions maintenance",
        },
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide Dependabot maintenance",
        },
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include node-pnpm-devcontainer to provide development container support",
        },
      ],
    });
  });
});
