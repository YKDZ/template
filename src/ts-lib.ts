import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderNewProject, type RenderOperation } from "./renderer.js";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset ts-lib"
};

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function packageJson(projectName: string): Record<string, unknown> {
  return {
    name: projectName,
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
    },
    packageManager: "pnpm@10.0.0"
  };
}

function operationsForTsLib(projectName: string): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(projectName),
      multilineArrays: ["files"]
    },
    {
      kind: "writeText",
      to: "pnpm-workspace.yaml",
      text: [
        "packages:",
        "  - .",
        "",
        "catalog:",
        '  "@types/node": ^24.0.0',
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  tsc-alias: ^1.8.17",
        "  typescript: ^5.8.0",
        ""
      ].join("\n")
    },
    {
      kind: "writeJson",
      to: "tsconfig.json",
      value: {
        compilerOptions: {
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
      from: "src/index.ts",
      to: "src/index.ts"
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: {
        schemaVersion: 1,
        preset: "ts-lib",
        packageManager: "pnpm",
        projectKind: "single-package",
        features: [
          "pnpm-catalog",
          "oxc-format-lint",
          "strict-typescript",
          "root-check",
          "fix-command",
          "devcontainer",
          "github-actions",
          "dependabot"
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
        name: `${projectName} development`,
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
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "ts-lib");
}

function sharedOxcSourceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "shared", "oxc");
}

export async function initTsLibProject(targetDir: string): Promise<void> {
  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForTsLib(projectNameFromDir(targetDir))
  });
}
