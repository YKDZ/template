import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import {
  honoApiDependencyKey,
  referencePackage as web,
} from "@ykdz/reference-vue-hono-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import {
  createTemplateSourceHandle,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import type { DefaultPresetRootContributionOwner } from "@ykdz/template-workspace/default-composition";

import presetPackage from "../package.json" with { type: "json" };
import {
  composeVueHonoJointE2e,
  vueHonoJointE2eResourcePaths,
  type VueHonoJointE2eOwnerFacts,
} from "./joint-e2e.ts";

const resourceRoot = new URL("../", import.meta.url);
const resourceSource = createTemplateSourceHandle(fileURLToPath(resourceRoot));
const jointE2eResources = Object.values(vueHonoJointE2eResourcePaths);

function prepareJointE2eAttachment(): {
  readonly ownerFacts: VueHonoJointE2eOwnerFacts;
} {
  return Object.freeze({
    ownerFacts: Object.freeze({
      resources: Object.freeze(
        jointE2eResources.map((path) =>
          Object.freeze({
            path,
            content: new Uint8Array(
              readFileSync(resolveTemplateSource(resourceSource, path)),
            ),
            mode: 0,
          }),
        ),
      ),
    }),
  });
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
      web: {
        reference: web,
        dependencyBindings: { [honoApiDependencyKey]: "api" },
      },
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
      source: createTemplateSourceHandle(
        resolveTemplateSource(resourceSource, path),
      ),
      mode: 0o644,
    })),
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);

const rootContribution: DefaultPresetRootContributionOwner<VueHonoJointE2eOwnerFacts> =
  Object.freeze({
    prepare: prepareJointE2eAttachment,
    compose: composeVueHonoJointE2e,
  });

/** 由默认外层按完整预设身份准备，并交纯组合器消费的根贡献。 */
export const preset = Object.freeze({
  ...nativePreset,
  rootContribution,
});

export type { VueHonoJointE2eOwnerFacts } from "./joint-e2e.ts";
