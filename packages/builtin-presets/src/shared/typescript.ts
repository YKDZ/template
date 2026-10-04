import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type {
  RenderOperation,
  TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

import { templateSources } from "../template-sources.ts";

const typescriptConfigPackageReplacement = "TYPESCRIPT_CONFIG_PACKAGE";

type TypescriptConfigFoundationContext = Pick<
  GenerationContext,
  "foundationPackages"
>;

export function typescriptConfigPackageName(
  context: TypescriptConfigFoundationContext,
): string {
  return context.foundationPackages.typescriptConfiguration.name;
}

export function typescriptConfigPackageDefinition(
  context: TypescriptConfigFoundationContext,
): PackageDefinition {
  return {
    name: typescriptConfigPackageName(context),
    path: "packages/typescript-config",
    role: "shared-library",
  };
}

export function typescriptConfigSourceOperation(options: {
  readonly context: GenerationContext;
  readonly source: TemplateSourceHandle;
  readonly from: string;
  readonly to: string;
}): RenderOperation {
  return {
    kind: "writeTextTemplate",
    source: options.source,
    from: options.from,
    to: options.to,
    replacements: {
      [typescriptConfigPackageReplacement]: typescriptConfigPackageName(
        options.context,
      ),
    },
  };
}

export function typescriptConfigContribution(
  context: GenerationContext,
  definition = typescriptConfigPackageDefinition(context),
): PackageContribution {
  return {
    definition,
    exposure: { exports: {}, imports: {} },
    manifest: {
      name: definition.name,
      private: true,
      files: ["base.json"],
      scripts: {
        "format:check": "oxfmt --list-different .",
        "format:write": "oxfmt --write .",
      },
      devDependencies: { oxfmt: "catalog:" },
      engines: { node: context.toolchain.nodeLtsMajor },
    },
    operations: [
      {
        kind: "writeJson",
        to: `${definition.path}/package.json`,
        value: {},
        multilineArrays: ["files"],
      },
      {
        kind: "copyFile",
        source: templateSources.foundation,
        from: "typescript-config/base.json",
        to: `${definition.path}/base.json`,
      },
      {
        kind: "copyFile",
        source: templateSources.foundation,
        from: "typescript-config/turbo.json",
        to: `${definition.path}/turbo.json`,
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

export const typescriptConfigReplayAdapter =
  definePackageContributionReplayAdapter({
    identity: "typescript-config",
    replay: ({ context, packageDefinition }) =>
      typescriptConfigContribution(context, packageDefinition),
  });
