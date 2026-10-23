import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-workspace-root",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "root",
  instance: "shared",
  defaultLeafName: "workspace",
  defaultPath: ".",
  role: "native-package",
  resources: [
    "scripts/task-gates.ts",
    "tsconfig.json",
    "tsconfig.config.json",
    "tsconfig.scripts.json",
  ],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      { name: "@ykdz/template-workspace", purpose: "template-execution" },
    ],
    scripts: [
      "build:template",
      "check:author-planning-roles",
      "typecheck:owner",
    ],
    exports: ["./task-gates"],
    resources: ["template", "tsconfig.template.json", "turbo.json"],
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
