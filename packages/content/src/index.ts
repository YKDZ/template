import {
  loadTemplateContent,
  type LoadedTemplateContentMember,
} from "./collection.ts";
import type { TemplateContentTypes } from "./template-content-types.ts";
import { deriveTemplateMembers as deriveContentMembers } from "./template-members.ts";

/** 所有可选择内容只在这里登记一次，并从原生公开入口装载。 */
export const templateContent = (await loadTemplateContent({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-npm-publication/template",
    "@ykdz/reference-tooling-config/template",
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
})) as readonly LoadedTemplateContentMember[];

export type { ContentKind } from "./collection.ts";
type ContentTypes = TemplateContentTypes<typeof templateContent>;
export type TemplateContentMember = ContentTypes["member"];

/** 从唯一内容集合派生的可选择预设成员。 */
export type TemplatePreset = ContentTypes["preset"];

/** 从唯一内容集合派生的原生参考包闭包。 */
export type TemplateReferencePackage = ContentTypes["reference"];

export { deriveTemplateMembers } from "./template-members.ts";

const templateMembers = deriveContentMembers(templateContent);
export const templatePresets: readonly TemplatePreset[] =
  templateMembers.presets;
export const templateReferencePackages: readonly TemplateReferencePackage[] =
  templateMembers.referencePackages;
