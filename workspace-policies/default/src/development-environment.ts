import { readFileSync } from "node:fs";

import {
  resolveTemplateSource,
  type WriteTextOperation,
} from "@ykdz/template-core/renderer";
import {
  developmentContainerDockerfileFromText,
  planDevelopmentContainerToolLayersFromTexts,
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerPlan,
} from "@ykdz/template-environment/development-container-tool-layer";

import { environmentSources } from "./default-environment-sources.ts";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomization,
  type EditorCustomizationCapability,
} from "./editor-customization.ts";

export function githubCliDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "github-cli",
    dockerfile: {
      source: environmentSources.devcontainer,
      from: "github-cli.Dockerfile",
    },
    requires: ["node-pnpm"],
    probes: [
      {
        identity: "github-cli",
        command: "gh",
        args: ["--version"],
      },
    ],
  };
}

export function browserTestDevelopmentContainerToolLayer(
  playwrightTestVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "browser-test",
    dockerfile: {
      source: environmentSources.devcontainer,
      from: "browser-test.Dockerfile",
    },
    requires: ["node-pnpm"],
    buildArguments: [
      {
        name: "PLAYWRIGHT_CLI_PACKAGE",
        value: `@playwright/test@${playwrightTestVersion}`,
      },
    ],
    probes: [
      {
        identity: "playwright",
        command: "npx",
        args: [
          "--yes",
          "--package",
          `@playwright/test@${playwrightTestVersion}`,
          "playwright",
          "--version",
        ],
      },
    ],
  };
}

export type PreparedBuiltInDevelopmentContainerResources = {
  readonly configuration: Readonly<Record<string, unknown>> & {
    readonly features: Readonly<Record<string, Record<string, unknown>>>;
  };
  readonly dockerfileFragments: Readonly<Record<string, string>>;
};

const builtInDockerfileResources = [
  "base.Dockerfile",
  "github-cli.Dockerfile",
  "rust.Dockerfile",
  "browser-test.Dockerfile",
  "shellcheck.Dockerfile",
] as const;

/** 环境 owner 在工作区策略准备阶段读取其有限配置与 Dockerfile 资源。 */
export function prepareBuiltInDevelopmentContainerResources(): PreparedBuiltInDevelopmentContainerResources {
  const read = (source: typeof environmentSources.base, file: string) => {
    try {
      return readFileSync(resolveTemplateSource(source, file), "utf8");
    } catch (cause) {
      throw new Error(
        `默认环境资源 @ykdz/template-workspace#./default-environment prepare 阶段无法读取 ${file}`,
        { cause },
      );
    }
  };
  const dockerfileFragments = Object.fromEntries(
    builtInDockerfileResources.map((file) => [
      file,
      read(
        file === "base.Dockerfile"
          ? environmentSources.base
          : environmentSources.devcontainer,
        file,
      ),
    ]),
  );
  let configuration: PreparedBuiltInDevelopmentContainerResources["configuration"];
  try {
    configuration = JSON.parse(
      readFileSync(
        resolveTemplateSource(
          environmentSources.devcontainer,
          "workspace-template.json",
        ),
        "utf8",
      ),
    ) as PreparedBuiltInDevelopmentContainerResources["configuration"];
  } catch (cause) {
    throw new Error(
      "默认环境资源 @ykdz/template-workspace#./default-environment prepare 阶段无法读取 workspace-template.json",
      { cause },
    );
  }
  return { configuration, dockerfileFragments };
}

function baseDevelopmentContainerToolLayer(
  nodeVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "node-pnpm",
    dockerfile: { source: environmentSources.base, from: "base.Dockerfile" },
    buildArguments: [{ name: "NODE_VERSION", value: nodeVersion }],
    probes: [
      { identity: "procps", command: "ps", args: ["--version"] },
      { identity: "bubblewrap", command: "bwrap", args: ["--version"] },
      {
        identity: "awk",
        command: "awk",
        args: ["BEGIN { exit (6 * 7 != 42) }"],
      },
      { identity: "ripgrep", command: "rg", args: ["--version"] },
      {
        identity: "jq",
        command: "jq",
        args: ["--exit-status", "--null-input", "{ ready: true } | .ready"],
      },
      {
        identity: "python3",
        command: "python3",
        args: [
          "-c",
          'import json, pathlib, sqlite3, urllib.request; assert json.loads("true") is True',
        ],
      },
      {
        identity: "python",
        command: "python",
        args: [
          "-c",
          'import os, shutil, sys; assert sys.version_info.major == 3; assert os.path.samefile(sys.executable, shutil.which("python3"))',
        ],
      },
      { identity: "openssh-client", command: "ssh", args: ["-V"] },
      { identity: "unzip", command: "unzip", args: ["-v"] },
      { identity: "file", command: "file", args: ["--version"] },
      { identity: "iproute2", command: "ss", args: ["--version"] },
    ],
    mounts: [
      {
        identity: "pnpm-store",
        type: "volume",
        source: "${devcontainerId}-pnpm-store",
        target: "/pnpm/store",
      },
    ],
  };
}

function completeBuiltInDevelopmentContainer(options: {
  readonly nodeVersion: string;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
  readonly resources: PreparedBuiltInDevelopmentContainerResources;
}): DevelopmentContainerToolLayerPlan & {
  readonly configuration: PreparedBuiltInDevelopmentContainerResources["configuration"];
  readonly features: Readonly<Record<string, Record<string, unknown>>>;
  readonly dockerfileOperation: WriteTextOperation;
} {
  const layers = [
    githubCliDevelopmentContainerToolLayer(),
    ...(options.layers ?? []),
  ];
  const plan = planDevelopmentContainerToolLayersFromTexts({
    baseLayer: baseDevelopmentContainerToolLayer(options.nodeVersion),
    layers,
    fragmentTexts: options.resources.dockerfileFragments,
  });
  return {
    ...plan,
    configuration: options.resources.configuration,
    features: options.resources.configuration.features,
    dockerfileOperation: developmentContainerDockerfileFromText({
      layers: plan.layers,
      fragmentTexts: options.resources.dockerfileFragments,
    }),
    probes: [
      ...plan.probes,
      {
        identity: "docker-daemon",
        command: "docker",
        args: ["version"],
        failureMessage:
          "无法连接宿主 Docker；请检查宿主 daemon 是否运行，以及开发容器 Feature 的连接配置与权限。",
      },
      {
        identity: "docker-buildx",
        command: "docker",
        args: ["buildx", "version"],
        failureMessage:
          "Buildx 不可用；请重建开发容器以完成官方 Feature 安装。",
      },
      {
        identity: "docker-compose",
        command: "docker",
        args: ["compose", "version"],
        failureMessage:
          "Compose 不可用；请重建开发容器以完成官方 Feature 安装。",
      },
    ],
  };
}

/** 只消费所属环境准备事实并投影所选开发容器能力。 */
export function projectBuiltInDevelopmentContainer(options: {
  readonly nodeVersion: string;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
  readonly resources: PreparedBuiltInDevelopmentContainerResources;
}): ReturnType<typeof completeBuiltInDevelopmentContainer> {
  return completeBuiltInDevelopmentContainer(options);
}

/** 非生成策略消费者的便利入口；生成策略应先准备再调用纯 project。 */
export function rustDevelopmentContainerToolLayer(
  rustVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "rust",
    dockerfile: {
      source: environmentSources.devcontainer,
      from: "rust.Dockerfile",
    },
    requires: ["node-pnpm"],
    buildArguments: [{ name: "RUST_TOOLCHAIN", value: rustVersion }],
    mounts: [
      {
        identity: "cargo-registry",
        type: "volume",
        source: "${devcontainerId}-cargo-registry",
        target: "/usr/local/cargo/registry",
      },
      {
        identity: "cargo-git",
        type: "volume",
        source: "${devcontainerId}-cargo-git",
        target: "/usr/local/cargo/git",
      },
    ],
    probes: [
      { identity: "cargo", command: "cargo", args: ["--version"] },
      { identity: "rustc", command: "rustc", args: ["--version"] },
      { identity: "rustfmt", command: "cargo", args: ["fmt", "--version"] },
      { identity: "clippy", command: "cargo", args: ["clippy", "--version"] },
    ],
  };
}

export function shellCheckDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "shellcheck",
    dockerfile: {
      source: environmentSources.devcontainer,
      from: "shellcheck.Dockerfile",
    },
    requires: ["node-pnpm"],
    probes: [
      { identity: "shellcheck", command: "shellcheck", args: ["--version"] },
    ],
  };
}

/** 环境 owner 在策略准备阶段读取并验证编辑器能力声明。 */
export function prepareBuiltInEditorCustomizationDeclarations() {
  try {
    return loadEditorCustomizationDeclarations(
      resolveTemplateSource(
        environmentSources.editorCustomization,
        "capabilities.json",
      ),
      "@ykdz/template-workspace#./assets/environment/editor-customization/capabilities.json",
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `默认环境资源 @ykdz/template-workspace#./default-environment prepare 阶段失败：${detail}`,
      { cause },
    );
  }
}

/** 只组合已准备的编辑器声明与实际能力。 */
export function projectBuiltInEditorCustomization(
  capabilities: readonly EditorCustomizationCapability[],
  declarations: ReturnType<typeof loadEditorCustomizationDeclarations>,
): EditorCustomization {
  const unknownCapability = capabilities.find(
    (capability) => !declarations.capabilityOrder.includes(capability),
  );
  if (unknownCapability !== undefined) {
    throw new Error(`未声明的编辑器能力：${unknownCapability}`);
  }
  return editorCustomizationForCapabilities(capabilities, declarations);
}
