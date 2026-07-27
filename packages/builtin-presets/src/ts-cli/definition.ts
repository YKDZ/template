import { fileURLToPath } from "node:url";

import type { PackageContribution } from "#template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint-v2";
import type { RenderOperation } from "#template-core/renderer";

import { templateSources } from "../template-sources.ts";

function packageScripts(): Record<string, string> {
  return {
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts --ignore-pattern node_modules .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    build: "tsc -p tsconfig.build.json --pretty false",
    postbuild:
      "node -e \"if (process.platform !== 'win32') require('node:fs').chmodSync('dist/cli.js', 0o755)\"",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
    test: "vitest run test/unit test/integration --reporter=verbose",
    "test:e2e":
      "node --conditions=source test/e2e/run-journeys.ts source distribution",
    prepack: "pnpm exec turbo run build --filter=.",
  };
}

function cliContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
}): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${options.context.scope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "cli-tool",
  };
  const exposure = {
    exports: {
      ".": {
        source: "./src/main.ts",
        types: "./dist/main.d.ts",
        default: "./dist/main.js",
      },
    },
    imports: {
      "#main": {
        source: "./src/main.ts",
        types: "./src/main.ts",
        default: "./dist/main.js",
      },
    },
  };
  const operations: RenderOperation[] = [
    {
      kind: "writeJson",
      to: `${definition.path}/package.json`,
      value: {},
      multilineArrays: ["files"],
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "tsconfig.json",
      to: `${definition.path}/tsconfig.json`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "tsconfig.build.json",
      to: `${definition.path}/tsconfig.build.json`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "turbo.json",
      to: `${definition.path}/turbo.json`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "src/cli.ts",
      to: `${definition.path}/src/cli.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "src/main.ts",
      to: `${definition.path}/src/main.ts`,
    },
    {
      kind: "replaceAnchors",
      path: `${definition.path}/src/main.ts`,
      language: "typescript",
      replacements: {
        "cli-command-name": `const commandName = ${JSON.stringify(options.packageLeafName)};`,
      },
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/unit/greet.test.ts",
      to: `${definition.path}/test/unit/greet.test.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/integration/command.test.ts",
      to: `${definition.path}/test/integration/command.test.ts`,
    },
    {
      kind: "replaceAnchors",
      path: `${definition.path}/test/integration/command.test.ts`,
      language: "typescript",
      replacements: {
        "cli-test-command-name": `commandName = ${JSON.stringify(options.packageLeafName)};`,
      },
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/e2e/journey.ts",
      to: `${definition.path}/test/e2e/journey.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/e2e/run-journeys.ts",
      to: `${definition.path}/test/e2e/run-journeys.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/e2e/journeys/greet.journey.ts",
      to: `${definition.path}/test/e2e/journeys/greet.journey.ts`,
    },
  ];
  return {
    definition,
    exposure,
    manifest: {
      name: definition.name,
      version: "0.0.0",
      publishConfig: { access: "public" },
      files: ["dist"],
      type: "module",
      bin: { [options.packageLeafName]: "./dist/cli.js" },
      ...exposure,
      scripts: packageScripts(),
      dependencies: { commander: "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
        vitest: "catalog:",
      },
      engines: { node: `>=${options.context.toolchain.nodeLtsMajor}` },
    },
    operations,
    environmentNeeds: [],
    foundation: {
      toolchains: {},
      editorCapabilities: ["oxc-format-lint"],
      dependencyMaintenance: {
        ecosystems: ["npm", "github-actions", "docker"],
        interval: "weekly",
      },
    },
  };
}

export const tsCliDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "ts-cli",
    title: "TypeScript CLI",
    description: "Publishable TypeScript command-line package.",
  },
  source: templateSources.tsCli,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    return {
      schemaVersion: 2,
      packages: [
        cliContribution({
          context,
          packageLeafName: context.projectName,
          packagePath: `packages/${context.projectName}`,
        }).definition,
      ],
    };
  },
  planInitialization(context) {
    return cliContribution({
      context,
      packageLeafName: context.projectName,
      packagePath: `packages/${context.projectName}`,
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `packages/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return cliContribution({ context, packageLeafName, packagePath });
  },
};
