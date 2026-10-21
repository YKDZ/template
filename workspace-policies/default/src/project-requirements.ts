import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

import type { DeploymentEnvironmentNeed } from "./environment-needs.ts";

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

/** Vue-Hono 根策略以实际 web 与 API 实例配置联合浏览器验收。 */
export type VueHonoJointE2eRequirement = {
  readonly kind: "vue-hono-joint-e2e";
  readonly web: PackageDefinition;
  readonly api: PackageDefinition;
};

/** Vike 数据准备只引用已解析的应用、数据库和迁移包实例。 */
export type DatabasePreparationRequirement = {
  readonly kind: "sqlite-database-preparation";
  readonly web: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
};

/** Vike 部署能力由工作区投影资源，并保留实际参与包与环境需求。 */
export type DeploymentCheckRequirement = {
  readonly kind: "application-container-with-database-migrations";
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
  readonly environmentNeeds: readonly DeploymentEnvironmentNeed[];
};

export type ProjectRequirement =
  | PackageLinkRequirement
  | VueHonoJointE2eRequirement
  | DatabasePreparationRequirement
  | DeploymentCheckRequirement;
