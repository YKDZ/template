import { referencePackage } from "@ykdz/reference-ts-lib/template";
import { definePreset } from "@ykdz/template-core/preset-definition";

export const preset = definePreset({
  metadata: {
    alias: "ts-lib",
    title: "TypeScript 库",
    description: "采用 pnpm catalog 工具配置的严格 TypeScript 包。",
  },
  operations: ["init", "add"],
  nodes: {
    library: { reference: referencePackage },
  },
});
