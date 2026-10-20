import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-migrations",
  resolve: (specifier) => import.meta.resolve(specifier),
  alias: "vike-migrations",
  instance: "independent",
  defaultLeafName: "db-migrations",
  defaultPath: "packages/db-migrations",
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
    manifest: {
      ...contribution.manifest,
      files: ["drizzle.config.ts", "drizzle/migrations"],
    },
  }),
});
