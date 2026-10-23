import { loadTemplateContent } from "./collection.ts";

/** 所有可选择内容只在这里登记一次，并从原生公开入口装载。 */
export const templateContent = await loadTemplateContent({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-ts-cli/template",
      load: () => import("@ykdz/reference-ts-cli/template"),
    },
    {
      specifier: "@ykdz/preset-ts-cli/template",
      load: () => import("@ykdz/preset-ts-cli/template"),
    },
    {
      specifier: "@ykdz/reference-rust-bin/template",
      load: () => import("@ykdz/reference-rust-bin/template"),
    },
    {
      specifier: "@ykdz/preset-rust-bin/template",
      load: () => import("@ykdz/preset-rust-bin/template"),
    },
    {
      specifier: "@ykdz/reference-vue-app/template",
      load: () => import("@ykdz/reference-vue-app/template"),
    },
    {
      specifier: "@ykdz/preset-vue-app/template",
      load: () => import("@ykdz/preset-vue-app/template"),
    },
    {
      specifier: "@ykdz/reference-hono-api/template",
      load: () => import("@ykdz/reference-hono-api/template"),
    },
    {
      specifier: "@ykdz/reference-vue-hono-web/template",
      load: () => import("@ykdz/reference-vue-hono-web/template"),
    },
    {
      specifier: "@ykdz/preset-vue-hono-app/template",
      load: () => import("@ykdz/preset-vue-hono-app/template"),
    },
    {
      specifier: "@ykdz/reference-vike-web/template",
      load: () => import("@ykdz/reference-vike-web/template"),
    },
    {
      specifier: "@ykdz/reference-vike-db/template",
      load: () => import("@ykdz/reference-vike-db/template"),
    },
    {
      specifier: "@ykdz/reference-vike-migrations/template",
      load: () => import("@ykdz/reference-vike-migrations/template"),
    },
    {
      specifier: "@ykdz/preset-vike-app/template",
      load: () => import("@ykdz/preset-vike-app/template"),
    },
  ],
});

export type { ContentKind } from "./collection.ts";
export type TemplateContentMember = (typeof templateContent)[number];
export type TemplatePreset = Extract<
  TemplateContentMember,
  { readonly kind: "preset" }
>;
export type TemplateReferencePackage = Extract<
  TemplateContentMember,
  { readonly kind: "reference" }
>;

export { deriveTemplateMembers } from "./template-members.ts";

export const templatePresets: readonly TemplatePreset[] =
  templateContent.filter(
    (member): member is TemplatePreset => member.kind === "preset",
  );
export const templateReferencePackages: readonly TemplateReferencePackage[] =
  templateContent.filter(
    (member): member is TemplateReferencePackage => member.kind === "reference",
  );
