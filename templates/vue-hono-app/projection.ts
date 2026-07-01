import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import { renderGeneratedPnpmWorkspaceYaml } from "../../src/dependency-catalog.js";
import {
  browserTestToolLayer,
  dockerfileFirstNodePnpmDevcontainer,
  nodePnpmToolLayer,
} from "../../src/devcontainer.js";
import { editorCustomizationForCapabilities } from "../../src/editor-customization.js";
import type { GenerationContext } from "../../src/generation-context.js";
import {
  type CheckPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "../../src/module-graph.js";
import type {
  PresetBlueprintOptions,
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
  command: "template init --preset vue-hono-app",
};

export const vueHonoAppPresetMetadata: BuiltInPreset = {
  name: "vue-hono-app",
  title: "Vue Hono app",
  description: "Full-stack Vue and Hono workspace with Hono RPC typing.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
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

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageScopeFromOptions(options: PresetBlueprintOptions): string {
  return options.scope ?? projectNameFromDir(options.targetDir);
}

function packageName(packageScope: string, leaf: "api" | "web"): string {
  return `@${packageScope}/${leaf}`;
}

export function vueHonoAppBlueprint(
  options: PresetBlueprintOptions,
): ProjectBlueprint {
  const packageScope = packageScopeFromOptions(options);

  return {
    schemaVersion: 1,
    preset: "vue-hono-app",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...vueHonoAppPresetMetadata.features],
    packages: [
      { name: packageName(packageScope, "web"), path: "apps/web" },
      { name: packageName(packageScope, "api"), path: "apps/api" },
    ],
  };
}

export function projectVueHonoRootPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planNodeChecks("vue-hono-root")),
    dev: "turbo run dev --parallel",
    fix: renderFixCommand(planNodeFixes("vue-hono-root")),
  };
}

export function projectVueHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planNodeChecks("vue-hono-api")),
    dev: "tsx watch src/server.ts",
    fix: renderFixCommand(planNodeFixes("vue-hono-api")),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    start: "node dist/server.js",
    test: "vitest run",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

export function projectVueHonoWebPackageScripts(): Record<string, string> {
  return {
    build: "vite build",
    check: renderRootCheckCommand(planNodeChecks("vue-hono-web")),
    dev: "vite",
    fix: renderFixCommand(planNodeFixes("vue-hono-web")),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    preview: "vite preview",
    test: "vitest run",
    "test:e2e": "pnpm run build && playwright test",
    typecheck: "vue-tsc --build",
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
      turbo: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
  };
}

function apiPackageJson(
  context: GenerationContext,
  packageScope: string,
): Record<string, unknown> {
  return {
    name: packageName(packageScope, "api"),
    version: "0.0.0",
    private: true,
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
    },
    scripts: projectVueHonoApiPackageScripts(),
    dependencies: {
      "@hono/node-server": "catalog:",
      hono: "catalog:",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      tsx: "catalog:",
      typescript: "catalog:",
      vitest: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
  };
}

function webPackageJson(
  context: GenerationContext,
  packageScope: string,
): Record<string, unknown> {
  return {
    name: packageName(packageScope, "web"),
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: projectVueHonoWebPackageScripts(),
    dependencies: {
      [packageName(packageScope, "api")]: "workspace:*",
      "@vueuse/core": "catalog:",
      hono: "catalog:",
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

function packageScopeFromBlueprint(context: GenerationContext): string {
  const apiPackage = context.blueprint.packages?.find(
    (pkg) => pkg.path === "apps/api",
  );

  if (apiPackage?.name.startsWith("@") && apiPackage.name.endsWith("/api")) {
    return apiPackage.name.slice(1, -"/api".length);
  }

  return context.projectName.value;
}

function operationsForVueHonoApp(
  context: GenerationContext,
  packageScripts: Record<string, string>,
  checkPlan: CheckPlan,
): RenderOperation[] {
  const packageScope = packageScopeFromBlueprint(context);
  const apiName = packageName(packageScope, "api");
  const webName = packageName(packageScope, "web");
  const editorCustomization = editorCustomizationForCapabilities(
    ["oxc-format-lint", "vue", "tailwind", "vitest"],
    {
      oxcConfigPaths: "nested",
    },
  );
  const developmentContainer = dockerfileFirstNodePnpmDevcontainer({
    name: context.projectName.value,
    layer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    additionalLayers: [browserTestToolLayer()],
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });

  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootPackageJson(context, packageScripts),
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: renderGeneratedPnpmWorkspaceYaml({
        packages: ["apps/*"],
        dependencies: [
          "@hono/node-server",
          "@playwright/test",
          "@tailwindcss/vite",
          "@types/node",
          "@types/web-bluetooth",
          "@vitejs/plugin-vue",
          "@vue/tsconfig",
          "@vueuse/core",
          "hono",
          "oxfmt",
          "oxlint",
          "pinia",
          "tailwindcss",
          "tsc-alias",
          "tsx",
          "turbo",
          "typescript",
          "vite",
          "vitest",
          "vue",
          "vue-tsc",
        ],
        allowBuilds: {
          esbuild: true,
        },
      }),
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          build: {
            dependsOn: ["^build"],
            outputs: ["dist/**"],
          },
          check: {
            dependsOn: ["^build"],
          },
          dev: {
            cache: false,
            persistent: true,
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
        references: [
          { path: "./apps/api/tsconfig.json" },
          { path: "./apps/web/tsconfig.app.json" },
          { path: "./apps/web/tsconfig.test.json" },
          { path: "./apps/web/tsconfig.node.json" },
        ],
      },
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
      kind: "writeText",
      to: ".devcontainer/Dockerfile",
      text: developmentContainer.dockerfile,
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
      to: ".gitignore",
      text: [
        "node_modules",
        "dist",
        "playwright-report",
        "test-results",
        ".env",
        ".template/",
        ".pnpm-store/",
        "",
      ].join("\n"),
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
    {
      kind: "writeJson",
      to: "apps/api/package.json",
      value: apiPackageJson(context, packageScope),
    },
    {
      kind: "writeJson",
      to: "apps/api/tsconfig.json",
      value: {
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
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
      to: "apps/api/oxlint.config.ts",
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "apps/api/oxfmt.config.ts",
    },
    { kind: "copyFile", from: "api/src/index.ts", to: "apps/api/src/index.ts" },
    {
      kind: "copyFile",
      from: "api/src/runtime.ts",
      to: "apps/api/src/runtime.ts",
    },
    {
      kind: "copyFile",
      from: "api/src/server.ts",
      to: "apps/api/src/server.ts",
    },
    {
      kind: "copyFile",
      from: "api/test/app.test.ts",
      to: "apps/api/test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "api/vitest.config.ts",
      to: "apps/api/vitest.config.ts",
    },
    {
      kind: "writeJson",
      to: "apps/web/package.json",
      value: webPackageJson(context, packageScope),
    },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.json",
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
      to: "apps/web/tsconfig.app.json",
      value: {
        extends: "@vue/tsconfig/tsconfig.dom.json",
        compilerOptions: {
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          paths: {
            "@/*": ["./src/*"],
            [apiName]: ["../api/src/index.ts"],
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"],
        references: [{ path: "../api/tsconfig.build.json" }],
      },
    },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.test.json",
      value: {
        extends: "./tsconfig.app.json",
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
          types: ["node", "vitest/globals", "web-bluetooth"],
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue", "test/**/*.ts"],
        references: [{ path: "../api/tsconfig.build.json" }],
      },
    },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.node.json",
      value: {
        compilerOptions: {
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          outDir: "./node_modules/.tmp/tsconfig.node",
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
      to: "apps/web/oxlint.config.ts",
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "apps/web/oxfmt.config.ts",
    },
    { kind: "copyFile", from: "web/env.d.ts", to: "apps/web/env.d.ts" },
    { kind: "copyFile", from: "web/index.html", to: "apps/web/index.html" },
    {
      kind: "copyFile",
      from: "web/playwright.config.ts",
      to: "apps/web/playwright.config.ts",
    },
    {
      kind: "copyFile",
      from: "web/vite.config.ts",
      to: "apps/web/vite.config.ts",
    },
    {
      kind: "copyFile",
      from: "web/vitest.config.ts",
      to: "apps/web/vitest.config.ts",
    },
    { kind: "copyFile", from: "web/src/api.ts", to: "apps/web/src/api.ts" },
    {
      kind: "replaceAnchors",
      path: "apps/web/src/api.ts",
      language: "typescript",
      replacements: {
        "api-type-import-start": `import type { AppType } from "${apiName}";\nimport { hc } from "hono/client";\n/*`,
        "api-type-import-end": "*/",
      },
    },
    { kind: "copyFile", from: "web/src/App.vue", to: "apps/web/src/App.vue" },
    { kind: "copyFile", from: "web/src/main.ts", to: "apps/web/src/main.ts" },
    {
      kind: "copyFile",
      from: "web/src/style.css",
      to: "apps/web/src/style.css",
    },
    {
      kind: "copyFile",
      from: "web/src/stores/counter.ts",
      to: "apps/web/src/stores/counter.ts",
    },
    {
      kind: "copyFile",
      from: "web/test/app.test.ts",
      to: "apps/web/test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "web/test/e2e/app.spec.ts",
      to: "apps/web/test/e2e/app.spec.ts",
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
    "vue-hono-app",
  );

  return existsSync(path.join(publishedTemplateRoot, "web", "src", "App.vue"))
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

export const vueHonoAppPresetProjection: PresetProjection = {
  metadata: vueHonoAppPresetMetadata,
  blueprint: vueHonoAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planNodeChecks("vue-hono-root");
    const fixPlan = planNodeFixes("vue-hono-root");
    const packageScripts = projectVueHonoRootPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
      operations: operationsForVueHonoApp(context, packageScripts, checkPlan),
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
