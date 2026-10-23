import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "root",
  instance: "shared",
  defaultLeafName: "workspace",
  defaultPath: ".",
  role: "native-package",
  dependencies: [
    {
      key: "tooling-config",
      ownerLocal: {
        specifier: "@ykdz/reference-tooling-config/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "scripts/task-gates.ts" },
    { path: "tsconfig.json" },
    { path: "tsconfig.config.json" },
    { path: "tsconfig.scripts.json" },
    { path: "template/files/turbo.json", targetPath: "turbo.json" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    {
      name: "@ykdz/template-core",
      purpose: "template-build",
    },
    {
      name: "@ykdz/template-workspace",
      purpose: "template-execution",
    },
  ],
  executionDependencies: ["@ykdz/template-workspace"],
  templateScripts: [
    "build:template",
    "check:author-planning-roles",
    "typecheck:owner",
  ],
  templateExports: ["./reference", "./template", "./task-gates"],
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
