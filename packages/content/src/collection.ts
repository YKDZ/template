import type {
  ContentKind,
  LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type {
  PresetDefinition,
  PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import type { ContentSourceOptions } from "@ykdz/template-generator/content-source";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace-authoring/reference-package";

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

/** 使用唯一公开loader装载本次选中的内容成员。 */
export async function loadTemplateContent(options: {
  readonly namespace: string;
  readonly resolve: ContentSourceOptions["resolve"];
  readonly members: readonly string[];
}): Promise<readonly LoadedTemplateContentMember[]> {
  return (await loadContentSource({
    ...options,
    prepareReferenceDefinition(definition) {
      return defineReferencePackage(
        definition as Parameters<typeof defineReferencePackage>[0],
      );
    },
  })) as readonly LoadedTemplateContentMember[];
}

export type { ContentKind };
