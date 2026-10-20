import { referencePackage } from "@ykdz/reference-vue-app/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";

import presetPackage from "../package.json" with { type: "json" };

export const preset = definePreset({
  metadata: {
    alias: "vue-app",
    title: "Vue 应用",
    description: "使用 Vite、Tailwind、Pinia 和测试工具的 Vue 应用工作区。",
  },
  operations: ["init", "add"],
  owner: presetOwnerFromManifest(presetPackage),
  nodes: {
    web: { reference: referencePackage },
  },
});
