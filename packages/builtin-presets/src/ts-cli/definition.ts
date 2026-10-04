import { fileURLToPath } from "node:url";

import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
import { templateSources } from "../template-sources.ts";

type CandidateCreationOrigin =
  | "new-publication-candidate"
  | "existing-candidate-replay";

// 公开候选 engines.node 的唯一派生点：精确三段 nodeVersion 派生 `^<精确值>`，绝不从
// nodeLtsMajor 猜 patch。新建候选缺失或非精确一律清楚失败；既有候选 replay 允许旧根只声明
// 大版本，此时投影与磁盘原文相同的 `>=major`，由既有三方合并律保留，不引入磁盘 engines 接管。
function publicationCandidateNodeEngine(
  toolchain: GenerationContext["toolchain"],
  creationOrigin: CandidateCreationOrigin,
): string {
  const nodeVersion = toolchain.nodeVersion;
  if (nodeVersion === undefined) {
    if (creationOrigin === "existing-candidate-replay") {
      return `>=${toolchain.nodeLtsMajor}`;
    }
    throw new Error(
      "新建公开 ts-cli 发布候选要求 Generation Context 提供精确三段 toolchain.nodeVersion，实际缺失；不能从 nodeLtsMajor 猜 patch 派生公开 caret 范围。",
    );
  }
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) {
    throw new Error(
      `公开 ts-cli 发布候选要求 toolchain.nodeVersion 为精确三段 Node 版本（例如 "24.16.0"），实际收到 ${JSON.stringify(nodeVersion)}。`,
    );
  }
  if (
    nodeVersion.slice(0, nodeVersion.indexOf(".")) !== toolchain.nodeLtsMajor
  ) {
    throw new Error(
      `公开 ts-cli 发布候选的 toolchain.nodeVersion ${nodeVersion} 与 nodeLtsMajor ${toolchain.nodeLtsMajor} 大版本不一致。`,
    );
  }
  return `^${nodeVersion}`;
}

function packagePathForLeaf(packageLeafName: string): string {
  return `packages/${packageLeafName}`;
}

function packageScripts(): Record<string, string> {
  return {
    "format:check": "oxfmt --list-different .",
    "format:write": "oxfmt --write .",
    lint: "oxlint --quiet --format=unix --ignore-pattern node_modules .",
    "lint:fix": "oxlint --format=unix . --fix",
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

function cliContribution(
  options:
    | {
        readonly context: GenerationContext;
        readonly packageLeafName: string;
        readonly packagePath: string;
        readonly packageDefinition?: PackageDefinition;
        readonly publicationCandidate: false;
        readonly creationOrigin?: undefined;
      }
    | {
        readonly context: GenerationContext;
        readonly packageLeafName: string;
        readonly packagePath: string;
        readonly packageDefinition?: PackageDefinition;
        readonly publicationCandidate: true;
        readonly creationOrigin: CandidateCreationOrigin;
      },
): PackageContribution {
  const definition: PackageDefinition = options.packageDefinition ?? {
    name: `@${options.context.defaultPackageScope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "cli-tool",
  };
  const exposure = { exports: {}, imports: {} };
  const operations: RenderOperation[] = [
    {
      kind: "writeJson",
      to: `${definition.path}/package.json`,
      value: {},
      multilineArrays: ["files"],
    },
    typescriptConfigSourceOperation({
      context: options.context,
      source: templateSources.tsCli,
      from: "tsconfig.json",
      to: `${definition.path}/tsconfig.json`,
    }),
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
      from: "src/cli-command-identity.ts",
      to: `${definition.path}/src/cli-command-identity.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "src/main.ts",
      to: `${definition.path}/src/main.ts`,
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
      from: "test/unit/cli-command-identity.test.ts",
      to: `${definition.path}/test/unit/cli-command-identity.test.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsCli,
      from: "test/integration/command.test.ts",
      to: `${definition.path}/test/integration/command.test.ts`,
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
      private: true,
      files: ["dist"],
      type: "module",
      bin: { [options.packageLeafName]: "./dist/cli.js" },
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
      engines: {
        node: options.publicationCandidate
          ? publicationCandidateNodeEngine(
              options.context.toolchain,
              options.creationOrigin,
            )
          : `>=${options.context.toolchain.nodeLtsMajor}`,
      },
    },
    operations,
    environmentNeeds: [],
    foundation: {
      ...(options.publicationCandidate
        ? { npmPublication: { kind: "public-cli-candidate" as const } }
        : {}),
      toolchains: {},
      editorCapabilities: ["oxc-format-lint"],
      typescriptConfigurationPackage: { dependency: "required" },
      dependencyMaintenance: {
        ecosystems: ["npm", "github-actions", "docker"],
        interval: "weekly",
      },
    },
  };
}

const cliPublicationCandidateReplayAdapter =
  definePackageContributionReplayAdapter({
    identity: "cli-publication-candidate",
    replay: ({
      context,
      packageDefinition,
      packageLeafName,
      planningContribution,
    }) => {
      if (planningContribution !== "planInitialization") {
        throw new Error(
          "cli-publication-candidate replay identity requires planInitialization provenance",
        );
      }
      return cliContribution({
        context,
        packageLeafName,
        packagePath: packageDefinition.path,
        packageDefinition,
        publicationCandidate: true,
        creationOrigin: "existing-candidate-replay",
      });
    },
  });

const cliPackageAdditionReplayAdapter = definePackageContributionReplayAdapter({
  identity: "cli-package-addition",
  replay: ({
    context,
    packageDefinition,
    packageLeafName,
    planningContribution,
  }) => {
    if (planningContribution !== "planPackageAddition") {
      throw new Error(
        "cli-package-addition replay identity requires planPackageAddition provenance",
      );
    }
    return cliContribution({
      context,
      packageLeafName,
      packagePath: packageDefinition.path,
      packageDefinition,
      publicationCandidate: false,
    });
  },
});

export const tsCliDefinition = {
  metadata: {
    name: "ts-cli",
    title: "TypeScript 命令行工具",
    description: "TypeScript 命令行包。",
  },
  source: templateSources.tsCli,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [
    cliPublicationCandidateReplayAdapter,
    cliPackageAdditionReplayAdapter,
  ],
  initialPrimaryPackage: {
    defaultLeafName: "cli",
    role: "cli-tool",
    defaultPackagePath: ({ packageLeafName }) =>
      packagePathForLeaf(packageLeafName),
    planInitialContribution({ context, resolvedPackageIdentity }) {
      return cliPublicationCandidateReplayAdapter.identify(
        cliContribution({
          context,
          packageLeafName: resolvedPackageIdentity.leafName,
          packagePath: resolvedPackageIdentity.definition.path,
          packageDefinition: resolvedPackageIdentity.definition,
          publicationCandidate: true,
          creationOrigin: "new-publication-candidate",
        }),
      );
    },
  },
  defaultPackagePath({ packageLeafName }) {
    return packagePathForLeaf(packageLeafName);
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return cliPackageAdditionReplayAdapter.identify(
      cliContribution({
        context,
        packageLeafName,
        packagePath,
        publicationCandidate: false,
      }),
    );
  },
} satisfies BuiltInPresetDefinition;
