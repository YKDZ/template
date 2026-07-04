import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "@ykdz/template-core/declarations";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "@ykdz/template-core/module-graph";
import { PackageAdditionSupport } from "@ykdz/template-core/package-addition-support";
import {
  packageManifestExposureFields,
  planPackageLinks,
} from "@ykdz/template-core/package-linking";
import type {
  PresetPackageAdditionOptions,
  PresetPackageAdditionPlan,
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "@ykdz/template-core/preset-projection";
import { interpretPresetProjectionDeclaration } from "@ykdz/template-core/projection-capabilities";
import {
  renderNewProject,
  type RenderOperation,
} from "@ykdz/template-core/renderer";

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

const tsLibPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
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

function planTsLibPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: tsLibPackageBoundary },
      { kind: "oxc-lint-fix", owner: tsLibPackageBoundary },
    ],
  };
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function scopedPackageName(
  packageScope: string,
  packageLeafName: string,
): string {
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
        name: scopedPackageName(packageScope, packageLeafName),
        path: `packages/${packageLeafName}`,
      },
    ],
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
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

function packageAdditionOperations(
  packagePath: string,
  packageNameValue: string,
  nodeVersion: string,
): RenderOperation[] {
  const packageExposure = planPackageLinks([
    {
      name: packageNameValue,
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
        name: packageNameValue,
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
          "oxlint-tsgolint": "catalog:",
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
          erasableSyntaxOnly: true,
          exactOptionalPropertyTypes: true,
          forceConsistentCasingInFileNames: true,
          isolatedModules: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          noEmitOnError: true,
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noUncheckedIndexedAccess: true,
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "es2023",
          types: ["node"],
          verbatimModuleSyntax: true,
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
  packageNameValue: string,
  packagePath: string,
  nodeVersion: string,
): PresetPackageAdditionPlan {
  const [workspaceCollection] = packagePath.split("/");

  return {
    packagePath,
    workspacePackageGlob: `${workspaceCollection}/*`,
    packageRole: "shared-library",
    packageSourcePreset: "ts-lib",
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    operations: packageAdditionOperations(
      packagePath,
      packageNameValue,
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
    return interpretPresetProjectionDeclaration({
      preset: tsLibPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("ts-lib"),
      context,
      sourceRoots: builtInPresetProjectionSourceRoots(),
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
