import { fileURLToPath } from "node:url";

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-workspace-authoring/preset-definition";

import { requireReferencePackage } from "../reference-composition.ts";
const referencePackage = requireReferencePackage("@ykdz/reference-rust-bin");
const packagePathForLeaf = (leaf: string) => "packages/" + leaf;
function rustContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
}): PackageContribution {
  return referencePackage.contribute({
    context: options.context,
    definition: options.packageDefinition ?? {
      name:
        "@" +
        options.context.defaultPackageScope +
        "/" +
        options.packageLeafName,
      path: options.packagePath,
      role: "native-package",
    },
  });
}
const binaryReplayAdapter = definePackageContributionReplayAdapter({
  identity: "binary",
  replay: ({ context, packageDefinition, packageLeafName }) =>
    rustContribution({
      context,
      packageLeafName,
      packagePath: packageDefinition.path,
      packageDefinition,
    }),
});

export const rustBinDefinition = {
  metadata: {
    name: "rust-bin",
    title: "Rust 二进制程序",
    description: "包含 rustfmt、clippy 和 cargo 测试的 Rust 原生二进制工作区。",
  },
  source: referencePackage.source("src"),
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [binaryReplayAdapter],
  initialPrimaryPackage: {
    defaultLeafName: "app",
    role: "native-package",
    defaultPackagePath: ({ packageLeafName }) =>
      packagePathForLeaf(packageLeafName),
    planInitialContribution({ context, resolvedPackageIdentity }) {
      return binaryReplayAdapter.identify(
        rustContribution({
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
    return binaryReplayAdapter.identify(
      rustContribution({ context, packageLeafName, packagePath }),
    );
  },
} satisfies BuiltInPresetDefinition;
