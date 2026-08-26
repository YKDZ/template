import type { PackageContribution } from "./package-contribution.ts";
import type {
  PackageDefinition,
  PackageRole,
  ProjectBlueprintDraft,
} from "./project-blueprint.ts";
import type { TemplateSourceHandle } from "./renderer.ts";

/** Stable, preset-agnostic input supplied after toolchain resolution. */
export type GenerationContext = {
  readonly targetDir: string;
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly foundationPackages: {
    readonly typescriptConfiguration: {
      readonly name: string;
    };
  };
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly packageManagerPin: string;
  };
};

/** An in-memory plan tagged with the stable adapter that can replay it. */
export type PlannedPackageContribution = PackageContribution & {
  readonly planningIdentity: string;
};

/** Narrow access to initial sibling packages, keyed by stable adapter identity. */
export type InitialPackageDefinitionLookup = {
  require(identity: string): PackageDefinition;
};

export type PackageContributionReplayAdapter = {
  readonly identity: string;
  identify(contribution: PackageContribution): PlannedPackageContribution;
  replay(options: {
    readonly context: GenerationContext;
    readonly packageDefinition: PackageDefinition;
    readonly packageLeafName: string;
    readonly initialPackages: InitialPackageDefinitionLookup;
  }): PackageContribution;
};

/**
 * Declares one stable replay semantic. Persisted provenance selection and
 * diagnostics stay with the Foundation instead of leaking into Presets.
 */
export function definePackageContributionReplayAdapter(options: {
  readonly identity: string;
  readonly replay: PackageContributionReplayAdapter["replay"];
}): PackageContributionReplayAdapter {
  if (options.identity.length === 0) {
    throw new Error("Package Contribution replay adapter identity is required");
  }
  return {
    identity: options.identity,
    identify(contribution) {
      return { ...contribution, planningIdentity: options.identity };
    },
    replay: options.replay,
  };
}

export type ResolvedPrimaryPackageIdentity = {
  readonly leafName: string;
  readonly definition: PackageDefinition;
};

/** Optional behavior owned only by Presets with a configurable initial package. */
export type InitialPrimaryPackageCapability = {
  readonly defaultLeafName: string;
  readonly role: PackageRole;
  defaultPackagePath(options: { readonly packageLeafName: string }): string;
  planInitialContribution(options: {
    readonly context: GenerationContext;
    readonly resolvedPackageIdentity: ResolvedPrimaryPackageIdentity;
  }): PlannedPackageContribution;
};

type BuiltInPresetDefinitionBase = {
  readonly metadata: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
  };
  /** The Definition owns its Preset-local Self-Checking Template Source. */
  readonly source: TemplateSourceHandle;
  /** The owned planner source inspected by the Template Boundary Check. */
  readonly plannerSourceFile: string;
  /** Stable semantics used to replay persisted Package Definitions. */
  readonly packageContributionReplayAdapters: readonly PackageContributionReplayAdapter[];
  /** Package layout is Preset-owned even when callers omit --path. */
  defaultPackagePath?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
  }): string;
  planPackageAddition?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
    readonly packagePath: string;
  }): PlannedPackageContribution;
};

type ConfigurablePrimaryPackagePresetDefinition =
  BuiltInPresetDefinitionBase & {
    readonly initialPrimaryPackage: InitialPrimaryPackageCapability;
    readonly blueprint?: never;
    readonly planInitialization?: never;
    readonly planInitializationContributions?: never;
  };

type FixedTopologyPresetDefinition = BuiltInPresetDefinitionBase & {
  readonly initialPrimaryPackage?: never;
  blueprint(context: GenerationContext): ProjectBlueprintDraft;
  planInitialization(context: GenerationContext): PlannedPackageContribution;
  /** Multi-package Definitions expose their complete owned topology directly. */
  planInitializationContributions?(
    context: GenerationContext,
  ): readonly PlannedPackageContribution[];
};

/** A side-effect-free Built-in Preset planner. */
export type BuiltInPresetDefinition =
  | ConfigurablePrimaryPackagePresetDefinition
  | FixedTopologyPresetDefinition;
