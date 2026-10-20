import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-ts-lib",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "library",
  instance: "independent",
  defaultLeafName: "lib",
  role: "shared-library",
  resources: ["."],
  authoring: {
    dependencies: ["@ykdz/template-core", "@ykdz/template-workspace-authoring"],
    scripts: ["build:template"],
    resources: ["template", "template-dist", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
});
