import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-hono-api",
  resolve: (specifier) => import.meta.resolve(specifier),
  alias: "hono-api",
  instance: "independent",
  defaultLeafName: "api",
  defaultPath: "apps/api",
  role: "runtime-service",
  resources: ["."],
  authoring: {
    dependencies: ["@ykdz/template-core", "@ykdz/template-workspace-authoring"],
    scripts: ["build:template"],
    resources: ["template", "template-dist", "tsconfig.template.json"],
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
