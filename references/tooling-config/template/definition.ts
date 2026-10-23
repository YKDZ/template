import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";
import toolingManifest from "@ykdz/tooling-config/reference" with { type: "json" };

import referenceManifest from "../package.json" with { type: "json" };

const targetExports = Object.freeze(
  Object.fromEntries(
    Object.entries(toolingManifest.exports ?? {}).filter(
      ([exportPath]) => exportPath !== "./reference",
    ),
  ),
);

const toolingResources = Object.entries(targetExports).map(
  ([exportPath, resourcePath]) => {
    if (typeof resourcePath !== "string" || !resourcePath.startsWith("./")) {
      throw new Error(`静态工具配置导出必须指向包内资源：${exportPath}`);
    }
    const path = resourcePath.slice(2);
    return {
      path,
      targetPath: path,
      source: createTemplateSourceHandle(
        fileURLToPath(
          import.meta.resolve(`${toolingManifest.name}${exportPath.slice(1)}`),
        ),
      ),
    };
  },
);

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  sourcePackageName: toolingManifest.name,
  targetExports,
  resourceRoot: new URL("../", import.meta.url),
  alias: "tooling-config",
  instance: "shared",
  defaultLeafName: "tooling-config",
  workspaceConfiguration: {
    kind: "typescript-workspace-configuration",
  },
  role: "shared-library",
  resources: [
    ...toolingResources,
    { path: "tsconfig.json" },
    { path: "turbo.json" },
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
    { name: "@ykdz/template-core", purpose: "template-execution" },
    { name: "@ykdz/tooling-config", purpose: "template-execution" },
    {
      name: "@ykdz/template-workspace",
      purpose: "template-execution",
    },
  ],
  executionDependencies: [
    "@ykdz/template-core",
    "@ykdz/tooling-config",
    "@ykdz/template-workspace",
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
