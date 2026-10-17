import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

import { typescriptReferencePackage } from "../reference-composition.ts";

export { typescriptReferencePackage };

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

export function typescriptConfigContribution(
  context: GenerationContext,
  definition = typescriptConfigPackageDefinition(context),
): PackageContribution {
  return typescriptReferencePackage.contribute({ context, definition });
}

export const typescriptConfigReplayAdapter =
  definePackageContributionReplayAdapter({
    identity: "typescript-config",
    replay: ({ context, packageDefinition }) =>
      typescriptConfigContribution(context, packageDefinition),
  });
