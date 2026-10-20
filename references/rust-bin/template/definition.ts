import type { RenderOperation } from "@ykdz/template-core/renderer";
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import { rustDevelopmentContainerToolLayer } from "@ykdz/template-environment/development-environment";
import { rustToolchainEnvironmentNeed } from "@ykdz/template-environment/module-graph";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace-authoring/reference-package";
import { parse, type TomlTable } from "smol-toml";

type CargoFile = { readonly source: string; readonly data: TomlTable };
type RustReferenceFacts = {
  readonly cargoManifest: CargoFile;
  readonly cargoLock: CargoFile;
  readonly toolchainConfiguration: string;
};

export const referencePackage: ReferencePackage<
  PackageCreationInput,
  RustReferenceFacts
> = defineReferencePackage({
  packageName: "@ykdz/reference-rust-bin",
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
      { name: "@ykdz/template-environment", purpose: "template-execution" },
      {
        name: "@ykdz/template-workspace-authoring",
        purpose: "template-execution",
      },
      { name: "smol-toml", purpose: "template-execution" },
    ],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
    executionData: ["Cargo.toml", "Cargo.lock", "template/rust-toolchain.toml"],
  },
  prepare(input) {
    const source = (file: string): CargoFile => {
      const text = input.readText(file);
      return { source: text, data: parse(text) };
    };
    return {
      cargoManifest: source("Cargo.toml"),
      cargoLock: source("Cargo.lock"),
      toolchainConfiguration: input.readText("template/rust-toolchain.toml"),
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
    const targetManifest = { ...contribution.manifest };
    delete targetManifest.files;
    const { cargoManifest, cargoLock } = preparation.ownerFacts;
    const rustToolchain = contribution.foundation.toolchains.rust;
    if (rustToolchain === undefined) {
      throw new Error("Rust 参考包缺少所属工具链能力");
    }
    const cargoPackage = cargoManifest.data.package as Record<string, unknown>;
    const nativeName = cargoPackage.name;
    const targetName = definition.name.slice(
      definition.name.lastIndexOf("/") + 1,
    );
    const lockedPackages = cargoLock.data.package as Record<string, unknown>[];
    const replacements = new Map<string, RenderOperation>([
      [
        `${definition.path}/Cargo.toml`,
        {
          kind: "writeText",
          to: `${definition.path}/Cargo.toml`,
          text: projectTomlStringValues(cargoManifest.source, [
            { path: ["package", "name"], value: targetName },
          ]),
        },
      ],
      [
        `${definition.path}/Cargo.lock`,
        {
          kind: "writeText",
          to: `${definition.path}/Cargo.lock`,
          text: projectTomlStringValues(
            cargoLock.source,
            lockedPackages.flatMap((lockedPackage, index) =>
              lockedPackage.name === nativeName &&
              lockedPackage.source === undefined
                ? [{ path: ["package", index, "name"], value: targetName }]
                : [],
            ),
          ),
        },
      ],
    ]);
    return {
      ...contribution,
      manifest: targetManifest,
      foundation: {
        ...contribution.foundation,
        toolchains: {
          ...contribution.foundation.toolchains,
          rust: {
            ...rustToolchain,
            configurationText: preparation.ownerFacts.toolchainConfiguration,
          },
        },
      },
      operations: contribution.operations.map((operation) =>
        "to" in operation
          ? (replacements.get(operation.to) ?? operation)
          : operation,
      ),
    };
  },
});
