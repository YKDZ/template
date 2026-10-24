import { isDeepStrictEqual } from "node:util";

import type {
  ApplicationRequirements,
  DependencyMaintenancePolicy,
  RustToolchainRequirement,
  RustToolchainTarget,
  SharedRootContribution,
} from "@ykdz/default-content-authoring/contracts";

type DependencyMaintenanceContribution = {
  readonly foundation: {
    readonly dependencyMaintenance: DependencyMaintenancePolicy;
  };
};

type RootDependencyMaintenanceContribution = Pick<
  SharedRootContribution,
  "dependencyMaintenance"
>;

/** 在包求值前合并所选 owner 的相同工具要求，并报告相互冲突的来源。 */
export function composeApplicationRequirements(
  declarations: readonly {
    readonly source: string;
    readonly requirements?: ApplicationRequirements;
  }[],
): Pick<ApplicationRequirements, "rustToolchain"> {
  let rustToolchain: RustToolchainRequirement | undefined;
  let rustToolchainSource: string | undefined;
  for (const declaration of declarations) {
    const requirement = declaration.requirements?.rustToolchain;
    if (requirement === undefined) continue;
    if (
      rustToolchain !== undefined &&
      !isDeepStrictEqual(rustToolchain, requirement)
    ) {
      throw new Error(
        `工作区 Rust 工具链要求冲突：来源 ${rustToolchainSource} 与 ${declaration.source}`,
      );
    }
    rustToolchain ??= requirement;
    rustToolchainSource ??= declaration.source;
  }
  return rustToolchain === undefined ? {} : { rustToolchain };
}

/** 将本次目标根事实或初始化快照固定为包求值可见的稳定共同输入。 */
export function resolveApplicationRequirements(options: {
  readonly declared: Pick<ApplicationRequirements, "rustToolchain">;
  readonly rustToolchainTarget?: RustToolchainTarget;
  readonly defaultRustToolchain: string;
}): ApplicationRequirements {
  const requirement = options.declared.rustToolchain;
  if (requirement === undefined) return {};
  const target = options.rustToolchainTarget;
  return {
    rustToolchain: {
      ...requirement,
      toolchain: target?.channel ?? options.defaultRustToolchain,
      ...(target === undefined
        ? {}
        : { existingDeclaration: target.declaration }),
    },
  };
}

/** 合并包及根文件拥有者的依赖维护声明。 */
export function projectDependencyMaintenancePolicy(options: {
  readonly contributions: readonly DependencyMaintenanceContribution[];
  readonly rootContributions: readonly RootDependencyMaintenanceContribution[];
}): DependencyMaintenancePolicy {
  const policies = [
    ...options.contributions.map(
      (contribution) => contribution.foundation.dependencyMaintenance,
    ),
    ...options.rootContributions.flatMap((contribution) =>
      contribution.dependencyMaintenance === undefined
        ? []
        : [contribution.dependencyMaintenance],
    ),
  ];
  const ecosystems: DependencyMaintenancePolicy["ecosystems"] = [
    ...new Set([
      "devcontainers" as const,
      ...policies.flatMap((policy) => policy.ecosystems),
    ]),
  ];
  const directories: NonNullable<DependencyMaintenancePolicy["directories"]> =
    {};
  const extraDirectories: NonNullable<
    DependencyMaintenancePolicy["extraDirectories"]
  > = {};

  for (const ecosystem of ecosystems) {
    const candidates = [
      ...new Set([
        ...(ecosystem === "docker" ? (["/.devcontainer"] as const) : []),
        ...policies.flatMap((policy) => {
          const primary = policy.directories?.[ecosystem];
          return [
            ...(primary === undefined ? [] : [primary]),
            ...(policy.extraDirectories?.[ecosystem] ?? []),
          ];
        }),
      ]),
    ];
    const [primary, ...extra] = candidates;
    if (primary !== undefined) directories[ecosystem] = primary;
    if (extra.length > 0) extraDirectories[ecosystem] = extra;
  }

  return {
    ecosystems,
    ...(Object.keys(directories).length === 0 ? {} : { directories }),
    ...(Object.keys(extraDirectories).length === 0 ? {} : { extraDirectories }),
    interval: "weekly",
  };
}
