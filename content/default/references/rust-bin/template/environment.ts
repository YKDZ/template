import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  resolveTemplateSource,
} from "@ykdz/template-core/template-source";
import type { DevelopmentContainerToolLayer } from "@ykdz/template-environment/development-container-tool-layer";

const resourceSource = createTemplateSourceHandle(
  fileURLToPath(new URL("../resources/devcontainer/", import.meta.url)),
);

/** Rust owner 在宿主同步阶段读取自己的 Dockerfile 片段。 */
export function prepareRustDevelopmentContainerToolLayerFragments(): Readonly<
  Record<string, string>
> {
  try {
    return {
      "rust.Dockerfile": readFileSync(
        resolveTemplateSource(resourceSource, "rust.Dockerfile"),
        "utf8",
      ),
    };
  } catch (cause) {
    throw new Error(
      "Rust 开发容器资源 @ykdz/reference-rust-bin#./environment prepare 阶段无法读取 rust.Dockerfile",
      { cause },
    );
  }
}

/** Rust 工具层的参数、挂载与探针由 Rust owner 声明。 */
export function rustDevelopmentContainerToolLayer(
  rustVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "rust",
    dockerfile: { source: resourceSource, from: "rust.Dockerfile" },
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
