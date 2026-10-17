import { fileURLToPath } from "node:url";

import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

import { requireReferencePackage } from "../reference-composition.ts";

const referencePackage = requireReferencePackage("@ykdz/reference-ts-lib");

function packagePathForLeaf(packageLeafName: string): string {
  return `packages/${packageLeafName}`;
}

function libraryContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
}): PackageContribution {
  return referencePackage.contribute({
    context: options.context,
    definition: options.packageDefinition ?? {
      name: `@${options.context.defaultPackageScope}/${options.packageLeafName}`,
      path: options.packagePath,
      role: referencePackage.role,
    },
  });
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
    title: "TypeScript 库",
    description: "采用 pnpm catalog 工具配置的严格 TypeScript 包。",
  },
  source: referencePackage.source("src"),
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
