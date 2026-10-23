import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";
import type { ReferencePackage } from "@ykdz/template-workspace/reference-package";

import { projectChangesetsWorkspace } from "./workspace.ts";

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-npm-publication",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "npm-publication",
  instance: "shared",
  defaultLeafName: "npm-publication",
  defaultPath: "tools/npm-publication",
  role: "shared-library",
  resources: [
    "README.md",
    ".changeset/config.json",
    "resources/gitignore",
    "resources/release.yml",
  ],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      { name: "@ykdz/template-workspace", purpose: "template-execution" },
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

type PublicationConsumer = Pick<ReferencePackage, "dependencyUses">;

/** 只有显式依赖本参考模板内容的组合才取得 Changesets 根贡献。 */
export function projectPublicationWorkspace(options: {
  readonly references: readonly PublicationConsumer[];
}) {
  const required = options.references.some((reference) =>
    reference.dependencyUses.some(
      ({ name, purposes }) =>
        name === referencePackage.manifest.name &&
        purposes.includes("template-execution"),
    ),
  );
  return required ? projectChangesetsWorkspace(referencePackage.manifest) : [];
}
