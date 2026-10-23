import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import {
  createTemplateSourceHandle,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };
import {
  composeVueHonoJointE2e,
  prepareVueHonoJointE2eResources,
  vueHonoJointE2eResourcePaths,
} from "./joint-e2e.ts";

const resourceRoot = new URL("../", import.meta.url);
const resourceSource = createTemplateSourceHandle(fileURLToPath(resourceRoot));
const jointE2eResources = Object.values(vueHonoJointE2eResourcePaths);

function prepareJointE2eAttachment() {
  return prepareVueHonoJointE2eResources(
    jointE2eResources.map((path) => ({
      path,
      content: new Uint8Array(
        readFileSync(resolveTemplateSource(resourceSource, path)),
      ),
      mode: 0o644,
    })),
  );
}

const nativePreset = defineNativeContentArtifact(
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
    owner: presetOwnerFromManifest(presetPackage, "./template"),
  }),
  {
    manifest: presetPackage,
    resourceRoot,
    exportPath: "./template",
    resources: jointE2eResources.map((path) => ({
      path,
      source: resourceSource,
      mode: 0o644,
    })),
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);

/** 供外层按持久预设身份准备，并交正式组合器消费的联合附件。 */
export const preset = Object.freeze({
  ...nativePreset,
  jointE2e: Object.freeze({
    prepare: prepareJointE2eAttachment,
    compose: composeVueHonoJointE2e,
  }),
});
