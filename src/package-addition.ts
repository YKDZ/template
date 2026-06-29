import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderProject, type RenderOperation } from "./renderer.js";
import { validateProjectBlueprint, type ProjectBlueprint } from "./declarations.js";

export type AddPackageOptions = {
  cwd: string;
  preset: string;
  name: string;
};

type RootTsconfig = {
  references?: Array<{ path: string }>;
  [key: string]: unknown;
};

type RootUpdatePlan = {
  blueprint: ProjectBlueprint;
  rootTsconfig: RootTsconfig;
  workspaceText: string;
};

function projectNameFromBlueprint(blueprint: ProjectBlueprint): string {
  const firstPackage = blueprint.packages?.[0];
  const match = firstPackage?.name.match(/^@([^/]+)\//);

  if (!match) {
    throw new Error("Cannot infer workspace package scope from the stored Project Blueprint");
  }

  return match[1];
}

function assertSafePackageLeaf(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("--name must be a lowercase package leaf name using letters, numbers, and hyphens");
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertMissing(targetPath: string): Promise<void> {
  try {
    await stat(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`Package Addition would overwrite an existing path: ${targetPath}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tsLibPackageJson(packageName: string): Record<string, unknown> {
  return {
    name: packageName,
    version: "0.0.0",
    private: true,
    files: ["dist"],
    type: "module",
    exports: {
      ".": {
        default: "./dist/index.js",
        types: "./dist/index.d.ts"
      }
    },
    scripts: {
      build: "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
      check: "pnpm run typecheck && pnpm run lint && pnpm run format:check",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
      typecheck: "tsc -p tsconfig.json --noEmit"
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      typescript: "catalog:"
    },
    engines: {
      node: ">=22.0.0"
    }
  };
}

function tsLibPackageOperations(packagePath: string, packageName: string): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: tsLibPackageJson(packageName),
      multilineArrays: ["files"]
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
          declaration: true,
          declarationMap: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmitOnError: true,
          outDir: "dist",
          paths: {
            "@/*": ["./src/*"]
          },
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node"]
        },
        include: ["src/**/*.ts"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/.oxlintrc.json`,
      value: {
        categories: {
          correctness: "error",
          suspicious: "error"
        },
        plugins: ["typescript", "oxc"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/.oxfmtrc.json`,
      value: {
        printWidth: 100,
        singleQuote: false,
        trailingComma: "none"
      }
    },
    {
      kind: "copyFile",
      from: "src/index.ts",
      to: `${packagePath}/src/index.ts`
    }
  ];
}

function honoApiPackageJson(packageName: string): Record<string, unknown> {
  return {
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
      check:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",
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
      typescript: "catalog:",
      vitest: "catalog:"
    },
    engines: {
      node: ">=22.0.0"
    }
  };
}

function honoApiPackageOperations(packagePath: string, packageName: string): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: `${packagePath}/package.json`,
      value: honoApiPackageJson(packageName)
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.json`,
      value: {
        compilerOptions: {
          composite: true,
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
      to: `${packagePath}/tsconfig.build.json`,
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
      kind: "writeJson",
      to: `${packagePath}/.oxlintrc.json`,
      value: {
        categories: {
          correctness: "error",
          suspicious: "error"
        },
        plugins: ["typescript", "oxc"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/.oxfmtrc.json`,
      value: {
        printWidth: 100,
        singleQuote: false,
        trailingComma: "none"
      }
    },
    { kind: "copyFile", from: "src/app.ts", to: `${packagePath}/src/app.ts` },
    { kind: "copyFile", from: "src/server.ts", to: `${packagePath}/src/server.ts` },
    { kind: "copyFile", from: "test/app.test.ts", to: `${packagePath}/test/app.test.ts` },
    { kind: "copyFile", from: "vitest.config.ts", to: `${packagePath}/vitest.config.ts` }
  ];
}

function vueAppPackageJson(packageName: string): Record<string, unknown> {
  return {
    name: packageName,
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
      typecheck: "vue-tsc --build --noEmit"
    },
    dependencies: {
      "@vueuse/core": "catalog:",
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
      node: ">=22.0.0"
    }
  };
}

function vueAppPackageOperations(packagePath: string, packageName: string): RenderOperation[] {
  return [
    { kind: "writeJson", to: `${packagePath}/package.json`, value: vueAppPackageJson(packageName) },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.json`,
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
      to: `${packagePath}/tsconfig.app.json`,
      value: {
        extends: "@vue/tsconfig/tsconfig.dom.json",
        compilerOptions: {
          baseUrl: ".",
          composite: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmitOnError: true,
          paths: {
            "@/*": ["./src/*"]
          },
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
          types: ["web-bluetooth"]
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/tsconfig.test.json`,
      value: {
        extends: "./tsconfig.app.json",
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          tsBuildInfoFile: "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
          types: ["node", "vitest/globals", "web-bluetooth"]
        },
        include: ["env.d.ts", "src/**/*.ts", "src/**/*.vue", "test/**/*.ts"]
      }
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
          types: ["node"]
        },
        include: ["playwright.config.ts", "vite.config.ts", "vitest.config.ts"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/.oxlintrc.json`,
      value: {
        categories: {
          correctness: "error",
          suspicious: "error"
        },
        plugins: ["typescript", "oxc", "vue"]
      }
    },
    {
      kind: "writeJson",
      to: `${packagePath}/.oxfmtrc.json`,
      value: {
        printWidth: 100,
        singleQuote: false,
        trailingComma: "none"
      }
    },
    { kind: "copyFile", from: "env.d.ts", to: `${packagePath}/env.d.ts` },
    { kind: "copyFile", from: "index.html", to: `${packagePath}/index.html` },
    { kind: "copyFile", from: "playwright.config.ts", to: `${packagePath}/playwright.config.ts` },
    { kind: "copyFile", from: "vite.config.ts", to: `${packagePath}/vite.config.ts` },
    { kind: "copyFile", from: "vitest.config.ts", to: `${packagePath}/vitest.config.ts` },
    { kind: "copyFile", from: "src/App.vue", to: `${packagePath}/src/App.vue` },
    { kind: "copyFile", from: "src/main.ts", to: `${packagePath}/src/main.ts` },
    { kind: "copyFile", from: "src/style.css", to: `${packagePath}/src/style.css` },
    { kind: "copyFile", from: "src/stores/counter.ts", to: `${packagePath}/src/stores/counter.ts` },
    { kind: "copyFile", from: "test/app.test.ts", to: `${packagePath}/test/app.test.ts` },
    { kind: "copyFile", from: "test/e2e/app.spec.ts", to: `${packagePath}/test/e2e/app.spec.ts` }
  ];
}

function packagePathForPreset(preset: string, name: string): string {
  if (preset === "ts-lib") {
    return `packages/${name}`;
  }

  if (preset === "hono-api" || preset === "vue-app") {
    return `apps/${name}`;
  }

  throw new Error(
    "Only the ts-lib, hono-api, and vue-app package presets are supported for Package Addition in this version"
  );
}

function packageOperationsForPreset(
  preset: string,
  packagePath: string,
  packageName: string
): RenderOperation[] {
  if (preset === "ts-lib") {
    return tsLibPackageOperations(packagePath, packageName);
  }

  if (preset === "hono-api") {
    return honoApiPackageOperations(packagePath, packageName);
  }

  if (preset === "vue-app") {
    return vueAppPackageOperations(packagePath, packageName);
  }

  throw new Error(
    "Only the ts-lib, hono-api, and vue-app package presets are supported for Package Addition in this version"
  );
}

function rootTsReferencesForPreset(preset: string, packagePath: string): string[] {
  if (preset === "vue-app") {
    return [
      `./${packagePath}/tsconfig.app.json`,
      `./${packagePath}/tsconfig.test.json`,
      `./${packagePath}/tsconfig.node.json`
    ];
  }

  return [`./${packagePath}/tsconfig.json`];
}

function templateSourceRoot(preset: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", preset);
}

function localPortsFromText(text: string): number[] {
  return [
    ...text.matchAll(/port:\s*(\d+)/g),
    ...text.matchAll(/--port\s+(\d+)/g),
    ...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)
  ].map((match) => Number(match[1]));
}

async function usedPlaywrightPorts(root: string, blueprint: ProjectBlueprint): Promise<Set<number>> {
  const ports = new Set<number>();

  for (const projectPackage of blueprint.packages ?? []) {
    try {
      const configText = await readFile(
        path.join(root, projectPackage.path, "playwright.config.ts"),
        "utf8"
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

async function nextVuePreviewPort(root: string, blueprint: ProjectBlueprint): Promise<number> {
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

async function readGeneratedWorkspaceBlueprint(root: string): Promise<ProjectBlueprint> {
  const blueprintPath = path.join(root, ".project-kit/blueprint.json");
  const result = validateProjectBlueprint(await readJson<unknown>(blueprintPath));

  if (!result.ok) {
    throw new Error("Package Addition requires a valid .project-kit/blueprint.json");
  }

  const blueprint = result.value;

  if (blueprint.projectKind !== "multi-package") {
    throw new Error("Package Addition only supports existing workspace Generated Repositories");
  }

  if (blueprint.packageManager !== "pnpm") {
    throw new Error("Package Addition only supports pnpm workspace Generated Repositories");
  }

  if (!blueprint.packages || blueprint.packages.length === 0) {
    throw new Error("Package Addition requires package definitions in the stored Project Blueprint");
  }

  await stat(path.join(root, "turbo.json"));
  await stat(path.join(root, "pnpm-workspace.yaml"));

  return blueprint;
}

function workspaceTextWithPackageGlob(text: string, glob: string): string {
  if (text.includes(`  - ${glob}`)) {
    return text;
  }

  const nextText = text.replace(/^packages:\n/m, `packages:\n  - ${glob}\n`);
  if (nextText === text) {
    throw new Error("Cannot update pnpm workspace membership: missing packages section");
  }

  return nextText;
}

function assertRootTsconfig(input: unknown): asserts input is RootTsconfig {
  if (!isRecord(input)) {
    throw new Error("Cannot update root TypeScript project references: tsconfig.json must be an object");
  }

  const references = input.references;
  if (references === undefined) {
    return;
  }

  if (!Array.isArray(references)) {
    throw new Error("Cannot update root TypeScript project references: references must be an array");
  }

  for (const reference of references) {
    if (!isRecord(reference) || typeof reference.path !== "string") {
      throw new Error(
        "Cannot update root TypeScript project references: each reference must have a string path"
      );
    }
  }
}

function rootTsconfigWithReferences(input: unknown, referencePaths: string[]): RootTsconfig {
  assertRootTsconfig(input);
  const tsconfig = input;
  const references = tsconfig.references ?? [];

  for (const referencePath of referencePaths) {
    if (!references.some((reference) => reference.path === referencePath)) {
      references.push({ path: referencePath });
    }
  }

  return { ...tsconfig, references };
}

function blueprintWithPackage(
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string
): ProjectBlueprint {
  const nextBlueprint = {
    ...blueprint,
    packages: [...(blueprint.packages ?? []), { name: packageName, path: packagePath }]
  };
  const result = validateProjectBlueprint(nextBlueprint);

  if (!result.ok) {
    throw new Error("Package Addition would write an invalid .project-kit/blueprint.json");
  }

  return result.value;
}

async function planRootUpdates(
  root: string,
  blueprint: ProjectBlueprint,
  packageName: string,
  packagePath: string,
  preset: string
): Promise<RootUpdatePlan> {
  const workspaceText = workspaceTextWithPackageGlob(
    await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"),
    packagePath.startsWith("apps/") ? "apps/*" : "packages/*"
  );
  const rootTsconfig = rootTsconfigWithReferences(
    await readJson<unknown>(path.join(root, "tsconfig.json")),
    rootTsReferencesForPreset(preset, packagePath)
  );

  return {
    blueprint: blueprintWithPackage(blueprint, packageName, packagePath),
    rootTsconfig,
    workspaceText
  };
}

export async function addPackage(options: AddPackageOptions): Promise<void> {
  assertSafePackageLeaf(options.name);

  const root = path.resolve(options.cwd);
  const blueprint = await readGeneratedWorkspaceBlueprint(root);
  const projectName = projectNameFromBlueprint(blueprint);
  const packagePath = packagePathForPreset(options.preset, options.name);
  const packageName = `@${projectName}/${options.name}`;
  const vuePreviewPort =
    options.preset === "vue-app" ? await nextVuePreviewPort(root, blueprint) : undefined;

  if (blueprint.packages?.some((pkg) => pkg.name === packageName || pkg.path === packagePath)) {
    throw new Error(`Package Addition conflicts with an existing package definition: ${packageName}`);
  }

  await assertMissing(path.join(root, packagePath));
  const rootUpdatePlan = await planRootUpdates(
    root,
    blueprint,
    packageName,
    packagePath,
    options.preset
  );

  await mkdir(path.join(root, packagePath), { recursive: true });
  await renderProject({
    sourceRoot: templateSourceRoot(options.preset),
    targetRoot: root,
    operations: packageOperationsForPreset(options.preset, packagePath, packageName)
  });

  if (vuePreviewPort !== undefined) {
    await writeFile(
      path.join(root, packagePath, "playwright.config.ts"),
      vueAppPlaywrightConfig(vuePreviewPort),
      "utf8"
    );
  }

  await writeFile(path.join(root, "pnpm-workspace.yaml"), rootUpdatePlan.workspaceText, "utf8");
  await writeJson(path.join(root, "tsconfig.json"), rootUpdatePlan.rootTsconfig);
  await writeJson(path.join(root, ".project-kit/blueprint.json"), rootUpdatePlan.blueprint);
}
