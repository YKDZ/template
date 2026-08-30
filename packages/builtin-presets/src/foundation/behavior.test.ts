import { describe, expect, it } from "vitest";

import { materializeProjectProjection } from "#template-core/project-projection";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryInitialization,
  type BuiltInGenerationContext,
} from "../foundation.ts";
import { tsLibDefinition } from "../ts-lib/definition.ts";

const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.21.0",
} as const;
const configurableDefinitions = builtInPresetRegistry
  .all()
  .filter((definition) => definition.initialPrimaryPackage !== undefined);
const configurableDefinition = configurableDefinitions[0];
if (configurableDefinition?.initialPrimaryPackage === undefined) {
  throw new Error("Expected a configurable Primary Package Definition");
}
const defaultPrimaryPackage = configurableDefinition.initialPrimaryPackage;
const defaultLeafName = defaultPrimaryPackage.defaultLeafName;
const defaultPackagePath = defaultPrimaryPackage.defaultPackagePath({
  packageLeafName: defaultLeafName,
});

describe("Generated Repository initialization preparation", () => {
  it("rejects an invalid durable scope through the public initialization planner", () => {
    const context = createGenerationContext({
      targetDir: "/tmp/.bad",
      toolchain,
    });

    expect(() =>
      planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context,
      }),
    ).toThrow(
      /^Generation Record defaultPackageScope must be a valid npm scope$/u,
    );
  });

  it.each(configurableDefinitions)(
    "resolves the $metadata.name Preset-owned Primary Package Identity",
    (definition) => {
      const capability = definition.initialPrimaryPackage;
      const preparation = prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
      });

      expect(preparation.resolvedPackageIdentity).toEqual({
        leafName: capability.defaultLeafName,
        definition: {
          name: `@customer-repository/${capability.defaultLeafName}`,
          path: capability.defaultPackagePath({
            packageLeafName: capability.defaultLeafName,
          }),
          role: capability.role,
        },
      });
      expect(preparation.resolvedPackageIdentity).toBeDefined();
      expect(preparation.plan.blueprint.packages).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            preparation.resolvedPackageIdentity!.definition,
          ),
        ]),
      );
    },
  );

  it.each(
    builtInPresetRegistry
      .all()
      .filter((definition) => definition.initialPrimaryPackage === undefined),
  )(
    "preserves fixed-topology $metadata.name while applying only scope",
    (definition) => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { scope: "acme" },
      });

      expect(preparation.resolvedPackageIdentity).toBeUndefined();
      expect(preparation.context.defaultPackageScope).toBe("acme");
      expect(preparation.resolved).toEqual({
        preset: definition.metadata.name,
        topology: "fixed",
        packages: definition
          .blueprint(preparation.context)
          .packages.map(({ name, path }) => ({ name, path })),
        scope: "acme",
      });
      expect(preparation.plan.blueprint.packages).toEqual(
        expect.arrayContaining(
          definition
            .blueprint(preparation.context)
            .packages.map((candidate) => expect.objectContaining(candidate)),
        ),
      );
    },
  );

  it("uses the optional capability as the only configurable support fact", () => {
    for (const definition of builtInPresetRegistry.all()) {
      if (definition.initialPrimaryPackage === undefined) {
        expect(Object.hasOwn(definition, "blueprint")).toBe(true);
        expect(Object.hasOwn(definition, "planInitialization")).toBe(true);
      } else {
        expect(definition).not.toHaveProperty("blueprint");
        expect(definition).not.toHaveProperty("planInitialization");
        expect(definition).not.toHaveProperty(
          "planInitializationContributions",
        );
      }
    }
  });

  it.each([
    {
      overrides: { name: "runner" },
      expected: {
        leafName: "runner",
        name: "@customer-repository/runner",
        path: "packages/runner",
        scope: "customer-repository",
      },
    },
    {
      overrides: { path: "tools/release" },
      expected: {
        leafName: defaultLeafName,
        name: `@customer-repository/${defaultLeafName}`,
        path: "tools/release",
        scope: "customer-repository",
      },
    },
    {
      overrides: { scope: "@acme" },
      expected: {
        leafName: defaultLeafName,
        name: `@acme/${defaultLeafName}`,
        path: defaultPackagePath,
        scope: "acme",
      },
    },
    {
      overrides: { name: "runner", path: "tools/release", scope: "acme" },
      expected: {
        leafName: "runner",
        name: "@acme/runner",
        path: "tools/release",
        scope: "acme",
      },
    },
  ])(
    "keeps name, path, and scope overrides independent: $expected.path",
    ({ overrides, expected }) => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition: configurableDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides,
      });

      expect(preparation.context).toMatchObject({
        repositoryName: "customer-repository",
        defaultPackageScope: expected.scope,
      });
      expect(preparation.resolvedPackageIdentity).toMatchObject({
        leafName: expected.leafName,
        definition: { name: expected.name, path: expected.path },
      });
    },
  );

  it("returns one stable resolved display model for configurable topology", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: configurableDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "runner",
        path: "tools/release",
        scope: "acme",
      },
    });

    expect(preparation.resolved).toEqual({
      preset: configurableDefinition.metadata.name,
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/runner", path: "tools/release" }],
      scope: "acme",
    });
  });

  it("accepts a Node built-in name as a scoped Primary Package leaf", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: { name: "http", scope: "acme" },
    });

    expect(preparation.resolvedPackageIdentity).toEqual({
      leafName: "http",
      definition: {
        name: "@acme/http",
        path: "packages/http",
        role: "shared-library",
      },
    });
    expect(preparation.resolved).toEqual({
      preset: "ts-lib",
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/http", path: "packages/http" }],
      scope: "acme",
    });
  });

  it("rejects an unsafe Preset-derived Package Path for a valid leaf", () => {
    let error: unknown;
    try {
      prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { name: "node_modules", scope: "acme" },
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Preset-derived Package Path packages/node_modules is unsafe; pass --path with exactly two safe path segments",
    );
  });

  it("accepts a safe explicit Package Path for a leaf with an unsafe default path", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "node_modules",
        path: "tools/release",
        scope: "acme",
      },
    });

    expect(preparation.resolvedPackageIdentity).toEqual({
      leafName: "node_modules",
      definition: {
        name: "@acme/node_modules",
        path: "tools/release",
        role: "shared-library",
      },
    });
  });

  it.each([".bad", "-bad", "_bad"])(
    "rejects default package scope %s before planning",
    (scope) => {
      expect(() =>
        prepareGeneratedRepositoryInitialization({
          definition: tsLibDefinition,
          targetDir: "/tmp/customer-repository",
          toolchain,
          overrides: { scope },
        }),
      ).toThrowError("--scope must be a valid npm scope without whitespace");
    },
  );

  it.each(
    builtInPresetRegistry
      .all()
      .filter((definition) => definition.initialPrimaryPackage === undefined),
  )(
    "rejects Primary Package Identity overrides for fixed-topology $metadata.name",
    (definition) => {
      expect(() =>
        prepareGeneratedRepositoryInitialization({
          definition,
          targetDir: "/tmp/customer-repository",
          toolchain,
          overrides: { name: "renamed", path: "tools/renamed" },
        }),
      ).toThrow(
        `Built-in Preset ${definition.metadata.name} has fixed initial package topology and does not accept --name or --path`,
      );
    },
  );

  it("aggregates invalid name, path, and scope overrides", () => {
    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: builtInPresetRegistry.require("ts-lib"),
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "@acme/library",
          path: ".git/library/source",
          scope: "Bad Scope",
        },
      }),
    ).toThrowError(
      [
        "--name must be an unscoped package leaf name",
        "--path must be exactly two safe path segments",
        "--path .git/library/source uses reserved workspace collection .git",
        "--scope must be a valid npm scope without whitespace",
      ].join("\n"),
    );
  });

  it("aggregates invalid input with an independently knowable Foundation collision", () => {
    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "@acme/library",
          path: "packages/typescript-config",
        },
      }),
    ).toThrowError(
      [
        "--name must be an unscoped package leaf name",
        "Initial Package Path packages/typescript-config conflicts with Foundation Package Path packages/typescript-config",
      ].join("\n"),
    );
  });

  it("substitutes an overlong leaf while preserving a known Foundation path collision", () => {
    let error: unknown;
    try {
      prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "a".repeat(220),
          path: "packages/typescript-config",
        },
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      [
        "--name must be an unscoped package leaf name",
        "Initial Package Path packages/typescript-config conflicts with Foundation Package Path packages/typescript-config",
      ].join("\n"),
    );
  });

  it("does not invent a default-path collision for an invalid explicit path", () => {
    let error: unknown;
    try {
      prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "typescript-config",
          path: "packages/typescript-config/nested",
        },
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      [
        "--path must be exactly two safe path segments",
        "Initial package name @customer-repository/typescript-config conflicts with Foundation package @customer-repository/typescript-config",
      ].join("\n"),
    );
  });

  it("aggregates input, Blueprint, and planner diagnostics through one error mode", () => {
    const fixedDefinition = builtInPresetRegistry
      .all()
      .find((definition) => definition.initialPrimaryPackage === undefined);
    if (
      fixedDefinition === undefined ||
      fixedDefinition.initialPrimaryPackage !== undefined
    ) {
      throw new Error("Expected a fixed-topology Definition");
    }
    const diagnosticDefinition = {
      ...fixedDefinition,
      metadata: { ...fixedDefinition.metadata, name: "diagnostic-fixed" },
      blueprint() {
        return {
          schemaVersion: 3 as const,
          packages: [
            {
              name: "INVALID NAME",
              path: "packages/app",
              role: "runtime-service" as const,
            },
          ],
        };
      },
      planInitialization() {
        throw new Error(
          "Synthetic planner diagnostic one\nSynthetic planner diagnostic two",
        );
      },
      planInitializationContributions() {
        throw new Error(
          "Synthetic planner diagnostic one\nSynthetic planner diagnostic two",
        );
      },
    };

    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: diagnosticDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { scope: "Bad Scope" },
      }),
    ).toThrowError(
      [
        "--scope must be a valid npm scope without whitespace",
        ".packages[0].name: Package name must be a valid npm package name for new packages",
        "Synthetic planner diagnostic one",
        "Synthetic planner diagnostic two",
      ].join("\n"),
    );
  });

  it.each(configurableDefinitions)(
    "projects one resolved $metadata.name identity through durable and generated facts",
    async (definition) => {
      const capability = definition.initialPrimaryPackage;
      const preparation = prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "runner",
          path: "tools/release",
          scope: "acme",
        },
      });
      const resolved = preparation.resolvedPackageIdentity!;
      const packageDefinition = preparation.plan.blueprint.packages.find(
        (candidate) => candidate.path === "tools/release",
      )!;
      const contribution = preparation.plan.packageContributions[0]!;
      const provenance = preparation.plan.generationRecord.packages.find(
        (candidate) =>
          candidate.packageDefinitionId ===
          packageDefinition.packageDefinitionId,
      );

      expect(resolved).toEqual({
        leafName: "runner",
        definition: {
          name: "@acme/runner",
          path: "tools/release",
          role: capability.role,
        },
      });
      expect(contribution.definition).toEqual(resolved.definition);
      expect(contribution.manifest.name).toBe(resolved.definition.name);
      expect(provenance).toMatchObject({
        definitionName: definition.metadata.name,
        planningContribution: "planInitialization",
        path: resolved.definition.path,
      });

      const projection = await materializeProjectProjection({
        operations: preparation.plan.operations,
        reconciliation: preparation.plan.reconciliation,
      });
      const readJson = (projectionPath: string): Record<string, unknown> => {
        const entry = projection.entries.find(
          (candidate) => candidate.path === projectionPath,
        )!;
        return JSON.parse(new TextDecoder().decode(entry.content)) as Record<
          string,
          unknown
        >;
      };
      expect(readJson("tools/release/package.json").name).toBe(
        resolved.definition.name,
      );
      expect(readJson(".template/blueprint.json")).toEqual(
        preparation.plan.blueprint,
      );
      expect(readJson(".template/generation.json")).toEqual(
        preparation.plan.generationRecord,
      );
      if (capability.role === "cli-tool") {
        expect(readJson("tools/release/package.json").bin).toEqual({
          runner: "./dist/cli.js",
        });
      }
      if (
        contribution.foundation.npmPublication?.kind === "public-cli-candidate"
      ) {
        expect(readJson("tsconfig.json")).toMatchObject({
          compilerOptions: {
            allowJs: true,
            allowImportingTsExtensions: true,
            checkJs: true,
            noEmit: true,
          },
          include: [
            ".pnpmfile.mjs",
            "scripts/npm-publication/*.ts",
            "scripts/npm-publication-setup/bridge.ts",
          ],
        });
        expect(preparation.plan.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "writeTextTemplate",
              to: "scripts/npm-publication/check-readiness.ts",
              replacements: { PUBLIC_CLI_PACKAGE_PATH: "tools/release" },
            }),
          ]),
        );
      }
    },
  );

  it("exposes the enriched ts-lib contribution consumed by manifests and projection", async () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: { scope: "acme" },
    });
    const contribution = preparation.plan.packageContributions[0]!;
    const plannedManifest = preparation.plan.manifests.find(
      (manifest) => manifest.name === "@acme/lib",
    );
    const projection = await materializeProjectProjection({
      operations: preparation.plan.operations,
      reconciliation: preparation.plan.reconciliation,
    });
    const packageJson = projection.entries.find(
      (entry) => entry.path === "packages/lib/package.json",
    )!;

    expect(contribution.manifest).toMatchObject({
      devDependencies: {
        "@acme/typescript-config": "workspace:*",
      },
    });
    const rootManifest = preparation.plan.manifests.find(
      (manifest) => manifest.name === "customer-repository",
    );
    expect(rootManifest).not.toHaveProperty("scripts.publication:readiness");
    expect(rootManifest).not.toHaveProperty("devDependencies.semver");
    expect(
      preparation.plan.operations.some((operation) =>
        "to" in operation
          ? operation.to.startsWith("scripts/npm-publication/") ||
            operation.to === ".pnpmfile.mjs"
          : false,
      ),
    ).toBe(false);
    expect(contribution.manifest).toEqual(plannedManifest);
    expect(JSON.parse(new TextDecoder().decode(packageJson.content))).toEqual(
      contribution.manifest,
    );
  });

  it("rejects a complete plan with more than one public CLI candidate", () => {
    const base = builtInPresetRegistry.require("vue-hono-app");
    if (
      base.initialPrimaryPackage !== undefined ||
      base.planInitializationContributions === undefined
    ) {
      throw new Error("Expected a fixed multi-package Preset Definition");
    }
    const baseContributions = (context: BuiltInGenerationContext) =>
      base.planInitializationContributions!(context);
    const markCandidate = <
      T extends ReturnType<typeof baseContributions>[number],
    >(
      contribution: T,
    ): T =>
      ({
        ...contribution,
        foundation: {
          ...contribution.foundation,
          npmPublication: { kind: "public-cli-candidate" as const },
        },
      }) as T;
    const definition = {
      ...base,
      metadata: { ...base.metadata, name: "two-public-cli-candidates" },
      planInitialization(context: BuiltInGenerationContext) {
        return markCandidate(base.planInitialization(context));
      },
      planInitializationContributions(context: BuiltInGenerationContext) {
        return baseContributions(context).map((contribution, index) =>
          index < 2 ? markCandidate(contribution) : contribution,
        );
      },
    };

    expect(() =>
      planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: "/tmp/two-public-cli-candidates",
          toolchain,
        }),
      }),
    ).toThrow(
      "Generated Repository Plan supports at most one public CLI candidate",
    );
  });

  it("rejects a known projection collision during preparation", () => {
    const definition = {
      ...tsLibDefinition,
      metadata: { ...tsLibDefinition.metadata, name: "collision-test" },
      initialPrimaryPackage: {
        ...tsLibDefinition.initialPrimaryPackage,
        planInitialContribution(
          options: Parameters<
            typeof tsLibDefinition.initialPrimaryPackage.planInitialContribution
          >[0],
        ) {
          const contribution =
            tsLibDefinition.initialPrimaryPackage.planInitialContribution(
              options,
            );
          return {
            ...contribution,
            operations: [
              ...contribution.operations,
              {
                kind: "writeText" as const,
                to: `${contribution.definition.path}/package.json`,
                text: "{}\n",
              },
            ],
          };
        },
      },
    };

    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
      }),
    ).toThrow(
      `Project Projection collision at ${tsLibDefinition.initialPrimaryPackage.defaultPackagePath({ packageLeafName: tsLibDefinition.initialPrimaryPackage.defaultLeafName })}/package.json: writeText follows writeJson without overwrite`,
    );
  });

  it("aggregates Foundation package name and path collisions", () => {
    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: builtInPresetRegistry.require("ts-lib"),
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: {
          name: "typescript-config",
          path: "packages/typescript-config",
        },
      }),
    ).toThrowError(
      [
        "Initial package name @customer-repository/typescript-config conflicts with Foundation package @customer-repository/typescript-config",
        "Initial Package Path packages/typescript-config conflicts with Foundation Package Path packages/typescript-config",
      ].join("\n"),
    );
  });

  it.each(["Customer Repository", ".bad"])(
    "rejects Repository Identity %s as an invalid default scope actionably",
    (repositoryName) => {
      expect(() =>
        prepareGeneratedRepositoryInitialization({
          definition: builtInPresetRegistry.require("ts-lib"),
          targetDir: `/tmp/${repositoryName}`,
          toolchain,
        }),
      ).toThrow(
        `Repository Identity ${repositoryName} is not a valid default package scope; pass --scope with a valid npm scope`,
      );
    },
  );
});
