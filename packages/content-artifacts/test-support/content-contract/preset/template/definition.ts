import { definePreset } from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import manifest from "../package.json" with { type: "json" };

const presetDefinition = {
  ...definePreset({
    metadata: {
      alias: "contract-preset",
      title: "合同验证预设",
      description: "用于验证原生内容类型合同的中立测试预设。",
    },
    operations: ["init", "add"],
    nodes: {
      library: {
        reference: {
          alias: "contract-reference",
          instance: "independent",
        },
        creationInput: {
          init: { projectName: "contract-starter" },
          add: { projectName: "contract-added" },
        },
      },
    },
  }),
  authorExtension: {
    channel: "preset-extension-v2" as const,
    describe() {
      return { flavor: "neutral-project-v2" as const, rank: 2 as const };
    },
  },
};

export const preset = defineNativeContentArtifact(presetDefinition, {
  manifest,
  resourceRoot: new URL("../", import.meta.url),
  exportPath: "./template",
  resources: [],
  executionDependencies: ["@ykdz/template-workspace-authoring"],
});
