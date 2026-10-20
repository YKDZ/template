import path from "node:path";

import { validateCliCommandName } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

function publicationNodeEngine(
  toolchain: GenerationContext["toolchain"],
  creationOrigin: "new" | "replay",
): string {
  const nodeVersion = toolchain.nodeVersion;
  if (nodeVersion === undefined) {
    if (creationOrigin === "replay") return `>=${toolchain.nodeLtsMajor}`;
    throw new Error(
      "新建公开 ts-cli 发布候选要求 Generation Context 提供精确三段 toolchain.nodeVersion，实际缺失；不能从 nodeLtsMajor 猜 patch 派生公开 caret 范围。",
    );
  }
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) {
    throw new Error(
      `公开 ts-cli 发布候选要求 toolchain.nodeVersion 为精确三段 Node 版本，实际收到 ${JSON.stringify(nodeVersion)}。`,
    );
  }
  if (nodeVersion.split(".")[0] !== toolchain.nodeLtsMajor) {
    throw new Error(
      `公开 ts-cli 发布候选的 toolchain.nodeVersion ${nodeVersion} 与 nodeLtsMajor ${toolchain.nodeLtsMajor} 大版本不一致。`,
    );
  }
  return `^${nodeVersion}`;
}

export const referencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-ts-cli",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "cli-package-addition",
  instance: "independent",
  defaultLeafName: "cli",
  role: "cli-tool",
  resources: ["."],
  publicationIdentitySource: "src/cli-command-identity.ts",
  authoring: {
    dependencies: ["@ykdz/template-core", "@ykdz/template-workspace-authoring"],
    exports: ["./command-identity"],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
  },
  environmentNeeds: [],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  project(contribution, input) {
    const publicCandidate =
      input.planningIdentity === "cli-publication-candidate";
    const commandName = validateCliCommandName(
      input.definition.name.slice(input.definition.name.lastIndexOf("/") + 1),
    );
    const bin = contribution.manifest.bin as Readonly<Record<string, string>>;
    const configuration = input.bindings?.get(
      "@ykdz/reference-typescript-config",
    );
    const devDependencies = {
      ...(contribution.manifest.devDependencies as Record<string, string>),
    };
    if (configuration !== undefined) {
      devDependencies[configuration.name] = publicCandidate
        ? `link:${path.posix.relative(input.definition.path, configuration.path)}`
        : "workspace:*";
    }
    return {
      ...contribution,
      manifest: {
        ...contribution.manifest,
        bin: { [commandName]: Object.values(bin)[0]! },
        devDependencies,
        engines: {
          node: publicCandidate
            ? publicationNodeEngine(
                input.context.toolchain,
                input.creationOrigin ?? "new",
              )
            : `>=${input.context.toolchain.nodeLtsMajor}`,
        },
      },
      foundation: {
        ...contribution.foundation,
        ...(publicCandidate
          ? { npmPublication: { kind: "public-cli-candidate" as const } }
          : {}),
      },
    };
  },
});
