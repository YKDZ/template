import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
  type PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { ProjectRequirement } from "@ykdz/template-workspace-authoring/project-requirements";

import presetPackage from "../package.json" with { type: "json" };

const owner = presetOwnerFromManifest(presetPackage, "./template");

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

export const preset = defineNativeContentArtifact(
  definePreset({
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
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);
