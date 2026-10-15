import { readFileSync } from "node:fs";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import {
  planDevelopmentContainerToolLayersSync,
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerPlan,
} from "@ykdz/template-core/development-container-tool-layer";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomization,
  type EditorCustomizationCapability,
} from "@ykdz/template-core/editor-customization";
import {
  resolveTemplateSource,
  type WriteTextFromFragmentsOperation,
} from "@ykdz/template-core/renderer";

import { templateSources } from "../template-sources.ts";

export function githubCliDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "github-cli",
    dockerfile: {
      source: templateSources.sharedDevcontainer,
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

export function browserTestDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  const playwrightTestVersion =
    loadTemplateDependencyCatalog()["@playwright/test"];
  if (playwrightTestVersion === undefined) {
    throw new Error(
      "Template Dependency Catalog is missing dependency: @playwright/test",
    );
  }

  return {
    identity: "browser-test",
    dockerfile: {
      source: templateSources.sharedDevcontainer,
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

/** 共享基础层由内置仓库基础能力拥有，调用者仅追加其实际需要的工具层。 */
export function planBuiltInDevelopmentContainer(options: {
  readonly nodeVersion: string;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
}): DevelopmentContainerToolLayerPlan & {
  readonly features: Readonly<Record<string, Record<string, unknown>>>;
  readonly dockerfileOperation: WriteTextFromFragmentsOperation;
} {
  const plan = planDevelopmentContainerToolLayersSync({
    baseLayer: {
      identity: "node-pnpm",
      dockerfile: {
        source: templateSources.foundation,
        from: "devcontainer/base.Dockerfile",
      },
      buildArguments: [
        {
          name: "NODE_VERSION",
          // 根 Node 声明原文是 M1 槽位唯一来源；major 与快照字段不得另作真源。
          value: options.nodeVersion,
        },
      ],
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
    },
    layers: [
      githubCliDevelopmentContainerToolLayer(),
      ...(options.layers ?? []),
    ],
  });
  return {
    ...plan,
    features: (
      JSON.parse(
        readFileSync(
          resolveTemplateSource(
            templateSources.foundation,
            "devcontainer.json",
          ),
          "utf8",
        ),
      ) as { features: Record<string, Record<string, unknown>> }
    ).features,
    dockerfileOperation: {
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      validation: "development-container-dockerfile",
      fragments: plan.layers.map((layer) => layer.dockerfile),
    },
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

export function rustDevelopmentContainerToolLayer(
  rustVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "rust",
    dockerfile: {
      source: templateSources.sharedDevcontainer,
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
      source: templateSources.sharedDevcontainer,
      from: "shellcheck.Dockerfile",
    },
    requires: ["node-pnpm"],
    probes: [
      { identity: "shellcheck", command: "shellcheck", args: ["--version"] },
    ],
  };
}

export function builtInEditorCustomization(
  capabilities: readonly EditorCustomizationCapability[],
): EditorCustomization {
  const declarations = loadEditorCustomizationDeclarations(
    resolveTemplateSource(
      templateSources.editorCustomization,
      "capabilities.json",
    ),
  );
  const unknownCapability = capabilities.find(
    (capability) => !declarations.capabilityOrder.includes(capability),
  );
  if (unknownCapability !== undefined) {
    throw new Error(`未声明的编辑器能力：${unknownCapability}`);
  }
  return editorCustomizationForCapabilities(capabilities, declarations);
}
