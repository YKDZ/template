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
