import type { RenderOperation } from "@ykdz/template-core/renderer";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import {
  rustDevelopmentContainerToolLayer,
  rustToolchainEnvironmentNeed,
} from "@ykdz/template-workspace/default-environment";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace/reference-package";
import { parse } from "smol-toml";

import {
  projectRustCargoFiles,
  projectRustPackageScripts,
  projectRustTurboTasks,
  type CargoFileSnapshot,
} from "./rust-package-projection.ts";
import { parseRustToolchainDeclaration } from "./rust-toolchain-projection.ts";

type RustReferenceFacts = {
  readonly cargoManifest: CargoFileSnapshot;
  readonly cargoLock: CargoFileSnapshot;
  readonly toolchainConfiguration: ReturnType<
    typeof parseRustToolchainDeclaration
  >;
};

export const referencePackage: ReferencePackage<
  PackageCreationInput,
  RustReferenceFacts
> = defineReferencePackage({
  packageName: "@ykdz/reference-rust-bin",
  artifactVersion: "0.0.0",
  resolve: (specifier) => import.meta.resolve(specifier),
  resourceRoot: new URL("../", import.meta.url),
  alias: "binary",
  instance: "independent",
  defaultLeafName: "app",
  role: "native-package",
  requiresRootRustToolchain: true,
  resources: ["."],
  template: {
    dependencies: [
      { name: "@ykdz/template-core", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace",
        purpose: "template-execution",
      },
      { name: "smol-toml", purpose: "template-execution" },
    ],
    scripts: ["build:template", "check:author-planning-roles"],
    resources: ["template", "tsconfig.template.json"],
    executionData: ["Cargo.toml", "Cargo.lock", "template/rust-toolchain.toml"],
  },
  prepare(input) {
    const source = (file: string): CargoFileSnapshot => {
      const text = input.readText(file);
      return { source: text, data: parse(text) };
    };
    return {
      cargoManifest: source("Cargo.toml"),
      cargoLock: source("Cargo.lock"),
      toolchainConfiguration: parseRustToolchainDeclaration(
        input.readText("template/rust-toolchain.toml"),
      ),
    };
  },
  environmentNeeds: ({ definition }) => [
    rustToolchainEnvironmentNeed({
      kind: "package-boundary",
      path: definition.path,
    }),
  ],
  foundation({ context, definition }) {
    const rustChannel = context.toolchain.rustVersion ?? "stable";
    return {
      toolchains: {
        rust: {
          toolchain: rustChannel,
          components: ["rustfmt", "clippy"],
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
        rustDevelopmentContainerToolLayer(rustChannel),
      ],
    };
  },
  project(contribution, { definition, preparation }) {
    const { cargoManifest, cargoLock } = preparation.ownerFacts;
    const rustToolchain = contribution.foundation.toolchains.rust;
    if (rustToolchain === undefined) {
      throw new Error("Rust 参考包缺少所属工具链能力");
    }
    const targetName = definition.name.slice(
      definition.name.lastIndexOf("/") + 1,
    );
    const cargoFiles = projectRustCargoFiles({
      cargoManifest,
      cargoLock,
      targetName,
    });
    const scripts = projectRustPackageScripts(
      contribution.manifest.scripts as Record<string, string>,
    );
    const replacements = new Map<string, RenderOperation>([
      [
        `${definition.path}/Cargo.toml`,
        {
          kind: "writeText",
          to: `${definition.path}/Cargo.toml`,
          text: cargoFiles.manifestText,
        },
      ],
      [
        `${definition.path}/Cargo.lock`,
        {
          kind: "writeText",
          to: `${definition.path}/Cargo.lock`,
          text: cargoFiles.lockText,
        },
      ],
    ]);
    return {
      ...contribution,
      manifest: { ...contribution.manifest, scripts },
      foundation: {
        ...contribution.foundation,
        toolchains: {
          ...contribution.foundation.toolchains,
          rust: {
            ...rustToolchain,
            configurationText:
              preparation.ownerFacts.toolchainConfiguration.declaration,
          },
        },
      },
      operations: contribution.operations.map((operation) => {
        const projected =
          "to" in operation
            ? (replacements.get(operation.to) ?? operation)
            : operation;
        if (
          projected.kind !== "writeJson" ||
          projected.to !== `${definition.path}/turbo.json`
        ) {
          return projected;
        }

        const turbo = projected.value as {
          readonly tasks: Record<string, unknown>;
        };
        return {
          ...projected,
          value: { ...turbo, tasks: projectRustTurboTasks(turbo.tasks) },
        };
      }),
    };
  },
});

export {
  parseRustToolchainDeclaration,
  projectRustToolchainDeclaration,
  resolveRustToolchainRequirements,
} from "./rust-toolchain-projection.ts";
export type {
  PreparedRustToolchainDeclaration,
  RustToolchainRequirement,
} from "./rust-toolchain-projection.ts";
