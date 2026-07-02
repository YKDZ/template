import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  command: "template init --preset vue-app",
};

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

const dependencyMaintenancePolicy: DependencyMaintenancePolicy = {
  ecosystems: ["npm", "github-actions", "docker"],
  interval: "weekly",
};

const webPackageBoundary: ComponentOwner = {
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

const webWorkspaceBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: "apps/web",
};

function planVueAppPackageChecks(): CheckPlan {
  return {
    components: [
      { kind: "oxc-format-check", owner: webPackageBoundary },
      { kind: "oxc-lint", owner: webPackageBoundary },
      { kind: "typescript-typecheck", owner: webPackageBoundary },
      { kind: "build", owner: webPackageBoundary },
      { kind: "unit-test", owner: webPackageBoundary },
      { kind: "e2e-test", owner: webPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

function planVueAppRootChecks(): CheckPlan {
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

function planVueAppPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: webPackageBoundary },
      { kind: "oxc-lint-fix", owner: webPackageBoundary },
    ],
  };
}

function planVueAppRootFixes(): FixPlan {
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
    packages: [{ name: packageName(packageScope), path: "apps/web" }],
  };
}

function projectVueAppRootPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planVueAppRootChecks()),
    fix: renderFixCommand(planVueAppRootFixes()),
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

export function projectVueAppPackageScripts(): Record<string, string> {
  return {
    build: "vite build",
    check: renderRootCheckCommand(planVueAppPackageChecks()),
    dev: "vite",
    fix: renderFixCommand(planVueAppPackageFixes()),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
    "lint:fix":
      "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
    preview: "vite preview",
    test: "vitest run",
    "test:e2e": "pnpm run build && playwright test",
    typecheck: "vue-tsc --build --noEmit",
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

function webPackageName(context: GenerationContext): string {
  const webPackage = context.blueprint.packages?.find(
    (pkg) => pkg.path === "apps/web",
  );

  return webPackage?.name ?? packageName(context.projectName.value);
}

function webPackageJson(context: GenerationContext): Record<string, unknown> {
  return {
    name: webPackageName(context),
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
  checkPlan: CheckPlan,
): RenderOperation[] {
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
  const webManifest = webPackageJson(context);

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
      to: "apps/web/tsconfig.test.json",
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
      to: "apps/web/tsconfig.node.json",
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
        ".template/",
        ".pnpm-store/",
        "",
      ].join("\n"),
    },
    { kind: "copyFile", from: "env.d.ts", to: "apps/web/env.d.ts" },
    { kind: "copyFile", from: "index.html", to: "apps/web/index.html" },
    {
      kind: "copyFile",
      from: "playwright.config.ts",
      to: "apps/web/playwright.config.ts",
    },
    { kind: "copyFile", from: "vite.config.ts", to: "apps/web/vite.config.ts" },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: "apps/web/vitest.config.ts",
    },
    { kind: "copyFile", from: "src/App.vue", to: "apps/web/src/App.vue" },
    { kind: "copyFile", from: "src/main.ts", to: "apps/web/src/main.ts" },
    { kind: "copyFile", from: "src/style.css", to: "apps/web/src/style.css" },
    {
      kind: "copyFile",
      from: "src/stores/counter.ts",
      to: "apps/web/src/stores/counter.ts",
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: "apps/web/test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "test/e2e/app.spec.ts",
      to: "apps/web/test/e2e/app.spec.ts",
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function localPortsFromText(text: string): number[] {
  return [
    ...text.matchAll(/port:\s*(\d+)/g),
    ...text.matchAll(/--port\s+(\d+)/g),
    ...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g),
  ].map((match) => Number(match[1]));
}

async function usedPlaywrightPorts(
  root: string,
  blueprint: ProjectBlueprint,
): Promise<Set<number>> {
  const ports = new Set<number>();

  for (const projectPackage of blueprint.packages ?? []) {
    try {
      const configText = await readFile(
        path.join(root, projectPackage.path, "playwright.config.ts"),
        "utf8",
      );

      for (const port of localPortsFromText(configText)) {
        ports.add(port);
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return ports;
}

async function nextVuePreviewPort(
  root: string,
  blueprint: ProjectBlueprint,
): Promise<number> {
  const usedPorts = await usedPlaywrightPorts(root, blueprint);
  let port = 4173;

  while (usedPorts.has(port)) {
    port += 1;
  }

  return port;
}

function vueAppPlaywrightConfig(previewPort: number): string {
  return `import { defineConfig, devices } from "@playwright/test";

const previewUrl = "http://127.0.0.1:${previewPort}";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm run preview --host 127.0.0.1 --port ${previewPort}",
    reuseExistingServer: !process.env.CI,
    url: previewUrl
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
`;
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
        imports: {
          "#/*": {
            default: "./src/*.ts",
            types: "./src/*.ts",
          },
        },
        scripts: projectVueAppPackageScripts(),
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
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
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
  root,
  blueprint,
  packageName,
  packagePath,
  nodeVersion,
}: PresetPackageAdditionOptions): Promise<PresetPackageAdditionPlan> {
  const [workspaceCollection] = packagePath.split("/");
  const previewPort = await nextVuePreviewPort(root, blueprint);

  return {
    packagePath,
    workspacePackageGlob: `${workspaceCollection}/*`,
    rootTsconfigReferences: [
      `./${packagePath}/tsconfig.app.json`,
      `./${packagePath}/tsconfig.test.json`,
      `./${packagePath}/tsconfig.node.json`,
    ],
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    operations: packageAdditionOperations(
      packagePath,
      packageName,
      nodeVersion,
    ),
    textFiles: [
      {
        path: `${packagePath}/playwright.config.ts`,
        text: vueAppPlaywrightConfig(previewPort),
      },
    ],
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

export const vueAppPresetProjection: PresetProjection = {
  metadata: vueAppPresetMetadata,
  capabilities: {
    packageAddition: {
      planPackageAddition: packageAdditionPlan,
    },
  },
  blueprint: vueAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    const checkPlan = planVueAppRootChecks();
    const fixPlan = planVueAppRootFixes();
    const packageScripts = projectVueAppRootPackageScripts();

    return {
      sourceRoot: templateSourceRoot(),
      sourceRoots: {
        sharedDevcontainer: sharedDevcontainerSourceRoot(),
        sharedOxc: sharedOxcSourceRoot(),
      },
      operations: operationsForVueApp(context, packageScripts, checkPlan),
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
