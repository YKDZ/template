import path from "node:path";

import {
  isTsCliPublicCandidateCreationInput,
  tsCliPublicCandidateCreationInput,
  type TsCliCreationVariant,
} from "@ykdz/reference-ts-cli/command-identity";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import { validateCliCommandName } from "@ykdz/template-workspace-authoring/package-contribution";
import type { PackageLinkRequirement } from "@ykdz/template-workspace-authoring/project-requirements";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

export type { TsCliCreationVariant } from "@ykdz/reference-ts-cli/command-identity";
export type TsCliCreationInput = PackageCreationInput<TsCliCreationVariant> & {
  /** 要连接的已选参考包节点；目标角色和来源条件由默认 workspace 策略校验。 */
  readonly linkToNodeIdentity?: string;
};
export { tsCliPublicCandidateCreationInput };

function publicationNodeEngine(
  toolchain: GenerationContext["toolchain"],
): string {
  const nodeVersion = toolchain.nodeVersion;
  if (nodeVersion === undefined) {
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

export const referencePackage = defineReferencePackage<TsCliCreationInput>({
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
    const creationInput = input.creationInput as TsCliCreationInput | undefined;
    const publicCandidate =
      input.createdBy === "initialization" &&
      isTsCliPublicCandidateCreationInput(creationInput);
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
    let packageLinkRequirement: PackageLinkRequirement | undefined;
    if (creationInput?.linkToNodeIdentity !== undefined) {
      if (creationInput.linkToNodeIdentity.length === 0) {
        throw new Error("CLI 包连接要求非空节点身份");
      }
      const provider = input.nodeInstances?.get(
        creationInput.linkToNodeIdentity,
      );
      if (provider === undefined) {
        throw new Error(
          `CLI 包连接引用了未知节点身份：${creationInput.linkToNodeIdentity}`,
        );
      }
      packageLinkRequirement = {
        kind: "package-link",
        consumer: input.definition,
        provider,
      };
    }
    return {
      ...contribution,
      manifest: {
        ...contribution.manifest,
        bin: { [commandName]: Object.values(bin)[0]! },
        devDependencies,
        engines: {
          node: publicCandidate
            ? publicationNodeEngine(input.context.toolchain)
            : `>=${input.context.toolchain.nodeLtsMajor}`,
        },
      },
      foundation: {
        ...contribution.foundation,
        ...(publicCandidate
          ? { npmPublication: { kind: "public-cli-candidate" as const } }
          : {}),
      },
      ...(packageLinkRequirement === undefined
        ? {}
        : {
            projectRequirements: [
              ...(contribution.projectRequirements ?? []),
              packageLinkRequirement,
            ],
          }),
    };
  },
});
