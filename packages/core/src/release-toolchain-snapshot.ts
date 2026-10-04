/**
 * CLI 发版携带的不可变工具链快照：从模板根三个原生声明（engines.node、packageManager、rust-toolchain.toml）投影的静态交付副本。
 * 模板根声明仍是唯一作者真源，由根版本门核对漂移；本模块同步、无参、无任何文件系统、网络或模板根查找。
 */
export const releaseToolchainSnapshot = Object.freeze({
  nodeVersion: "24.16.0",
  packageManagerPin: "pnpm@12.8.1",
  rustVersion: "1.97.1",
} as const);

export type ReleaseToolchainSnapshot = typeof releaseToolchainSnapshot;
