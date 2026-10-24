import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const workspaceRootIdentity = Object.freeze({
  namespace: "ykdz",
  packageName: referenceManifest.name,
  exportPath: "./template",
});

export const workspaceRootNextSteps = Object.freeze([
  { display: "pnpm install" },
  { display: "pnpm run fix" },
  { display: "pnpm run check" },
]);

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "root",
  instance: "shared",
  defaultLeafName: "workspace",
  defaultPath: ".",
  targetName: ({ conventions }) => conventions.repositoryName,
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
    {
      path: "resources/agent-instructions.md",
      targetPath: "AGENTS.md",
    },
    { path: "scripts/task-gates.ts" },
    { path: "tsconfig.json" },
    { path: "tsconfig.config.json" },
    { path: "tsconfig.scripts.json" },
    { path: "template/files/turbo.json", targetPath: "turbo.json" },
    { path: "resources/environment/base.Dockerfile", prepareOnly: true },
    {
      path: "resources/environment/devcontainer/browser-test.Dockerfile",
      prepareOnly: true,
    },
    {
      path: "resources/environment/devcontainer/github-cli.Dockerfile",
      prepareOnly: true,
    },
    {
      path: "resources/environment/devcontainer/shellcheck.Dockerfile",
      prepareOnly: true,
    },
    {
      path: "resources/environment/devcontainer/workspace-template.json",
      prepareOnly: true,
    },
    {
      path: "resources/environment/editor-customization/capabilities.json",
      prepareOnly: true,
    },
    { path: "resources/github/check.yml", prepareOnly: true },
    { path: "resources/github/dependabot.yml", prepareOnly: true },
    { path: "resources/next-steps.md", prepareOnly: true },
  ],
  compositionResources: [
    { path: "resources/gitignore", targetPath: ".gitignore" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    {
      name: "@ykdz/template-core",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/template-environment",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "valibot", purpose: "template-execution" },
    { name: "yaml", purpose: "template-execution" },
  ],
  executionDependencies: [
    "@ykdz/default-content-authoring",
    "@ykdz/template-core",
    "@ykdz/template-environment",
    "valibot",
    "yaml",
  ],
  templateScripts: [
    "build:template",
    "check:author-planning-roles",
    "typecheck:owner",
  ],
  templateExports: [
    "./reference",
    "./template",
    "./task-gates",
    "./environment",
    "./project-github",
  ],
  transformManifest: ({ manifest, conventions, stableCommon }) => {
    const rootManifest: Record<string, unknown> = {
      ...manifest,
      name: conventions.repositoryName,
    };
    delete rootManifest.version;
    if (typeof stableCommon !== "object" || stableCommon === null) {
      return rootManifest;
    }
    const stableFacts = stableCommon as {
      readonly nodeDeclaration?: unknown;
      readonly packageManagerPin?: unknown;
    };
    if (typeof stableFacts.nodeDeclaration === "string") {
      const engines =
        typeof rootManifest.engines === "object" &&
        rootManifest.engines !== null &&
        !Array.isArray(rootManifest.engines)
          ? (rootManifest.engines as Record<string, unknown>)
          : {};
      rootManifest.engines = {
        ...engines,
        node: stableFacts.nodeDeclaration,
      };
    }
    if (typeof stableFacts.packageManagerPin === "string") {
      rootManifest.packageManager = stableFacts.packageManagerPin;
    }
    return rootManifest;
  },
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
