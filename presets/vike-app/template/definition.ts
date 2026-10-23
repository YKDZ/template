import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import {
  databaseDependencyKey as migrationsDatabaseDependencyKey,
  referencePackage as migrations,
} from "@ykdz/reference-vike-migrations/template";
import {
  databaseDependencyKey as webDatabaseDependencyKey,
  referencePackage as web,
} from "@ykdz/reference-vike-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import type { DefaultPresetRootContributionOwner } from "@ykdz/template-workspace/default-composition";

import presetPackage from "../package.json" with { type: "json" };
import {
  vikeDeploymentResources,
  vikeRootContribution,
  type VikeDeploymentOwnerFacts,
} from "./deployment.ts";

const owner = presetOwnerFromManifest(presetPackage, "./template");

const nodes = {
  web: {
    reference: web,
    dependencyBindings: { [webDatabaseDependencyKey]: "database" },
  },
  database: { reference: database },
  migrations: {
    reference: migrations,
    dependencyBindings: { [migrationsDatabaseDependencyKey]: "database" },
  },
};

const nativePreset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vike-app",
      title: "Vike 应用",
      description: "组合 Vike Web、数据库和迁移包，提供数据库准备与部署能力。",
    },
    operations: ["init"],
    nodes,
    owner,
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    resources: vikeDeploymentResources,
    executionDependencies: [
      "@ykdz/template-workspace",
      "@ykdz/template-workspace-authoring",
      "yaml",
    ],
  },
);

/** 外层按完整预设身份准备资源，纯组合消费同次正式包求值结果。 */
export const preset = Object.freeze({
  ...nativePreset,
  rootContribution:
    vikeRootContribution satisfies DefaultPresetRootContributionOwner<VikeDeploymentOwnerFacts>,
});
