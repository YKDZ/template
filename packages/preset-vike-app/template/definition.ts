import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as web } from "@ykdz/reference-vike-web/template";
import {
  definePreset,
  type PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { dockerEngineEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { ProjectRequirement } from "@ykdz/template-workspace-authoring/project-requirements";

import presetPackage from "../package.json" with { type: "json" };

const templateExportPath = Object.entries(presetPackage.exports).find(
  ([exportPath, definition]) =>
    (exportPath === "." || exportPath.startsWith("./")) &&
    typeof definition === "object" &&
    definition !== null &&
    "source" in definition &&
    definition.source === "./template/definition.ts",
)?.[0];

if (templateExportPath === undefined) {
  throw new Error("Vike 预设包清单未公开当前模板入口");
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
    throw new Error("Vike 应用预设缺少节点：" + identity);
  }
  return definition;
}

const nodes = {
  web: { reference: web },
  database: { reference: database },
  migrations: { reference: migrations },
};

export const preset = definePreset({
  metadata: {
    alias: "vike-app",
    title: "Vike 应用",
    description: "组合 Vike Web、数据库和迁移包，并投影应用级准备与部署任务。",
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
});
