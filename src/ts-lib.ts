import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectBlueprint } from "./declarations.js";
import { assembleGenerationContext, type GenerationContext } from "./generation-context.js";
import {
  planTsLibChecks,
  planTsLibFixes,
  renderFixCommand,
  renderRootCheckCommand,
} from "./module-graph.js";
import { projectPresetDependabotConfig, projectTsLibGithubCheckWorkflow } from "./project-github.js";
import { renderNewProject, type RenderOperation } from "./renderer.js";
import { resolveToolchainVersions } from "./toolchain-resolution.js";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset ts-lib",
};

type InitTsLibProjectOptions = {
  readonly generationContext?: GenerationContext;
};

const tsLibBlueprint: ProjectBlueprint = {
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
    "dependabot",
  ],
};

export function projectTsLibPackageScripts(): Record<string, string> {
  return {
    build: "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
    check: renderRootCheckCommand(planTsLibChecks()),
    fix: renderFixCommand(planTsLibFixes()),
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    lint: "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    typecheck: "tsc -p tsconfig.json --noEmit",
  };
}

function packageJson(context: GenerationContext): Record<string, unknown> {
  return {
    name: context.projectName.value,
    version: "0.0.0",
    private: true,
    files: ["dist"],
    type: "module",
    exports: {
      ".": {
        default: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
    scripts: projectTsLibPackageScripts(),
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "tsc-alias": "catalog:",
      typescript: "catalog:",
    },
    engines: {
      node: context.toolchain.nodeLtsMajor.value,
    },
    packageManager: context.toolchain.packageManagerPin.value,
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

function operationsForTsLib(context: GenerationContext): RenderOperation[] {
  return [
    {
      kind: "writeJson",
      to: "package.json",
      value: packageJson(context),
      multilineArrays: ["files"],
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
        "",
      ].join("\n"),
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
            "@/*": ["./src/*"],
          },
          rootDir: "src",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
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
      from: "src/index.ts",
      to: "src/index.ts",
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
          "dependabot",
        ],
      },
    },
    {
      kind: "writeJson",
      to: ".project-kit/generated-by.json",
      value: generationRecord(context),
    },
    {
      kind: "writeJson",
      to: ".devcontainer/devcontainer.json",
      value: {
        name: `${context.projectName.value} development`,
        image: `mcr.microsoft.com/devcontainers/typescript-node:${context.toolchain.nodeLtsMajor.value}`,
        postCreateCommand: "corepack enable && pnpm install",
        customizations: {
          vscode: {
            extensions: ["oxc.oxc-vscode"],
          },
        },
      },
    },
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectTsLibGithubCheckWorkflow(),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectPresetDependabotConfig("ts-lib"),
    },
  ];
}

function templateSourceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "ts-lib");
}

function sharedOxcSourceRoot(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "shared",
    "oxc",
  );
}

export async function initTsLibProject(
  targetDir: string,
  options?: InitTsLibProjectOptions,
): Promise<void> {
  const generationContext =
    options?.generationContext ??
    assembleGenerationContext({
      targetDir,
      blueprint: tsLibBlueprint,
      toolchain: await resolveToolchainVersions(),
    });

  await renderNewProject({
    sourceRoot: templateSourceRoot(),
    sourceRoots: { sharedOxc: sharedOxcSourceRoot() },
    targetRoot: targetDir,
    operations: operationsForTsLib(generationContext),
  });
}
