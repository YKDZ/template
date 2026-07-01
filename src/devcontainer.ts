export type DevcontainerNodeFeatureOptions = {
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
};

export type DevcontainerNodeFeature = {
  readonly version: string;
  readonly pnpmVersion: string;
};

export function pnpmVersionFromPackageManagerPin(
  packageManagerPin: string,
): string {
  return packageManagerPin.replace(/^pnpm@/, "");
}

export function devcontainerNodeFeature(
  options: DevcontainerNodeFeatureOptions,
): Record<"ghcr.io/devcontainers/features/node:1", DevcontainerNodeFeature> {
  return {
    "ghcr.io/devcontainers/features/node:1": {
      version: options.nodeVersion,
      pnpmVersion: pnpmVersionFromPackageManagerPin(options.packageManagerPin),
    },
  };
}

export function nodePnpmDevcontainer(options: {
  readonly name: string;
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
  readonly extensions: readonly string[];
  readonly settings?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: options.name,
    image: `mcr.microsoft.com/devcontainers/typescript-node:${options.nodeVersion}`,
    features: devcontainerNodeFeature(options),
    customizations: {
      vscode: {
        extensions: options.extensions,
        ...(options.settings ? { settings: options.settings } : {}),
      },
    },
  };
}

export type DevelopmentContainerNodePnpmLayer = {
  readonly kind: "node-pnpm";
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
};

export type DevelopmentContainerPlan = {
  readonly devcontainer: Record<string, unknown>;
  readonly dockerfile: string;
};

export function nodePnpmToolLayer(options: {
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
}): DevelopmentContainerNodePnpmLayer {
  return {
    kind: "node-pnpm",
    nodeVersion: options.nodeVersion,
    packageManagerPin: options.packageManagerPin,
  };
}

export function dockerfileFirstNodePnpmDevcontainer(options: {
  readonly name: string;
  readonly layer: DevelopmentContainerNodePnpmLayer;
  readonly extensions: readonly string[];
  readonly settings?: Record<string, unknown>;
}): DevelopmentContainerPlan {
  return {
    devcontainer: {
      name: options.name,
      build: {
        dockerfile: "Dockerfile",
        args: {
          NODE_VERSION: options.layer.nodeVersion,
          PACKAGE_MANAGER_PIN: options.layer.packageManagerPin,
        },
      },
      customizations: {
        vscode: {
          extensions: options.extensions,
          ...(options.settings ? { settings: options.settings } : {}),
        },
      },
    },
    dockerfile: [
      `FROM mcr.microsoft.com/devcontainers/typescript-node:${options.layer.nodeVersion}`,
      "",
      "SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]",
      `RUN corepack enable && corepack prepare ${options.layer.packageManagerPin} --activate`,
      "",
    ].join("\n"),
  };
}
