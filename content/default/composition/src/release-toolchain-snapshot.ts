// 由根 sync:workspace-policy 从原生工具链声明派生，请修改事实源后显式同步。
export const releaseToolchainSnapshot = Object.freeze({
  nodeVersion: "24.21.0",
  packageManagerPin: "pnpm@12.9.1",
  rustVersion: "1.99.1",
} as const);

export type ReleaseToolchainSnapshot = typeof releaseToolchainSnapshot;
