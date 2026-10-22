import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import {
  projectChangesetsWorkspace,
  type PublicationWorkspaceOptions,
} from "./workspace.ts";

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

export function projectPublicationWorkspace(
  options: PublicationWorkspaceOptions,
) {
  return projectChangesetsWorkspace(options, referencePackage.manifest);
}

export {
  normalizePublicationConfiguration,
  projectPublicationTarget,
  isPublicationEnabled,
} from "./target.ts";
