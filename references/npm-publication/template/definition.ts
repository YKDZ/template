import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-npm-publication",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "npm-publication",
  instance: "shared",
  defaultLeafName: "npm-publication",
  defaultPath: "tools/npm-publication",
  role: "shared-library",
  resources: ["scripts", "tsconfig.json", "turbo.json"],
  template: {
    dependencies: [
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
    ],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions"],
      interval: "weekly",
    },
  },
});
