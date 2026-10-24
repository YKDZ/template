import { referencePackage } from "@ykdz/reference-ts-lib/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "ts-lib",
      title: "TypeScript 库",
      description: "采用 pnpm catalog 工具配置的严格 TypeScript 包。",
    },
    operations: ["init", "add"],
    owner: presetOwnerFromManifest(presetPackage, "./template"),
    nodes: {
      library: { reference: referencePackage },
    },
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);
