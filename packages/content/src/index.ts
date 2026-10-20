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

type LoadedTemplateContentMember =
  | LoadedContentMember<ReferencePackage, "reference">
  | LoadedContentMember<TemplatePresetDefinition, "preset">;

/** 所有可选择内容只在这里登记一次，并从原生公开入口装载。 */
export const templateContent = (await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-typescript-config/template",
    "@ykdz/preset-ts-lib/template",
    "@ykdz/reference-ts-cli/template",
    "@ykdz/preset-ts-cli/template",
    "@ykdz/reference-rust-bin/template",
    "@ykdz/preset-rust-bin/template",
    "@ykdz/reference-vue-app/template",
    "@ykdz/reference-vue-shared/template",
    "@ykdz/preset-vue-app/template",
    "@ykdz/reference-hono-api/template",
    "@ykdz/reference-vue-hono-web/template",
    "@ykdz/preset-vue-hono-app/template",
    "@ykdz/reference-vike-web/template",
    "@ykdz/reference-vike-db/template",
    "@ykdz/reference-vike-migrations/template",
    "@ykdz/preset-vike-app/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
})) as readonly LoadedTemplateContentMember[];

export type { ContentKind };
export type TemplateContentMember = (typeof templateContent)[number];

/** 从唯一内容集合派生的可选择预设成员。 */
export type TemplatePreset = Extract<
  TemplateContentMember,
  { readonly kind: "preset" }
>;

/** 从唯一内容集合派生的原生参考包闭包。 */
export type TemplateReferencePackage = Extract<
  TemplateContentMember,
  { readonly kind: "reference" }
>;

/** 从唯一内容序列派生预设成员和打包所需参考包成员。 */
export function deriveTemplateMembers<Content extends readonly unknown[]>(
  content: Content,
): {
  readonly presets: readonly Extract<
    Content[number],
    { readonly kind: "preset" }
  >[];
  readonly referencePackages: readonly Extract<
    Content[number],
    { readonly kind: "reference" }
  >[];
} {
  const presets: Extract<Content[number], { readonly kind: "preset" }>[] = [];
  const referencePackages: Extract<
    Content[number],
    { readonly kind: "reference" }
  >[] = [];
  for (const member of content) {
    if (typeof member !== "object" || member === null) continue;
    if ("kind" in member && member.kind === "preset") {
      presets.push(
        member as Extract<Content[number], { readonly kind: "preset" }>,
      );
    }
    if ("kind" in member && member.kind === "reference") {
      referencePackages.push(
        member as Extract<Content[number], { readonly kind: "reference" }>,
      );
    }
  }
  return { presets, referencePackages };
}

const templateMembers = deriveTemplateMembers(templateContent);
export const templatePresets: readonly TemplatePreset[] =
  templateMembers.presets;
export const templateReferencePackages: readonly TemplateReferencePackage[] =
  templateMembers.referencePackages;
