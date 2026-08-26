import { fileURLToPath } from "node:url";

import type { PackageContribution } from "#template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint";
import type { RenderOperation } from "#template-core/renderer";

import { typescriptConfigSourceOperation } from "../shared/typescript.ts";
import { templateSources } from "../template-sources.ts";

function packagePathForLeaf(packageLeafName: string): string {
  return `packages/${packageLeafName}`;
}

function packageScripts(): Record<string, string> {
  return {
    "format:check": "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
    lint: "oxlint --quiet --format=unix --config ../../oxlint.config.ts --ignore-pattern node_modules .",
    "lint:fix": "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    build: "tsc -p tsconfig.build.json --pretty false",
    typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function libraryContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
}): PackageContribution {
  const definition: PackageDefinition = options.packageDefinition ?? {
    name: `@${options.context.defaultPackageScope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "shared-library",
  };
  const exposure = {
    exports: {
      ".": {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    imports: {
      "#/*": {
        source: "./src/*.ts",
        types: "./src/*.ts",
        default: "./dist/*.js",
      },
    },
  };
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    typescriptConfigSourceOperation({
      context: options.context,
      source: templateSources.tsLib,
      from: "tsconfig.json",
      to: `${definition.path}/tsconfig.json`,
    }),
    {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "tsconfig.build.json",
      to: `${definition.path}/tsconfig.build.json`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "src/index.ts",
      to: `${definition.path}/src/index.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "src/name-schema.ts",
      to: `${definition.path}/src/name-schema.ts`,
    },
    {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "turbo.json",
      to: `${definition.path}/turbo.json`,
    },
  ];
  return {
    definition,
    exposure,
    manifest: {
      name: definition.name,
      private: true,
      type: "module",
      ...exposure,
      dependencies: { valibot: "catalog:" },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
      },
      engines: { node: options.context.toolchain.nodeLtsMajor },
      scripts: packageScripts(),
    },
    operations,
    environmentNeeds: [],
    foundation: {
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

const libraryReplayAdapter = definePackageContributionReplayAdapter({
  identity: "library",
  replay: ({ context, packageDefinition, packageLeafName }) =>
    libraryContribution({
      context,
      packageLeafName,
      packagePath: packageDefinition.path,
      packageDefinition,
    }),
});

export const tsLibDefinition = {
  metadata: {
    name: "ts-lib",
    title: "TypeScript library",
    description: "Strict TypeScript package with pnpm catalog tooling.",
  },
  source: templateSources.tsLib,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [libraryReplayAdapter],
  initialPrimaryPackage: {
    defaultLeafName: "lib",
    role: "shared-library",
    defaultPackagePath: ({ packageLeafName }) =>
      packagePathForLeaf(packageLeafName),
    planInitialContribution({ context, resolvedPackageIdentity }) {
      return libraryReplayAdapter.identify(
        libraryContribution({
          context,
          packageLeafName: resolvedPackageIdentity.leafName,
          packagePath: resolvedPackageIdentity.definition.path,
          packageDefinition: resolvedPackageIdentity.definition,
        }),
      );
    },
  },
  defaultPackagePath({ packageLeafName }) {
    return packagePathForLeaf(packageLeafName);
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return libraryReplayAdapter.identify(
      libraryContribution({ context, packageLeafName, packagePath }),
    );
  },
} satisfies BuiltInPresetDefinition;
