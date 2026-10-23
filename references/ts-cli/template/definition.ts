import { projectCliPackageManifest } from "@ykdz/reference-ts-cli/command-identity";
import type { JsonValue } from "@ykdz/template-core/json";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export type TsCliCreationInput = Readonly<Record<string, JsonValue>> & {
  readonly linkTo?:
    | Readonly<{ readonly nodeIdentity: string }>
    | Readonly<{ readonly packageDefinitionId: string }>;
};

function nodeDeclarationFrom(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("nodeDeclaration" in value) ||
    typeof value.nodeDeclaration !== "string"
  ) {
    throw new Error("CLI 生成需要默认组合提供有效的 Node 声明");
  }
  return value.nodeDeclaration;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const referencePackage = defineReferencePackage<TsCliCreationInput>({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "cli-package-addition",
  instance: "independent",
  defaultLeafName: "cli",
  role: "cli-tool",
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
    { path: "src/cli.ts" },
    { path: "src/main.ts" },
    { path: "src/publication/cli-command-identity.ts" },
    { path: "test/e2e/journey.ts" },
    { path: "test/e2e/journeys/lookup.journey.ts" },
    { path: "test/e2e/run-journeys.ts" },
    { path: "test/e2e/source-journeys.test.ts" },
    { path: "test/integration/command.test.ts" },
    { path: "test/unit/cli-command-identity.test.ts" },
    { path: "tsconfig.build.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "target",
    },
    {
      name: "@ykdz/reference-tooling-config",
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
    {
      name: "@ykdz/template-core",
      purpose: "template-build",
    },
    {
      name: "@ykdz/template-workspace",
      purpose: "template-execution",
    },
  ],
  executionDependencies: [
    "@ykdz/reference-tooling-config",
    "@ykdz/reference-workspace-root",
    "@ykdz/reference-npm-publication",
    "@ykdz/template-workspace",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  templateExports: ["./command-identity"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: [],
  transformManifest(options) {
    return projectCliPackageManifest({
      manifest: options.manifest,
      commandName: options.definition.name.slice(
        options.definition.name.lastIndexOf("/") + 1,
      ),
      nodeDeclaration: nodeDeclarationFrom(options.stableCommon),
    });
  },
  transformDocument({ path: documentPath, value }) {
    if (documentPath !== "turbo.json") return value;
    const tasks = recordFrom(value.tasks);
    const build = tasks === undefined ? undefined : recordFrom(tasks.build);
    if (tasks === undefined || build === undefined) {
      throw new Error("CLI 原生 turbo.json 必须声明 build 任务");
    }
    return {
      ...value,
      tasks: {
        ...tasks,
        build: { ...build, dependsOn: ["^build"] },
      },
    };
  },
});
