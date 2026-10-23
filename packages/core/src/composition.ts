import type { ContentIdentity } from "./content-identity.ts";
import type { GenerationRecordSelection } from "./generation-record.ts";
import type { JsonValue } from "./json.ts";
import type {
  CompositionFile,
  CompositionReconciliation,
  PackageContribution,
} from "./package-contribution.ts";
import type {
  PackageDefinitionId,
  PackageLinkIntent,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type { PackageBinding } from "./reference-package.ts";

export type CompositionPackage<CreationInput extends JsonValue = JsonValue> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly contentIdentity: ContentIdentity;
  readonly definition: PersistedPackageDefinition;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly creationInput: CreationInput | null;
  readonly dependencyBindings: Readonly<Record<string, PackageDefinitionId>>;
};

export type CompositionResolution<StableCommon, PackageInput> = {
  readonly stableCommon: StableCommon;
  readonly packageInputs: ReadonlyMap<PackageDefinitionId, PackageInput>;
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

export type CompositionPackageEvaluation<ContributionFacts = unknown> = {
  readonly package: CompositionPackage;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly contribution: PackageContribution<ContributionFacts>;
};

export type Composition<
  Conventions extends JsonValue = JsonValue,
  StableCommon = unknown,
  PackageInput = unknown,
  ContributionFacts = unknown,
  OwnerFacts = unknown,
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly identity: ContentIdentity;
  parseConventions(value: unknown): Conventions;
  /** 在任何包求值前确定共同输入、每包输入和稳定连接。 */
  resolve(options: {
    readonly conventions: Conventions;
    readonly blueprint: ProjectBlueprint;
    readonly selections: readonly GenerationRecordSelection[];
    readonly packages: readonly CompositionPackage<CreationInput>[];
  }): CompositionResolution<StableCommon, PackageInput>;
  /** 只合成已经求得的贡献及明确组合声明。 */
  combine(options: {
    readonly conventions: Conventions;
    readonly stableCommon: StableCommon;
    readonly blueprint: ProjectBlueprint;
    readonly selections: readonly GenerationRecordSelection[];
    readonly packages: readonly CompositionPackageEvaluation<ContributionFacts>[];
  }): {
    readonly files?: readonly CompositionFile[];
    readonly reconciliation?: readonly CompositionReconciliation[];
    readonly facts: OwnerFacts;
  };
};
