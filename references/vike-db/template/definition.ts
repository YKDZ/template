import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-vike-db",
  // 私有原生清单未声明 npm 版本，给制品显式提供未发布坐标。
  artifactVersion: "0.0.0",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
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
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
    ],
    scripts: [
      "build:template",
      "typecheck:template",
      "check:author-planning-roles",
    ],
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
