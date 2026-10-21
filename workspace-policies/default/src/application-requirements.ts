import type { DependencyMaintenancePolicy } from "./project-requirements.ts";
import type { SharedRootContribution } from "./shared-root-files.ts";

type DependencyMaintenanceContribution = {
  readonly foundation: {
    readonly dependencyMaintenance: DependencyMaintenancePolicy;
  };
};

type RootDependencyMaintenanceContribution = Pick<
  SharedRootContribution,
  "dependencyMaintenance"
>;

export type { DependencyMaintenancePolicy };

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
