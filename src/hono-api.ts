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
  command: "template init --preset hono-api",
};

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

export function projectHonoApiPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    check: renderRootCheckCommand(planNodeChecks("hono-api")),
    fix: renderFixCommand(planNodeFixes("hono-api")),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    start: "node dist/server.js",
    test: "vitest run",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

function packageJson(projectName: string): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: projectHonoApiPackageScripts(),
    dependencies: {
      "@hono/node-server": "catalog:",
      hono: "catalog:",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      typescript: "catalog:",
      vitest: "catalog:",
    },
    engines: {
      node: "22",
    },
    packageManager: "pnpm@10.0.0",
  };
}

function operationsForHonoApi(projectName: string): RenderOperation[] {
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
        "catalog:",
        '  "@hono/node-server": ^2.0.6',
        '  "@types/node": ^24.0.0',
        "  hono: ^4.12.27",
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  tsc-alias: ^1.8.17",
        "  typescript: ^5.8.0",
        "  vitest: ^4.1.9",
        "",
      ].join("\n"),
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
      to: "tsconfig.build.json",
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
      text: ["node_modules", "dist", ".env", ""].join("\n"),
    },
    {
      kind: "copyFile",
      from: "src/app.ts",
      to: "src/app.ts",
    },
    {
      kind: "copyFile",
      from: "src/server.ts",
      to: "src/server.ts",
    },
    {
      kind: "copyFile",
      from: "test/app.test.ts",
      to: "test/app.test.ts",
    },
    {
      kind: "copyFile",
      from: "vitest.config.ts",
      to: "vitest.config.ts",
    },
    {
      kind: "writeJson",
      to: ".project-kit/blueprint.json",
      value: {
        schemaVersion: 1,
        preset: "hono-api",
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
        name: `${projectName} API development`,
        nodeVersion: "22",
        packageManagerPin: "pnpm@10.0.0",
        extensions: ["oxc.oxc-vscode"],
      }),
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectPresetGithubCheckWorkflow("hono-api"),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectPresetDependabotConfig("hono-api"),
    },
  ];
}

function templateSourceRoot(): string {
  return packageTemplateRoot(path.dirname(fileURLToPath(import.meta.url)), "hono-api");
}

function sharedOxcSourceRoot(): string {
  return packageTemplateRoot(path.dirname(fileURLToPath(import.meta.url)), "shared", "oxc");
}

export async function initHonoApiProject(targetDir: string): Promise<void> {
  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForHonoApi(projectNameFromDir(targetDir)),
  });
}
