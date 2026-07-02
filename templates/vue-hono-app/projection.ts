import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuiltInPreset,
  ProjectBlueprint,
} from "../../src/declarations.js";
import {
  collectGeneratedManifestCatalogReferences,
  renderGeneratedPnpmWorkspaceYaml,
} from "../../src/dependency-catalog.js";
import {
  browserTestToolLayer,
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
import type {
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "../../src/preset-projection.js";
import type { DependencyMaintenancePolicy } from "../../src/project-github.js";
import { renderNewProject, type RenderOperation } from "../../src/renderer.js";

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
  packageAdditionSupport: PackageAdditionSupport.Unsupported,
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

const rootBoundary: ComponentOwner = {
  kind: "workspace-orchestration",
  path: ".",
};

const apiPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const webPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

const workspacePackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/*",
};

const webWorkspaceBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/web",
};

function honoApiCheckComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
  ] as const;
}

function vueWebCheckComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-check", owner },
    { kind: "oxc-lint", owner },
    { kind: "typescript-typecheck", owner },
    { kind: "build", owner },
    { kind: "unit-test", owner },
    { kind: "e2e-test", owner },
  ] as const;
}

function nodeFixComponents(owner: ComponentOwner) {
  return [
    { kind: "oxc-format-write", owner },
    { kind: "oxc-lint-fix", owner },
  ] as const;
}

function planVueHonoRootChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: rootBoundary },
      { kind: "oxc-lint", owner: rootBoundary },
      { kind: "typescript-typecheck", owner: rootBoundary },
      { kind: "turbo-package-check", owner: workspacePackageBoundary },
    ],
    environmentNeeds: [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: webWorkspaceBoundary,
      },
    ],
  };
}

function planVueHonoRootFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: rootBoundary },
      { kind: "oxc-lint-fix", owner: rootBoundary },
      { kind: "turbo-package-fix", owner: workspacePackageBoundary },
    ],
  };
}

function planVueHonoApiChecks(): CheckPlan {
  return {
    components: [...honoApiCheckComponents(apiPackageBoundary)],
    environmentNeeds: [],
  };
}

function planVueHonoWebChecks(): CheckPlan {
  return {
    components: [...vueWebCheckComponents(webPackageBoundary)],
    environmentNeeds: [],
  };
}

function planVueHonoPackageFixes(owner: ComponentOwner): FixPlan {
  return {
    components: [...nodeFixComponents(owner)],
  };
}

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
    check: renderRootCheckCommand(planVueHonoRootChecks()),
    dev: "turbo run dev --parallel",
    fix: renderFixCommand(planVueHonoRootFixes()),
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

export function projectVueHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planVueHonoApiChecks()),
    dev: "tsx watch src/server.ts",
    fix: renderFixCommand(planVueHonoPackageFixes(apiPackageBoundary)),
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

export function projectVueHonoWebPackageScripts(): Record<string, string> {
  return {
    build: "vite build",
    check: renderRootCheckCommand(planVueHonoWebChecks()),
    dev: "vite",
    fix: renderFixCommand(planVueHonoPackageFixes(webPackageBoundary)),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
    "lint:fix":
      "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
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
    imports: {
      "#/*": {
        default: "./dist/*.js",
        types: "./src/*.ts",
      },
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
    imports: {
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    },
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
  const editorCustomization = editorCustomizationForCapabilities([
    "oxc-format-lint",
    "vue",
    "tailwind",
    "vitest",
  ]);
  const developmentContainer = checkedDockerfileFirstNodePnpmDevcontainer({
    name: context.projectName.value,
    layer: nodePnpmToolLayer({
      nodeVersion: context.toolchain.nodeLtsMajor.value,
      packageManagerPin: context.toolchain.packageManagerPin.value,
    }),
    additionalLayers: [browserTestToolLayer()],
    extensions: editorCustomization.extensions,
    settings: editorCustomization.settings,
  });
  const rootManifest = rootPackageJson(context, packageScripts);
  const apiManifest = apiPackageJson(context, packageScope);
  const webManifest = webPackageJson(context, packageScope);

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
        dependencies: collectGeneratedManifestCatalogReferences([
          rootManifest,
          apiManifest,
          webManifest,
        ]),
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
      kind: "copyFile",
      from: ".github/workflows/check.yml",
      to: ".github/workflows/check.yml",
    },
    {
      kind: "copyFile",
      from: ".github/dependabot.yml",
      to: ".github/dependabot.yml",
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
          declaration: true,
          declarationMap: true,
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
      value: webManifest,
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

export const vueHonoAppPresetProjection: PresetProjection = {
  metadata: vueHonoAppPresetMetadata,
  blueprint: vueHonoAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planVueHonoRootChecks();
    const fixPlan = planVueHonoRootFixes();
    const packageScripts = projectVueHonoRootPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: {
        sharedDevcontainer: sharedDevcontainerSourceRoot(),
        sharedOxc: sharedOxcSourceRoot(),
      },
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
