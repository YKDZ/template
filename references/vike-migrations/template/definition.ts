import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";
import type { ReferenceDependency } from "@ykdz/template-core/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

const databaseDependency = {
  key: "database" as const,
  ownerLocal: {
    specifier: "@ykdz/reference-vike-db/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

const baseWorkspaceDependency = {
  key: "base-workspace" as const,
  ownerLocal: {
    specifier: "@ykdz/reference-workspace-root/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

const toolingConfigDependency = {
  key: "tooling-config" as const,
  ownerLocal: {
    specifier: "@ykdz/reference-tooling-config/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

export const databaseDependencyKey = databaseDependency.key;

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "vike-migrations",
  instance: "independent",
  defaultLeafName: "db-migrations",
  defaultPath: "packages/db-migrations",
  role: "shared-library",
  dependencies: [
    baseWorkspaceDependency,
    toolingConfigDependency,
    databaseDependency,
  ],
  resources: [
    { path: "drizzle.config.ts" },
    {
      path: "drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
    },
    {
      path: "drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
    },
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
    {
      name: "@ykdz/template-core",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "typescript-7", purpose: "target" },
    { name: "typescript-7", purpose: "template-build" },
  ],
  executionDependencies: [
    "@ykdz/template-core",
    "@ykdz/default-content-authoring",
    "@ykdz/reference-workspace-root",
    "@ykdz/reference-tooling-config",
  ],
  templateScripts: [
    "build:template",
    "typecheck:template",
    "check:author-planning-roles",
  ],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: ["packages/*"],
  },
  environmentNeeds: [],
});
