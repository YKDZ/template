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
  command: "template init --preset hono-api"
};

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageJson(projectName: string): Record<string, unknown> {
  return {
    name: projectName,
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
    },
    packageManager: "pnpm@10.0.0"
  };
}

function operationsForHonoApi(projectName: string): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(projectName)
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: [
        "packages:",
        "  - .",
        "",
        "catalog:",
        '  "@hono/node-server": ^2.0.6',
        '  "@types/node": ^24.0.0',
        "  hono: ^4.12.27",
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  tsc-alias: ^1.8.17",
        "  typescript: ^5.8.0",
        "  vitest: ^4.1.9",
        ""
      ].join("\n")
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        compilerOptions: {
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
      to: "tsconfig.build.json",
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
      to: "oxlint.config.ts"
    },
    {
      kind: "copyFile",
      sourceRoot: "sharedOxc",
      from: "oxfmt.config.ts",
      to: "oxfmt.config.ts"
    },
    {
      kind: "writeText",
      to: ".gitignore",
      text: ["node_modules", "dist", ".env", ""].join("\n")
    },
    {
      kind: "copyFile",
      from: "src/app.ts",
      to: "src/app.ts"
    },
    {
      kind: "copyFile",
      from: "src/server.ts",
      to: "src/server.ts"
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: "test/app.test.ts"
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: "vitest.config.ts"
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: {
        schemaVersion: 1,
        preset: "hono-api",
        packageManager: "pnpm",
        projectKind: "single-package",
        features
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
        name: `${projectName} API development`,
        image: "mcr.microsoft.com/devcontainers/typescript-node:22",
        postCreateCommand: "corepack enable && pnpm install",
        customizations: {
          vscode: {
            extensions: ["oxc.oxc-vscode"]
          }
        }
      }
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: [
        "name: Check",
        "",
        "on:",
        "  pull_request:",
        "  push:",
        "    branches:",
        "      - main",
        "",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: pnpm/action-setup@v4",
        "        with:",
        "          version: 10.0.0",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "      - run: pnpm install",
        "      - run: pnpm run check",
        ""
      ].join("\n")
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: [
        "version: 2",
        "updates:",
        "  - package-ecosystem: npm",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        "  - package-ecosystem: github-actions",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        ""
      ].join("\n")
    }
  ];
}

function templateSourceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "hono-api");
}

function sharedOxcSourceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "shared", "oxc");
}

export async function initHonoApiProject(targetDir: string): Promise<void> {
  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForHonoApi(projectNameFromDir(targetDir))
  });
}
