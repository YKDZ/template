import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import {
  collectGeneratedManifestCatalogDependencies,
  renderGeneratedPnpmWorkspaceYaml,
} from "../../src/dependency-catalog.js";
import {
  checkedDockerfileFirstNodePnpmDevcontainer,
  nodePnpmToolLayer,
} from "../../src/devcontainer.js";
import { editorCustomizationForCapabilities } from "../../src/editor-customization.js";
import type { GenerationContext } from "../../src/generation-context.js";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "../../src/module-graph.js";
import { PackageAdditionSupport } from "../../src/package-addition-support.js";
import {
  packageManifestExposureFields,
  planPackageLinks,
  packageTurboTasks,
} from "../../src/package-linking.js";
import type {
  PresetPackageAdditionOptions,
  PresetPackageAdditionPlan,
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "../../src/preset-projection.js";
import type { DependencyMaintenancePolicy } from "../../src/project-github.js";
import {
  interpretPresetProjectionDeclaration,
  loadBuiltInPresetProjectionDeclaration,
} from "../../src/projection-capabilities.js";
import { renderNewProject, type RenderOperation } from "../../src/renderer.js";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset hono-api",
};

export const honoApiPresetMetadata: BuiltInPreset = {
  name: "hono-api",
  title: "Hono API",
  description: "Hono Node API workspace with strict TypeScript tooling.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
  packageAdditionSupport: PackageAdditionSupport.Supported,
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
  ecosystems: ["npm", "github-actions", "docker"],
  interval: "weekly",
};

const apiPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const rootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const workspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/*",
};

function planHonoApiPackageChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: apiPackageBoundary },
      { kind: "oxc-lint", owner: apiPackageBoundary },
      { kind: "typescript-typecheck", owner: apiPackageBoundary },
      { kind: "build", owner: apiPackageBoundary },
      { kind: "unit-test", owner: apiPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planHonoApiRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: rootBoundary },
      { kind: "oxc-lint", owner: rootBoundary },
      { kind: "typescript-typecheck", owner: rootBoundary },
      { kind: "turbo-package-typecheck", owner: workspacePackageBoundary },
      { kind: "turbo-package-build", owner: workspacePackageBoundary },
      { kind: "turbo-package-test", owner: workspacePackageBoundary },
      { kind: "turbo-package-check", owner: workspacePackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planHonoApiPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: apiPackageBoundary },
      { kind: "oxc-lint-fix", owner: apiPackageBoundary },
    ],
  };
}

function planHonoApiRootFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: rootBoundary },
      { kind: "oxc-lint-fix", owner: rootBoundary },
      { kind: "turbo-package-fix", owner: workspacePackageBoundary },
    ],
  };
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function packageName(packageScope: string): string {
  return `@${packageScope}/api`;
}

export function honoApiBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const packageScope = packageScopeFromOptions(options);

  return {
    schemaVersion: 1,
    preset: "hono-api",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...honoApiPresetMetadata.features],
    packages: [{ name: packageName(packageScope), path: "apps/api" }],
  };
}

function projectHonoApiRootPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planHonoApiRootChecks()),
    fix: renderFixCommand(planHonoApiRootFixes()),
    "format:check":
      "oxfmt --check --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts",
    "format:write":
      "oxfmt --write --config oxfmt.config.ts oxlint.config.ts oxfmt.config.ts",
    lint: "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --deny-warnings",
    "lint:fix":
      "oxlint --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts --fix --deny-warnings",
    typecheck: "tsc -p tsconfig.config.json --noEmit",
  };
}

export function projectHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planHonoApiPackageChecks()),
    fix: renderFixCommand(planHonoApiPackageFixes()),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
    "lint:fix":
      "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
    start: "node dist/server.js",
    test: "vitest run",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

function rootPackageJson(
  context: GenerationContext,
  packageScripts: Record<string, string>,
): Record<string, unknown> {
  return {
    name: context.projectName.value,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: packageScripts,
    devDependencies: {
      oxfmt: "catalog:",
      oxlint: "catalog:",
      turbo: "catalog:",
      typescript: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function apiPackageName(context: GenerationContext): string {
  const apiPackage = context.blueprint.packages?.find(
    (pkg) => pkg.path === "apps/api",
  );

  return apiPackage?.name ?? packageName(context.projectName.value);
}

function apiPackageJson(context: GenerationContext): Record<string, unknown> {
  return {
    name: apiPackageName(context),
    version: "0.0.0",
    private: true,
    type: "module",
    imports: {
      "#/*": {
        default: "./dist/*.js",
        types: "./src/*.ts",
      },
    },
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
      node: context.toolchain.nodeLtsMajor.value,
    },
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
  const developmentContainer = checkedDockerfileFirstNodePnpmDevcontainer({
    name: context.projectName.value,
    layer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });
  const rootManifest = rootPackageJson(context, packageScripts);
  const apiManifest = apiPackageJson(context);
  const turboTasks = packageTurboTasks({ dependencyBuildsRequired: false });

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootManifest,
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        packages: ["apps/*"],
        dependencies: collectGeneratedManifestCatalogDependencies([
          rootManifest,
          apiManifest,
        ]),
      }),
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          build: turboTasks.build,
          check: turboTasks.check,
          typecheck: turboTasks.typecheck,
          test: turboTasks.test,
          "test:e2e": turboTasks["test:e2e"],
          fix: {
            cache: false,
          },
        },
      },
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        files: [],
        references: [{ path: "./apps/api/tsconfig.json" }],
      },
    },
    {
      kind: "writeJson",
      to: "tsconfig.config.json",
      value: {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
        },
        include: ["oxlint.config.ts", "oxfmt.config.ts"],
      },
    },
    {
      kind: "writeJson",
      to: "apps/api/package.json",
      value: apiManifest,
    },
    {
      kind: "writeJson",
      to: "apps/api/tsconfig.json",
      value: {
        compilerOptions: {
          composite: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
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
      to: "apps/api/tsconfig.build.json",
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
    { kind: "copyFile", from: "src/app.ts", to: "apps/api/src/app.ts" },
    {
      kind: "copyFile",
      from: "src/server.ts",
      to: "apps/api/src/server.ts",
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: "apps/api/test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: "apps/api/vitest.config.ts",
    },
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: context.blueprint,
    },
    {
      kind: "writeJson",
      to: ".template/generated-by.json",
      value: generationRecord(context),
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: developmentContainer.devcontainer,
    },
    {
      ...developmentContainer.dockerfileOperation!,
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
      kind: "copyFile",
      from: ".github/workflows/check.yml",
      to: ".github/workflows/check.yml",
    },
    {
      kind: "copyFile",
      from: ".github/dependabot.yml",
      to: ".github/dependabot.yml",
    },
  ];
}

function packageAdditionOperations(
  packagePath: string,
  packageName: string,
  nodeVersion: string,
): RenderOperation[] {
  const packageExposure = planPackageLinks([
    {
      name: packageName,
      path: packagePath,
      role: "runtime-service",
      sourcePreset: "hono-api",
    },
  ]).exposuresByPackagePath.get(packagePath);

  if (packageExposure === undefined) {
    throw new Error(`Missing Package Exposure for ${packagePath}`);
  }

  const exposureFields = packageManifestExposureFields(packageExposure);

  return [
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: {
        name: packageName,
        version: "0.0.0",
        private: true,
        type: "module",
        types: exposureFields.types,
        exports: exposureFields.exports,
        imports: exposureFields.imports,
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
  packageName: string,
  packagePath: string,
  nodeVersion: string,
): PresetPackageAdditionPlan {
  const [workspaceCollection] = packagePath.split("/");

  return {
    packagePath,
    workspacePackageGlob: `${workspaceCollection}/*`,
    packageRole: "runtime-service",
    packageSourcePreset: "hono-api",
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

function sharedDevcontainerSourceRoot(): string {
  const projectionDir = path.dirname(fileURLToPath(import.meta.url));
  const publishedSharedRoot = path.join(
    projectionDir,
    "..",
    "..",
    "..",
    "templates",
    "shared",
    "devcontainer",
  );

  return existsSync(path.join(publishedSharedRoot, "node-pnpm.Dockerfile"))
    ? publishedSharedRoot
    : path.join(projectionDir, "..", "shared", "devcontainer");
}

export const honoApiPresetProjection: PresetProjection = {
  metadata: honoApiPresetMetadata,
  capabilities: {
    packageAddition: {
      planPackageAddition({
        packageName,
        packagePath,
        nodeVersion,
      }: PresetPackageAdditionOptions) {
        return packageAdditionPlan(packageName, packagePath, nodeVersion);
      },
    },
  },
  blueprint: honoApiBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    return interpretPresetProjectionDeclaration({
      preset: honoApiPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("hono-api"),
      context,
    });
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
