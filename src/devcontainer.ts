import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTemplateDependencyCatalog } from "./dependency-catalog.js";
import type { WriteTextFromFragmentsOperation } from "./renderer.js";
import { packageTemplateRoot } from "./runtime-paths.js";

export type DevelopmentContainerNodePnpmLayer = {
  readonly kind: "node-pnpm";
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
};

export type DevelopmentContainerBrowserTestLayer = {
  readonly kind: "browser-test";
  readonly playwrightCliPackage: string;
};

export type DevelopmentContainerRustLayer = {
  readonly kind: "rust";
  readonly toolchain: string;
};

export type DevelopmentContainerPlan = {
  readonly devcontainer: Record<string, unknown>;
  readonly dockerfile: string;
  readonly dockerfileOperation?: WriteTextFromFragmentsOperation;
};

export type DevelopmentContainerDockerfileLayer = {
  readonly kind: "base" | "capability";
  readonly name: string;
  readonly text: string;
};

const runtimeDockerfileInstructions = new Set([
  "CMD",
  "ENTRYPOINT",
  "EXPOSE",
  "HEALTHCHECK",
  "STOPSIGNAL",
  "VOLUME",
]);

function dockerfileInstructions(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase())
    .filter((instruction): instruction is string => instruction !== undefined);
}

export function composeDevelopmentContainerDockerfile(options: {
  readonly layers: readonly DevelopmentContainerDockerfileLayer[];
}): string {
  const baseImageInstructionCount = options.layers.reduce(
    (count, layer) =>
      count +
      dockerfileInstructions(layer.text).filter(
        (instruction) => instruction === "FROM",
      ).length,
    0,
  );

  if (baseImageInstructionCount !== 1) {
    throw new Error(
      `Development Container Dockerfile must have exactly one base layer with a FROM instruction; found ${baseImageInstructionCount}.`,
    );
  }

  for (const layer of options.layers) {
    const instructions = dockerfileInstructions(layer.text);

    if (layer.kind === "capability" && instructions.includes("FROM")) {
      throw new Error(
        `${layer.name} capability layer must not supply a Dockerfile FROM instruction.`,
      );
    }

    if (layer.kind !== "capability") {
      continue;
    }

    for (const instruction of instructions) {
      if (runtimeDockerfileInstructions.has(instruction)) {
        throw new Error(
          `${layer.name} must not use runtime Dockerfile instruction ${instruction}.`,
        );
      }
    }
  }

  return options.layers.map((layer) => layer.text.trimEnd()).join("\n\n");
}

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

export function browserTestToolLayer(): DevelopmentContainerBrowserTestLayer {
  const playwrightTestVersion =
    loadTemplateDependencyCatalog()["@playwright/test"];

  if (playwrightTestVersion === undefined) {
    throw new Error(
      "Template Dependency Catalog is missing dependency: @playwright/test",
    );
  }

  return {
    kind: "browser-test",
    playwrightCliPackage: `@playwright/test@${playwrightTestVersion}`,
  };
}

export function rustToolLayer(
  options: {
    readonly toolchain?: string;
  } = {},
): DevelopmentContainerRustLayer {
  return { kind: "rust", toolchain: options.toolchain ?? "stable" };
}

function sharedDevcontainerSourceRoot(): string {
  return packageTemplateRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    "shared",
    "devcontainer",
  );
}

function checkedDockerfileFragment(name: string): string {
  return readFileSync(path.join(sharedDevcontainerSourceRoot(), name), "utf8");
}

function checkedNodePnpmDockerfile(
  options: {
    readonly additionalLayers?: readonly DevelopmentContainerBrowserTestLayer[];
  } = {},
): string {
  return composeDevelopmentContainerDockerfile({
    layers: [
      {
        kind: "base",
        name: "node-pnpm",
        text: checkedDockerfileFragment("node-pnpm.Dockerfile"),
      },
      ...(options.additionalLayers ?? []).map((layer) => {
        switch (layer.kind) {
          case "browser-test":
            return {
              kind: "capability" as const,
              name: "browser-test",
              text: checkedDockerfileFragment("browser-test.Dockerfile"),
            };
        }
      }),
    ],
  });
}

function checkedNodePnpmDockerfileFragments(
  options: {
    readonly additionalLayers?: readonly DevelopmentContainerBrowserTestLayer[];
  } = {},
): WriteTextFromFragmentsOperation["fragments"] {
  return [
    {
      sourceRoot: "sharedDevcontainer",
      from: "node-pnpm.Dockerfile",
    },
    ...(options.additionalLayers ?? []).map((layer) => {
      switch (layer.kind) {
        case "browser-test":
          return {
            sourceRoot: "sharedDevcontainer",
            from: "browser-test.Dockerfile",
          };
      }
    }),
  ];
}

function browserTestBuildArgs(
  layers: readonly DevelopmentContainerBrowserTestLayer[] = [],
): Record<string, string> {
  const browserTestLayer = layers.find(
    (layer) => layer.kind === "browser-test",
  );

  return browserTestLayer === undefined
    ? {}
    : { PLAYWRIGHT_CLI_PACKAGE: browserTestLayer.playwrightCliPackage };
}

function renderRustLayer(
  layer: DevelopmentContainerRustLayer,
): readonly string[] {
  return [
    `ARG RUST_TOOLCHAIN=${layer.toolchain}`,
    "ENV RUSTUP_HOME=/usr/local/rustup",
    "ENV CARGO_HOME=/usr/local/cargo",
    'ENV PATH="/usr/local/cargo/bin:${PATH}"',
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "    build-essential \\",
    "    ca-certificates \\",
    "    curl \\",
    "    pkg-config \\",
    "    libssl-dev \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \\",
    "    sh -s -- -y --profile minimal --default-toolchain none \\",
    "    && rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy \\",
    "    && rustup default ${RUST_TOOLCHAIN} \\",
    "    && chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}",
    "",
  ];
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
      'SHELL ["/bin/bash", "-o", "pipefail", "-c"]',
      `RUN corepack enable && corepack prepare ${options.layer.packageManagerPin} --activate`,
      "",
    ].join("\n"),
  };
}

export function checkedDockerfileFirstNodePnpmDevcontainer(options: {
  readonly name: string;
  readonly layer: DevelopmentContainerNodePnpmLayer;
  readonly additionalLayers?: readonly DevelopmentContainerBrowserTestLayer[];
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
          ...browserTestBuildArgs(options.additionalLayers),
        },
      },
      customizations: {
        vscode: {
          extensions: options.extensions,
          ...(options.settings ? { settings: options.settings } : {}),
        },
      },
    },
    dockerfile: checkedNodePnpmDockerfile({
      additionalLayers: options.additionalLayers,
    }),
    dockerfileOperation: {
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      fragments: checkedNodePnpmDockerfileFragments({
        additionalLayers: options.additionalLayers,
      }),
    },
  };
}

export function dockerfileFirstRustPnpmDevcontainer(options: {
  readonly name: string;
  readonly nodeLayer: DevelopmentContainerNodePnpmLayer;
  readonly rustLayer: DevelopmentContainerRustLayer;
  readonly extensions: readonly string[];
  readonly settings?: Record<string, unknown>;
}): DevelopmentContainerPlan {
  return {
    devcontainer: {
      name: options.name,
      build: {
        dockerfile: "Dockerfile",
        args: {
          NODE_VERSION: options.nodeLayer.nodeVersion,
          PACKAGE_MANAGER_PIN: options.nodeLayer.packageManagerPin,
          RUST_TOOLCHAIN: options.rustLayer.toolchain,
        },
      },
      customizations: {
        vscode: {
          extensions: options.extensions,
          ...(options.settings ? { settings: options.settings } : {}),
        },
      },
      mounts: [
        "source=${localWorkspaceFolderBasename}-cargo-registry,target=/usr/local/cargo/registry,type=volume",
        "source=${localWorkspaceFolderBasename}-cargo-git,target=/usr/local/cargo/git,type=volume",
        "source=${localWorkspaceFolderBasename}-target,target=${containerWorkspaceFolder}/target,type=volume",
      ],
    },
    dockerfile: [
      `FROM mcr.microsoft.com/devcontainers/typescript-node:${options.nodeLayer.nodeVersion}`,
      "",
      'SHELL ["/bin/bash", "-o", "pipefail", "-c"]',
      `RUN corepack enable && corepack prepare ${options.nodeLayer.packageManagerPin} --activate`,
      "",
      ...renderRustLayer(options.rustLayer),
    ].join("\n"),
  };
}
