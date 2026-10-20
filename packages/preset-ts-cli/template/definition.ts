import {
  referencePackage,
  tsCliPublicCandidateCreationInput,
  type TsCliCreationInput,
} from "@ykdz/reference-ts-cli/template";
import { definePreset } from "@ykdz/template-core/preset-definition";

export const preset = definePreset({
  metadata: {
    alias: "ts-cli",
    title: "TypeScript 命令行工具",
    description: "采用 pnpm catalog 工具配置的 TypeScript 命令行包。",
  },
  operations: ["init", "add"],
  nodes: {
    cli: {
      reference: referencePackage,
      creationInput: {
        init: tsCliPublicCandidateCreationInput,
        add: { variant: "private" } satisfies TsCliCreationInput,
      },
    },
  },
});
