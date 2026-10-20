import { preset as tsLibPreset } from "@ykdz/preset-ts-lib/template";
import { preset as vueAppPreset } from "@ykdz/preset-vue-app/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as vueApp } from "@ykdz/reference-vue-app/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

const configuration = defineReferencePackage(configurationDefinition);

export const templateContent = [
  library,
  configuration,
  tsLibPreset,
  vueApp,
  vueShared,
  vueAppPreset,
] as const;
