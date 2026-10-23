import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "library",
  instance: "independent",
  defaultLeafName: "lib",
  role: "shared-library",
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
  rootAttachmentDependencies: [
    {
      key: "npm-publication",
      ownerLocal: {
        specifier: "@ykdz/reference-npm-publication/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "resources/gitignore", targetPath: ".gitignore" },
    { path: "resources/npmignore", targetPath: ".npmignore" },
    { path: "src/index.ts" },
    { path: "src/name-schema.ts" },
    { path: "test/greet.test.ts" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "tsconfig.build.json" },
    { path: "turbo.json" },
  ],
  templateDependencies: [
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "target",
    },
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "template-execution",
    },
    { name: "@ykdz/template-core", purpose: "template-build" },
    {
      name: "@ykdz/template-workspace",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/reference-workspace-root",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/reference-npm-publication",
      purpose: "template-execution",
    },
  ],
  executionDependencies: [
    "@ykdz/template-workspace",
    "@ykdz/reference-workspace-root",
    "@ykdz/reference-tooling-config",
    "@ykdz/reference-npm-publication",
  ],
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
