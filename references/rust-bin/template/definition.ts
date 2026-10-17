import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rustToolchainEnvironmentNeed } from "@ykdz/template-core/module-graph";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-core/reference-package";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import { rustDevelopmentContainerToolLayer } from "@ykdz/template-environment/development-environment";
import { parse, type TomlTable } from "smol-toml";

function readCargoFile(file: string): { source: string; data: TomlTable } {
  const source = readFileSync(
    fileURLToPath(
      import.meta.resolve(`@ykdz/reference-rust-bin/assets/${file}`),
    ),
    "utf8",
  );
  return { source, data: parse(source) };
}

export const referencePackage: ReferencePackage = defineReferencePackage({
  packageName: "@ykdz/reference-rust-bin",
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: "binary",
  instance: "independent",
  defaultLeafName: "app",
  role: "native-package",
  resources: ["."],
  authoring: {
    dependencies: [
      "@ykdz/template-core",
      "@ykdz/template-environment",
      "smol-toml",
    ],
    scripts: ["build:template"],
    resources: ["template", "tsconfig.template.json"],
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
          configurationSource: {
            source: referencePackage.source("template/rust-toolchain.toml"),
            from: ".",
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
        rustDevelopmentContainerToolLayer(rustChannel),
      ],
    };
  },
  project(contribution, { definition }) {
    const cargoManifest = readCargoFile("Cargo.toml");
    const cargoPackage = cargoManifest.data.package as Record<string, unknown>;
    const nativeName = cargoPackage.name;
    const targetName = definition.name.slice(
      definition.name.lastIndexOf("/") + 1,
    );
    const cargoLock = readCargoFile("Cargo.lock");
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
      operations: contribution.operations.map((operation) =>
        "to" in operation
          ? (replacements.get(operation.to) ?? operation)
          : operation,
      ),
    };
  },
});
