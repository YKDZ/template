import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-db",
  resolve: (specifier) => import.meta.resolve(specifier),
  alias: "vike-database",
  instance: "independent",
  defaultLeafName: "db",
  defaultPath: "packages/db",
  role: "shared-library",
  resources: ["."],
  template: {
    resources: ["template", "tsconfig.template.json"],
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace-authoring",
        purpose: "template-execution",
      },
    ],
    scripts: ["build:template", "typecheck:template"],
  },
  foundation: ({ definition }) => ({
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: [`${definition.path.split("/")[0]}/*`],
  }),
  environmentNeeds: [],
  project: (contribution) => ({
    ...contribution,
    manifest: { ...contribution.manifest, files: ["dist"] },
  }),
});

/** 根拥有跨包准备顺序；真实依赖图无需反向依赖应用或迁移包。 */
export function databasePreparation(options: {
  readonly web: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): NonNullable<PackageContribution["foundation"]["databasePreparation"]> {
  return {
    kind: "sqlite-database-preparation",
    migrationPackageName: options.migrations.name,
    consumers: [
      { kind: "application-dev", packageName: options.web.name },
      { kind: "database-test", packageName: options.database.name },
      { kind: "application-e2e", packageName: options.web.name },
    ],
  };
}
