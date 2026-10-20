import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import {
  definePreset,
  type PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import type { ProjectRequirement } from "@ykdz/template-workspace-authoring/project-requirements";

import presetPackage from "../package.json" with { type: "json" };

const templateExportPath = Object.entries(presetPackage.exports).find(
  ([exportPath, definition]) =>
    exportPath.startsWith("./") &&
    typeof definition === "object" &&
    definition !== null &&
    "source" in definition &&
    definition.source === "./template/definition.ts",
)?.[0];

if (templateExportPath === undefined) {
  throw new Error("Vue-Hono 预设包清单未公开当前模板入口");
}

const owner = {
  packageName: presetPackage.name,
  exportPath: templateExportPath,
};

function requireNode(
  nodeInstances: ReadonlyMap<string, PackageDefinition>,
  identity: string,
): PackageDefinition {
  const definition = nodeInstances.get(identity);
  if (definition === undefined) {
    throw new Error("Vue-Hono 预设缺少节点：" + identity);
  }
  return definition;
}

export const preset = definePreset({
  metadata: {
    alias: "vue-hono-app",
    title: "Vue-Hono 全栈应用",
    description: "组合 Vue 页面、Hono API 与参考包提供的共享能力。",
  },
  operations: ["init"],
  nodes: {
    web: { reference: web },
    api: { reference: api },
  },
  owner,
  project({
    nodeInstances,
  }: PresetProjectOptions<GenerationContext, PackageContribution>) {
    const webPackage = requireNode(nodeInstances, "web");
    const apiPackage = requireNode(nodeInstances, "api");
    const requirements: ProjectRequirement[] = [
      {
        kind: "vue-hono-joint-e2e",
        web: webPackage,
        api: apiPackage,
      },
    ];
    return requirements;
  },
});
