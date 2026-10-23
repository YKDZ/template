import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-workspace/default-environment";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "vue-app",
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
  ],
  resources: [
    { path: "TESTING.md" },
    { path: "env.d.ts" },
    { path: "index.html" },
    { path: "playwright.config.ts" },
    { path: "src/App.vue" },
    { path: "src/components/CounterButton.vue" },
    { path: "src/main.ts" },
    { path: "src/stores/counter.ts" },
    { path: "src/style.css" },
    { path: "test/app.browser.test.ts" },
    { path: "test/counter.node.test.ts" },
    { path: "test/e2e/app.spec.ts" },
    { path: "tsconfig.app.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
    { path: "vite.config.ts" },
    { path: "vitest.config.ts" },
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
    {
      kind: "playwright",
      owner: { kind: "package-boundary", path: definition.path },
    },
  ],
});
