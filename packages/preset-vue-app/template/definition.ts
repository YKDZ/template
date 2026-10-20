import { referencePackage } from "@ykdz/reference-vue-app/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vue-app",
      title: "Vue 应用",
      description: "使用 Vite、Tailwind、Pinia 和测试工具的 Vue 应用工作区。",
    },
    operations: ["init", "add"],
    owner: presetOwnerFromManifest(presetPackage, "./template"),
    nodes: {
      web: { reference: referencePackage },
    },
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);
