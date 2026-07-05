import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "@ykdz/template-core/module-graph";
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
import {
  PackageAdditionSupport,
  type BuiltInPreset,
  type ProjectBlueprint,
} from "@ykdz/template-shared";

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

const apiPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
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

function planHonoApiPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: apiPackageBoundary },
      { kind: "oxc-lint-fix", owner: apiPackageBoundary },
    ],
  };
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function scopedPackageName(packageScope: string): string {
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
    packages: [{ name: scopedPackageName(packageScope), path: "apps/api" }],
  };
}

export function projectHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planHonoApiPackageChecks()),
    fix: renderFixCommand(planHonoApiPackageFixes()),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
    start: "node dist/server.js",
    test: "vitest run",
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
        name: packageNameValue,
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
          "oxlint-tsgolint": "catalog:",
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
          skipLibCheck: false,
          strict: true,
          target: "es2023",
          types: ["node", "vitest/globals"],
          verbatimModuleSyntax: true,
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
  packageNameValue: string,
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
