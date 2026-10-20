import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-migrations",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "vike-migrations",
  instance: "independent",
  defaultLeafName: "db-migrations",
  defaultPath: "packages/db-migrations",
  role: "shared-library",
  resources: ["."],
  authoring: {
    resources: ["template", "template-dist", "tsconfig.template.json"],
    dependencies: ["@ykdz/template-core", "@ykdz/template-workspace-authoring"],
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
});
