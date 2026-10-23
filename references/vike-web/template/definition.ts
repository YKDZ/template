import type { ReferenceDependency } from "@ykdz/template-core/reference-package";
import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-workspace/default-environment";
import {
  defineReferencePackage,
  type ReferenceTemplateDependency,
} from "@ykdz/template-workspace/reference-package";

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

const templateDependencies = [
  { name: "@ykdz/reference-tooling-config", purpose: "target" },
  {
    name: "@ykdz/reference-tooling-config",
    purpose: "template-execution",
  },
  { name: "@ykdz/tooling-config", purpose: "template-build" },
  {
    name: "@ykdz/reference-workspace-root",
    purpose: "template-execution",
  },
  { name: "@ykdz/template-core", purpose: "template-execution" },
  { name: "@ykdz/template-workspace", purpose: "template-execution" },
  { name: "typescript-7", purpose: "template-build" },
] as const satisfies readonly ReferenceTemplateDependency[];

const targetDependencyNames = new Set<string>(
  templateDependencies
    .filter(({ purpose }) => purpose === "target")
    .map(({ name }) => name),
);
const templateOnlyDependencyNames = new Set<string>(
  templateDependencies
    .filter(
      ({ purpose }) =>
        purpose === "template-execution" || purpose === "template-build",
    )
    .map(({ name }) => name)
    .filter((name) => !targetDependencyNames.has(name)),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeTemplateTaskDependencies(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value.tasks)) return value;

  let changed = false;
  const projectedTasks: Record<string, unknown> = {};
  for (const [name, task] of Object.entries(value.tasks)) {
    if (!isRecord(task) || !Array.isArray(task.dependsOn)) {
      projectedTasks[name] = task;
      continue;
    }
    const dependsOn = task.dependsOn.filter((dependency: unknown) => {
      if (typeof dependency !== "string") return true;
      const separator = dependency.indexOf("#");
      return (
        separator < 0 ||
        !templateOnlyDependencyNames.has(dependency.slice(0, separator))
      );
    });
    if (dependsOn.length === task.dependsOn.length) {
      projectedTasks[name] = task;
      continue;
    }
    changed = true;
    projectedTasks[name] = { ...task, dependsOn };
  }
  return changed ? { ...value, tasks: projectedTasks } : value;
}

export const databaseDependencyKey = databaseDependency.key;

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "vike-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  dependencies: [
    baseWorkspaceDependency,
    toolingConfigDependency,
    databaseDependency,
  ],
  resources: [
    { path: "+server.ts" },
    { path: ".env.example" },
    { path: "TESTING.md" },
    { path: "assets/logo.svg" },
    { path: "components/PageShell.vue" },
    { path: "pages/+Head.vue" },
    { path: "pages/+Layout.vue" },
    { path: "pages/+config.ts" },
    { path: "pages/index/+Page.telefunc.ts" },
    { path: "pages/index/+Page.vue" },
    { path: "pages/tailwind.css" },
    { path: "playwright.config.ts" },
    { path: "server/api.ts" },
    { path: "server/app.ts" },
    { path: "server/database.ts" },
    { path: "test/e2e/app.spec.ts" },
    { path: "test/playwright-teardown.ts" },
    { path: "test/todos.browser.test.ts" },
    { path: "tooling/vite.ts" },
    { path: "tsconfig.app.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
    { path: "types/env.d.ts" },
    { path: "types/global.d.ts" },
    { path: "vite.config.ts" },
    { path: "vitest.config.ts" },
  ],
  templateDependencies,
  executionDependencies: [
    "@ykdz/template-core",
    "@ykdz/template-workspace",
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
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: ["apps/*"],
  },
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  ciDiagnosticArtifacts: ({ definition }) => [
    {
      kind: "playwright",
      owner: { kind: "package-boundary", path: definition.path },
    },
    {
      kind: "vitest-browser",
      owner: { kind: "package-boundary", path: definition.path },
    },
  ],
  transformDocument: ({ path, value }) =>
    path === "turbo.json" ? removeTemplateTaskDependencies(value) : value,
});
