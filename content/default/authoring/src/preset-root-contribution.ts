import type {
  CompositionPackage,
  CompositionPackageEvaluation,
} from "@ykdz/template-core/composition";
import type { ContentIdentity } from "@ykdz/template-core/content-identity";
import type { GenerationRecordSelection } from "@ykdz/template-core/generation-record";
import type { PackageDefinitionId } from "@ykdz/template-core/project-blueprint";
import type { CurrentProjectProjectionEntry } from "@ykdz/template-core/project-projection";

import type {
  DefaultReferenceContributionFacts,
  DefaultRootDeclarationData,
} from "./contracts.ts";

export type DefaultPresetRootContributionResource = Readonly<{
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
}>;

export type DefaultPresetRootContributionPrepared<OwnerFacts = unknown> =
  Readonly<{
    readonly ownerFacts: OwnerFacts;
    readonly readFacts?: readonly CurrentProjectProjectionEntry[];
  }>;

export type DefaultPresetPackageEvaluation = CompositionPackageEvaluation<
  DefaultReferenceContributionFacts<unknown>
>;

export type DefaultPresetRootContributionOwner<OwnerFacts = unknown> =
  Readonly<{
    prepare(options: {
      readonly ownerIdentity: ContentIdentity;
      readonly repositoryRoot?: string;
      readonly selection?: GenerationRecordSelection;
      /** 仅包含该完整预设身份的持久节点，按 nodeIdentity 索引。 */
      readonly selectedPackages?: ReadonlyMap<string, CompositionPackage>;
    }):
      | DefaultPresetRootContributionPrepared<OwnerFacts>
      | Promise<DefaultPresetRootContributionPrepared<OwnerFacts>>;
    compose(
      options: Readonly<{
        readonly ownerIdentity: ContentIdentity;
        readonly selection: GenerationRecordSelection;
        /** 仅包含该持久选择的节点，按 nodeIdentity 索引。 */
        readonly selectedPackages: ReadonlyMap<
          string,
          DefaultPresetPackageEvaluation
        >;
        readonly rootPackage: CompositionPackage;
        readonly ownerFacts: OwnerFacts;
      }>,
    ): Readonly<{
      readonly rootPackageDefinitionId: PackageDefinitionId;
      readonly rootDeclaration: DefaultRootDeclarationData;
    }>;
  }>;
