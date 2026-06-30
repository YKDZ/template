import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderNewProject, type RenderOperation } from "./renderer.js";

const features = [
  "pnpm-catalog",
  "oxc-format-lint",
  "strict-typescript",
  "root-check",
  "fix-command",
  "devcontainer",
  "github-actions",
  "dependabot"
] as const;

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset vue-hono-app"
};

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageName(packageScope: string, leaf: "api" | "web"): string {
  return `@${packageScope}/${leaf}`;
}

function workspacePackageFilter(packageScope: string, leaf: "api" | "web"): string {
  return `--filter ${packageName(packageScope, leaf)}`;
}

function rootPackageJson(projectName: string): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      check: "turbo run check",
      dev: "turbo run dev --parallel",
      fix: "turbo run fix"
    },
    devDependencies: {
      turbo: "catalog:"
    },
    engines: {
      node: "22"
    },
    packageManager: "pnpm@10.0.0"
  };
}

function apiPackageJson(packageScope: string): Record<string, unknown> {
  return {
    name: packageName(packageScope, "api"),
    version: "0.0.0",
    private: true,
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js"
    },
    scripts: {
      build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
      check:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",
      dev: "tsx watch src/server.ts",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
      start: "node dist/server.js",
      test: "vitest run",
      typecheck: "tsc -p tsconfig.json --noEmit"
    },
    dependencies: {
      "@hono/node-server": "catalog:",
      hono: "catalog:"
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      tsx: "catalog:",
      typescript: "catalog:",
      vitest: "catalog:"
    },
    engines: {
      node: "22"
    }
  };
}

function webPackageJson(packageScope: string): Record<string, unknown> {
  return {
    name: packageName(packageScope, "web"),
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      build: "vite build",
      check:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:e2e",
      dev: "vite",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
      preview: "vite preview",
      test: "vitest run",
      "test:e2e": "pnpm run build && playwright test",
      typecheck: "vue-tsc --build"
    },
    dependencies: {
      [packageName(packageScope, "api")]: "workspace:*",
      "@vueuse/core": "catalog:",
      hono: "catalog:",
      pinia: "catalog:",
      vue: "catalog:"
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
      "vue-tsc": "catalog:"
    },
    engines: {
      node: "22"
    }
  };
}

function operationsForVueHonoApp(projectName: string, packageScope: string): RenderOperation[] {
  const apiName = packageName(packageScope, "api");
  const webName = packageName(packageScope, "web");
  const webFilter = workspacePackageFilter(packageScope, "web");

  return [
    { kind: "writeJson", to: "package.json", value: rootPackageJson(projectName) },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: [
        "packages:",
        "  - apps/*",
        "",
        "allowBuilds:",
        "  esbuild: true",
        "",
        "catalog:",
        '  "@hono/node-server": ^2.0.6',
        '  "@playwright/test": ^1.57.0',
        '  "@tailwindcss/vite": ^4.1.18',
        '  "@types/node": ^24.0.0',
        '  "@types/web-bluetooth": ^0.0.21',
        '  "@vitejs/plugin-vue": ^6.0.2',
        '  "@vue/tsconfig": ^0.8.1',
        '  "@vueuse/core": ^14.1.0',
        "  hono: ^4.12.27",
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  pinia: ^3.0.4",
        "  tailwindcss: ^4.1.18",
        "  tsc-alias: ^1.8.17",
        "  tsx: ^4.20.0",
        "  turbo: ^2.7.0",
        "  typescript: ^5.8.0",
        "  vite: ^7.3.0",
        "  vitest: ^4.1.9",
        "  vue: ^3.5.26",
        "  vue-tsc: ^3.1.8",
        ""
      ].join("\n")
    },
    {
      kind: "writeJson",
      to: "turbo.json",
      value: {
        tasks: {
          build: {
            dependsOn: ["^build"],
            outputs: ["dist/**"]
          },
          check: {
            dependsOn: ["^build"]
          },
          dev: {
            cache: false,
            persistent: true
          },
          fix: {
            cache: false
          }
        }
      }
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
          { path: "./apps/web/tsconfig.node.json" }
        ]
      }
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: {
        schemaVersion: 1,
        preset: "vue-hono-app",
        packageManager: "pnpm",
        projectKind: "multi-package",
        features,
        packages: [
          { name: webName, path: "apps/web" },
          { name: apiName, path: "apps/api" }
        ]
      }
    },
    {
      kind: "writeJson",
      to: ".project-kit/generated-by.json",
      value: generatedBy
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: {
        name: `${projectName} full-stack development`,
        image: "mcr.microsoft.com/devcontainers/typescript-node:22",
        postCreateCommand: `corepack enable && pnpm install && pnpm ${webFilter} exec playwright install chromium`,
        customizations: {
          vscode: {
            extensions: ["Vue.volar", "oxc.oxc-vscode"]
          }
        }
      }
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: ["node_modules", "dist", "playwright-report", "test-results", ".env", ""].join("\n")
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
    { kind: "writeJson", to: "apps/api/package.json", value: apiPackageJson(packageScope) },
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
            "@/*": ["./src/*"]
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node", "vitest/globals"]
        },
        include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
      }
    },
    {
      kind: "writeJson",
      to: "apps/api/tsconfig.build.json",
      value: {
        extends: "./tsconfig.json",
        compilerOptions: {
          outDir: "dist",
          rootDir: "src",
          types: ["node"]
        },
        include: ["src/**/*.ts"]
      }
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "node/oxlint.config.ts",
      to: "apps/api/oxlint.config.ts"
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "apps/api/oxfmt.config.ts"
    },
    { kind: "copyFile", from: "api/src/index.ts", to: "apps/api/src/index.ts" },
    { kind: "copyFile", from: "api/src/runtime.ts", to: "apps/api/src/runtime.ts" },
    { kind: "copyFile", from: "api/src/server.ts", to: "apps/api/src/server.ts" },
    { kind: "copyFile", from: "api/test/app.test.ts", to: "apps/api/test/app.test.ts" },
    { kind: "copyFile", from: "api/vitest.config.ts", to: "apps/api/vitest.config.ts" },
    { kind: "writeJson", to: "apps/web/package.json", value: webPackageJson(packageScope) },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.json",
      value: {
        files: [],
        references: [
          { path: "./tsconfig.app.json" },
          { path: "./tsconfig.test.json" },
          { path: "./tsconfig.node.json" }
        ]
      }
    },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.app.json",
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
            [apiName]: ["../api/src/index.ts"]
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"]
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"],
        references: [{ path: "../api/tsconfig.build.json" }]
      }
    },
    {
      kind: "writeJson",
      to: "apps/web/tsconfig.test.json",
      value: {
        extends: "./tsconfig.app.json",
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
          types: ["node", "vitest/globals", "web-bluetooth"]
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue", "test/**/*.ts"],
        references: [{ path: "../api/tsconfig.build.json" }]
      }
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
          types: ["node"]
        },
        include: ["playwright.config.ts", "vite.config.ts", "vitest.config.ts"]
      }
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "vue/oxlint.config.ts",
      to: "apps/web/oxlint.config.ts"
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "apps/web/oxfmt.config.ts"
    },
    { kind: "copyFile", from: "web/env.d.ts", to: "apps/web/env.d.ts" },
    { kind: "copyFile", from: "web/index.html", to: "apps/web/index.html" },
    { kind: "copyFile", from: "web/playwright.config.ts", to: "apps/web/playwright.config.ts" },
    { kind: "copyFile", from: "web/vite.config.ts", to: "apps/web/vite.config.ts" },
    { kind: "copyFile", from: "web/vitest.config.ts", to: "apps/web/vitest.config.ts" },
    { kind: "copyFile", from: "web/src/api.ts", to: "apps/web/src/api.ts" },
    {
      kind: "replaceAnchors",
      path: "apps/web/src/api.ts",
      language: "typescript",
      replacements: {
        "api-type-import-start": `import type { AppType } from "${apiName}";\nimport { hc } from "hono/client";\n/*`,
        "api-type-import-end": "*/"
      }
    },
    { kind: "copyFile", from: "web/src/App.vue", to: "apps/web/src/App.vue" },
    { kind: "copyFile", from: "web/src/main.ts", to: "apps/web/src/main.ts" },
    { kind: "copyFile", from: "web/src/style.css", to: "apps/web/src/style.css" },
    { kind: "copyFile", from: "web/src/stores/counter.ts", to: "apps/web/src/stores/counter.ts" },
    { kind: "copyFile", from: "web/test/app.test.ts", to: "apps/web/test/app.test.ts" },
    { kind: "copyFile", from: "web/test/e2e/app.spec.ts", to: "apps/web/test/e2e/app.spec.ts" }
  ];
}

function templateSourceRoot(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "vue-hono-app"
  );
}

function sharedOxcSourceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "shared", "oxc");
}

export async function initVueHonoAppProject(
  targetDir: string,
  options: { scope?: string } = {}
): Promise<void> {
  const projectName = projectNameFromDir(targetDir);
  const packageScope = options.scope ?? projectName;
  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForVueHonoApp(projectName, packageScope)
  });
}
