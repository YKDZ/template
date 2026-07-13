import type { PackageContribution } from "./package-contribution.ts";
import {
  assertProjectBlueprintV2,
  type ProjectBlueprintV2,
} from "./project-blueprint-v2.ts";

export type ExplicitProjectLinkPlan = {
  readonly manifestDependenciesByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, "workspace:*">>
  >;
  /**
   * Build ordering follows the same explicit package relationships as manifest
   * dependencies. Turbo resolves ^build through the derived workspace
   * dependency rather than through Preset or framework vocabulary.
   */
  readonly hasBuildOrdering: boolean;
};

/**
 * Resolves durable Link Intents using the explicit exposures supplied by
 * Package Contributions. No Preset identity or string resource protocol is
 * involved.
 */
export function planExplicitProjectLinks(options: {
  readonly blueprint: ProjectBlueprintV2;
  readonly contributions: readonly PackageContribution[];
}): ExplicitProjectLinkPlan {
  const blueprint = assertProjectBlueprintV2(options.blueprint);
  const contributionsByPath = new Map(
    options.contributions.map((contribution) => [
      contribution.definition.path,
      contribution,
    ]),
  );
  const dependencies = new Map<string, Record<string, "workspace:*">>();
  for (const intent of blueprint.packageLinkIntents ?? []) {
    const provider = contributionsByPath.get(intent.providerPackagePath);
    const consumer = contributionsByPath.get(intent.consumerPackagePath);
    if (provider === undefined || consumer === undefined) {
      throw new Error(
        "Project Linking requires explicit Package Contributions for every Link Intent endpoint",
      );
    }
    if (Object.keys(provider.exposure.exports).length === 0) {
      throw new Error(
        `Package Link provider ${provider.definition.path} has no Package Exposure`,
      );
    }
    const consumerDependencies = dependencies.get(intent.consumerPackagePath);
    if (consumerDependencies === undefined) {
      dependencies.set(intent.consumerPackagePath, {
        [provider.definition.name]: "workspace:*",
      });
    } else {
      consumerDependencies[provider.definition.name] = "workspace:*";
    }
  }
  return {
    manifestDependenciesByPackagePath: dependencies,
    hasBuildOrdering: dependencies.size > 0,
  };
}
