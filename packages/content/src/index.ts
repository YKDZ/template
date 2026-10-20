import { preset as rustBinPreset } from "@ykdz/preset-rust-bin/template";
import { preset as tsCliPreset } from "@ykdz/preset-ts-cli/template";
import { preset as tsLibPreset } from "@ykdz/preset-ts-lib/template";
import { preset as vikeAppPreset } from "@ykdz/preset-vike-app/template";
import { preset as vueAppPreset } from "@ykdz/preset-vue-app/template";
import { preset as vueHonoPreset } from "@ykdz/preset-vue-hono-app/template";
import { referencePackage as honoApi } from "@ykdz/reference-hono-api/template";
import { referencePackage as rustBin } from "@ykdz/reference-rust-bin/template";
import { referencePackage as tsCli } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as vikeDatabase } from "@ykdz/reference-vike-db/template";
import { referencePackage as vikeMigrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as vikeWeb } from "@ykdz/reference-vike-web/template";
import { referencePackage as vueApp } from "@ykdz/reference-vue-app/template";
import { referencePackage as vueHonoWeb } from "@ykdz/reference-vue-hono-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

const configuration = defineReferencePackage(configurationDefinition);

export const templateContent = [
  library,
  configuration,
  tsLibPreset,
  tsCli,
  tsCliPreset,
  rustBin,
  rustBinPreset,
  vueApp,
  vueShared,
  vueAppPreset,
  honoApi,
  vueHonoWeb,
  vueHonoPreset,
  vikeWeb,
  vikeDatabase,
  vikeMigrations,
  vikeAppPreset,
] as const;

type TemplateContentMember = (typeof templateContent)[number];

/** 从唯一内容集合派生的可选择预设成员。 */
export type TemplatePreset = Extract<
  TemplateContentMember,
  { readonly kind: "preset" }
>;

/** 从唯一内容集合派生的原生参考包闭包。 */
export type TemplateReferencePackage = Extract<
  TemplateContentMember,
  { readonly manifest: unknown }
>;

export const templatePresets: readonly TemplatePreset[] =
  templateContent.filter(
    (member): member is TemplatePreset =>
      "kind" in member && member.kind === "preset",
  );

export const templateReferencePackages: readonly TemplateReferencePackage[] =
  templateContent.filter(
    (member): member is TemplateReferencePackage => "manifest" in member,
  );
