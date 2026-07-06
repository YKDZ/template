import { mkdir, readFile, stat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import {
  defaultPackagePathForPresetSourcePackageAddition,
  interpretPresetProjectionDeclaration,
  planPresetSourcePackageAddition,
  validateProjectionCapabilities,
} from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";
import type { PresetProjectionDeclaration } from "@ykdz/template-shared";
import * as v from "valibot";

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
    {
      kind: "oxc-format-lint",
      editorCustomizationResourceId: "shared-editor-customization",
    },
    {
      kind: "node-pnpm-devcontainer",
      devcontainerResourceId: "shared-devcontainer",
    },
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

const jsonObjectSchema = v.record(v.string(), v.unknown());
const packageJsonSchema = v.looseObject({
  scripts: v.record(v.string(), v.string()),
});

function parseJsonWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, JSON.parse(text) as unknown);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return parseJsonWithSchema(
    await readFile(filePath, "utf8"),
    jsonObjectSchema,
  );
}

async function readPackageJson(
  filePath: string,
): Promise<v.InferOutput<typeof packageJsonSchema>> {
  return parseJsonWithSchema(
    await readFile(filePath, "utf8"),
    packageJsonSchema,
  );
}

async function expectFile(pathName: string): Promise<void> {
  const fileStat = await stat(pathName);

  expect(typeof fileStat.size).toBe("number");
}

describe("Projection Capability declarations", () => {
  it("derives Package Addition defaults and workspace glob from Projection Declarations", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const tsLib = manifest.presets.find((preset) => preset.name === "ts-lib")!;
    const honoApi = manifest.presets.find(
      (preset) => preset.name === "hono-api",
    )!;
    const vueApp = manifest.presets.find(
      (preset) => preset.name === "vue-app",
    )!;
    const root = await mkdtemp(
      path.join(tmpdir(), "template-projection-capabilities-"),
    );

    expect(
      defaultPackagePathForPresetSourcePackageAddition(
        tsLib,
        "shared",
        builtInPresetProjectionSourceRoots(),
      ),
    ).toBe("packages/shared");
    expect(
      defaultPackagePathForPresetSourcePackageAddition(
        honoApi,
        "worker",
        builtInPresetProjectionSourceRoots(),
      ),
    ).toBe("apps/worker");
    expect(
      defaultPackagePathForPresetSourcePackageAddition(
        vueApp,
        "admin",
        builtInPresetProjectionSourceRoots(),
      ),
    ).toBe("apps/admin");

    const additionPlan = await planPresetSourcePackageAddition({
      preset: vueApp,
      sourceRoots: builtInPresetProjectionSourceRoots(),
      addition: {
        root,
        blueprint: {
          schemaVersion: 1,
          preset: "vue-hono-app",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: [],
          packages: [{ name: "@demo/web", path: "apps/web" }],
        },
        packageLeafName: "admin",
        packageName: "@demo/admin",
        packagePath: "services/admin",
        nodeVersion: "24",
      },
    });

    expect(additionPlan.workspacePackageGlob).toBe("apps/*");
    expect(additionPlan.workspaceMembershipGlob).toBe("services/*");
    expect(additionPlan.textFiles).toBeUndefined();
    expect(additionPlan.operations).not.toContainEqual(
      expect.objectContaining({
        kind: "copyFile",
        to: "services/admin/playwright.config.ts",
      }),
    );
    expect(additionPlan.operations).toContainEqual({
      kind: "writeTextTemplate",
      from: "playwright.package-addition.config.ts",
      to: "services/admin/playwright.config.ts",
      replacements: { VUE_PREVIEW_PORT: "4173" },
    });
  });

  it("interprets a synthetic ts-lib declaration into Generated Repository behavior", async () => {
    const { legacyProjection, context } = await tsLibContext();

    const plan = interpretPresetProjectionDeclaration({
      preset: legacyProjection.metadata,
      declaration: syntheticTsLibDeclaration,
      context,
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual([
      "oxc-format-check",
      "oxc-lint",
      "typescript-typecheck",
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
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run check --filter './packages/*'",
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
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readPackageJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readPackageJson(
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
          "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run check --filter './packages/*'",
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

  it("renders only selected Development Container fragments from the declared Shared Resource id", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const resourceRoot = await mkdtemp(
      path.join(tmpdir(), "template-devcontainer-resource-"),
    );

    await mkdir(resourceRoot, { recursive: true });
    await writeFile(
      path.join(resourceRoot, "node-pnpm.Dockerfile"),
      [
        "# custom devcontainer resource",
        "ARG NODE_VERSION",
        "ARG PACKAGE_MANAGER_PIN",
        "FROM node:${NODE_VERSION}-bookworm-slim",
        "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
        "",
      ].join("\n"),
    );

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: {
        capabilities: preset!.projection!.capabilities.map((capability) =>
          capability.kind === "node-pnpm-devcontainer"
            ? {
                ...capability,
                devcontainerResourceId: "local-devcontainer-fragments",
              }
            : capability,
        ),
      },
      context,
      sourceRoots: {
        ...builtInSourceRoots,
        sharedResource(resourceId) {
          return resourceId === "local-devcontainer-fragments"
            ? resourceRoot
            : builtInSourceRoots.sharedResource(resourceId);
        },
      },
    });
    const dockerfileOperation = plan.operations.find(
      (operation) =>
        operation.kind === "writeTextFromFragments" &&
        operation.to === ".devcontainer/Dockerfile",
    );

    expect(dockerfileOperation).toMatchObject({
      kind: "writeTextFromFragments",
      fragments: [
        {
          sourceRoot: "devcontainer:local-devcontainer-fragments",
          from: "node-pnpm.Dockerfile",
        },
      ],
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer", "Dockerfile"),
      "utf8",
    );

    expect(devcontainerDockerfile).toContain("# custom devcontainer resource");
  });

  it("keeps Development Container resource ids out of internal renderer source-root keys", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const resourceRoot = await mkdtemp(
      path.join(tmpdir(), "template-devcontainer-resource-"),
    );

    await writeFile(
      path.join(resourceRoot, "node-pnpm.Dockerfile"),
      [
        "# resource id collides with sharedOxc",
        "ARG NODE_VERSION",
        "ARG PACKAGE_MANAGER_PIN",
        "FROM node:${NODE_VERSION}-bookworm-slim",
        "RUN corepack enable && corepack prepare ${PACKAGE_MANAGER_PIN} --activate",
        "",
      ].join("\n"),
    );

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: {
        capabilities: preset!.projection!.capabilities.map((capability) =>
          capability.kind === "node-pnpm-devcontainer"
            ? {
                ...capability,
                devcontainerResourceId: "sharedOxc",
              }
            : capability,
        ),
      },
      context,
      sourceRoots: {
        ...builtInSourceRoots,
        sharedResource(resourceId) {
          return resourceId === "sharedOxc"
            ? resourceRoot
            : builtInSourceRoots.sharedResource(resourceId);
        },
      },
    });
    const sourceRoots = plan.sourceRoots;

    expect(sourceRoots).toBeDefined();

    expect(sourceRoots!.sharedOxc).toBe(builtInSourceRoots.sharedOxc());
    expect(sourceRoots!["devcontainer:sharedOxc"]).toBe(resourceRoot);
    expect(sourceRoots!.sharedOxc).not.toBe(resourceRoot);

    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer", "Dockerfile"),
      "utf8",
    );

    expect(devcontainerDockerfile).toContain(
      "# resource id collides with sharedOxc",
    );
  });

  it("resolves Editor Customization declarations by explicit Shared Resource id", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-editor-customization-resource-"),
    );
    const resourcePath = path.join(workspace, "editor-capabilities.json");

    await writeFile(
      resourcePath,
      JSON.stringify({
        capabilities: {
          "oxc-format-lint": {
            extensions: ["custom.oxc-extension"],
            settings: {
              "custom.editorResource": true,
              "editor.defaultFormatter": "custom.oxc-extension",
            },
          },
          vue: { extensions: [], settings: {} },
          tailwind: { extensions: [], settings: {} },
          "rust-tooling": { extensions: [], settings: {} },
          vitest: { extensions: [], settings: {} },
        },
      }),
    );

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: {
        capabilities: preset!.projection!.capabilities.map((capability) =>
          capability.kind === "oxc-format-lint"
            ? {
                ...capability,
                editorCustomizationResourceId: "custom-editor-declarations",
              }
            : capability,
        ),
      },
      context,
      sourceRoots: {
        ...builtInSourceRoots,
        sharedResource(resourceId) {
          return resourceId === "custom-editor-declarations"
            ? resourcePath
            : builtInSourceRoots.sharedResource(resourceId);
        },
      },
    });

    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const workspaceExtensions = await readJson(
      path.join(targetDir, ".vscode/extensions.json"),
    );
    const workspaceSettings = await readJson(
      path.join(targetDir, ".vscode/settings.json"),
    );
    const devcontainer = await readJson(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
    );

    expect(workspaceExtensions.recommendations).toEqual([
      "custom.oxc-extension",
    ]);
    expect(workspaceSettings).toMatchObject({
      "custom.editorResource": true,
      "editor.defaultFormatter": "custom.oxc-extension",
      "oxc.configPath": "./oxlint.config.ts",
      "oxc.fmt.configPath": "./oxfmt.config.ts",
    });
    expect(devcontainer.customizations).toMatchObject({
      vscode: {
        extensions: ["custom.oxc-extension"],
        settings: workspaceSettings,
      },
    });
  });

  it("reports malformed Editor Customization Shared Resource declarations", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-editor-customization-resource-"),
    );
    const resourcePath = path.join(workspace, "editor-capabilities.json");

    await writeFile(
      resourcePath,
      JSON.stringify({
        capabilities: {
          "oxc-format-lint": {
            extensions: [true],
            settings: {},
          },
        },
      }),
    );

    expect(() =>
      interpretPresetProjectionDeclaration({
        preset: preset!,
        declaration: {
          capabilities: preset!.projection!.capabilities.map((capability) =>
            capability.kind === "oxc-format-lint"
              ? {
                  ...capability,
                  editorCustomizationResourceId: "bad-editor-declarations",
                }
              : capability,
          ),
        },
        context,
        sourceRoots: {
          ...builtInSourceRoots,
          sharedResource(resourceId) {
            return resourceId === "bad-editor-declarations"
              ? resourcePath
              : builtInSourceRoots.sharedResource(resourceId);
          },
        },
      }),
    ).toThrow(
      `Editor Customization Shared Resource ${resourcePath} is invalid: $.capabilities.oxc-format-lint.extensions.0: Invalid type: Expected string but received true`,
    );
  });

  it("reports a missing Development Container Shared Resource fragment", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const resourceRoot = await mkdtemp(
      path.join(tmpdir(), "template-devcontainer-resource-"),
    );

    expect(() =>
      interpretPresetProjectionDeclaration({
        preset: preset!,
        declaration: {
          capabilities: preset!.projection!.capabilities.map((capability) =>
            capability.kind === "node-pnpm-devcontainer"
              ? {
                  ...capability,
                  devcontainerResourceId: "empty-devcontainer-fragments",
                }
              : capability,
          ),
        },
        context,
        sourceRoots: {
          ...builtInSourceRoots,
          sharedResource(resourceId) {
            return resourceId === "empty-devcontainer-fragments"
              ? resourceRoot
              : builtInSourceRoots.sharedResource(resourceId);
          },
        },
      }),
    ).toThrow(
      "Development Container Shared Resource empty-devcontainer-fragments is missing Dockerfile fragment: node-pnpm.Dockerfile",
    );
  });

  it("reports a malformed Development Container Shared Resource root as a semantic fragment error", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context } = await tsLibContext();
    const builtInSourceRoots = builtInPresetProjectionSourceRoots();
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-devcontainer-resource-"),
    );
    const resourceFile = path.join(workspace, "not-a-directory");

    await writeFile(resourceFile, "not a directory\n");

    expect(() =>
      interpretPresetProjectionDeclaration({
        preset: preset!,
        declaration: {
          capabilities: preset!.projection!.capabilities.map((capability) =>
            capability.kind === "node-pnpm-devcontainer"
              ? {
                  ...capability,
                  devcontainerResourceId: "file-devcontainer-fragments",
                }
              : capability,
          ),
        },
        context,
        sourceRoots: {
          ...builtInSourceRoots,
          sharedResource(resourceId) {
            return resourceId === "file-devcontainer-fragments"
              ? resourceFile
              : builtInSourceRoots.sharedResource(resourceId);
          },
        },
      }),
    ).toThrow(
      "Development Container Shared Resource file-devcontainer-fragments is missing Dockerfile fragment: node-pnpm.Dockerfile",
    );
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
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readPackageJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readPackageJson(
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
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run check --filter './apps/*'",
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
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readPackageJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readPackageJson(
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
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run check --filter './apps/*'",
    );
    expect(packageJson).toMatchObject({
      name: "@demo-vue-app/web",
      scripts: {
        build: "vite build",
        dev: "vite",
        preview: "vite preview",
        test: "vitest run",
        "test:e2e":
          "pnpm run build && node --experimental-strip-types scripts/run-playwright.ts",
        typecheck: "vue-tsc --build --noEmit",
      },
      dependencies: {
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

  it("derives Vue browser environment setup from the declared package path", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "vue-app",
    );
    expect(preset).toBeDefined();
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-package-path-"),
    );
    const targetDir = path.join(workspace, "demo-vue");

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: {
        capabilities: [
          {
            kind: "workspace-node-packages",
            workspacePackageGlob: "apps/*",
            packages: [
              {
                kind: "vue-app",
                path: "apps/api",
                sourceFiles: ["src/main.ts"],
              },
            ],
          },
          { kind: "strict-typescript-root" },
          {
            kind: "oxc-format-lint",
            editorCustomizationResourceId: "shared-editor-customization",
          },
          {
            kind: "node-pnpm-devcontainer",
            devcontainerResourceId: "shared-devcontainer",
          },
          { kind: "github-maintenance" },
        ],
      },
      context: assembleGenerationContext({
        targetDir,
        blueprint: {
          schemaVersion: 1,
          preset: "vue-app",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: [],
          packages: [{ name: "@demo/api", path: "apps/api" }],
        },
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      }),
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });

    expect(plan.checkPlan.environmentNeeds).toEqual([
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "package-boundary", path: "apps/api" },
        nextStep: {
          id: "install-apps-api-playwright-browsers",
          label: "Install Playwright browser assets for apps/api package",
          command: "pnpm",
          args: [
            "--filter",
            "./apps/api",
            "exec",
            "playwright",
            "install",
            "chromium",
          ],
          display: "pnpm --filter ./apps/api exec playwright install chromium",
          machineVerifiable: true,
        },
      },
    ]);
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
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const apiPackageJson = await readPackageJson(
      path.join(targetDir, "apps", "api", "package.json"),
    );
    const webPackageJson = await readPackageJson(
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
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readPackageJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readPackageJson(
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
            devcontainerResourceId: "shared-devcontainer",
            editorCustomizationResourceId: "shared-editor-customization",
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
          {
            kind: "oxc-format-lint",
            editorCustomizationResourceId: "shared-editor-customization",
          },
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
