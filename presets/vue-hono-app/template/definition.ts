import { fileURLToPath } from "node:url";

import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
  type PresetProjectOptions,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import type { GenerationContext } from "@ykdz/template-workspace/generation-context";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";
import type { PackageLinkRequirement } from "@ykdz/template-workspace/project-requirements";
import type { SharedRootContribution } from "@ykdz/template-workspace/shared-root-files";

import presetPackage from "../package.json" with { type: "json" };

const owner = presetOwnerFromManifest(presetPackage, "./template");
const resourceRoot = new URL("../", import.meta.url);
const resourceSource = createTemplateSourceHandle(fileURLToPath(resourceRoot));

const jointE2eResources = [
  "resources/joint-e2e/playwright.config.ts",
  "resources/joint-e2e/test/e2e/app.spec.ts",
  "resources/joint-e2e/test/e2e/fixtures.ts",
] as const;

function requireNode(
  nodeInstances: ReadonlyMap<string, PackageDefinition>,
  identity: string,
): PackageDefinition {
  const definition = nodeInstances.get(identity);
  if (definition === undefined) {
    throw new Error("Vue-Hono 预设缺少节点：" + identity);
  }
  return definition;
}

function samePackageDefinition(
  left: PackageDefinition,
  right: PackageDefinition,
): boolean {
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.role === right.role
  );
}

function projectJointE2e(
  options: PresetProjectOptions<GenerationContext, PackageContribution>,
): readonly (PackageLinkRequirement | SharedRootContribution)[] {
  const webPackage = requireNode(options.nodeInstances, "web");
  const apiPackage = requireNode(options.nodeInstances, "api");
  for (const [role, definition] of [
    ["web", webPackage],
    ["API", apiPackage],
  ] as const) {
    if (definition.role !== "runtime-service") {
      throw new Error(
        `Vue-Hono 预设要求 ${role} 实例 ${definition.name} (${definition.path}) 的角色为 runtime-service，实际为 ${definition.role}`,
      );
    }
  }

  const webContribution = options.contributions.find((contribution) =>
    samePackageDefinition(contribution.definition, webPackage),
  );
  const boundApi = webContribution?.referenceBindings?.[api.manifest.name];
  if (boundApi === undefined || !samePackageDefinition(boundApi, apiPackage)) {
    throw new Error(
      `Vue-Hono 预设的 web 实例 ${webPackage.name} (${webPackage.path}) 必须绑定到 API 实例 ${apiPackage.name} (${apiPackage.path})`,
    );
  }

  const copy = (from: (typeof jointE2eResources)[number], to: string) => ({
    operation: {
      kind: "copyFile" as const,
      from,
      to,
      source: resourceSource,
    },
  });

  return [
    { kind: "package-link", consumer: webPackage, provider: apiPackage },
    {
      kind: "shared-root-files",
      source: `${owner.packageName}#${owner.exportPath}`,
      manifest: {
        scripts: { "test:e2e": "playwright test" },
        devDependencies: { "@playwright/test": "catalog:" },
      },
      turboTasks: {
        "//#test:e2e": {
          cache: false,
          tags: ["quality:heavy"],
          dependsOn: [
            `${apiPackage.name}#build`,
            `${webPackage.name}#build`,
            `${webPackage.name}#browser:prepare`,
          ],
        },
      },
      typescript: { include: ["test/**/*.ts"] },
      ciDiagnosticArtifacts: [
        {
          kind: "playwright",
          owner: { kind: "workspace-orchestration", path: "." },
        },
      ],
      environmentNeeds: {
        check: [
          {
            kind: "playwright-browser-assets",
            browser: "chromium",
            owner: { kind: "workspace-orchestration", path: "." },
          },
        ],
      },
      resources: [
        copy(jointE2eResources[0], "playwright.config.ts"),
        {
          operation: {
            kind: "writeJson",
            to: "joint-e2e.json",
            value: {
              apiPackageName: apiPackage.name,
              webPackageName: webPackage.name,
            },
          },
        },
        copy(jointE2eResources[1], "test/e2e/app.spec.ts"),
        copy(jointE2eResources[2], "test/e2e/fixtures.ts"),
      ],
    },
  ];
}

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vue-hono-app",
      title: "Vue-Hono 全栈应用",
      description: "组合 Vue 页面、Hono API 与参考包提供的共享能力。",
    },
    operations: ["init"],
    nodes: {
      web: { reference: web },
      api: { reference: api },
    },
    owner,
    project: projectJointE2e,
  }),
  {
    manifest: presetPackage,
    resourceRoot,
    exportPath: "./template",
    resources: jointE2eResources.map((file) => ({
      path: file,
      source: createTemplateSourceHandle(
        fileURLToPath(new URL(file, resourceRoot)),
      ),
      mode: 0o644,
    })),
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);
