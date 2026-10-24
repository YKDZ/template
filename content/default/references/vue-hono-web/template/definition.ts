import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/default-content-authoring/environment-needs";
import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

/** Hono API 与 web 之间保持稳定的原生依赖绑定键。 */
export const honoApiDependencyKey = "hono-api";

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "vue-hono-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
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
    {
      key: honoApiDependencyKey,
      ownerLocal: {
        specifier: "@ykdz/reference-hono-api/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "TESTING.md" },
    { path: "env.d.ts" },
    { path: "index.html" },
    { path: "src/App.vue" },
    { path: "src/api.ts" },
    { path: "src/main.ts" },
    { path: "src/style.css" },
    { path: "test/app.browser.test.ts" },
    { path: "tsconfig.app.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
    { path: "vite.config.ts" },
    { path: "vitest.config.ts" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    { name: "@ykdz/reference-hono-api", purpose: "target" },
    {
      name: "@ykdz/reference-hono-api",
      purpose: "template-execution",
    },
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
    { name: "@ykdz/default-content-authoring", purpose: "template-execution" },
  ],
  executionDependencies: [
    "@ykdz/reference-hono-api",
    "@ykdz/reference-tooling-config",
    "@ykdz/reference-workspace-root",
    "@ykdz/default-content-authoring",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  ciDiagnosticArtifacts: ({ definition }) => [
    {
      kind: "vitest-browser",
      owner: { kind: "package-boundary", path: definition.path },
    },
  ],
});
