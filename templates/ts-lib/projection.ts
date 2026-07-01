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
  type ComponentOwner,
  type FixPlan,
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

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset ts-lib",
};

export const tsLibPresetMetadata: BuiltInPreset = {
  name: "ts-lib",
  title: "TypeScript library",
  description: "Strict TypeScript package with pnpm catalog tooling.",
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

const tsLibPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

function planTsLibChecks(): CheckPlan {
  return {
    components: [
      { kind: "typescript-typecheck", owner: tsLibPackageBoundary },
      { kind: "oxc-lint", owner: tsLibPackageBoundary },
      { kind: "oxc-format-check", owner: tsLibPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planTsLibFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: tsLibPackageBoundary },
      { kind: "oxc-lint-fix", owner: tsLibPackageBoundary },
    ],
  };
}

export function tsLibBlueprint(): ProjectBlueprint {
  return {
    schemaVersion: 1,
    preset: "ts-lib",
    packageManager: "pnpm",
    projectKind: "single-package",
    features: [...tsLibPresetMetadata.features],
  };
}

export function projectTsLibPackageScripts(): Record<string, string> {
  const checkPlan = planTsLibChecks();
  const fixPlan = planTsLibFixes();

  return {
    build: "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
    check: renderRootCheckCommand(checkPlan),
    fix: renderFixCommand(fixPlan),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
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
    files: ["dist"],
    type: "module",
    exports: {
      ".": {
        default: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
    scripts: packageScripts,
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      typescript: "catalog:",
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

function operationsForTsLib(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  checkPlan: CheckPlan,
): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities([
    "oxc-format-lint",
  ]);

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(context, packageScripts),
      multilineArrays: ["files"],
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        dependencies: [
          "@types/node",
          "oxfmt",
          "oxlint",
          "tsc-alias",
          "typescript",
        ],
      }),
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        compilerOptions: {
          declaration: true,
          declarationMap: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          outDir: "dist",
          paths: {
            "@/*": ["./src/*"],
          },
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
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
    {
      kind: "copyFile",
      from: "src/index.ts",
      to: "src/index.ts",
    },
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: tsLibBlueprint(),
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
        name: `${context.projectName.value} development`,
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
        files: ["dist"],
        type: "module",
        exports: {
          ".": {
            default: "./dist/index.js",
            types: "./dist/index.d.ts",
          },
        },
        scripts: projectTsLibPackageScripts(),
        devDependencies: {
          "@types/node": "catalog:",
          oxfmt: "catalog:",
          oxlint: "catalog:",
          "tsc-alias": "catalog:",
          typescript: "catalog:",
        },
        engines: {
          node: nodeVersion,
        },
      },
      multilineArrays: ["files"],
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          outDir: "dist",
          paths: {
            "@/*": ["./src/*"],
          },
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
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
    {
      kind: "copyFile",
      from: "src/index.ts",
      to: `${packagePath}/src/index.ts`,
    },
  ];
}

function packageAdditionPlan(
  packageLeafName: string,
  packageName: string,
  nodeVersion: string,
): PresetPackageAdditionPlan {
  const packagePath = `packages/${packageLeafName}`;

  return {
    packagePath,
    workspacePackageGlob: "packages/*",
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
    "ts-lib",
  );

  return existsSync(path.join(publishedTemplateRoot, "src", "index.ts"))
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

export const tsLibPresetProjection: PresetProjection = {
  metadata: tsLibPresetMetadata,
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
  blueprint: tsLibBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planTsLibChecks();
    const fixPlan = planTsLibFixes();
    const packageScripts = projectTsLibPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
      operations: operationsForTsLib(context, packageScripts, checkPlan),
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
