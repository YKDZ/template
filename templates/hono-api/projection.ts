import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import { renderGeneratedPnpmWorkspaceYaml } from "../../src/dependency-catalog.js";
import { nodePnpmDevcontainer } from "../../src/devcontainer.js";
import { editorCustomizationForCapabilities } from "../../src/editor-customization.js";
import type { GenerationContext } from "../../src/generation-context.js";
import {
  type CheckPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "../../src/module-graph.js";
import type {
  PresetPackageAdditionOptions,
  PresetPackageAdditionPlan,
  PresetProjection,
  PresetProjectionPlan,
} from "../../src/preset-projection.js";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
  type DependencyMaintenancePolicy,
} from "../../src/project-github.js";
import { renderNewProject, type RenderOperation } from "../../src/renderer.js";
import { planNodeChecks, planNodeFixes } from "../projection-plans.js";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset hono-api",
};

export const honoApiPresetMetadata: BuiltInPreset = {
  name: "hono-api",
  title: "Hono API",
  description: "Single-package Hono Node API with strict TypeScript tooling.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["single-package"],
  features: [
    "pnpm-catalog",
    "oxc-format-lint",
    "strict-typescript",
    "root-check",
    "fix-command",
    "devcontainer",
    "github-actions",
    "dependabot",
  ],
};

const dependencyMaintenancePolicy: DependencyMaintenancePolicy = {
  ecosystems: ["npm", "github-actions"],
  interval: "weekly",
};

export function honoApiBlueprint(): ProjectBlueprint {
  return {
    schemaVersion: 1,
    preset: "hono-api",
    packageManager: "pnpm",
    projectKind: "single-package",
    features: [...honoApiPresetMetadata.features],
  };
}

export function projectHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planNodeChecks("hono-api")),
    fix: renderFixCommand(planNodeFixes("hono-api")),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    start: "node dist/server.js",
    test: "vitest run",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

function packageJson(
  context: GenerationContext,
  packageScripts: Record<string, string>,
): Record<string, unknown> {
  return {
    name: context.projectName.value,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: packageScripts,
    dependencies: {
      "@hono/node-server": "catalog:",
      hono: "catalog:",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      typescript: "catalog:",
      vitest: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function generationRecord(context: GenerationContext): Record<string, unknown> {
  return {
    ...generatedBy,
    toolchain: {
      nodeLtsMajor: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
      source: context.toolchain.source,
    },
  };
}

function operationsForHonoApi(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  checkPlan: CheckPlan,
): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities([
    "oxc-format-lint",
    "vitest",
  ]);

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(context, packageScripts),
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        dependencies: [
          "@hono/node-server",
          "@types/node",
          "hono",
          "oxfmt",
          "oxlint",
          "tsc-alias",
          "typescript",
          "vitest",
        ],
      }),
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          paths: {
            "@/*": ["./src/*"],
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node", "vitest/globals"],
        },
        include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
      },
    },
    {
      kind: "writeJson",
      to: "tsconfig.build.json",
      value: {
        extends: "./tsconfig.json",
        compilerOptions: {
          outDir: "dist",
          rootDir: "src",
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "node/oxlint.config.ts",
      to: "oxlint.config.ts",
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "oxfmt.config.ts",
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: [
        "node_modules",
        "dist",
        ".env",
        ".template/",
        ".pnpm-store/",
        "",
      ].join("\n"),
    },
    { kind: "copyFile", from: "src/app.ts", to: "src/app.ts" },
    { kind: "copyFile", from: "src/server.ts", to: "src/server.ts" },
    { kind: "copyFile", from: "test/app.test.ts", to: "test/app.test.ts" },
    { kind: "copyFile", from: "vitest.config.ts", to: "vitest.config.ts" },
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: honoApiBlueprint(),
    },
    {
      kind: "writeJson",
      to: ".template/generated-by.json",
      value: generationRecord(context),
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: nodePnpmDevcontainer({
        name: `${context.projectName.value} API development`,
        nodeVersion: context.toolchain.nodeLtsMajor.value,
        packageManagerPin: context.toolchain.packageManagerPin.value,
        extensions: editorCustomization.extensions,
        settings: editorCustomization.settings,
      }),
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: {
        recommendations: editorCustomization.extensions,
      },
      multilineArrays: ["recommendations"],
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectCheckWorkflow({ checkPlan }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(dependencyMaintenancePolicy),
    },
  ];
}

function packageAdditionOperations(
  packagePath: string,
  packageName: string,
  nodeVersion: string,
): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: {
        name: packageName,
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: projectHonoApiPackageScripts(),
        dependencies: {
          "@hono/node-server": "catalog:",
          hono: "catalog:",
        },
        devDependencies: {
          "@types/node": "catalog:",
          oxfmt: "catalog:",
          oxlint: "catalog:",
          "tsc-alias": "catalog:",
          typescript: "catalog:",
          vitest: "catalog:",
        },
        engines: {
          node: nodeVersion,
        },
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          paths: {
            "@/*": ["./src/*"],
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node", "vitest/globals"],
        },
        include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.build.json`,
      value: {
        extends: "./tsconfig.json",
        compilerOptions: {
          outDir: "dist",
          rootDir: "src",
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "node/oxlint.config.ts",
      to: `${packagePath}/oxlint.config.ts`,
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: `${packagePath}/oxfmt.config.ts`,
    },
    { kind: "copyFile", from: "src/app.ts", to: `${packagePath}/src/app.ts` },
    {
      kind: "copyFile",
      from: "src/server.ts",
      to: `${packagePath}/src/server.ts`,
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: `${packagePath}/test/app.test.ts`,
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: `${packagePath}/vitest.config.ts`,
    },
  ];
}

function packageAdditionPlan(
  packageLeafName: string,
  packageName: string,
  nodeVersion: string,
): PresetPackageAdditionPlan {
  const packagePath = `apps/${packageLeafName}`;

  return {
    packagePath,
    workspacePackageGlob: "apps/*",
    rootTsconfigReferences: [`./${packagePath}/tsconfig.json`],
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    operations: packageAdditionOperations(
      packagePath,
      packageName,
      nodeVersion,
    ),
  };
}

function templateSourceRoot(): string {
  const projectionDir = path.dirname(fileURLToPath(import.meta.url));
  const publishedTemplateRoot = path.join(
    projectionDir,
    "..",
    "..",
    "..",
    "templates",
    "hono-api",
  );

  return existsSync(path.join(publishedTemplateRoot, "src", "app.ts"))
    ? publishedTemplateRoot
    : projectionDir;
}

function sharedOxcSourceRoot(): string {
  const projectionDir = path.dirname(fileURLToPath(import.meta.url));
  const publishedSharedRoot = path.join(
    projectionDir,
    "..",
    "..",
    "..",
    "templates",
    "shared",
    "oxc",
  );

  return existsSync(path.join(publishedSharedRoot, "oxfmt.config.ts"))
    ? publishedSharedRoot
    : path.join(projectionDir, "..", "shared", "oxc");
}

export const honoApiPresetProjection: PresetProjection = {
  metadata: honoApiPresetMetadata,
  capabilities: {
    packageAddition: {
      planPackageAddition({
        packageLeafName,
        packageName,
        nodeVersion,
      }: PresetPackageAdditionOptions) {
        return packageAdditionPlan(packageLeafName, packageName, nodeVersion);
      },
    },
  },
  blueprint: honoApiBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planNodeChecks("hono-api");
    const fixPlan = planNodeFixes("hono-api");
    const packageScripts = projectHonoApiPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
      operations: operationsForHonoApi(context, packageScripts, checkPlan),
      checkPlan,
      fixPlan,
      dependencyMaintenancePolicy,
      packageScripts,
      capabilities: {
        rootCheck: true,
        fixCommand: true,
        githubActions: true,
        dependabot: true,
        devcontainer: true,
      },
    };
  },
  async render({ targetDir, plan }): Promise<void> {
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
  },
};
