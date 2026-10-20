import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import {
  dockerEngineEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
} from "@ykdz/template-environment/module-graph";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-web",
  resolve: (specifier) => import.meta.resolve(specifier),
  alias: "vike-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  resources: ["."],
  template: {
    resources: ["template", "tsconfig.template.json"],
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      { name: "@ykdz/template-environment", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace-authoring",
        purpose: "template-execution",
      },
      { name: "typescript-7", purpose: "template-execution" },
    ],
    scripts: ["build:template", "typecheck:template"],
  },
  foundation: ({ definition }) => ({
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: [`${definition.path.split("/")[0]}/*`],
  }),
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  project: (contribution, { definition }) => ({
    ...contribution,
    manifest: { ...contribution.manifest, files: ["dist"] },
    ciDiagnosticArtifacts: [
      {
        kind: "playwright",
        owner: { kind: "package-boundary", path: definition.path },
      },
      {
        kind: "vitest-browser",
        owner: { kind: "package-boundary", path: definition.path },
      },
    ],
  }),
});

type DeploymentCheck = NonNullable<
  PackageContribution["foundation"]["deploymentCheck"]
>;

/** 部署资源由根共同能力提供，应用仅声明参与部署的公开包身份。 */
export function deploymentCheck(options: {
  readonly web: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
  readonly sources: DeploymentCheck["sources"];
}): DeploymentCheck {
  return {
    kind: "application-container-with-database-migrations",
    applicationPackageName: options.web.name,
    databasePackageName: options.database.name,
    migrationPackageName: options.migrations.name,
    environmentNeeds: [dockerEngineEnvironmentNeed()],
    sources: options.sources,
  };
}
