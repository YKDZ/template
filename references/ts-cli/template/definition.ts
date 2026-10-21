import path from "node:path";

import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import type { GenerationContext } from "@ykdz/template-workspace/generation-context";
import { validateCliCommandName } from "@ykdz/template-workspace/package-contribution";
import type { PackageLinkRequirement } from "@ykdz/template-workspace/project-requirements";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace/reference-package";

import {
  isTsCliPublicCandidateCreationInput,
  tsCliPublicCandidateCreationInput,
  type TsCliCreationVariant,
} from "./authoring/creation-input.ts";

export type { TsCliCreationVariant } from "./authoring/creation-input.ts";
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

export const referencePackage: ReferencePackage<TsCliCreationInput> =
  defineReferencePackage<TsCliCreationInput>({
    packageName: "@ykdz/reference-ts-cli",
    // 私有原生清单未声明 npm 版本，给制品显式提供未发布坐标。
    artifactVersion: "0.0.0",
    resolve: (specifier) => import.meta.resolve(specifier),
    resourceRoot: new URL("../", import.meta.url),
    alias: "cli-package-addition",
    instance: "independent",
    defaultLeafName: "cli",
    role: "cli-tool",
    resources: ["."],
    publicationIdentitySource: "src/publication/cli-command-identity.ts",
    template: {
      dependencies: [
        { name: "@ykdz/template-core", purpose: "template-execution" },
        {
          name: "@ykdz/template-workspace",
          purpose: "template-execution",
        },
      ],
      exports: ["./command-identity", "./creation-input"],
      scripts: ["build:template", "check:author-planning-roles"],
      resources: ["template", "tsconfig.template.json"],
      executionData: [
        "src/publication/cli-command-identity.ts",
        "template/authoring/creation-input.ts",
      ],
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
      const creationInput = input.creationInput as
        | TsCliCreationInput
        | undefined;
      const publicCandidate =
        input.createdBy === "initialization" &&
        isTsCliPublicCandidateCreationInput(creationInput);
      const commandName = validateCliCommandName(
        input.definition.name.slice(input.definition.name.lastIndexOf("/") + 1),
      );
      const bin = contribution.manifest.bin as Readonly<Record<string, string>>;
      const configuration = input.bindings?.get(
        "@ykdz/reference-tooling-config",
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
      const npmPublication = publicCandidate
        ? (() => {
            const commandIdentitySource =
              referencePackage.publicationIdentitySource;
            if (commandIdentitySource === undefined) {
              throw new Error("公开 CLI 候选缺少所属命令身份资源");
            }
            const creationInputResource = input.preparation.executionData.find(
              (resource) =>
                resource.path === "template/authoring/creation-input.ts",
            );
            if (creationInputResource === undefined) {
              throw new Error("公开 CLI 候选缺少所属创建输入数据资源");
            }
            return {
              kind: "public-cli-candidate" as const,
              commandIdentitySource: {
                source: commandIdentitySource,
                from: ".",
              },
              creationInputSource: {
                source: creationInputResource.source,
                from: ".",
              },
            };
          })()
        : undefined;
      const scripts = {
        ...(contribution.manifest.scripts as Record<string, string>),
        ...(publicCandidate
          ? {
              "publication:readiness":
                "pnpm --workspace-root exec node --conditions=source --experimental-strip-types scripts/npm-publication/generated/diagnose.ts",
              "publication:prepare":
                "pnpm --workspace-root exec node --conditions=source --experimental-strip-types scripts/npm-publication/generated/prepare.ts",
              "publication:accept":
                "pnpm --workspace-root exec node --conditions=source --experimental-strip-types scripts/npm-publication/generated/accept.ts",
              "publication:consume":
                "node --conditions=source --experimental-strip-types scripts/publication-consumer.ts",
            }
          : {}),
      };
      return {
        ...contribution,
        manifest: {
          ...contribution.manifest,
          bin: { [commandName]: Object.values(bin)[0]! },
          scripts,
          devDependencies,
          engines: {
            node: publicCandidate
              ? publicationNodeEngine(input.context.toolchain)
              : `>=${input.context.toolchain.nodeLtsMajor}`,
          },
        },
        foundation: {
          ...contribution.foundation,
          ...(npmPublication === undefined ? {} : { npmPublication }),
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
