import path from "node:path";

import type { DevelopmentContainerToolLayerProbe } from "@ykdz/template-core/development-container-tool-layer";
import { materializeProjectProjection } from "@ykdz/template-core/project-projection";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import {
  builtInEditorCustomization,
  browserTestDevelopmentContainerToolLayer,
  planBuiltInDevelopmentContainer,
  rustDevelopmentContainerToolLayer,
  shellCheckDevelopmentContainerToolLayer,
} from "@ykdz/template-environment/development-environment";
import { format } from "oxfmt";

import formatterConfig from "../oxfmt.config.ts";
import type { TemplateToolchainDeclarations } from "./template-toolchain-declarations.ts";

/** 源码仓库仅声明自己的用途；通用工具与编辑器策略由所属包维护。 */
export async function repositoryDevelopmentEnvironment(
  declarations: TemplateToolchainDeclarations,
): Promise<{
  readonly files: Readonly<Record<string, string>>;
  readonly probes: readonly DevelopmentContainerToolLayerProbe[];
}> {
  const container = planBuiltInDevelopmentContainer({
    nodeVersion: declarations.rootNodeEngine.trim(),
    layers: [
      browserTestDevelopmentContainerToolLayer(),
      rustDevelopmentContainerToolLayer(
        declarations.rustToolchainChannel.trim(),
      ),
      shellCheckDevelopmentContainerToolLayer(),
      {
        identity: "template-repository",
        requires: ["node-pnpm"],
        dockerfile: {
          source: createTemplateSourceHandle(
            path.join(import.meta.dirname, "repository-environment"),
          ),
          from: "repository.Dockerfile",
        },
        buildArguments: [
          {
            name: "PACKAGE_MANAGER_PIN",
            value: declarations.packageManagerDeclaration.trim(),
          },
        ],
        mounts: [
          {
            identity: "cargo-target",
            type: "volume",
            source: "${devcontainerId}-target",
            target: "${containerWorkspaceFolder}/target",
          },
        ],
        probes: [
          { identity: "git-lfs", command: "git", args: ["lfs", "version"] },
        ],
      },
    ],
  });
  const editor = builtInEditorCustomization([
    "oxc-format-lint",
    "vue",
    "rust-tooling",
  ]);
  const extensions = [...editor.extensions, "fill-labs.dependi"];
  const settings = {
    ...editor.settings,
    "[rust]": { "editor.defaultFormatter": "rust-lang.rust-analyzer" },
    "[toml]": { "editor.defaultFormatter": "tamasfe.even-better-toml" },
  };
  const projection = await materializeProjectProjection({
    operations: [container.dockerfileOperation],
  });
  const files: Record<string, string> = Object.fromEntries(
    projection.entries.map((entry) => [
      entry.path,
      Buffer.from(entry.content).toString("utf8"),
    ]),
  );
  const structuredFiles: Record<string, unknown> = {
    ".devcontainer/devcontainer.json": {
      name: "Template",
      build: {
        dockerfile: "Dockerfile",
        args: Object.fromEntries(
          container.buildArguments.map(({ name, value }) => [name, value]),
        ),
      },
      features: container.features,
      customizations: { vscode: { extensions, settings } },
      runArgs: [
        "--security-opt=seccomp=unconfined",
        "--security-opt=apparmor=unconfined",
        "--cap-add=SYS_ADMIN",
      ],
      containerEnv: {
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        RUST_BACKTRACE: "1",
      },
      postCreateCommand: {
        installNodeDependencies: "pnpm install --frozen-lockfile",
      },
      remoteUser: "root",
      mounts: container.mounts.map(
        ({ identity: _identity, ...mount }) => mount,
      ),
    },
    ".vscode/settings.json": settings,
    ".vscode/extensions.json": { recommendations: extensions },
  };
  for (const [file, value] of Object.entries(structuredFiles)) {
    const result = await format(
      file,
      JSON.stringify(value, null, 2),
      formatterConfig,
    );
    if (result.errors.length > 0)
      throw new Error(
        `${file} 投影格式化失败：${result.errors.map((error) => error.message).join("；")}`,
      );
    files[file] = result.code;
  }
  return { files, probes: container.probes };
}
