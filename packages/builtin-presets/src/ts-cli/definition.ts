import { fileURLToPath } from "node:url";

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-workspace-authoring/preset-definition";

import { requireReferencePackage } from "../reference-composition.ts";
const referencePackage = requireReferencePackage("@ykdz/reference-ts-cli");
type CandidateCreationOrigin =
  | "new-publication-candidate"
  | "existing-candidate-replay";
const packagePathForLeaf = (leaf: string) => "packages/" + leaf;
function cliContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
  readonly publicationCandidate: boolean;
  readonly creationOrigin?: CandidateCreationOrigin;
}): PackageContribution {
  referencePackage.prepare();
  return referencePackage.contribute({
    context: options.context,
    definition: options.packageDefinition ?? {
      name:
        "@" +
        options.context.defaultPackageScope +
        "/" +
        options.packageLeafName,
      path: options.packagePath,
      role: "cli-tool",
    },
    planningIdentity: options.publicationCandidate
      ? "cli-publication-candidate"
      : "cli-package-addition",
    creationOrigin:
      options.creationOrigin === "existing-candidate-replay" ? "replay" : "new",
  });
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
  source: referencePackage.source("src"),
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
