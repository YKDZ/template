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
  type PackageExposure,
} from "../../src/package-linking.js";
import type {
  PresetPackageAdditionOptions,
  PresetPackageAdditionPlan,
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "../../src/preset-projection.js";
import type { DependencyMaintenancePolicy } from "../../src/project-github.js";
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

const tsLibPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const tsLibRootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const tsLibWorkspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "packages/*",
};

function planTsLibPackageChecks(): CheckPlan {
  return {
    components: [
      { kind: "typescript-typecheck", owner: tsLibPackageBoundary },
      { kind: "oxc-lint", owner: tsLibPackageBoundary },
      { kind: "oxc-format-check", owner: tsLibPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planTsLibRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: tsLibRootBoundary },
      { kind: "oxc-lint", owner: tsLibRootBoundary },
      { kind: "typescript-typecheck", owner: tsLibRootBoundary },
      { kind: "turbo-package-check", owner: tsLibWorkspacePackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planTsLibPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: tsLibPackageBoundary },
      { kind: "oxc-lint-fix", owner: tsLibPackageBoundary },
    ],
  };
}

function planTsLibRootFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: tsLibRootBoundary },
      { kind: "oxc-lint-fix", owner: tsLibRootBoundary },
      { kind: "turbo-package-fix", owner: tsLibWorkspacePackageBoundary },
    ],
  };
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function packageName(packageScope: string, packageLeafName: string): string {
  return `@${packageScope}/${packageLeafName}`;
}

export function tsLibBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const packageScope = packageScopeFromOptions(options);
  const packageLeafName = projectNameFromDir(options.targetDir);

  return {
    schemaVersion: 1,
    preset: "ts-lib",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...tsLibPresetMetadata.features],
    packages: [
      {
        name: packageName(packageScope, packageLeafName),
        path: `packages/${packageLeafName}`,
      },
    ],
  };
}

function workspacePackagePath(context: GenerationContext): string {
  return `packages/${context.projectName.value}`;
}

function workspacePackageName(context: GenerationContext): string {
  const packageDefinition = context.blueprint.packages?.find(
    (pkg) => pkg.path === workspacePackagePath(context),
  );

  return (
    packageDefinition?.name ??
    packageName(context.projectName.value, context.projectName.value)
  );
}

function projectTsLibRootPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planTsLibRootChecks()),
    fix: renderFixCommand(planTsLibRootFixes()),
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

export function projectTsLibPackageScripts(): Record<string, string> {
  const checkPlan = planTsLibPackageChecks();
  const fixPlan = planTsLibPackageFixes();

  return {
    check: renderRootCheckCommand(checkPlan),
    fix: renderFixCommand(fixPlan),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
    "lint:fix":
      "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
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

function libraryPackageJson(
  context: GenerationContext,
  exposure: PackageExposure,
): Record<string, unknown> {
  const exposureFields = packageManifestExposureFields(exposure);

  return {
    name: workspacePackageName(context),
    version: "0.0.0",
    private: true,
    type: "module",
    imports: exposureFields.imports,
    exports: exposureFields.exports,
    dependencies: {
      valibot: "catalog:",
    },
    scripts: projectTsLibPackageScripts(),
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      typescript: "catalog:",
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

function operationsForTsLib(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  checkPlan: CheckPlan,
): RenderOperation[] {
  const editorCustomization = editorCustomizationForCapabilities([
    "oxc-format-lint",
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
  const packageLinkPlan = planPackageLinks([
    {
      name: workspacePackageName(context),
      path: workspacePackagePath(context),
      role: "shared-library",
      sourcePreset: "ts-lib",
    },
  ]);
  const packageExposure = packageLinkPlan.exposuresByPackagePath.get(
    workspacePackagePath(context),
  );

  if (packageExposure === undefined) {
    throw new Error(
      `Missing Package Exposure for ${workspacePackagePath(context)}`,
    );
  }

  const packageManifest = libraryPackageJson(context, packageExposure);

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
        packages: ["packages/*"],
        dependencies: collectGeneratedManifestCatalogDependencies([
          rootManifest,
          packageManifest,
        ]),
      }),
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          check: {
            dependsOn: ["^check"],
          },
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
      to: `${workspacePackagePath(context)}/package.json`,
      value: packageManifest,
      multilineArrays: ["files"],
    },
    {
      kind: "writeJson",
      to: `${workspacePackagePath(context)}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
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
      to: `${workspacePackagePath(context)}/src/index.ts`,
    },
    {
      kind: "copyFile",
      from: "src/name-schema.ts",
      to: `${workspacePackagePath(context)}/src/name-schema.ts`,
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
      kind: "copyFile",
      sourceRoot: "sharedDevcontainer",
      from: "node-pnpm.Dockerfile",
      to: ".devcontainer/Dockerfile",
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
      role: "shared-library",
      sourcePreset: "ts-lib",
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
        imports: exposureFields.imports,
        exports: exposureFields.exports,
        dependencies: {
          valibot: "catalog:",
        },
        scripts: projectTsLibPackageScripts(),
        devDependencies: {
          "@types/node": "catalog:",
          oxfmt: "catalog:",
          oxlint: "catalog:",
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
      from: "src/index.ts",
      to: `${packagePath}/src/index.ts`,
    },
    {
      kind: "copyFile",
      from: "src/name-schema.ts",
      to: `${packagePath}/src/name-schema.ts`,
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
    rootTsconfigReferences: [],
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

export const tsLibPresetProjection: PresetProjection = {
  metadata: tsLibPresetMetadata,
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
  blueprint: tsLibBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planTsLibRootChecks();
    const fixPlan = planTsLibRootFixes();
    const packageScripts = projectTsLibRootPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: {
        sharedDevcontainer: sharedDevcontainerSourceRoot(),
        sharedOxc: sharedOxcSourceRoot(),
      },
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
