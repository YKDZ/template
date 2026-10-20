import type {
  ContentKind,
  LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type {
  PresetDefinition,
  PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { ReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

type TemplatePresetDefinition = PresetDefinition<
  ReferencePackage,
  unknown,
  PackageCreationInput,
  PresetProjectOptions<GenerationContext, PackageContribution>,
  unknown
>;

export type LoadedTemplateContentMember =
  | LoadedContentMember<ReferencePackage, "reference">
  | LoadedContentMember<TemplatePresetDefinition, "preset">;

export type TemplateContentTypes<Content extends readonly unknown[]> = {
  readonly member: Content[number];
  readonly preset: Extract<Content[number], { readonly kind: "preset" }>;
  readonly reference: Extract<Content[number], { readonly kind: "reference" }>;
};

export type { ContentKind };
