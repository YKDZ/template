import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { materializeProjectProjection } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
  prepareGeneratedRepositoryInitialization,
  validateGeneratedRepositoryInitializationInput,
  type BuiltInGenerationContext,
  type InitializationPreparation,
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

function requireReadyInitialization(
  options: Parameters<typeof prepareGeneratedRepositoryInitialization>[0],
): Extract<InitializationPreparation, { readonly status: "ready" }> {
  const preparation = prepareGeneratedRepositoryInitialization(options);
  if (preparation.status !== "ready") {
    throw new Error(
      `Expected ready initialization, received ${preparation.status}`,
    );
  }
  return preparation;
}

describe("Generated Repository initialization preparation", () => {
  it("returns an owned input result for an unknown Preset before planning", () => {
    expect(
      prepareGeneratedRepositoryInitialization({
        preset: "missing-preset",
        targetDir: "/tmp/customer-repository",
        toolchain,
      }),
    ).toEqual({
      status: "input-invalid",
      issues: [{ code: "PRESET_UNKNOWN" }],
    });
  });

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
      const preparation = requireReadyInitialization({
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
      const preparation = requireReadyInitialization({
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
      const preparation = requireReadyInitialization({
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
    const preparation = requireReadyInitialization({
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
    const preparation = requireReadyInitialization({
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
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: { name: "node_modules", scope: "acme" },
    });

    expect(preparation).toEqual({
      status: "operation-failure",
      phase: "preset",
    });
  });

  it("keeps an unsafe Preset-derived Package Path as an invariant even with an explicit override", () => {
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

    expect(preparation).toEqual({
      status: "operation-failure",
      phase: "preset",
    });
  });

  it("does not inspect a Preset default path when pure input diagnostics already exist", () => {
    let defaultPathCalls = 0;
    const definition = {
      ...tsLibDefinition,
      initialPrimaryPackage: {
        ...tsLibDefinition.initialPrimaryPackage,
        defaultPackagePath() {
          defaultPathCalls += 1;
          throw new Error("default path must not run");
        },
      },
    };

    expect(
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { scope: "Bad Scope" },
      }),
    ).toEqual({
      status: "input-invalid",
      issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
    });
    expect(defaultPathCalls).toBe(0);
  });

  it("shares pure input issues with preparation without invoking Preset work", () => {
    let defaultPathCalls = 0;
    let plannerCalls = 0;
    const definition = {
      ...tsLibDefinition,
      initialPrimaryPackage: {
        ...tsLibDefinition.initialPrimaryPackage,
        defaultPackagePath() {
          defaultPathCalls += 1;
          throw new Error("default path must not run");
        },
        planInitialContribution() {
          plannerCalls += 1;
          throw new Error("planner must not run");
        },
      },
    };
    const options = {
      definition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "@acme/library",
        path: ".git/library/source",
        scope: "Bad Scope",
      },
    };

    const validation = validateGeneratedRepositoryInitializationInput(options);
    expect(validation).toEqual({
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "INVALID_PACKAGE_PATH" },
        { code: "RESERVED_PACKAGE_PATH" },
        { code: "INVALID_PACKAGE_SCOPE" },
      ],
    });
    expect(defaultPathCalls).toBe(0);
    expect(plannerCalls).toBe(0);
    expect(
      prepareGeneratedRepositoryInitialization({ ...options, toolchain }),
    ).toEqual(validation);
    expect(defaultPathCalls).toBe(0);
    expect(plannerCalls).toBe(0);
  });

  it("derives a valid Preset default path once before reusing it for planning", () => {
    let defaultPathCalls = 0;
    const definition = {
      ...tsLibDefinition,
      initialPrimaryPackage: {
        ...tsLibDefinition.initialPrimaryPackage,
        defaultPackagePath(options: { readonly packageLeafName: string }) {
          defaultPathCalls += 1;
          return `packages/${options.packageLeafName}`;
        },
      },
    };

    expect(
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
      }).status,
    ).toBe("ready");
    expect(defaultPathCalls).toBe(1);
  });

  it.each([
    {
      label: "throws",
      defaultPackagePath() {
        throw new Error("default path failure");
      },
    },
    {
      label: "is invalid",
      defaultPackagePath() {
        return ".git/invalid/path";
      },
    },
    {
      label: "conflicts with Foundation",
      defaultPackagePath() {
        return "packages/typescript-config";
      },
    },
  ])("returns a Preset invariant when the default path $label", (candidate) => {
    const definition = {
      ...tsLibDefinition,
      initialPrimaryPackage: {
        ...tsLibDefinition.initialPrimaryPackage,
        defaultPackagePath: () => candidate.defaultPackagePath(),
      },
    };

    expect(
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
      }),
    ).toEqual({ status: "operation-failure", phase: "preset" });
  });

  it.each([".bad", "-bad", "_bad"])(
    "rejects default package scope %s before planning",
    (scope) => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { scope },
      });
      expect(preparation).toEqual({
        status: "input-invalid",
        issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
      });
    },
  );

  it.each(
    builtInPresetRegistry
      .all()
      .filter((definition) => definition.initialPrimaryPackage === undefined),
  )(
    "rejects Primary Package Identity overrides for fixed-topology $metadata.name",
    (definition) => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        toolchain,
        overrides: { name: "renamed", path: "tools/renamed" },
      });
      expect(preparation).toEqual({
        status: "input-invalid",
        issues: [{ code: "FIXED_TOPOLOGY_OVERRIDE" }],
      });
    },
  );

  it("aggregates invalid name, path, and scope overrides", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "@acme/library",
        path: ".git/library/source",
        scope: "Bad Scope",
      },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "INVALID_PACKAGE_PATH" },
        { code: "RESERVED_PACKAGE_PATH" },
        { code: "INVALID_PACKAGE_SCOPE" },
      ],
    });
  });

  it("aggregates invalid input with an independently knowable Foundation collision", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "@acme/library",
        path: "packages/typescript-config",
      },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  it("substitutes an overlong leaf while preserving a known Foundation path collision", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "a".repeat(220),
        path: "packages/typescript-config",
      },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  it("does not invent a default-path collision for an invalid explicit path", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "typescript-config",
        path: "packages/typescript-config/nested",
      },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_PATH" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  it("short-circuits planner work after pure input diagnostics", () => {
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

    const preparation = prepareGeneratedRepositoryInitialization({
      definition: diagnosticDefinition,
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: { scope: "Bad Scope" },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
    });
  });

  it.each(configurableDefinitions)(
    "projects one resolved $metadata.name identity through durable and generated facts",
    async (definition) => {
      const capability = definition.initialPrimaryPackage;
      const preparation = requireReadyInitialization({
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
          files: [".pnpmfile.mjs"],
          include: ["*.config.ts", "scripts/**/*.ts"],
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
    const preparation = requireReadyInitialization({
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

    const preparation = prepareGeneratedRepositoryInitialization({
      definition,
      targetDir: "/tmp/customer-repository",
      toolchain,
    });
    expect(preparation).toEqual({
      status: "operation-failure",
      phase: "preflight",
    });
  });

  it("aggregates Foundation package name and path collisions", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: "/tmp/customer-repository",
      toolchain,
      overrides: {
        name: "typescript-config",
        path: "packages/typescript-config",
      },
    });
    expect(preparation).toEqual({
      status: "input-invalid",
      issues: [{ code: "CONFLICTING_PACKAGE_IDENTITY" }],
    });
  });

  it.each(["Customer Repository", ".bad"])(
    "rejects Repository Identity %s as an invalid default scope actionably",
    (repositoryName) => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition: builtInPresetRegistry.require("ts-lib"),
        targetDir: `/tmp/${repositoryName}`,
        toolchain,
      });
      expect(preparation).toEqual({
        status: "input-invalid",
        issues: [{ code: "INVALID_REPOSITORY_SCOPE" }],
      });
    },
  );
});

describe("Generated Repository Package Addition preparation", () => {
  it("returns pure invalid input before reading local metadata", () => {
    expect(
      prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: "/definitely-not-a-generated-repository",
        preset: "missing-preset",
        packageLeafName: "Invalid Name",
        packagePath: "dist/utility",
      }),
    ).toEqual({
      status: "input-invalid",
      issues: [
        { code: "PRESET_UNKNOWN" },
        { code: "INVALID_PACKAGE_NAME" },
        { code: "RESERVED_PACKAGE_PATH" },
      ],
    });
  });

  it("orders unknown consumers before one provider plan and bounds later failures", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-prep-"));
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({ targetDir, toolchain });
    const initial = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initial.operations],
    });
    let calls = 0;
    const countingDefinition = {
      ...tsLibDefinition,
      planPackageAddition(
        options: Parameters<
          NonNullable<typeof tsLibDefinition.planPackageAddition>
        >[0],
      ) {
        calls += 1;
        return tsLibDefinition.planPackageAddition!(options);
      },
    };
    const registry = vi
      .spyOn(builtInPresetRegistry, "all")
      .mockReturnValue([countingDefinition]);
    try {
      expect(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: path.join(workspace, "missing"),
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
        }),
      ).toEqual({ status: "operation-failure", phase: "metadata" });
      expect(calls).toBe(0);

      expect(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
          linkFrom: ["packages/missing"],
        }),
      ).toEqual({
        status: "input-invalid",
        issues: [{ code: "UNKNOWN_LINK_FROM" }],
      });
      expect(calls).toBe(0);

      expect(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
        }).status,
      ).toBe("ready");
      expect(calls).toBe(1);

      const throwingDefinition = {
        ...countingDefinition,
        planPackageAddition() {
          throw new Error("planner failure");
        },
      };
      registry.mockReturnValue([throwingDefinition]);
      expect(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: throwingDefinition.metadata.name,
          packageLeafName: "failure",
          linkFrom: [initial.blueprint.packages[0]!.path],
        }),
      ).toEqual({ status: "operation-failure", phase: "planning" });
    } finally {
      registry.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
