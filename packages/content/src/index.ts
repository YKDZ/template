import { preset as tsLibPreset } from "@ykdz/preset-ts-lib/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

const configuration = defineReferencePackage(configurationDefinition);

export const templateContent = [library, configuration, tsLibPreset] as const;
