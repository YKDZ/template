import { describe, expect, it } from "vitest";

import type { PackageContribution } from "#template-core/package-contribution";
import type {
  PackageDefinition,
  ProjectBlueprintV2,
} from "#template-core/project-blueprint-v2";
import { planExplicitProjectLinks } from "#template-core/project-linking-v2";

function contribution(
  definition: PackageDefinition,
  manifest: Readonly<Record<string, unknown>>,
): PackageContribution {
  const exports =
    typeof manifest.exports === "object" &&
    manifest.exports !== null &&
    !Array.isArray(manifest.exports)
      ? (manifest.exports as Readonly<Record<string, unknown>>)
      : {};
  const imports =
    typeof manifest.imports === "object" &&
    manifest.imports !== null &&
    !Array.isArray(manifest.imports)
      ? (manifest.imports as Readonly<Record<string, unknown>>)
      : {};
  return {
    definition,
    manifest: { ...manifest, name: definition.name },
    exposure: { exports, imports },
    operations: [],
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: { ecosystems: [], interval: "weekly" },
    },
    environmentNeeds: [],
  };
}

describe("Project Linking", () => {
  it("rejects a native consumer before planning and lists valid Package Paths", () => {
    const nativeDefinition: PackageDefinition = {
      name: "@demo/native",
      path: "packages/native",
      role: "native-package",
    };
    const runtimeDefinition: PackageDefinition = {
      name: "@demo/web",
      path: "apps/web",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const blueprint: ProjectBlueprintV2 = {
      schemaVersion: 2,
      packages: [nativeDefinition, runtimeDefinition, providerDefinition],
      packageLinkIntents: [
        {
          consumerPackagePath: nativeDefinition.path,
          providerPackagePath: providerDefinition.path,
        },
      ],
    };

    expect(() =>
      planExplicitProjectLinks({
        blueprint,
        contributions: [
          contribution(nativeDefinition, { scripts: { test: "cargo test" } }),
          contribution(runtimeDefinition, {
            type: "module",
            imports: { "#/*": "./src/*.ts" },
          }),
          contribution(providerDefinition, {
            type: "module",
            exports: {
              ".": {
                source: "./src/index.ts",
                types: "./dist/index.d.ts",
                default: "./dist/index.js",
              },
            },
          }),
        ],
      }),
    ).toThrow(
      "Package Link consumer packages/native cannot consume a Node package-name import. Valid Package Paths: apps/web",
    );
  });

  it("keeps a partial-source provider injected when its root export is default-only", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const plan = planExplicitProjectLinks({
      blueprint: {
        schemaVersion: 2,
        packages: [consumerDefinition, providerDefinition],
        packageLinkIntents: [
          {
            consumerPackagePath: consumerDefinition.path,
            providerPackagePath: providerDefinition.path,
          },
        ],
      },
      contributions: [
        contribution(consumerDefinition, { type: "module" }),
        contribution(providerDefinition, {
          type: "module",
          exports: {
            ".": { default: "./dist/index.js" },
            "./feature": {
              source: "./src/feature.ts",
              types: "./dist/feature.d.ts",
              default: "./dist/feature.js",
            },
          },
        }),
      ],
    });

    expect(
      plan.manifestPatchesByPackagePath.get(consumerDefinition.path),
    ).toMatchObject({
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    });
  });

  it("keeps a provider injected when its root source conditions are out of order", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const plan = planExplicitProjectLinks({
      blueprint: {
        schemaVersion: 2,
        packages: [consumerDefinition, providerDefinition],
        packageLinkIntents: [
          {
            consumerPackagePath: consumerDefinition.path,
            providerPackagePath: providerDefinition.path,
          },
        ],
      },
      contributions: [
        contribution(consumerDefinition, { type: "module" }),
        contribution(providerDefinition, {
          type: "module",
          exports: {
            ".": {
              default: "./dist/index.js",
              source: "./src/index.ts",
              types: "./dist/index.d.ts",
            },
          },
        }),
      ],
    });

    expect(
      plan.manifestPatchesByPackagePath.get(consumerDefinition.path),
    ).toMatchObject({
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    });
  });

  it("keeps a provider injected when a root source target is unusable", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const plan = planExplicitProjectLinks({
      blueprint: {
        schemaVersion: 2,
        packages: [consumerDefinition, providerDefinition],
        packageLinkIntents: [
          {
            consumerPackagePath: consumerDefinition.path,
            providerPackagePath: providerDefinition.path,
          },
        ],
      },
      contributions: [
        contribution(consumerDefinition, { type: "module" }),
        contribution(providerDefinition, {
          type: "module",
          exports: {
            ".": {
              source: "src/index.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        }),
      ],
    });

    expect(
      plan.manifestPatchesByPackagePath.get(consumerDefinition.path),
    ).toMatchObject({
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    });
  });

  it("uses current Manifest Truth instead of reconstructed exposure for a link decision", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const plan = planExplicitProjectLinks({
      blueprint: {
        schemaVersion: 2,
        packages: [consumerDefinition, providerDefinition],
        packageLinkIntents: [
          {
            consumerPackagePath: consumerDefinition.path,
            providerPackagePath: providerDefinition.path,
          },
        ],
      },
      contributions: [
        contribution(consumerDefinition, { type: "module" }),
        contribution(providerDefinition, {
          type: "module",
          exports: {
            ".": {
              source: "./src/index.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        }),
      ],
      manifestTruthByPackagePath: new Map([
        [
          providerDefinition.path,
          {
            name: providerDefinition.name,
            type: "module",
            exports: { ".": { default: "./dist/stale.js" } },
          },
        ],
      ]),
    });

    expect(
      plan.manifestPatchesByPackagePath.get(consumerDefinition.path),
    ).toMatchObject({
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    });
  });

  it("preserves a conservative injected dependency from Current Manifest Truth", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };
    const consumerManifest = {
      name: consumerDefinition.name,
      type: "module",
      dependencies: { [providerDefinition.name]: "workspace:*" },
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    };
    const providerManifest = {
      name: providerDefinition.name,
      type: "module",
      exports: {
        ".": {
          source: "./src/index.ts",
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
      },
    };
    const plan = planExplicitProjectLinks({
      blueprint: {
        schemaVersion: 2,
        packages: [consumerDefinition, providerDefinition],
        packageLinkIntents: [
          {
            consumerPackagePath: consumerDefinition.path,
            providerPackagePath: providerDefinition.path,
          },
        ],
      },
      contributions: [
        contribution(consumerDefinition, consumerManifest),
        contribution(providerDefinition, providerManifest),
      ],
      manifestTruthByPackagePath: new Map<
        string,
        Readonly<Record<string, unknown>>
      >([
        [consumerDefinition.path, consumerManifest],
        [providerDefinition.path, providerManifest],
      ]),
    });

    expect(
      plan.manifestPatchesByPackagePath.get(consumerDefinition.path),
    ).toMatchObject({
      dependenciesMeta: {
        [providerDefinition.name]: { injected: true },
      },
    });
  });

  it("rejects a provider without an importable root package export", () => {
    const consumerDefinition: PackageDefinition = {
      name: "@demo/consumer",
      path: "apps/consumer",
      role: "runtime-service",
    };
    const providerDefinition: PackageDefinition = {
      name: "@demo/provider",
      path: "packages/provider",
      role: "shared-library",
    };

    expect(() =>
      planExplicitProjectLinks({
        blueprint: {
          schemaVersion: 2,
          packages: [consumerDefinition, providerDefinition],
          packageLinkIntents: [
            {
              consumerPackagePath: consumerDefinition.path,
              providerPackagePath: providerDefinition.path,
            },
          ],
        },
        contributions: [
          contribution(consumerDefinition, { type: "module" }),
          contribution(providerDefinition, {
            type: "module",
            exports: {
              "./feature": {
                source: "./src/feature.ts",
                types: "./dist/feature.d.ts",
                default: "./dist/feature.js",
              },
            },
          }),
        ],
      }),
    ).toThrow(
      "Package Link provider packages/provider does not expose an importable package root",
    );
  });
});
