import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import { nodePnpmDevcontainer } from "../../src/devcontainer.js";
import type { GenerationContext } from "../../src/generation-context.js";
import {
  planNodeChecks,
  planNodeFixes,
  renderFixCommand,
  renderRootCheckCommand,
} from "../../src/module-graph.js";
import type {
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
  command: "template init --preset vue-app",
};

export const vueAppPresetMetadata: BuiltInPreset = {
  name: "vue-app",
  title: "Vue app",
  description:
    "Single-package Vue app with Vite, Tailwind, Pinia, and test tooling.",
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

export function vueAppBlueprint(): ProjectBlueprint {
  return {
    schemaVersion: 1,
    preset: "vue-app",
    packageManager: "pnpm",
    projectKind: "single-package",
    features: [...vueAppPresetMetadata.features],
  };
}

export function projectVueAppPackageScripts(): Record<string, string> {
  return {
    build: "vite build",
    check: renderRootCheckCommand(planNodeChecks("vue-app")),
    dev: "vite",
    fix: renderFixCommand(planNodeFixes("vue-app")),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    preview: "vite preview",
    test: "vitest run",
    "test:e2e": "pnpm run build && playwright test",
    typecheck: "vue-tsc --build --noEmit",
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
      "@vueuse/core": "catalog:",
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
      tailwindcss: "catalog:",
      typescript: "catalog:",
      vite: "catalog:",
      vitest: "catalog:",
      "vue-tsc": "catalog:",
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

function operationsForVueApp(
  context: GenerationContext,
  packageScripts: Record<string, string>,
): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(context, packageScripts),
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: [
        "packages:",
        "  - .",
        "",
        "allowBuilds:",
        "  esbuild: true",
        "",
        "catalog:",
        '  "@playwright/test": ^1.57.0',
        '  "@tailwindcss/vite": ^4.1.18',
        '  "@types/node": ^24.0.0',
        '  "@types/web-bluetooth": ^0.0.21',
        '  "@vitejs/plugin-vue": ^6.0.2',
        '  "@vue/tsconfig": ^0.8.1',
        '  "@vueuse/core": ^14.1.0',
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  pinia: ^3.0.4",
        "  tailwindcss: ^4.1.18",
        "  typescript: ^5.8.0",
        "  vite: ^7.3.0",
        "  vitest: ^4.1.9",
        "  vue: ^3.5.26",
        "  vue-tsc: ^3.1.8",
        "",
      ].join("\n"),
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
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
      to: "tsconfig.app.json",
      value: {
        extends: "@vue/tsconfig/tsconfig.dom.json",
        compilerOptions: {
          baseUrl: ".",
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          paths: {
            "@/*": ["./src/*"],
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"],
      },
    },
    {
      kind: "writeJson",
      to: "tsconfig.test.json",
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
      to: "tsconfig.node.json",
      value: {
        compilerOptions: {
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
          types: ["node"],
        },
        include: ["playwright.config.ts", "vite.config.ts", "vitest.config.ts"],
      },
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "vue/oxlint.config.ts",
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
        "playwright-report",
        "test-results",
        ".env",
        "",
      ].join("\n"),
    },
    { kind: "copyFile", from: "env.d.ts", to: "env.d.ts" },
    { kind: "copyFile", from: "index.html", to: "index.html" },
    {
      kind: "copyFile",
      from: "playwright.config.ts",
      to: "playwright.config.ts",
    },
    { kind: "copyFile", from: "vite.config.ts", to: "vite.config.ts" },
    { kind: "copyFile", from: "vitest.config.ts", to: "vitest.config.ts" },
    { kind: "copyFile", from: "src/App.vue", to: "src/App.vue" },
    { kind: "copyFile", from: "src/main.ts", to: "src/main.ts" },
    { kind: "copyFile", from: "src/style.css", to: "src/style.css" },
    {
      kind: "copyFile",
      from: "src/stores/counter.ts",
      to: "src/stores/counter.ts",
    },
    { kind: "copyFile", from: "test/app.test.ts", to: "test/app.test.ts" },
    {
      kind: "copyFile",
      from: "test/e2e/app.spec.ts",
      to: "test/e2e/app.spec.ts",
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: vueAppBlueprint(),
    },
    {
      kind: "writeJson",
      to: ".project-kit/generated-by.json",
      value: generationRecord(context),
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: nodePnpmDevcontainer({
        name: `${context.projectName.value} Vue development`,
        nodeVersion: context.toolchain.nodeLtsMajor.value,
        packageManagerPin: context.toolchain.packageManagerPin.value,
        extensions: ["Vue.volar", "oxc.oxc-vscode"],
      }),
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectCheckWorkflow({ checkPlan: planNodeChecks("vue-app") }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(dependencyMaintenancePolicy),
    },
  ];
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

export const vueAppPresetProjection: PresetProjection = {
  metadata: vueAppPresetMetadata,
  blueprint: vueAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planNodeChecks("vue-app");
    const fixPlan = planNodeFixes("vue-app");
    const packageScripts = projectVueAppPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
      operations: operationsForVueApp(context, packageScripts),
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
