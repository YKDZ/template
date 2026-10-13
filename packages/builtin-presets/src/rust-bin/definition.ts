import { fileURLToPath } from "node:url";

import { rustToolchainEnvironmentNeed } from "@ykdz/template-core/module-graph";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";

import { templateSources } from "../template-sources.ts";

function packagePathForLeaf(packageLeafName: string): string {
  return `packages/${packageLeafName}`;
}

function packageScripts(): Record<string, string> {
  return {
    "format:check":
      "cargo fmt --all -- --check && oxfmt --list-different --no-error-on-unmatched-pattern package.json tsconfig.scripts.json turbo.json scripts",
    "format:write":
      "cargo fmt --all && oxfmt --write --no-error-on-unmatched-pattern package.json tsconfig.scripts.json turbo.json scripts",
    lint: "cargo clippy --workspace --all-targets -- -D warnings && oxlint --quiet --format=unix scripts",
    test: "node --conditions=source scripts/run-rust-tests.ts",
    typecheck: "tsc -p tsconfig.scripts.json --noEmit --pretty false",
  };
}

function rustContribution(options: {
  readonly context: GenerationContext;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly packageDefinition?: PackageDefinition;
}): PackageContribution {
  const definition: PackageDefinition = options.packageDefinition ?? {
    name: `@${options.context.defaultPackageScope}/${options.packageLeafName}`,
    path: options.packagePath,
    role: "native-package",
  };
  // 根声明与容器初值共用同一个上下文 channel：初始化携带 CLI 发版快照的精确版本，加包携带目标根
  // rust-toolchain.toml 的现行 channel；缺省只服务还没有根声明的首次建源路径。
  const rustChannel = options.context.toolchain.rustVersion ?? "stable";
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    {
      kind: "writeTextTemplate",
      source: templateSources.rustBin,
      from: "tsconfig.scripts.json",
      to: `${definition.path}/tsconfig.scripts.json`,
      replacements: {
        TYPESCRIPT_CONFIG_PACKAGE:
          options.context.foundationPackages.typescriptConfiguration.name,
      },
    },
    {
      kind: "writeTextTemplate",
      source: templateSources.rustBin,
      from: "Cargo.toml",
      to: `${definition.path}/Cargo.toml`,
      replacements: { CARGO_PACKAGE_NAME: options.packageLeafName },
    },
    {
      kind: "writeTextTemplate",
      source: templateSources.rustBin,
      from: "Cargo.lock",
      to: `${definition.path}/Cargo.lock`,
      replacements: { CARGO_PACKAGE_NAME: options.packageLeafName },
    },
    {
      kind: "copyFile",
      source: templateSources.rustBin,
      from: "rustfmt.toml",
      to: `${definition.path}/rustfmt.toml`,
    },
    {
      kind: "copyFile",
      source: templateSources.rustBin,
      from: "turbo.json",
      to: `${definition.path}/turbo.json`,
    },
    {
      kind: "copyFile",
      source: templateSources.rustBin,
      from: "src/main.rs",
      to: `${definition.path}/src/main.rs`,
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "scripts/run-rust-tests.ts",
      to: `${definition.path}/scripts/run-rust-tests.ts`,
    },
  ];
  return {
    definition,
    exposure: { exports: {}, imports: {} },
    manifest: {
      name: definition.name,
      private: true,
      type: "module",
      scripts: packageScripts(),
      devDependencies: {
        [options.context.foundationPackages.typescriptConfiguration.name]:
          "link:../typescript-config",
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "typescript-7": "catalog:",
      },
      engines: { node: options.context.toolchain.nodeLtsMajor },
    },
    operations,
    environmentNeeds: [
      rustToolchainEnvironmentNeed({
        kind: "package-boundary",
        path: definition.path,
      }),
    ],
    foundation: {
      toolchains: {
        rust: {
          toolchain: rustChannel,
          components: ["rustfmt", "clippy"],
          configurationSource: {
            source: templateSources.rustBin,
            from: "rust-toolchain.toml",
          },
        },
      },
      editorCapabilities: ["rust-tooling"],
      dependencyMaintenance: {
        ecosystems: [
          "npm",
          "cargo",
          "github-actions",
          "docker",
          "rust-toolchain",
        ],
        directories: { cargo: `/${definition.path}` },
        interval: "weekly",
      },
      developmentContainerToolLayers: [
        {
          identity: "rust",
          dockerfile: {
            source: templateSources.rustBin,
            from: "devcontainer/rust.Dockerfile",
          },
          requires: ["node-pnpm"],
          buildArguments: [{ name: "RUST_TOOLCHAIN", value: rustChannel }],
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
          ],
        },
      ],
    },
  };
}

const binaryReplayAdapter = definePackageContributionReplayAdapter({
  identity: "binary",
  replay: ({ context, packageDefinition, packageLeafName }) =>
    rustContribution({
      context,
      packageLeafName,
      packagePath: packageDefinition.path,
      packageDefinition,
    }),
});

export const rustBinDefinition = {
  metadata: {
    name: "rust-bin",
    title: "Rust 二进制程序",
    description: "包含 rustfmt、clippy 和 cargo 测试的 Rust 原生二进制工作区。",
  },
  source: templateSources.rustBin,
  plannerSourceFile: fileURLToPath(import.meta.url),
  packageContributionReplayAdapters: [binaryReplayAdapter],
  initialPrimaryPackage: {
    defaultLeafName: "app",
    role: "native-package",
    defaultPackagePath: ({ packageLeafName }) =>
      packagePathForLeaf(packageLeafName),
    planInitialContribution({ context, resolvedPackageIdentity }) {
      return binaryReplayAdapter.identify(
        rustContribution({
          context,
          packageLeafName: resolvedPackageIdentity.leafName,
          packagePath: resolvedPackageIdentity.definition.path,
          packageDefinition: resolvedPackageIdentity.definition,
        }),
      );
    },
  },
  defaultPackagePath({ packageLeafName }) {
    return packagePathForLeaf(packageLeafName);
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return binaryReplayAdapter.identify(
      rustContribution({ context, packageLeafName, packagePath }),
    );
  },
} satisfies BuiltInPresetDefinition;
