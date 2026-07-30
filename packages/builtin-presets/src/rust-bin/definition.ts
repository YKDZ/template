import { fileURLToPath } from "node:url";

import { rustToolchainEnvironmentNeed } from "#template-core/module-graph";
import type { PackageContribution } from "#template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "#template-core/preset-definition";
import type { PackageDefinition } from "#template-core/project-blueprint-v2";
import type { RenderOperation } from "#template-core/renderer";

import { templateSources } from "../template-sources.ts";

function cargoPackageName(projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "rust-bin";
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
}): PackageContribution {
  const definition: PackageDefinition = {
    name: `@${options.context.scope}/${options.packageLeafName}`,
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
      version: "0.0.0",
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

export const rustBinDefinition: BuiltInPresetDefinition = {
  metadata: {
    name: "rust-bin",
    title: "Rust binary",
    description:
      "Rust native binary workspace with rustfmt, clippy, and cargo tests.",
  },
  source: templateSources.rustBin,
  plannerSourceFile: fileURLToPath(import.meta.url),
  blueprint(context) {
    const packageLeafName = cargoPackageName(context.projectName);
    return {
      schemaVersion: 2,
      packages: [
        rustContribution({
          context,
          packageLeafName,
          packagePath: `packages/${packageLeafName}`,
        }).definition,
      ],
    };
  },
  planInitialization(context) {
    const packageLeafName = cargoPackageName(context.projectName);
    return rustContribution({
      context,
      packageLeafName,
      packagePath: `packages/${packageLeafName}`,
    });
  },
  defaultPackagePath({ packageLeafName }) {
    return `packages/${packageLeafName}`;
  },
  planPackageAddition({ context, packageLeafName, packagePath }) {
    return rustContribution({ context, packageLeafName, packagePath });
  },
};
