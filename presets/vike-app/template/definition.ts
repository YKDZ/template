import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as web } from "@ykdz/reference-vike-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
  type PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { dockerEngineEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import type { GenerationContext } from "@ykdz/template-workspace/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";
import type { ProjectRequirement } from "@ykdz/template-workspace/project-requirements";

import presetPackage from "../package.json" with { type: "json" };

const owner = presetOwnerFromManifest(presetPackage, "./template");

function requireNode(
  nodeInstances: ReadonlyMap<string, PackageDefinition>,
  identity: string,
): PackageDefinition {
  const definition = nodeInstances.get(identity);
  if (definition === undefined) {
    throw new Error("Vike 应用预设缺少节点：" + identity);
  }
  return definition;
}

const nodes = {
  web: { reference: web },
  database: { reference: database },
  migrations: { reference: migrations },
};

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vike-app",
      title: "Vike 应用",
      description:
        "组合 Vike Web、数据库和迁移包，并投影应用级准备与部署任务。",
    },
    operations: ["init"],
    nodes,
    owner,
    project({
      nodeInstances,
    }: PresetProjectOptions<GenerationContext, PackageContribution>) {
      const application = requireNode(nodeInstances, "web");
      const databasePackage = requireNode(nodeInstances, "database");
      const migrationPackage = requireNode(nodeInstances, "migrations");
      const requirements: ProjectRequirement[] = [
        {
          kind: "sqlite-database-preparation",
          web: application,
          database: databasePackage,
          migrations: migrationPackage,
        },
        {
          kind: "application-container-with-database-migrations",
          application,
          database: databasePackage,
          migrations: migrationPackage,
          environmentNeeds: [dockerEngineEnvironmentNeed()],
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
