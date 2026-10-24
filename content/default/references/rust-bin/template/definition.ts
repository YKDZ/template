import type {
  ApplicationRequirements,
  RustToolchainRequirement,
} from "@ykdz/default-content-authoring/contracts";
import { rustToolchainEnvironmentNeed } from "@ykdz/default-content-authoring/environment-needs";
import {
  defineReferencePackage,
  serializeNativeReferenceDocument,
  type DefaultReferenceContributionFacts,
} from "@ykdz/default-content-authoring/reference-package";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type { ResourceFileSnapshot } from "@ykdz/template-core/reference-package";
import { rustDevelopmentContainerToolLayer } from "@ykdz/template-workspace/default-environment";
import { parse } from "smol-toml";

import referenceManifest from "../package.json" with { type: "json" };
import {
  projectRustCargoFiles,
  projectRustPackageScripts,
  projectRustTurboTasks,
  type CargoFileSnapshot,
} from "./rust-package-projection.ts";
import {
  parseRustToolchainDeclaration,
  projectRustToolchainDeclaration,
} from "./rust-toolchain-projection.ts";

type RustCreationInput = {
  readonly leafName?: string;
  readonly packageName?: string;
  readonly packagePath?: string;
};

export type RustReferenceFacts = {
  readonly cargoManifest: CargoFileSnapshot;
  readonly cargoLock: CargoFileSnapshot;
  readonly toolchainConfiguration: ReturnType<
    typeof parseRustToolchainDeclaration
  >;
};

type RustContributionFacts =
  DefaultReferenceContributionFacts<RustReferenceFacts>;

function snapshot(
  resources: readonly ResourceFileSnapshot[],
  resourcePath: string,
): CargoFileSnapshot {
  const resource = resources.find(({ path }) => path === resourcePath);
  if (resource === undefined) {
    throw new Error(`Rust 原生资源缺失：${resourcePath}`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    resource.content,
  );
  return { source, data: parse(source) };
}

function applicationRequirements(
  ownerFacts: RustReferenceFacts,
): ApplicationRequirements {
  const configuration = ownerFacts.toolchainConfiguration;
  return {
    rustToolchain: {
      toolchain: configuration.channel,
      components: configuration.components,
      configurationText: configuration.declaration,
    },
  };
}

function stableRustToolchain(
  value: unknown,
):
  | (RustToolchainRequirement & { readonly existingDeclaration?: string })
  | undefined {
  if (!isRecord(value) || !isRecord(value.applicationRequirements)) {
    return undefined;
  }
  const requirement = value.applicationRequirements.rustToolchain;
  if (
    !isRecord(requirement) ||
    typeof requirement.toolchain !== "string" ||
    !Array.isArray(requirement.components) ||
    !requirement.components.every(
      (component) => typeof component === "string",
    ) ||
    typeof requirement.configurationText !== "string" ||
    (requirement.existingDeclaration !== undefined &&
      typeof requirement.existingDeclaration !== "string")
  ) {
    return undefined;
  }
  return requirement as unknown as RustToolchainRequirement & {
    readonly existingDeclaration?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nativeReference = defineReferencePackage<
  RustCreationInput,
  RustReferenceFacts
>({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "binary",
  instance: "independent",
  defaultLeafName: "app",
  role: "native-package",
  dependencies: [
    {
      key: "base-workspace",
      ownerLocal: {
        specifier: "@ykdz/reference-workspace-root/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "resources/gitignore", targetPath: ".gitignore" },
    { path: "resources/npmignore", targetPath: ".npmignore" },
    { path: "Cargo.toml" },
    { path: "Cargo.lock" },
    { path: "rustfmt.toml" },
    { path: "src/main.rs" },
    { path: "turbo.json" },
    { path: "template/rust-toolchain.toml", prepareOnly: true },
  ],
  templateDependencies: [
    { name: "@ykdz/template-core", purpose: "template-execution" },
    {
      name: "@ykdz/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "@ykdz/template-workspace", purpose: "template-execution" },
    { name: "@ykdz/reference-workspace-root", purpose: "template-execution" },
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    { name: "oxfmt", purpose: "template-build" },
    { name: "oxlint", purpose: "template-build" },
    { name: "oxlint-tsgolint", purpose: "template-build" },
    { name: "smol-toml", purpose: "template-execution" },
    { name: "typescript-7", purpose: "template-build" },
  ],
  executionDependencies: [
    "@ykdz/template-core",
    "@ykdz/default-content-authoring",
    "@ykdz/template-workspace",
    "@ykdz/reference-workspace-root",
    "smol-toml",
  ],
  templateScripts: [
    "build:template",
    "check:author-planning-roles",
    "lint:fix",
    "typecheck",
  ],
  templateExports: ["./reference", "./template"],
  foundation: ({ definition, ownerFacts, stableCommon }) => {
    const requirement = stableRustToolchain(stableCommon);
    if (requirement === undefined) {
      throw new Error("Rust 参考包缺少稳定工具链共同输入");
    }
    return {
      toolchains: {
        rust: {
          toolchain: requirement.toolchain,
          components: requirement.components,
          configurationText: ownerFacts.toolchainConfiguration.declaration,
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
        rustDevelopmentContainerToolLayer(requirement.toolchain),
      ],
    };
  },
  environmentNeeds: ({ definition }) => [
    rustToolchainEnvironmentNeed({
      kind: "package-boundary",
      path: definition.path,
    }),
  ],
  rootDeclaration(ownerFacts, stableCommon) {
    const requirement = stableRustToolchain(stableCommon);
    const files =
      requirement === undefined
        ? []
        : [
            {
              path: "rust-toolchain.toml",
              content: new TextEncoder().encode(
                projectRustToolchainDeclaration({
                  requirement,
                  ...(requirement.existingDeclaration === undefined
                    ? {}
                    : { existingDeclaration: requirement.existingDeclaration }),
                }),
              ),
              mode: 0,
              sourcePath: "template/rust-toolchain.toml",
            },
          ];
    return {
      manifest: { scripts: { "toolchain:prepare": "cargo --version" } },
      turboTasks: {
        "//#toolchain:prepare": {
          cache: false,
          tags: ["work:preparation"],
        },
      },
      applicationRequirements: applicationRequirements(ownerFacts),
      ...(files.length === 0 ? {} : { files }),
    };
  },
  prepareFacts(resources) {
    const toolchain = resources.find(
      ({ path: resourcePath }) =>
        resourcePath === "template/rust-toolchain.toml",
    );
    if (toolchain === undefined) {
      throw new Error("Rust 工具链原生资源缺失：template/rust-toolchain.toml");
    }
    return {
      cargoManifest: snapshot(resources, "Cargo.toml"),
      cargoLock: snapshot(resources, "Cargo.lock"),
      toolchainConfiguration: parseRustToolchainDeclaration(
        new TextDecoder("utf-8", { fatal: true }).decode(toolchain.content),
      ),
    };
  },
});

export const referencePackage = Object.freeze({
  ...nativeReference,
  evaluate(input: Parameters<typeof nativeReference.evaluate>[0]) {
    const contribution = nativeReference.evaluate(input);
    const rustFacts = contribution.facts.ownerFacts;
    const targetName = input.definition.name.slice(
      input.definition.name.lastIndexOf("/") + 1,
    );
    const cargoFiles = projectRustCargoFiles({
      cargoManifest: rustFacts.cargoManifest,
      cargoLock: rustFacts.cargoLock,
      targetName,
    });
    const manifest = {
      ...contribution.facts.manifest,
      scripts: projectRustPackageScripts(
        isRecord(contribution.facts.manifest.scripts)
          ? (contribution.facts.manifest.scripts as Record<string, string>)
          : {},
      ),
    };
    const nativeDocuments = contribution.facts.nativeDocuments.map(
      (document) => {
        if (document.path === "package.json" && document.scope === "package") {
          return { ...document, value: manifest };
        }
        if (document.path !== "turbo.json" || !isRecord(document.value.tasks)) {
          return document;
        }
        return {
          ...document,
          value: {
            ...document.value,
            tasks: projectRustTurboTasks(document.value.tasks),
          },
        };
      },
    );
    const turboDocument = nativeDocuments.find(
      (document) => document.path === "turbo.json",
    );
    const packageManifestDocument = nativeDocuments.find(
      (document) => document.path === "package.json",
    );
    const files = contribution.files.map((file) => {
      if (
        file.path === "package.json" &&
        packageManifestDocument !== undefined
      ) {
        return {
          ...file,
          content: serializeNativeReferenceDocument(packageManifestDocument),
        };
      }
      if (file.path === "Cargo.toml") {
        return {
          ...file,
          content: new TextEncoder().encode(cargoFiles.manifestText),
        };
      }
      if (file.path === "Cargo.lock") {
        return {
          ...file,
          content: new TextEncoder().encode(cargoFiles.lockText),
        };
      }
      if (file.path === "turbo.json" && turboDocument !== undefined) {
        return {
          ...file,
          content: serializeNativeReferenceDocument(turboDocument),
        };
      }
      return file;
    });
    return {
      ...contribution,
      files,
      facts: {
        ...contribution.facts,
        manifest,
        nativeDocuments,
      },
    } satisfies PackageContribution<RustContributionFacts>;
  },
});

export {
  parseRustToolchainDeclaration,
  projectRustToolchainDeclaration,
  resolveRustToolchainRequirements,
} from "./rust-toolchain-projection.ts";
export type { CargoFileSnapshot } from "./rust-package-projection.ts";
export type {
  PreparedRustToolchainDeclaration,
  RustToolchainRequirement,
} from "./rust-toolchain-projection.ts";
