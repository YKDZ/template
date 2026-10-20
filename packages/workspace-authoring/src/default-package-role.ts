export const defaultPackageRoles = [
  "cli-tool",
  "runtime-service",
  "shared-library",
  "native-package",
] as const;

/** 默认 Node/Rust 工作区策略公开给参考包作者的角色合同。 */
export type DefaultPackageRole = (typeof defaultPackageRoles)[number];

export function isDefaultPackageRole(
  value: string,
): value is DefaultPackageRole {
  return (defaultPackageRoles as readonly string[]).includes(value);
}
