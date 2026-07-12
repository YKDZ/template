import { fileURLToPath } from "node:url";

import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { templateSources } from "../template-sources.ts";

function packageScripts(): Record<string, string> {
  return {
    "format:check:run":
      "oxfmt --list-different --config ../../oxfmt.config.ts .",
    "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
    "lint:run":
      "oxlint --quiet --format=unix --config ../../oxlint.config.ts --ignore-pattern node_modules .",
    "lint:fix:run":
      "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
    "typecheck:run": "tsc -p tsconfig.json --noEmit --pretty false",
  };
}

function libraryContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
}): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${options.context.scope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "shared-library",
  };
  const exposure = {
    exports: { ".": { default: "./src/index.ts", types: "./src/index.ts" } },
    imports: { "#/*": { default: "./src/*.ts", types: "./src/*.ts" } },
  };
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    {
      kind: "copyFile",
      source: templateSources.tsLib,
      from: "tsconfig.json",
      to: `${definition.path}/tsconfig.json`,
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
      version: "0.0.0",
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
    checks: [
      {
        kind: "typescript-typecheck",
        owner: { kind: "package-boundary", path: definition.path },
      },
      {
        kind: "oxc-lint",
        owner: { kind: "package-boundary", path: definition.path },
      },
      {
        kind: "oxc-format-check",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
    fixes: [
      {
        kind: "oxc-format-write",
        owner: { kind: "package-boundary", path: definition.path },
      },
      {
        kind: "oxc-lint-fix",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
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

export const tsLibDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "ts-lib",
    title: "TypeScript library",
    description: "Strict TypeScript package with pnpm catalog tooling.",
  },
  source: templateSources.tsLib,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    return {
      schemaVersion: 2,
      packages: [
        libraryContribution({
          context,
          packageLeafName: context.projectName,
          packagePath: `packages/${context.projectName}`,
        }).definition,
      ],
    };
  },
  planInitialization(context) {
    return libraryContribution({
      context,
      packageLeafName: context.projectName,
      packagePath: `packages/${context.projectName}`,
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `packages/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return libraryContribution({ context, packageLeafName, packagePath });
  },
};
