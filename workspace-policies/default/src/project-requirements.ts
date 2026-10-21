import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

export type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "devcontainers"
  | "rust-toolchain";

export type DependabotDirectory = `/${string}`;

/** 内容可以请求的有限根级依赖维护范围。 */
export type DependencyMaintenancePolicy = {
  readonly ecosystems: readonly DependencyEcosystem[];
  readonly directories?: Partial<
    Record<DependencyEcosystem, DependabotDirectory>
  >;
  readonly extraDirectories?: Partial<
    Record<DependencyEcosystem, readonly DependabotDirectory[]>
  >;
  readonly interval: "weekly";
};

/** 内容通过稳定节点身份请求的显式包连接，具体可连接性由工作区策略判定。 */
export type PackageLinkRequirement = {
  readonly kind: "package-link";
  readonly consumer: PackageDefinition;
  readonly provider: PackageDefinition;
};

export type ProjectRequirement = PackageLinkRequirement;
