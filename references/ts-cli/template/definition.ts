import {
  normalizePublicationConfiguration,
  projectPublicationTarget,
} from "@ykdz/reference-npm-publication/template";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import { validateCliCommandName } from "@ykdz/template-workspace/package-contribution";
import type { PackageLinkRequirement } from "@ykdz/template-workspace/project-requirements";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace/reference-package";

export type TsCliCreationInput = PackageCreationInput & {
  /** 一次性连接意图不属于可变配置。 */
  readonly linkToNodeIdentity?: string;
};

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
    normalizeConfiguration: normalizePublicationConfiguration,
    template: {
      dependencies: [
        {
          name: "@ykdz/reference-npm-publication",
          purpose: "template-execution",
        },
        { name: "@ykdz/template-core", purpose: "template-execution" },
        {
          name: "@ykdz/template-workspace",
          purpose: "template-execution",
        },
      ],
      exports: ["./command-identity"],
      scripts: ["build:template", "check:author-planning-roles"],
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
      const creationInput = input.creationInput as
        | TsCliCreationInput
        | undefined;
      const commandName = validateCliCommandName(
        input.definition.name.slice(input.definition.name.lastIndexOf("/") + 1),
      );
      const bin = contribution.manifest.bin as Readonly<Record<string, string>>;
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
      return projectPublicationTarget({
        configuration: input.configuration,
        contribution: {
          ...contribution,
          manifest: {
            ...contribution.manifest,
            bin: { [commandName]: Object.values(bin)[0]! },
            engines: { node: `>=${input.context.toolchain.nodeLtsMajor}` },
          },
          ...(packageLinkRequirement === undefined
            ? {}
            : {
                projectRequirements: [
                  ...(contribution.projectRequirements ?? []),
                  packageLinkRequirement,
                ],
              }),
        },
      });
    },
  });
