import {
  dockerfileFirstNodePnpmDevcontainer,
  nodePnpmToolLayer,
} from "../src/devcontainer.js";

describe("Development Container planning", () => {
  it("plans a Dockerfile-first Node pnpm tool layer from the toolchain baseline", () => {
    const plan = dockerfileFirstNodePnpmDevcontainer({
      name: "demo development",
      layer: nodePnpmToolLayer({
        nodeVersion: "24",
        packageManagerPin: "pnpm@10.0.0",
      }),
      extensions: ["oxc.oxc-vscode"],
      settings: { "oxc.enable": true },
    });

    expect(plan.devcontainer).toEqual({
      name: "demo development",
      build: {
        dockerfile: "Dockerfile",
        args: {
          NODE_VERSION: "24",
          PACKAGE_MANAGER_PIN: "pnpm@10.0.0",
        },
      },
      customizations: {
        vscode: {
          extensions: ["oxc.oxc-vscode"],
          settings: { "oxc.enable": true },
        },
      },
    });
    expect(plan.devcontainer).not.toHaveProperty("features");
    expect(plan.dockerfile).toContain(
      "FROM mcr.microsoft.com/devcontainers/typescript-node:24",
    );
    expect(plan.dockerfile).toContain(
      "RUN corepack enable && corepack prepare pnpm@10.0.0 --activate",
    );
  });
});
