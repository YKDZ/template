import type { PackageContribution } from "./package-contribution.ts";
import {
  assertProjectBlueprintV2,
  type PackageRole,
  type ProjectBlueprintV2,
} from "./project-blueprint-v2.ts";

type PackageManifest = Readonly<Record<string, unknown>>;

export type ExplicitProjectLinkPlan = {
  readonly manifestPatchesByPackagePath: ReadonlyMap<
    string,
    {
      readonly dependencies: Readonly<Record<string, "workspace:*">>;
      readonly dependenciesMeta: Readonly<
        Record<string, { readonly injected: boolean }>
      >;
    }
  >;
  /**
   * Build ordering follows the same explicit package relationships as manifest
   * dependencies. Turbo resolves ^build through the derived workspace
   * dependency rather than through Preset or framework vocabulary.
   */
  readonly hasBuildOrdering: boolean;
};

export function canConsumeNodePackageNameImport(
  contribution: PackageContribution,
  manifest: PackageManifest = contribution.manifest,
): boolean {
  return (
    contribution.definition.role !== "native-package" &&
    manifest.type === "module"
  );
}

export function canLinkNodePackageRoles(
  consumerRole: PackageRole,
  providerRole: PackageRole,
): boolean {
  if (consumerRole === "native-package" || providerRole === "native-package") {
    return false;
  }
  return consumerRole !== "shared-library" || providerRole === "shared-library";
}

function isPackageRelativeTarget(
  value: unknown,
  extension: RegExp,
): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("./") ||
    value.includes("\\")
  ) {
    return false;
  }
  const segments = value.slice(2).split("/");
  return (
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    ) && extension.test(value)
  );
}

function manifestExports(
  manifest: PackageManifest,
): Readonly<Record<string, unknown>> {
  const exports = manifest.exports;
  return typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports)
    ? (exports as Readonly<Record<string, unknown>>)
    : {};
}

function requestsInjectedDependency(
  manifest: PackageManifest,
  dependencyName: string,
): boolean {
  const dependenciesMeta = manifest.dependenciesMeta;
  if (
    typeof dependenciesMeta !== "object" ||
    dependenciesMeta === null ||
    Array.isArray(dependenciesMeta)
  ) {
    return false;
  }
  const dependency = (dependenciesMeta as Readonly<Record<string, unknown>>)[
    dependencyName
  ];
  return (
    typeof dependency === "object" &&
    dependency !== null &&
    !Array.isArray(dependency) &&
    (dependency as Readonly<Record<string, unknown>>).injected === true
  );
}

function exposesSourceCondition(manifest: PackageManifest): boolean {
  const rootExport = manifestExports(manifest)["."];
  if (
    typeof rootExport !== "object" ||
    rootExport === null ||
    Array.isArray(rootExport) ||
    Object.keys(rootExport).join("\u0000") !== "source\u0000types\u0000default"
  ) {
    return false;
  }
  const conditions = rootExport as Readonly<Record<string, unknown>>;
  return (
    isPackageRelativeTarget(conditions.source, /(?<!\.d)\.(?:[cm]?ts|tsx)$/u) &&
    isPackageRelativeTarget(conditions.types, /\.d\.[cm]?ts$/u) &&
    isPackageRelativeTarget(conditions.default, /\.[cm]?js$/u)
  );
}

export function canProvideSourceConditionPackageNameImport(
  contribution: PackageContribution,
  manifest: PackageManifest = contribution.manifest,
): boolean {
  return (
    contribution.definition.role !== "native-package" &&
    exposesSourceCondition(manifest)
  );
}

function exposesImportablePackageRoot(manifest: PackageManifest): boolean {
  const rootExport = manifestExports(manifest)["."];
  if (isPackageRelativeTarget(rootExport, /\.[cm]?[jt]sx?$/u)) {
    return true;
  }
  if (
    typeof rootExport !== "object" ||
    rootExport === null ||
    Array.isArray(rootExport)
  ) {
    return false;
  }
  return isPackageRelativeTarget(
    (rootExport as Readonly<Record<string, unknown>>).default,
    /\.[cm]?[jt]sx?$/u,
  );
}

/**
 * Resolves durable Link Intents from Package Contributions, optionally using
 * Current Manifest Truth for a follow-up decision. No Preset identity or
 * string resource protocol is involved.
 */
export function planExplicitProjectLinks(options: {
  readonly blueprint: ProjectBlueprintV2;
  readonly contributions: readonly PackageContribution[];
  readonly manifestTruthByPackagePath?: ReadonlyMap<string, PackageManifest>;
}): ExplicitProjectLinkPlan {
  const blueprint = assertProjectBlueprintV2(options.blueprint);
  const contributionsByPath = new Map(
    options.contributions.map((contribution) => [
      contribution.definition.path,
      contribution,
    ]),
  );
  const manifestPatches = new Map<
    string,
    {
      dependencies: Record<string, "workspace:*">;
      dependenciesMeta: Record<string, { injected: boolean }>;
    }
  >();
  for (const intent of blueprint.packageLinkIntents ?? []) {
    const provider = contributionsByPath.get(intent.providerPackagePath);
    const consumer = contributionsByPath.get(intent.consumerPackagePath);
    if (provider === undefined || consumer === undefined) {
      throw new Error(
        "Project Linking requires explicit Package Contributions for every Link Intent endpoint",
      );
    }
    const providerManifest =
      options.manifestTruthByPackagePath?.get(intent.providerPackagePath) ??
      provider.manifest;
    const consumerManifest =
      options.manifestTruthByPackagePath?.get(intent.consumerPackagePath) ??
      consumer.manifest;
    for (const [contribution, manifest] of [
      [provider, providerManifest],
      [consumer, consumerManifest],
    ] as const) {
      if (manifest.name !== contribution.definition.name) {
        throw new Error(
          `Project Linking Manifest Truth for ${contribution.definition.path} must have package name ${contribution.definition.name}`,
        );
      }
    }
    if (!canConsumeNodePackageNameImport(consumer, consumerManifest)) {
      const validPackagePaths = options.contributions
        .filter(
          (candidate) =>
            candidate.definition.path !== intent.providerPackagePath &&
            canConsumeNodePackageNameImport(
              candidate,
              options.manifestTruthByPackagePath?.get(
                candidate.definition.path,
              ) ?? candidate.manifest,
            ),
        )
        .map((candidate) => candidate.definition.path)
        .toSorted();
      throw new Error(
        `Package Link consumer ${consumer.definition.path} cannot consume a Node package-name import. Valid Package Paths: ${validPackagePaths.length === 0 ? "<none>" : validPackagePaths.join(", ")}`,
      );
    }
    if (
      !canLinkNodePackageRoles(
        consumer.definition.role,
        provider.definition.role,
      )
    ) {
      throw new Error(
        `Package Link ${consumer.definition.path} (${consumer.definition.role}) cannot depend on ${provider.definition.path} (${provider.definition.role}) under Package Role boundaries`,
      );
    }
    if (!exposesImportablePackageRoot(providerManifest)) {
      throw new Error(
        `Package Link provider ${provider.definition.path} does not expose an importable package root`,
      );
    }
    const injected =
      !exposesSourceCondition(providerManifest) ||
      requestsInjectedDependency(consumerManifest, provider.definition.name);
    const consumerPatch = manifestPatches.get(intent.consumerPackagePath);
    if (consumerPatch === undefined) {
      manifestPatches.set(intent.consumerPackagePath, {
        dependencies: { [provider.definition.name]: "workspace:*" },
        dependenciesMeta: {
          [provider.definition.name]: { injected },
        },
      });
    } else {
      consumerPatch.dependencies[provider.definition.name] = "workspace:*";
      consumerPatch.dependenciesMeta[provider.definition.name] = {
        injected,
      };
    }
  }
  return {
    manifestPatchesByPackagePath: manifestPatches,
    hasBuildOrdering: manifestPatches.size > 0,
  };
}
