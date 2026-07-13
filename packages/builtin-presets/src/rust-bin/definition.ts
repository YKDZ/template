import { fileURLToPath } from "node:url";

import { rustToolchainEnvironmentNeed } from "@ykdz/template-core/module-graph";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "@ykdz/template-core/preset-definition";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint-v2";
import type { RenderOperation } from "@ykdz/template-core/renderer";

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

function rustContribution(context: GenerationContext): PackageContribution {
  const cargoName = cargoPackageName(context.projectName);
  const definition: PackageDefinition = {
    name: `@${context.scope}/${cargoName}-native`,
    path: `packages/${cargoName}`,
    role: "native-package",
  };
  const operations: RenderOperation[] = [
    { kind: "writeJson", to: `${definition.path}/package.json`, value: {} },
    {
      kind: "writeTextTemplate",
      source: templateSources.rustBin,
      from: "Cargo.toml",
      to: `${definition.path}/Cargo.toml`,
      replacements: { CARGO_PACKAGE_NAME: cargoName },
    },
    {
      kind: "writeTextTemplate",
      source: templateSources.rustBin,
      from: "Cargo.lock",
      to: `${definition.path}/Cargo.lock`,
      replacements: { CARGO_PACKAGE_NAME: cargoName },
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
      engines: { node: context.toolchain.nodeLtsMajor },
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
    return {
      schemaVersion: 2,
      packages: [rustContribution(context).definition],
    };
  },
  planInitialization: rustContribution,
};
