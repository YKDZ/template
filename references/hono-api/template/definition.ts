import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "hono-api",
  instance: "independent",
  defaultLeafName: "api",
  defaultPath: "apps/api",
  role: "runtime-service",
  dependencies: [
    {
      key: "base-workspace",
      ownerLocal: {
        specifier: "@ykdz/reference-workspace-root/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
    {
      key: "tooling-config",
      ownerLocal: {
        specifier: "@ykdz/reference-tooling-config/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "src/index.ts" },
    { path: "src/runtime.ts" },
    { path: "src/server.ts" },
    { path: "test/app.test.ts" },
    { path: "tsconfig.build.json" },
    { path: "tsconfig.json" },
    { path: "turbo.json" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    { name: "@ykdz/reference-tooling-config", purpose: "target" },
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/reference-workspace-root",
      purpose: "template-execution",
    },
    { name: "@ykdz/template-core", purpose: "template-build" },
    { name: "@ykdz/template-workspace", purpose: "template-execution" },
    { name: "typescript-7", purpose: "target" },
    { name: "typescript-7", purpose: "template-build" },
  ],
  executionDependencies: [
    "@ykdz/reference-tooling-config",
    "@ykdz/reference-workspace-root",
    "@ykdz/template-workspace",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
});
