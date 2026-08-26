import { fileURLToPath } from "node:url";

import { rustToolchainEnvironmentNeed } from "#template-core/module-graph";
import type { PackageContribution } from "#template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type BuiltInPresetDefinition,
  type GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint";
import type { RenderOperation } from "#template-core/renderer";

import { templateSources } from "../template-sources.ts";

function packagePathForLeaf(packageLeafName: string): string {
  return `packages/${packageLeafName}`;
}

function packageScripts(): Record<string, string> {
  return {
    "format:check": "cargo fmt --all -- --check",
    "format:write": "cargo fmt --all",
    lint: "cargo clippy --workspace --all-targets -- -D warnings",
    test: "cargo test --workspace",
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
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
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
  ];
  return {
    definition,
    exposure: { exports: {}, imports: {} },
    manifest: {
      name: definition.name,
      private: true,
      scripts: packageScripts(),
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
        rust: { toolchain: "stable", components: ["rustfmt", "clippy"] },
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
          buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
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
      templateFiles: [
        {
          identity: "rust-toolchain",
          source: templateSources.rustBin,
          from: "rust-toolchain.toml",
          to: "rust-toolchain.toml",
          replacements: { RUST_TOOLCHAIN: "stable" },
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
    title: "Rust binary",
    description:
      "Rust native binary workspace with rustfmt, clippy, and cargo tests.",
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
