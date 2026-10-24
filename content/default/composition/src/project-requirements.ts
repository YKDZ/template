import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

/** 内容通过稳定节点身份请求的显式包连接，具体可连接性由工作区策略判定。 */
export type PackageLinkRequirement = {
  readonly kind: "package-link";
  readonly consumer: PackageDefinition;
  readonly provider: PackageDefinition;
};

/** 包连接规划中可映射为用户请求问题的默认策略原因。 */
export type PackageLinkValidationIssue =
  | { readonly kind: "unknown-consumer"; readonly path: string }
  | {
      readonly kind: "unsupported-link";
      readonly consumerPath: string;
      readonly providerPath: string;
    };

export class PackageLinkValidationError extends Error {
  readonly issue: PackageLinkValidationIssue;

  constructor(issue: PackageLinkValidationIssue, message: string) {
    super(message);
    this.name = "PackageLinkValidationError";
    this.issue = issue;
  }
}

/** 加包前核验根清单中与工作区工具链有关的持久声明。 */
export type RootToolchainDeclarationIssue =
  | { readonly kind: "invalid-node-declaration" }
  | { readonly kind: "invalid-package-manager-pin" };

export class RootToolchainDeclarationError extends Error {
  readonly issue: RootToolchainDeclarationIssue;

  constructor(issue: RootToolchainDeclarationIssue, message: string) {
    super(message);
    this.name = "RootToolchainDeclarationError";
    this.issue = issue;
  }
}

export type ProjectRequirement = PackageLinkRequirement;
