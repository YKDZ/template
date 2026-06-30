import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodePnpmDevcontainer } from "./devcontainer.js";
import {
  planNodeChecks,
  planNodeFixes,
  renderFixCommand,
  renderRootCheckCommand,
} from "./module-graph.js";
import { projectPresetDependabotConfig, projectPresetGithubCheckWorkflow } from "./project-github.js";
import { renderNewProject, type RenderOperation } from "./renderer.js";
import { packageTemplateRoot } from "./runtime-paths.js";

const features = [
  "pnpm-catalog",
  "oxc-format-lint",
  "strict-typescript",
  "root-check",
  "fix-command",
  "devcontainer",
  "github-actions",
  "dependabot",
] as const;

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset vue-app",
};

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
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

function packageJson(projectName: string): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    type: "module",
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
      node: "22",
    },
    packageManager: "pnpm@10.0.0",
  };
}

function operationsForVueApp(projectName: string): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(projectName),
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
      text: ["node_modules", "dist", "playwright-report", "test-results", ".env", ""].join("\n"),
    },
    {
      kind: "copyFile",
      from: "env.d.ts",
      to: "env.d.ts",
    },
    {
      kind: "copyFile",
      from: "index.html",
      to: "index.html",
    },
    {
      kind: "copyFile",
      from: "playwright.config.ts",
      to: "playwright.config.ts",
    },
    {
      kind: "copyFile",
      from: "vite.config.ts",
      to: "vite.config.ts",
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: "vitest.config.ts",
    },
    {
      kind: "copyFile",
      from: "src/App.vue",
      to: "src/App.vue",
    },
    {
      kind: "copyFile",
      from: "src/main.ts",
      to: "src/main.ts",
    },
    {
      kind: "copyFile",
      from: "src/style.css",
      to: "src/style.css",
    },
    {
      kind: "copyFile",
      from: "src/stores/counter.ts",
      to: "src/stores/counter.ts",
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: "test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "test/e2e/app.spec.ts",
      to: "test/e2e/app.spec.ts",
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: {
        schemaVersion: 1,
        preset: "vue-app",
        packageManager: "pnpm",
        projectKind: "single-package",
        features,
      },
    },
    {
      kind: "writeJson",
      to: ".project-kit/generated-by.json",
      value: generatedBy,
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: nodePnpmDevcontainer({
        name: `${projectName} Vue development`,
        nodeVersion: "22",
        packageManagerPin: "pnpm@10.0.0",
        extensions: ["Vue.volar", "oxc.oxc-vscode"],
      }),
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectPresetGithubCheckWorkflow("vue-app"),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectPresetDependabotConfig("vue-app"),
    },
  ];
}

function templateSourceRoot(): string {
  return packageTemplateRoot(path.dirname(fileURLToPath(import.meta.url)), "vue-app");
}

function sharedOxcSourceRoot(): string {
  return packageTemplateRoot(path.dirname(fileURLToPath(import.meta.url)), "shared", "oxc");
}

export async function initVueAppProject(targetDir: string): Promise<void> {
  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForVueApp(projectNameFromDir(targetDir)),
  });
}
