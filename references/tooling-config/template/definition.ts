import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "tooling-config",
  instance: "shared",
  defaultLeafName: "tooling-config",
  workspaceConfiguration: {
    kind: "typescript-workspace-configuration",
  },
  role: "shared-library",
  resources: [
    { path: "base.json" },
    { path: "node.json" },
    { path: "oxlint.config.ts" },
    { path: "oxfmt.config.ts" },
  ],
  compositionResources: [
    {
      path: "template/workspace/oxlint.config.ts",
      targetPath: "oxlint.config.ts",
    },
    {
      path: "template/workspace/oxfmt.config.ts",
      targetPath: "oxfmt.config.ts",
    },
  ],
  templateDependencies: [
    {
      name: "@ykdz/template-workspace",
      purpose: "template-execution",
    },
  ],
  executionDependencies: ["@ykdz/template-workspace"],
  templateScripts: ["build:template", "check:author-planning-roles"],
  templateExports: ["./reference", "./template"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: [],
});
