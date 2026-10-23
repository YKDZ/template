import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-ts-lib",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "library",
  instance: "independent",
  defaultLeafName: "lib",
  role: "shared-library",
  resources: ["."],
  template: {
    dependencies: [
      {
        name: "@ykdz/reference-npm-publication",
        purpose: "template-execution",
      },
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
    ],
    scripts: ["build:template", "check:author-planning-roles"],
    resources: ["template", "tsconfig.template.json"],
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
