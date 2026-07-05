import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

const webPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
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

function planVueAppPackageFixes(): FixPlan {
  return {
    components: [
      { kind: "oxc-format-write", owner: webPackageBoundary },
      { kind: "oxc-lint-fix", owner: webPackageBoundary },
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
    build: "vite build",
    check: renderRootCheckCommand(planVueAppPackageChecks()),
    dev: "vite",
    fix: renderFixCommand(planVueAppPackageFixes()),
    "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --config ../../oxlint.config.ts .",
    "lint:fix": "oxlint --config ../../oxlint.config.ts . --fix",
    preview: "vite preview",
    test: "vitest run",
    "test:e2e":
      "pnpm run build && node --experimental-strip-types scripts/run-playwright.ts",
    typecheck: "vue-tsc --build --noEmit",
  };
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
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noUncheckedIndexedAccess: true,
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
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noUncheckedIndexedAccess: true,
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
  packageName: packageNameValue,
  packagePath,
  nodeVersion,
}: PresetPackageAdditionOptions): Promise<PresetPackageAdditionPlan> {
  const [workspaceCollection] = packagePath.split("/");
  const previewPort = await nextVuePreviewPort(root, blueprint);

  return {
    packagePath,
    workspacePackageGlob: `${workspaceCollection}/*`,
    packageRole: "runtime-service",
    packageSourcePreset: "vue-app",
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    operations: packageAdditionOperations(
      packagePath,
      packageNameValue,
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
