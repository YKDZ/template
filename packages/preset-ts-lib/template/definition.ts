import { referencePackage } from "@ykdz/reference-ts-lib/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";

import presetPackage from "../package.json" with { type: "json" };

export const preset = definePreset({
  metadata: {
    alias: "ts-lib",
    title: "TypeScript 库",
    description: "采用 pnpm catalog 工具配置的严格 TypeScript 包。",
  },
  operations: ["init", "add"],
  owner: presetOwnerFromManifest(presetPackage),
  nodes: {
    library: { reference: referencePackage },
  },
});
