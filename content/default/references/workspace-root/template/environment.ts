import { readFileSync } from "node:fs";

import { resolveTemplateSource } from "@ykdz/template-core/template-source";
import {
  developmentContainerDockerfileFromText,
  planDevelopmentContainerToolLayersFromTexts,
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerPlan,
} from "@ykdz/template-environment/development-container-tool-layer";

import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomization,
  type EditorCustomizationCapability,
  type EditorCustomizationDeclarations,
} from "./editor-customization.ts";
import { workspaceEnvironmentSources as environmentSources } from "./environment-sources.ts";

export type {
  EditorCustomization,
  EditorCustomizationCapability,
  EditorCustomizationDeclarations,
} from "./editor-customization.ts";
export {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
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

/** 浏览器资源版本由最终合成依赖事实提供。 */
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

export type PreparedWorkspaceDevelopmentContainerResources = {
  readonly configuration: Readonly<Record<string, unknown>> & {
    readonly features: Readonly<Record<string, Record<string, unknown>>>;
  };
  readonly dockerfileFragments: Readonly<Record<string, string>>;
};

const workspaceDockerfileResources = [
  "base.Dockerfile",
  "github-cli.Dockerfile",
  "browser-test.Dockerfile",
  "shellcheck.Dockerfile",
] as const;

/** 根参考包在准备阶段读取自有配置和 Dockerfile 片段。 */
export function prepareWorkspaceDevelopmentContainerResources(): PreparedWorkspaceDevelopmentContainerResources {
  const read = (source: typeof environmentSources.base, file: string) => {
    try {
      return readFileSync(resolveTemplateSource(source, file), "utf8");
    } catch (cause) {
      throw new Error(
        `根环境资源 @ykdz/reference-workspace-root#./environment prepare 阶段无法读取 ${file}`,
        { cause },
      );
    }
  };
  const dockerfileFragments = Object.fromEntries(
    workspaceDockerfileResources.map((file) => [
      file,
      read(
        file === "base.Dockerfile"
          ? environmentSources.base
          : environmentSources.devcontainer,
        file,
      ),
    ]),
  );
  let configuration: PreparedWorkspaceDevelopmentContainerResources["configuration"];
  try {
    configuration = JSON.parse(
      readFileSync(
        resolveTemplateSource(
          environmentSources.devcontainer,
          "workspace-template.json",
        ),
        "utf8",
      ),
    ) as PreparedWorkspaceDevelopmentContainerResources["configuration"];
  } catch (cause) {
    throw new Error(
      "根环境资源 @ykdz/reference-workspace-root#./environment prepare 阶段无法读取 workspace-template.json",
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

function completeWorkspaceDevelopmentContainer(options: {
  readonly nodeVersion: string;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
  readonly resources: PreparedWorkspaceDevelopmentContainerResources;
}): DevelopmentContainerToolLayerPlan & {
  readonly configuration: PreparedWorkspaceDevelopmentContainerResources["configuration"];
  readonly features: Readonly<Record<string, Record<string, unknown>>>;
  readonly dockerfile: string;
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
    dockerfile: developmentContainerDockerfileFromText({
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

/** 只消费根环境快照和所选能力，投影开发容器配置。 */
export function projectWorkspaceDevelopmentContainer(options: {
  readonly nodeVersion: string;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
  readonly resources: PreparedWorkspaceDevelopmentContainerResources;
}): ReturnType<typeof completeWorkspaceDevelopmentContainer> {
  return completeWorkspaceDevelopmentContainer(options);
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

/** 根参考包在准备阶段读取并验证自有编辑器能力声明。 */
export function prepareWorkspaceEditorCustomizationDeclarations(): EditorCustomizationDeclarations {
  try {
    return loadEditorCustomizationDeclarations(
      resolveTemplateSource(
        environmentSources.editorCustomization,
        "capabilities.json",
      ),
      "@ykdz/reference-workspace-root#./resources/environment/editor-customization/capabilities.json",
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `根环境资源 @ykdz/reference-workspace-root#./environment prepare 阶段失败：${detail}`,
      { cause },
    );
  }
}

/** 只组合已准备的编辑器声明与实际能力。 */
export function projectWorkspaceEditorCustomization(
  capabilities: readonly EditorCustomizationCapability[],
  declarations: EditorCustomizationDeclarations,
): EditorCustomization {
  const unknownCapability = capabilities.find(
    (capability) => !declarations.capabilityOrder.includes(capability),
  );
  if (unknownCapability !== undefined) {
    throw new Error(`未声明的编辑器能力：${unknownCapability}`);
  }
  return editorCustomizationForCapabilities(capabilities, declarations);
}
