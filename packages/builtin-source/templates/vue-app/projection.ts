import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
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

export const vueAppPresetMetadata: BuiltInPreset = {
  name: "vue-app",
  title: "Vue app",
  description:
    "Vue app workspace with Vite, Tailwind, Pinia, and test tooling.",
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

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function scopedPackageName(packageScope: string): string {
  return `@${packageScope}/web`;
}

export function vueAppBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const packageScope = packageScopeFromOptions(options);

  return {
    schemaVersion: 1,
    preset: "vue-app",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...vueAppPresetMetadata.features],
    packages: [{ name: scopedPackageName(packageScope), path: "apps/web" }],
  };
}

export function projectVueAppPackageScripts(): Record<string, string> {
  return {
    "build:run": "vite build",
    dev: "vite",
    "format:check:run":
      "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
    "lint:run":
      "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
    "lint:fix:run":
      "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    preview: "vite preview",
    "test:run": "vitest run --reporter=agent --silent=passed-only",
    "test:e2e:run": "node scripts/run-playwright.ts",
    "typecheck:run":
      "node scripts/run-vue-tsc.ts --build --noEmit --pretty false",
  };
}

function packageAdditionOperations(
  packagePath: string,
  packageNameValue: string,
  nodeVersion: string,
): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: {
        name: packageNameValue,
        version: "0.0.0",
        private: true,
        type: "module",
        imports: {
          "#/*": {
            default: "./src/*.ts",
            types: "./src/*.ts",
          },
        },
        scripts: projectVueAppPackageScripts(),
        dependencies: {
          pinia: "catalog:",
          vue: "catalog:",
        },
        devDependencies: {
          "@playwright/test": "catalog:",
          "@tailwindcss/vite": "catalog:",
          "@types/node": "catalog:",
          "@types/web-bluetooth": "catalog:",
          "@vitejs/plugin-vue": "catalog:",
          "@vue/tsconfig": "catalog:",
          oxfmt: "catalog:",
          oxlint: "catalog:",
          "oxlint-tsgolint": "catalog:",
          tailwindcss: "catalog:",
          typescript: "catalog:",
          "typescript-6": "catalog:",
          vite: "catalog:",
          vitest: "catalog:",
          "vue-tsc": "catalog:",
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
        files: [],
        references: [
          { path: "./tsconfig.app.json" },
          { path: "./tsconfig.test.json" },
          { path: "./tsconfig.node.json" },
        ],
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.app.json`,
      value: {
        extends: "@vue/tsconfig/tsconfig.dom.json",
        compilerOptions: {
          composite: true,
          erasableSyntaxOnly: true,
          exactOptionalPropertyTypes: true,
          forceConsistentCasingInFileNames: true,
          isolatedModules: true,
          module: "esnext",
          moduleResolution: "bundler",
          noEmitOnError: true,
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noUncheckedIndexedAccess: true,
          rewriteRelativeImportExtensions: false,
          skipLibCheck: false,
          strict: true,
          target: "es2023",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"],
          verbatimModuleSyntax: true,
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"],
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.test.json`,
      value: {
        extends: "./tsconfig.app.json",
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
          types: ["node", "vitest/globals", "web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue", "test/**/*.ts"],
      },
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.node.json`,
      multilineArrays: ["include"],
      value: {
        compilerOptions: {
          composite: true,
          erasableSyntaxOnly: true,
          exactOptionalPropertyTypes: true,
          forceConsistentCasingInFileNames: true,
          isolatedModules: true,
          module: "esnext",
          moduleResolution: "bundler",
          noEmitOnError: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noUncheckedIndexedAccess: true,
          rewriteRelativeImportExtensions: false,
          skipLibCheck: false,
          strict: true,
          target: "es2023",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
          types: ["node"],
          verbatimModuleSyntax: true,
        },
        include: [
          "playwright.config.ts",
          "scripts/**/*.ts",
          "vite.config.ts",
          "vitest.config.ts",
        ],
      },
    },
    { kind: "copyFile", from: "env.d.ts", to: `${packagePath}/env.d.ts` },
    { kind: "copyFile", from: "index.html", to: `${packagePath}/index.html` },
    {
      kind: "copyFile",
      from: "playwright.config.ts",
      to: `${packagePath}/playwright.config.ts`,
    },
    {
      kind: "copyFile",
      from: "vite.config.ts",
      to: `${packagePath}/vite.config.ts`,
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: `${packagePath}/vitest.config.ts`,
    },
    {
      kind: "copyFile",
      from: "run-vue-tsc.ts",
      to: `${packagePath}/scripts/run-vue-tsc.ts`,
      sourceRoot: "sharedTypescript",
    },
    { kind: "copyFile", from: "src/App.vue", to: `${packagePath}/src/App.vue` },
    { kind: "copyFile", from: "src/main.ts", to: `${packagePath}/src/main.ts` },
    {
      kind: "copyFile",
      from: "src/style.css",
      to: `${packagePath}/src/style.css`,
    },
    {
      kind: "copyFile",
      from: "src/stores/counter.ts",
      to: `${packagePath}/src/stores/counter.ts`,
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: `${packagePath}/test/app.test.ts`,
    },
    {
      kind: "copyFile",
      from: "test/e2e/app.spec.ts",
      to: `${packagePath}/test/e2e/app.spec.ts`,
    },
  ];
}

async function packageAdditionPlan({
  packageName: packageNameValue,
  packagePath,
  nodeVersion,
}: PresetPackageAdditionOptions): Promise<PresetPackageAdditionPlan> {
  const [workspaceCollection] = packagePath.split("/");

  return {
    packagePath,
    workspacePackageGlob: `${workspaceCollection}/*`,
    packageRole: "runtime-service",
    packageSourcePreset: "vue-app",
    sourceRoot: templateSourceRoot(),
    sourceRoots: {
      sharedOxc: sharedOxcSourceRoot(),
      sharedTypescript: sharedTypeScriptSourceRoot(),
    },
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
    "vue-app",
  );

  return existsSync(path.join(publishedTemplateRoot, "src", "App.vue"))
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

function sharedTypeScriptSourceRoot(): string {
  const projectionDir = path.dirname(fileURLToPath(import.meta.url));
  const publishedSharedRoot = path.join(
    projectionDir,
    "..",
    "..",
    "..",
    "templates",
    "shared",
    "typescript",
  );

  return existsSync(path.join(publishedSharedRoot, "run-vue-tsc.ts"))
    ? publishedSharedRoot
    : path.join(projectionDir, "..", "shared", "typescript");
}

export const vueAppPresetProjection: PresetProjection = {
  metadata: vueAppPresetMetadata,
  capabilities: {
    packageAddition: {
      planPackageAddition: packageAdditionPlan,
    },
  },
  blueprint: vueAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    return interpretPresetProjectionDeclaration({
      preset: vueAppPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("vue-app"),
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
