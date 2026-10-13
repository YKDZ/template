import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
  type ProjectProjectionAction,
  type ProjectProjectionReconciliation,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  type RenderOperation,
  type WriteJsonOperation,
  type WriteTextTemplateOperation,
} from "@ykdz/template-core/renderer";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
  prepareGeneratedRepositoryInitialization,
  validateGeneratedRepositoryInitializationInput,
  type BuiltInGenerationContext,
  type InitializationPreparation,
  type PackageAdditionPreparation,
} from "../foundation.ts";
import { rustBinDefinition } from "../rust-bin/definition.ts";
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

void describe("Generated Repository initialization preparation", () => {
  void it("returns an owned input result for an unknown Preset before planning", () => {
    assert.deepStrictEqual(
      prepareGeneratedRepositoryInitialization({
        preset: "missing-preset",
        targetDir: "/tmp/customer-repository",
      }),
      {
        status: "input-invalid",
        issues: [{ code: "PRESET_UNKNOWN" }],
      },
    );
  });

  void it("rejects an invalid durable scope through the public initialization planner", () => {
    const context = createGenerationContext({
      targetDir: "/tmp/.bad",
      toolchain,
    });

    assert.throws(
      () =>
        planGeneratedRepositoryInitialization({
          definition: tsLibDefinition,
          context,
        }),
      (error: unknown) =>
        /^Generation Record defaultPackageScope must be a valid npm scope$/u.test(
          error instanceof Error ? error.message : String(error),
        ),
    );
  });

  for (const definition of configurableDefinitions) {
    void it(`resolves the ${definition.metadata.name} Preset-owned Primary Package Identity`, () => {
      const capability = definition.initialPrimaryPackage;
      const preparation = requireReadyInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
      });

      assert.deepStrictEqual(preparation.resolvedPackageIdentity, {
        leafName: capability.defaultLeafName,
        definition: {
          name: `@customer-repository/${capability.defaultLeafName}`,
          path: capability.defaultPackagePath({
            packageLeafName: capability.defaultLeafName,
          }),
          role: capability.role,
        },
      });
      const resolvedIdentity = preparation.resolvedPackageIdentity!;
      assert.ok(
        preparation.plan.blueprint.packages.some(
          (candidate) =>
            Object.hasOwn(candidate, "name") &&
            candidate.name === resolvedIdentity.definition.name &&
            Object.hasOwn(candidate, "path") &&
            candidate.path === resolvedIdentity.definition.path &&
            Object.hasOwn(candidate, "role") &&
            candidate.role === resolvedIdentity.definition.role,
        ),
      );
    });
  }

  for (const definition of builtInPresetRegistry
    .all()
    .filter((definition) => definition.initialPrimaryPackage === undefined)) {
    void it(`preserves fixed-topology ${definition.metadata.name} while applying only scope`, () => {
      const preparation = requireReadyInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        overrides: { scope: "acme" },
      });

      assert.strictEqual(preparation.resolvedPackageIdentity, undefined);
      assert.strictEqual(preparation.context.defaultPackageScope, "acme");
      assert.deepStrictEqual(preparation.resolved, {
        preset: definition.metadata.name,
        topology: "fixed",
        packages: definition
          .blueprint(preparation.context)
          .packages.map(({ name, path }) => ({ name, path })),
        scope: "acme",
      });
      const expectedPackages = definition.blueprint(
        preparation.context,
      ).packages;
      for (const expectedPackage of expectedPackages) {
        assert.ok(
          preparation.plan.blueprint.packages.some(
            (candidate) =>
              Object.hasOwn(candidate, "name") &&
              candidate.name === expectedPackage.name &&
              Object.hasOwn(candidate, "path") &&
              candidate.path === expectedPackage.path &&
              Object.hasOwn(candidate, "role") &&
              candidate.role === expectedPackage.role,
          ),
        );
      }
    });
  }

  void it("uses the optional capability as the only configurable support fact", () => {
    for (const definition of builtInPresetRegistry.all()) {
      if (definition.initialPrimaryPackage === undefined) {
        assert.strictEqual(Object.hasOwn(definition, "blueprint"), true);
        assert.strictEqual(
          Object.hasOwn(definition, "planInitialization"),
          true,
        );
      } else {
        assert.strictEqual("blueprint" in definition, false);
        assert.strictEqual("planInitialization" in definition, false);
        assert.strictEqual(
          "planInitializationContributions" in definition,
          false,
        );
      }
    }
  });

  for (const { overrides, expected } of [
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
  ]) {
    void it(`keeps name, path, and scope overrides independent: ${expected.path}`, () => {
      const preparation = requireReadyInitialization({
        definition: configurableDefinition,
        targetDir: "/tmp/customer-repository",
        overrides,
      });

      assert.partialDeepStrictEqual(preparation.context, {
        repositoryName: "customer-repository",
        defaultPackageScope: expected.scope,
      });
      assert.partialDeepStrictEqual(preparation.resolvedPackageIdentity, {
        leafName: expected.leafName,
        definition: { name: expected.name, path: expected.path },
      });
    });
  }

  void it("returns one stable resolved display model for configurable topology", () => {
    const preparation = requireReadyInitialization({
      definition: configurableDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "runner",
        path: "tools/release",
        scope: "acme",
      },
    });

    assert.deepStrictEqual(preparation.resolved, {
      preset: configurableDefinition.metadata.name,
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/runner", path: "tools/release" }],
      scope: "acme",
    });
  });

  void it("accepts a Node built-in name as a scoped Primary Package leaf", () => {
    const preparation = requireReadyInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: { name: "http", scope: "acme" },
    });

    assert.deepStrictEqual(preparation.resolvedPackageIdentity, {
      leafName: "http",
      definition: {
        name: "@acme/http",
        path: "packages/http",
        role: "shared-library",
      },
    });
    assert.deepStrictEqual(preparation.resolved, {
      preset: "ts-lib",
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/http", path: "packages/http" }],
      scope: "acme",
    });
  });

  void it("rejects an unsafe Preset-derived Package Path for a valid leaf", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: { name: "node_modules", scope: "acme" },
    });

    assert.deepStrictEqual(preparation, {
      status: "operation-failure",
      phase: "preset",
    });
  });

  void it("keeps an unsafe Preset-derived Package Path as an invariant even with an explicit override", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "node_modules",
        path: "tools/release",
        scope: "acme",
      },
    });

    assert.deepStrictEqual(preparation, {
      status: "operation-failure",
      phase: "preset",
    });
  });

  void it("does not inspect a Preset default path when pure input diagnostics already exist", () => {
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

    assert.deepStrictEqual(
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        overrides: { scope: "Bad Scope" },
      }),
      {
        status: "input-invalid",
        issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
      },
    );
    assert.strictEqual(defaultPathCalls, 0);
  });

  void it("shares pure input issues with preparation without invoking Preset work", () => {
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
    assert.deepStrictEqual(validation, {
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "INVALID_PACKAGE_PATH" },
        { code: "RESERVED_PACKAGE_PATH" },
        { code: "INVALID_PACKAGE_SCOPE" },
      ],
    });
    assert.strictEqual(defaultPathCalls, 0);
    assert.strictEqual(plannerCalls, 0);
    assert.deepStrictEqual(
      prepareGeneratedRepositoryInitialization(options),
      validation,
    );
    assert.strictEqual(defaultPathCalls, 0);
    assert.strictEqual(plannerCalls, 0);
  });

  void it("derives a valid Preset default path once before reusing it for planning", () => {
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

    assert.strictEqual(
      prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
      }).status,
      "ready",
    );
    assert.strictEqual(defaultPathCalls, 1);
  });

  for (const candidate of [
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
  ]) {
    void it(`returns a Preset invariant when the default path ${candidate.label}`, () => {
      const definition = {
        ...tsLibDefinition,
        initialPrimaryPackage: {
          ...tsLibDefinition.initialPrimaryPackage,
          defaultPackagePath: () => candidate.defaultPackagePath(),
        },
      };

      assert.deepStrictEqual(
        prepareGeneratedRepositoryInitialization({
          definition,
          targetDir: "/tmp/customer-repository",
        }),
        { status: "operation-failure", phase: "preset" },
      );
    });
  }

  for (const scope of [".bad", "-bad", "_bad"]) {
    void it(`rejects default package scope ${scope} before planning`, () => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        targetDir: "/tmp/customer-repository",
        overrides: { scope },
      });
      assert.deepStrictEqual(preparation, {
        status: "input-invalid",
        issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
      });
    });
  }

  for (const definition of builtInPresetRegistry
    .all()
    .filter((definition) => definition.initialPrimaryPackage === undefined)) {
    void it(`rejects Primary Package Identity overrides for fixed-topology ${definition.metadata.name}`, () => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
        overrides: { name: "renamed", path: "tools/renamed" },
      });
      assert.deepStrictEqual(preparation, {
        status: "input-invalid",
        issues: [{ code: "FIXED_TOPOLOGY_OVERRIDE" }],
      });
    });
  }

  void it("aggregates invalid name, path, and scope overrides", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "@acme/library",
        path: ".git/library/source",
        scope: "Bad Scope",
      },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "INVALID_PACKAGE_PATH" },
        { code: "RESERVED_PACKAGE_PATH" },
        { code: "INVALID_PACKAGE_SCOPE" },
      ],
    });
  });

  void it("aggregates invalid input with an independently knowable Foundation collision", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "@acme/library",
        path: "packages/typescript-config",
      },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  void it("substitutes an overlong leaf while preserving a known Foundation path collision", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "a".repeat(220),
        path: "packages/typescript-config",
      },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_NAME" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  void it("does not invent a default-path collision for an invalid explicit path", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "typescript-config",
        path: "packages/typescript-config/nested",
      },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [
        { code: "INVALID_PACKAGE_PATH" },
        { code: "CONFLICTING_PACKAGE_IDENTITY" },
      ],
    });
  });

  void it("short-circuits planner work after pure input diagnostics", () => {
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
      overrides: { scope: "Bad Scope" },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [{ code: "INVALID_PACKAGE_SCOPE" }],
    });
  });

  for (const definition of configurableDefinitions) {
    void it(`projects one resolved ${definition.metadata.name} identity through durable and generated facts`, async () => {
      const capability = definition.initialPrimaryPackage;
      const preparation = requireReadyInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
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

      assert.deepStrictEqual(resolved, {
        leafName: "runner",
        definition: {
          name: "@acme/runner",
          path: "tools/release",
          role: capability.role,
        },
      });
      assert.deepStrictEqual(contribution.definition, resolved.definition);
      assert.strictEqual(contribution.manifest.name, resolved.definition.name);
      assert.partialDeepStrictEqual(provenance, {
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
      assert.strictEqual(
        readJson("tools/release/package.json").name,
        resolved.definition.name,
      );
      assert.deepStrictEqual(
        readJson(".template/blueprint.json"),
        preparation.plan.blueprint,
      );
      assert.deepStrictEqual(
        readJson(".template/generation.json"),
        preparation.plan.generationRecord,
      );
      if (capability.role === "cli-tool") {
        assert.deepStrictEqual(readJson("tools/release/package.json").bin, {
          runner: "./dist/cli.js",
        });
      }
      if (
        contribution.foundation.npmPublication?.kind === "public-cli-candidate"
      ) {
        const tsconfig = readJson("tsconfig.json");
        assert.partialDeepStrictEqual(tsconfig.compilerOptions, {
          allowJs: true,
          allowImportingTsExtensions: true,
          checkJs: true,
          noEmit: true,
        });
        assert.deepStrictEqual(tsconfig.files, [".pnpmfile.mjs"]);
        assert.deepStrictEqual(tsconfig.include, [
          "*.config.ts",
          "scripts/**/*.ts",
        ]);
        assert.ok(
          preparation.plan.operations.some(
            (operation) =>
              operation.kind === "writeTextTemplate" &&
              Object.hasOwn(operation, "kind") &&
              Object.hasOwn(operation, "to") &&
              operation.to === "scripts/npm-publication/check-readiness.ts" &&
              Object.hasOwn(operation, "replacements") &&
              isDeepStrictEqual(operation.replacements, {
                PUBLIC_CLI_PACKAGE_PATH: "tools/release",
              }),
          ),
        );
      }
    });
  }

  void it("exposes the enriched ts-lib contribution consumed by manifests and projection", async () => {
    const preparation = requireReadyInitialization({
      definition: tsLibDefinition,
      targetDir: "/tmp/customer-repository",
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

    assert.partialDeepStrictEqual(contribution.manifest, {
      devDependencies: {
        "@acme/typescript-config": "workspace:*",
      },
    });
    const rootManifest = preparation.plan.manifests.find(
      (manifest) => manifest.name === "customer-repository",
    );
    const rootScripts = rootManifest?.scripts;
    assert.strictEqual(
      rootScripts !== null &&
        (typeof rootScripts === "object" ||
          typeof rootScripts === "function") &&
        "publication:readiness" in rootScripts,
      false,
    );
    const rootDevDependencies = rootManifest?.devDependencies;
    assert.strictEqual(
      rootDevDependencies !== null &&
        (typeof rootDevDependencies === "object" ||
          typeof rootDevDependencies === "function") &&
        "semver" in rootDevDependencies,
      false,
    );
    assert.strictEqual(
      preparation.plan.operations.some((operation) =>
        "to" in operation
          ? operation.to.startsWith("scripts/npm-publication/") ||
            operation.to === ".pnpmfile.mjs"
          : false,
      ),
      false,
    );
    assert.deepStrictEqual(contribution.manifest, plannedManifest);
    assert.deepStrictEqual(
      JSON.parse(new TextDecoder().decode(packageJson.content)),
      contribution.manifest,
    );
  });

  void it("rejects a complete plan with more than one public CLI candidate", () => {
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
    ): T => ({
      ...contribution,
      foundation: {
        ...contribution.foundation,
        npmPublication: { kind: "public-cli-candidate" as const },
      },
    });
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

    assert.throws(
      () =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: "/tmp/two-public-cli-candidates",
            toolchain,
          }),
        }),
      (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).includes(
          "Generated Repository Plan supports at most one public CLI candidate",
        ),
    );
  });

  void it("rejects a known projection collision during preparation", () => {
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
    });
    assert.deepStrictEqual(preparation, {
      status: "operation-failure",
      phase: "preflight",
    });
  });

  void it("aggregates Foundation package name and path collisions", () => {
    const preparation = prepareGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("ts-lib"),
      targetDir: "/tmp/customer-repository",
      overrides: {
        name: "typescript-config",
        path: "packages/typescript-config",
      },
    });
    assert.deepStrictEqual(preparation, {
      status: "input-invalid",
      issues: [{ code: "CONFLICTING_PACKAGE_IDENTITY" }],
    });
  });

  for (const repositoryName of ["Customer Repository", ".bad"]) {
    void it(`rejects Repository Identity ${repositoryName} as an invalid default scope actionably`, () => {
      const preparation = prepareGeneratedRepositoryInitialization({
        definition: builtInPresetRegistry.require("ts-lib"),
        targetDir: `/tmp/${repositoryName}`,
      });
      assert.deepStrictEqual(preparation, {
        status: "input-invalid",
        issues: [{ code: "INVALID_REPOSITORY_SCOPE" }],
      });
    });
  }
});

void describe("Generated Repository Package Addition preparation", () => {
  void it("returns pure invalid input before reading local metadata", () => {
    assert.deepStrictEqual(
      prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: "/definitely-not-a-generated-repository",
        preset: "missing-preset",
        packageLeafName: "Invalid Name",
        packagePath: "dist/utility",
      }),
      {
        status: "input-invalid",
        issues: [
          { code: "PRESET_UNKNOWN" },
          { code: "INVALID_PACKAGE_NAME" },
          { code: "RESERVED_PACKAGE_PATH" },
        ],
      },
    );
  });

  void it("orders unknown consumers before one provider plan and bounds later failures", async () => {
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
        return tsLibDefinition.planPackageAddition(options);
      },
    };
    const originalAll = builtInPresetRegistry.all.bind(builtInPresetRegistry);
    builtInPresetRegistry.all = () => [countingDefinition];
    try {
      assert.deepStrictEqual(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: path.join(workspace, "missing"),
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
        }),
        { status: "operation-failure", phase: "metadata" },
      );
      assert.strictEqual(calls, 0);

      assert.deepStrictEqual(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
          linkFrom: ["packages/missing"],
        }),
        {
          status: "input-invalid",
          issues: [{ code: "UNKNOWN_LINK_FROM" }],
        },
      );
      assert.strictEqual(calls, 0);

      assert.strictEqual(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: countingDefinition.metadata.name,
          packageLeafName: "utility",
        }).status,
        "ready",
      );
      assert.strictEqual(calls, 1);

      const throwingDefinition = {
        ...countingDefinition,
        planPackageAddition() {
          throw new Error("planner failure");
        },
      };
      builtInPresetRegistry.all = () => [throwingDefinition];
      assert.deepStrictEqual(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: throwingDefinition.metadata.name,
          packageLeafName: "failure",
          linkFrom: [initial.blueprint.packages[0]!.path],
        }),
        { status: "operation-failure", phase: "planning" },
      );
    } finally {
      builtInPresetRegistry.all = originalAll;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

const snapshotToolchain = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
} as const;

/** 上下文携带快照的精确 Node 与 Rust 事实，Generation Record v2 只保留派生的两个历史字段。 */
const snapshotContextToolchain = {
  ...snapshotToolchain,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
  rustVersion: releaseToolchainSnapshot.rustVersion,
} as const;

function recordToolchainKeys(toolchain: object): readonly string[] {
  return Object.keys(toolchain).toSorted();
}

function rootManifestDeclarations(
  operations: readonly RenderOperation[],
): readonly (readonly [string, string])[] {
  return operations
    .filter(
      (
        operation,
      ): operation is WriteJsonOperation & { readonly to: "package.json" } =>
        operation.kind === "writeJson" &&
        "to" in operation &&
        operation.to === "package.json",
    )
    .map((operation) => {
      const value = operation.value as {
        readonly engines: { readonly node: string };
        readonly packageManager: string;
      };
      return [value.engines.node, value.packageManager] as const;
    });
}

void describe("Generated Repository initialization consumes the release toolchain snapshot", () => {
  for (const definition of builtInPresetRegistry.all()) {
    void it(`projects the exact snapshot Node and pnpm into the ${definition.metadata.name} private root`, () => {
      const preparation = requireReadyInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
      });

      assert.deepStrictEqual(
        preparation.context.toolchain,
        snapshotContextToolchain,
      );
      assert.deepStrictEqual(
        rootManifestDeclarations(preparation.plan.operations),
        [
          [
            releaseToolchainSnapshot.nodeVersion,
            releaseToolchainSnapshot.packageManagerPin,
          ],
        ],
      );
      assert.deepStrictEqual(
        preparation.plan.generationRecord.toolchain,
        snapshotToolchain,
      );
      assert.deepStrictEqual(
        recordToolchainKeys(preparation.plan.generationRecord.toolchain),
        ["nodeLtsMajor", "packageManagerPin"],
      );
    });
  }

  for (const definition of builtInPresetRegistry.all()) {
    void it(`projects rust-toolchain.toml for ${definition.metadata.name} only from Rust Environment Needs`, () => {
      const preparation = requireReadyInitialization({
        definition,
        targetDir: "/tmp/customer-repository",
      });
      const requiresRustToolchain = preparation.plan.packageContributions.some(
        (contribution) =>
          contribution.environmentNeeds.some(
            (need) => need.kind === "rust-toolchain",
          ),
      );
      const rootToolchainOperation = preparation.plan.operations.find(
        (operation): operation is WriteTextTemplateOperation =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "rust-toolchain.toml",
      );

      assert.strictEqual(
        rootToolchainOperation?.replacements.RUST_TOOLCHAIN,
        requiresRustToolchain
          ? releaseToolchainSnapshot.rustVersion
          : undefined,
      );
    });
  }

  void it("不选 Rust 的真实初始化不产生 Rust 根文件、rust-analyzer 与 Cargo 任务", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-non-rust-initialization-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [
          ...requireReadyInitialization({
            definition: tsLibDefinition,
            targetDir,
          }).plan.operations,
        ],
      });

      await assert.rejects(
        readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
      );
      const extensions = JSON.parse(
        await readFile(path.join(targetDir, ".vscode/extensions.json"), "utf8"),
      ) as { readonly recommendations: readonly string[] };
      assert.strictEqual(
        extensions.recommendations.some((recommendation) =>
          Object.is(recommendation, "rust-lang.rust-analyzer"),
        ),
        false,
      );
      const devcontainer = JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { readonly build?: { readonly args?: Record<string, string> } };
      assert.strictEqual(
        "RUST_TOOLCHAIN" in (devcontainer.build?.args ?? {}),
        false,
      );

      const cargoTasks: string[] = [];
      for (const relativePath of [
        "package.json",
        "packages/lib/package.json",
      ]) {
        const manifest = JSON.parse(
          await readFile(path.join(targetDir, relativePath), "utf8"),
        ) as { readonly scripts?: Record<string, string> };
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
          if (command.split(/\s+/u).includes("cargo")) {
            cargoTasks.push(`${relativePath}#${name}`);
          }
        }
      }
      assert.deepStrictEqual(cargoTasks, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps the target root declaration for a Package Addition instead of applying the snapshot", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-snapshot-initialization-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [
          ...requireReadyInitialization({
            definition: tsLibDefinition,
            targetDir,
          }).plan.operations,
        ],
      });
      const renderedRoot = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        readonly engines: { readonly node: string };
        readonly packageManager: string;
      };
      assert.strictEqual(
        renderedRoot.engines.node,
        releaseToolchainSnapshot.nodeVersion,
      );
      assert.strictEqual(
        renderedRoot.packageManager,
        releaseToolchainSnapshot.packageManagerPin,
      );
      const initializedRecord = JSON.parse(
        await readFile(
          path.join(targetDir, ".template/generation.json"),
          "utf8",
        ),
      ) as { readonly toolchain: Record<string, string> };
      assert.deepStrictEqual(initializedRecord.toolchain, snapshotToolchain);
      assert.deepStrictEqual(recordToolchainKeys(initializedRecord.toolchain), [
        "nodeLtsMajor",
        "packageManagerPin",
      ]);

      await writeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: "22.11.0" };
        manifest.packageManager = "pnpm@10.5.0";
      });
      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: tsLibDefinition.metadata.name,
          packageLeafName: "utility",
        }),
      );

      for (const operations of [
        addition.plan.operations,
        addition.plan.projectProjections.before.operations,
        addition.plan.projectProjections.after.operations,
      ]) {
        assert.deepStrictEqual(rootManifestDeclarations(operations), [
          ["22.11.0", "pnpm@10.5.0"],
        ]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

const directPlanningCases = [
  { nodeVersion: undefined, expectedRootNode: "24" },
  { nodeVersion: "24.9.3", expectedRootNode: "24.9.3" },
] as const;

void describe("Direct initialization planning with an optional exact Node fact", () => {
  for (const { nodeVersion, expectedRootNode } of directPlanningCases) {
    void it(`projects private root engines.node ${expectedRootNode} from toolchain.nodeVersion ${nodeVersion}`, () => {
      const plan = planGeneratedRepositoryInitialization({
        definition: tsLibDefinition,
        context: createGenerationContext({
          targetDir: "/tmp/direct-exact-node",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.21.0",
            ...(nodeVersion === undefined ? {} : { nodeVersion }),
          },
        }),
      });

      assert.deepStrictEqual(rootManifestDeclarations(plan.operations), [
        [expectedRootNode, "pnpm@11.21.0"],
      ]);
      assert.deepStrictEqual(plan.generationRecord.toolchain, {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.21.0",
      });
      assert.deepStrictEqual(
        recordToolchainKeys(plan.generationRecord.toolchain),
        ["nodeLtsMajor", "packageManagerPin"],
      );
    });
  }

  for (const { nodeVersion, message } of [
    {
      nodeVersion: "22.16.0",
      message: /nodeVersion 22\.16\.0 与 nodeLtsMajor 24 大版本不一致/u,
    },
    {
      nodeVersion: "24.16",
      message: /必须是精确三段 Node 版本/u,
    },
  ]) {
    void it(`rejects the inconsistent exact Node fact ${nodeVersion} instead of planning a divergent root`, () => {
      assert.throws(
        () =>
          planGeneratedRepositoryInitialization({
            definition: tsLibDefinition,
            context: createGenerationContext({
              targetDir: "/tmp/direct-exact-node",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.21.0",
                nodeVersion,
              },
            }),
          }),
        (error: unknown) =>
          message.test(error instanceof Error ? error.message : String(error)),
      );
    });
  }
});

const currentRootToolchainCases = [
  { declaration: "22", nodeLtsMajor: "22", nodeVersion: undefined },
  { declaration: "24.16.0", nodeLtsMajor: "24", nodeVersion: "24.16.0" },
  { declaration: "25.1.2", nodeLtsMajor: "25", nodeVersion: "25.1.2" },
] as const;

type InvalidRootToolchainCase = {
  readonly label: string;
  readonly field: "engines.node" | "packageManager";
  readonly actual: string;
  readonly patch: (manifest: Record<string, unknown>) => void;
  readonly message: RegExp;
};

const invalidRootToolchainCases: readonly InvalidRootToolchainCase[] = [
  {
    label: "a missing engines field",
    field: "engines.node",
    actual: "null",
    patch: (manifest: Record<string, unknown>) => {
      delete manifest.engines;
    },
    message: /package\.json 的 engines\.node/u,
  },
  {
    label: "an engines field without a node entry",
    field: "engines.node",
    actual: "null",
    patch: (manifest: Record<string, unknown>) => {
      manifest.engines = {};
    },
    message: /package\.json 的 engines\.node/u,
  },
  {
    label: "a Node range",
    field: "engines.node",
    actual: '">=22"',
    patch: (manifest: Record<string, unknown>) => {
      manifest.engines = { node: ">=22" };
    },
    message: /package\.json 的 engines\.node/u,
  },
  {
    label: "a prefixed Node version",
    field: "engines.node",
    actual: '"v24"',
    patch: (manifest: Record<string, unknown>) => {
      manifest.engines = { node: "v24" };
    },
    message: /package\.json 的 engines\.node/u,
  },
  {
    label: "a two-segment Node version",
    field: "engines.node",
    actual: '"24.16"',
    patch: (manifest: Record<string, unknown>) => {
      manifest.engines = { node: "24.16" };
    },
    message: /package\.json 的 engines\.node/u,
  },
  {
    label: "a missing packageManager field",
    field: "packageManager",
    actual: "null",
    patch: (manifest: Record<string, unknown>) => {
      delete manifest.packageManager;
    },
    message: /package\.json 的 packageManager/u,
  },
  {
    label: "a pnpm range",
    field: "packageManager",
    actual: '"pnpm@^10.5.0"',
    patch: (manifest: Record<string, unknown>) => {
      manifest.packageManager = "pnpm@^10.5.0";
    },
    message: /package\.json 的 packageManager/u,
  },
  {
    label: "another package manager",
    field: "packageManager",
    actual: '"yarn@4.1.0"',
    patch: (manifest: Record<string, unknown>) => {
      manifest.packageManager = "yarn@4.1.0";
    },
    message: /package\.json 的 packageManager/u,
  },
] as const;

async function writeRootManifest(
  targetDir: string,
  patch: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  patch(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function requireReadyAddition(
  preparation: PackageAdditionPreparation,
): Extract<PackageAdditionPreparation, { readonly status: "ready" }> {
  if (preparation.status !== "ready") {
    throw new Error(
      `Expected ready Package Addition, received ${preparation.status}`,
    );
  }
  return preparation;
}

void describe("Package Addition toolchain context from the target root declaration", () => {
  for (const {
    declaration,
    nodeLtsMajor,
    nodeVersion,
  } of currentRootToolchainCases) {
    void it(`follows root engines.node ${declaration} instead of the stale Generation Record`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-toolchain-"),
      );
      const targetDir = path.join(workspace, "project");
      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [
            ...planGeneratedRepositoryInitialization({
              definition: tsLibDefinition,
              context: createGenerationContext({ targetDir, toolchain }),
            }).operations,
          ],
        });
        await writeRootManifest(targetDir, (manifest) => {
          manifest.engines = { node: declaration };
          manifest.packageManager = "pnpm@10.5.0";
        });

        const metadata = loadLocalTemplateMetadata(targetDir);
        assert.deepStrictEqual(metadata.context.toolchain, {
          nodeLtsMajor,
          packageManagerPin: "pnpm@10.5.0",
          ...(nodeVersion === undefined ? {} : { nodeVersion }),
        });
        // 纯大版本根没有诚实的精确 patch，不能伪造；精确根则沿用现行声明。
        assert.strictEqual(
          Object.hasOwn(metadata.context.toolchain, "nodeVersion"),
          nodeVersion !== undefined,
        );

        const preparation = requireReadyAddition(
          prepareGeneratedRepositoryPackageAddition({
            repositoryRoot: targetDir,
            preset: tsLibDefinition.metadata.name,
            packageLeafName: "utility",
          }),
        );
        const addedPackagePath =
          preparation.plan.blueprint.packages.at(-1)!.path;
        const packageManifestOperation = preparation.plan.operations.find(
          (operation) =>
            operation.kind === "writeJson" &&
            Object.hasOwn(operation, "kind") &&
            Object.hasOwn(operation, "to") &&
            operation.to === `${addedPackagePath}/package.json`,
        );
        assert.ok(packageManifestOperation);
        if (packageManifestOperation.kind !== "writeJson") {
          throw new Error("Expected package manifest write operation");
        }
        assert.ok(Object.hasOwn(packageManifestOperation, "value"));
        const manifestValue = packageManifestOperation.value;
        assert.ok(typeof manifestValue === "object" && manifestValue !== null);
        assert.ok(Object.hasOwn(manifestValue, "engines"));
        assert.deepStrictEqual(
          (manifestValue as Record<string, unknown>).engines,
          {
            node: nodeLtsMajor,
          },
        );

        const persistedRecord = JSON.parse(
          await readFile(
            path.join(targetDir, ".template/generation.json"),
            "utf8",
          ),
        ) as {
          readonly schemaVersion: number;
          readonly toolchain: unknown;
        };
        assert.strictEqual(persistedRecord.schemaVersion, 2);
        assert.deepStrictEqual(persistedRecord.toolchain, toolchain);
        const rootManifest = JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as { engines: { node: string }; packageManager: string };
        assert.strictEqual(rootManifest.engines.node, declaration);
        assert.strictEqual(rootManifest.packageManager, "pnpm@10.5.0");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  for (const {
    field,
    actual,
    patch,
    message,
    label,
  } of invalidRootToolchainCases) {
    void it(`rejects ${label} without replaying the Generation Record`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-toolchain-invalid-"),
      );
      const targetDir = path.join(workspace, "project");
      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [
            ...planGeneratedRepositoryInitialization({
              definition: tsLibDefinition,
              context: createGenerationContext({ targetDir, toolchain }),
            }).operations,
          ],
        });
        await writeRootManifest(targetDir, (manifest) => {
          patch(manifest);
        });

        assert.throws(
          () => loadLocalTemplateMetadata(targetDir),
          (error: unknown) =>
            message.test(
              error instanceof Error ? error.message : String(error),
            ),
        );
        const preparation = prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: tsLibDefinition.metadata.name,
          packageLeafName: "utility",
        });
        assert.strictEqual(preparation.status, "operation-failure");
        if (preparation.status !== "operation-failure") {
          throw new Error("Expected invalid root toolchain metadata");
        }
        assert.strictEqual(preparation.phase, "metadata");
        assert.ok(preparation.diagnostic);
        const diagnostic = preparation.diagnostic;
        assert.match(diagnostic.message, message);
        assert.ok(diagnostic.suggestion.includes(field));
        // 诊断必须点名实际值，并给出修正现行声明的动作。
        assert.ok(diagnostic.message.includes(actual));
        assert.ok(diagnostic.suggestion.includes("根 package.json"));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  void it("fails actionably when the target has no root manifest at all", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-toolchain-missing-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [
          ...planGeneratedRepositoryInitialization({
            definition: tsLibDefinition,
            context: createGenerationContext({ targetDir, toolchain }),
          }).operations,
        ],
      });
      await rm(path.join(targetDir, "package.json"));

      assert.throws(
        () => loadLocalTemplateMetadata(targetDir),
        (error: unknown) =>
          /Package Addition requires.*package\.json/u.test(
            error instanceof Error ? error.message : String(error),
          ),
      );
      assert.deepStrictEqual(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: tsLibDefinition.metadata.name,
          packageLeafName: "utility",
        }),
        { status: "operation-failure", phase: "metadata" },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

const rootRustDeclarationPath = "rust-toolchain.toml";

function rootRustDeclaration(channel: string): string {
  return `[toolchain]\nchannel = "${channel}"\ncomponents = ["rustfmt", "clippy"]\n`;
}

async function renderRustRepository(targetDir: string): Promise<void> {
  const preparation = requireReadyInitialization({
    preset: "rust-bin",
    targetDir,
  });
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...preparation.plan.operations],
  });
}

function projectedRootRustDeclaration(
  projection: Awaited<ReturnType<typeof materializeProjectProjection>>,
): string {
  const entry = projection.entries.find(
    (candidate) => candidate.path === rootRustDeclarationPath,
  );
  if (entry === undefined) {
    throw new Error("Project Projection is missing the root Rust declaration");
  }
  return new TextDecoder().decode(entry.content);
}

type InvalidRootRustDeclarationCase = {
  readonly label: string;
  readonly declaration: string | null;
  readonly message: RegExp;
  readonly actual: string;
};

const invalidRootRustDeclarationCases: readonly InvalidRootRustDeclarationCase[] =
  [
    {
      label: "a missing declaration file",
      declaration: null,
      message: /rust-toolchain\.toml 的 \[toolchain\]\.channel 存在/u,
      actual: "文件不存在",
    },
    {
      label: "an unparseable declaration",
      declaration: "[toolchain\nchannel = ",
      message:
        /rust-toolchain\.toml 的 \[toolchain\]\.channel 是有效 TOML 声明/u,
      actual: "无法解析",
    },
    {
      label: "a channel that is not a string",
      declaration: '[toolchain]\nchannel = ["1.97.1"]\n',
      message: /rust-toolchain\.toml 的 \[toolchain\]\.channel 为非空字符串/u,
      actual: String.raw`["1.97.1"]`,
    },
  ] as const;

void describe("Package Addition follows the target root Rust declaration", () => {
  void it("adopts a legacy stable channel as the addition version source without migrating it", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-add-rust-stable-"),
    );
    const targetDir = path.join(workspace, "project");
    try {
      const initialization = requireReadyInitialization({
        preset: "rust-bin",
        targetDir,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.plan.operations],
      });
      await writeFile(
        path.join(targetDir, rootRustDeclarationPath),
        rootRustDeclaration("stable"),
      );

      const metadata = loadLocalTemplateMetadata(targetDir);
      const preparation = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const [before, after] = await Promise.all([
        materializeProjectProjection(
          preparation.plan.projectProjections.before,
        ),
        materializeProjectProjection(preparation.plan.projectProjections.after),
      ]);

      assert.strictEqual(metadata.context.toolchain.rustVersion, "stable");
      assert.notStrictEqual(
        metadata.context.toolchain.rustVersion,
        initialization.context.toolchain.rustVersion,
      );
      assert.strictEqual(
        preparation.plan.operations.some(
          (operation) =>
            operation.kind === "writeTextTemplate" &&
            Object.hasOwn(operation, "kind") &&
            Object.hasOwn(operation, "to") &&
            operation.to === rootRustDeclarationPath &&
            Object.hasOwn(operation, "replacements") &&
            isDeepStrictEqual(operation.replacements, {
              RUST_TOOLCHAIN: "stable",
            }),
        ),
        true,
      );
      assert.strictEqual(
        preparation.plan.developmentContainer.buildArguments.some((argument) =>
          isDeepStrictEqual(argument, {
            name: "RUST_TOOLCHAIN",
            value: "stable",
          }),
        ),
        true,
      );
      assert.strictEqual(
        projectedRootRustDeclaration(before),
        rootRustDeclaration("stable"),
      );
      assert.strictEqual(
        projectedRootRustDeclaration(after),
        projectedRootRustDeclaration(before),
      );
      assert.strictEqual(
        preparation.plan.environmentNeeds.some(
          (need) =>
            Object.hasOwn(need, "kind") &&
            need.kind === "rust-toolchain" &&
            Object.hasOwn(need, "toolchain") &&
            need.toolchain === "stable",
        ),
        true,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  for (const {
    declaration,
    message,
    actual,
    label,
  } of invalidRootRustDeclarationCases) {
    void it(`rejects ${label} with a path and field diagnostic before any replay`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-rust-invalid-"),
      );
      const targetDir = path.join(workspace, "project");
      try {
        await renderRustRepository(targetDir);
        if (declaration === null) {
          await rm(path.join(targetDir, rootRustDeclarationPath));
        } else {
          await writeFile(
            path.join(targetDir, rootRustDeclarationPath),
            declaration,
          );
        }

        assert.throws(
          () => loadLocalTemplateMetadata(targetDir),
          (error: unknown) =>
            message.test(
              error instanceof Error ? error.message : String(error),
            ),
        );
        const preparation = prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        });
        assert.strictEqual(preparation.status, "operation-failure");
        if (preparation.status !== "operation-failure") {
          throw new Error("Expected invalid root Rust metadata");
        }
        assert.strictEqual(preparation.phase, "metadata");
        assert.ok(preparation.diagnostic);
        const diagnostic = preparation.diagnostic;
        assert.match(diagnostic.message, message);
        assert.ok(diagnostic.suggestion.includes(rootRustDeclarationPath));
        // 诊断必须点名实际声明形状，修正动作指向目标根而非 CLI 快照。
        assert.ok(diagnostic.message.includes(actual));
        assert.ok(diagnostic.suggestion.includes("[toolchain]"));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

const devcontainerPath = ".devcontainer/devcontainer.json";
const additionTargetNode = "22.2.2";
const additionTargetPnpm = "pnpm@10.9.0";

type MutableJsonObject = Record<string, unknown>;

function withoutPointer(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const [head, ...rest] = segments as [string, ...string[]];
  const source = value as MutableJsonObject;
  const clone: MutableJsonObject = { ...source };
  if (rest.length === 0) {
    delete clone[head];
    return clone;
  }
  if (head in source) {
    const stripped = withoutPointer(source[head], rest) as
      | MutableJsonObject
      | undefined;
    if (stripped === undefined) delete clone[head];
    else clone[head] = stripped;
  }
  return clone;
}

function structuredValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((member, index) => structuredValuesEqual(member, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        structuredValuesEqual(
          (left as MutableJsonObject)[key],
          (right as MutableJsonObject)[key],
        ),
    )
  );
}

async function readJsonObject(filePath: string): Promise<MutableJsonObject> {
  return JSON.parse(await readFile(filePath, "utf8")) as MutableJsonObject;
}

async function writeJsonObject(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pointerValue(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as MutableJsonObject)[segment];
  }
  return current;
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    const entries = (
      await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map(
          async (entry) =>
            entry.isDirectory()
              ? { kind: "dir" as const, name: entry.name }
              : {
                  kind: "file" as const,
                  name: entry.name,
                  digest: createHash("sha256")
                    .update(await readFile(path.join(directory, entry.name)))
                    .digest("hex"),
                },
        ),
      )
    ).toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.kind === "dir") {
        hash.update(`dir:${entry.name}\n`);
        await walk(path.join(directory, entry.name));
        continue;
      }
      hash.update(`file:${entry.name}:${entry.digest}\n`);
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function initTsLibRepository(workspace: string): Promise<string> {
  const targetDir = path.join(workspace, "project");
  await renderNewProject({
    targetRoot: targetDir,
    operations: [
      ...requireReadyInitialization({
        preset: "ts-lib",
        targetDir,
      }).plan.operations,
    ],
  });
  return targetDir;
}

function actionsFor(
  actions: readonly ProjectProjectionAction[],
  targetPath: string,
): readonly ProjectProjectionAction[] {
  return actions.filter((action) => action.path === targetPath);
}

/** 真实 plan 一侧声明的镜像槽位形制，与 Core 策略兼容比较同一口径。 */
function declaredMirrorSlotKeys(
  reconciliation: readonly ProjectProjectionReconciliation[] | undefined,
  targetPath: string,
): readonly string[] {
  if (!reconciliation) {
    throw new Error("Real Package Addition plan must declare reconciliation.");
  }
  return reconciliation
    .filter((policy) => policy.path === targetPath)
    .flatMap((policy) =>
      policy.driver === "canonical"
        ? []
        : (policy.mirrorSlots ?? []).map((slot) =>
            [
              slot.id,
              slot.location.kind,
              slot.location.kind === "json-pointer"
                ? slot.location.pointer
                : slot.location.name,
            ].join("|"),
          ),
    );
}

async function prepareAddition(
  targetDir: string,
): Promise<Extract<PackageAdditionPreparation, { readonly status: "ready" }>> {
  return requireReadyAddition(
    prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: targetDir,
      preset: "ts-lib",
      packageLeafName: "utility",
    }),
  );
}

void describe("Package Addition 协调开发容器根工具链静态镜像槽位", () => {
  void it("初始化的 M1 取根 Node 声明精确原文，pnpm 不再拥有烘焙副本", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-init-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const config = await readJsonObject(
        path.join(targetDir, devcontainerPath),
      );
      assert.strictEqual(
        pointerValue(config, ["build", "args", "NODE_VERSION"]),
        releaseToolchainSnapshot.nodeVersion,
      );
      assert.strictEqual(
        "PACKAGE_MANAGER_PIN" in
          (pointerValue(config, ["build", "args"]) as Record<string, unknown>),
        false,
      );
      const containerDockerfile = await readFile(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.ok(containerDockerfile.includes("corepack enable"));
      assert.strictEqual(
        containerDockerfile.includes("corepack prepare"),
        false,
      );
      assert.strictEqual(
        containerDockerfile.includes("PACKAGE_MANAGER_PIN"),
        false,
      );
      assert.ok(containerDockerfile.includes("ARG NODE_VERSION"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("改根后加包把漂移与手改的 M1 协调回根原文，保留定制且只报一条动作", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-reconcile-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      await writeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
        manifest.packageManager = additionTargetPnpm;
      });
      const configPath = path.join(targetDir, devcontainerPath);
      const configured = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(configured, ["build", "args", "NODE_VERSION"]),
        releaseToolchainSnapshot.nodeVersion,
      );
      (configured.build as MutableJsonObject).args = {
        ...((configured.build as MutableJsonObject).args as MutableJsonObject),
        NODE_VERSION: "999",
        USER_EXTRA_ARG: "keep-me",
      };
      configured.mounts = [
        ...(configured.mounts as readonly MutableJsonObject[]),
        {
          type: "volume",
          source: "user-extra-store",
          target: "/user-extra-store",
        },
      ];
      await writeJsonObject(configPath, configured);

      const addition = await prepareAddition(targetDir);
      const treeBeforeDryRun = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.strictEqual(dryRun.ok, true);
      assert.deepStrictEqual(actionsFor(dryRun.actions, devcontainerPath), [
        { path: devcontainerPath, driver: "structured", action: "update" },
      ]);
      assert.strictEqual(await treeFingerprint(workspace), treeBeforeDryRun);
      assert.deepStrictEqual(await readJsonObject(configPath), configured);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(applied.actions, dryRun.actions);
      assert.deepStrictEqual(applied.changedPaths, dryRun.changedPaths);

      const reconciled = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(reconciled, ["build", "args", "NODE_VERSION"]),
        additionTargetNode,
      );
      assert.strictEqual(
        structuredValuesEqual(
          withoutPointer(reconciled, ["build", "args", "NODE_VERSION"]),
          withoutPointer(configured, ["build", "args", "NODE_VERSION"]),
        ),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(
          withoutPointer(reconciled, ["build", "args"]),
          withoutPointer(configured, ["build", "args"]),
        ),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(reconciled.mounts, configured.mounts),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(
          reconciled.customizations,
          configured.customizations,
        ),
        true,
      );

      const rootManifest = await readJsonObject(
        path.join(targetDir, "package.json"),
      );
      assert.deepStrictEqual(rootManifest.engines, {
        node: additionTargetNode,
      });
      assert.strictEqual(rootManifest.packageManager, additionTargetPnpm);

      const rootBytes = await readFile(path.join(targetDir, "package.json"));
      await writeJsonObject(configPath, reconciled);
      const repeated = await prepareAddition(targetDir);
      const replayed = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeated.plan.projectProjections,
      });
      if (!replayed.ok) throw new Error(JSON.stringify(replayed));
      assert.strictEqual(replayed.ok, true);
      assert.deepStrictEqual(
        actionsFor(replayed.actions, devcontainerPath),
        [],
      );
      assert.strictEqual(
        replayed.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.strictEqual(
        Buffer.from(await readFile(configPath)).equals(rootBytes),
        false,
      );
      assert.deepStrictEqual(await readJsonObject(configPath), reconciled);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("改 Rust 根后加包把漂移与手改的 M5 协调回现行 channel，保留定制且只报一条动作", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-rust-reconcile-"),
    );
    const targetDir = path.join(workspace, "project");
    const rustChannel = "stable";
    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [
          ...requireReadyInitialization({
            definition: rustBinDefinition,
            targetDir,
          }).plan.operations,
        ],
      });
      const configPath = path.join(targetDir, devcontainerPath);
      const rustToolPath = path.join(targetDir, "rust-toolchain.toml");
      assert.strictEqual(
        pointerValue(await readJsonObject(configPath), [
          "build",
          "args",
          "RUST_TOOLCHAIN",
        ]),
        releaseToolchainSnapshot.rustVersion,
      );

      // 现行根 channel 改为合法历史 stable，M5 手改为错误 "999" 并保留无关定制。
      await writeFile(
        rustToolPath,
        `[toolchain]\nchannel = "${rustChannel}"\ncomponents = ["rustfmt", "clippy"]\n`,
      );
      const configured = await readJsonObject(configPath);
      (configured.build as MutableJsonObject).args = {
        ...((configured.build as MutableJsonObject).args as MutableJsonObject),
        RUST_TOOLCHAIN: "999",
        USER_EXTRA_ARG: "keep-me",
      };
      configured.mounts = [
        ...(configured.mounts as readonly MutableJsonObject[]),
        {
          type: "volume",
          source: "user-extra-store",
          target: "/user-extra-store",
        },
      ];
      await writeJsonObject(configPath, configured);

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const treeBeforeDryRun = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.deepStrictEqual(actionsFor(dryRun.actions, devcontainerPath), [
        { path: devcontainerPath, driver: "structured", action: "update" },
      ]);
      assert.strictEqual(await treeFingerprint(workspace), treeBeforeDryRun);
      assert.deepStrictEqual(await readJsonObject(configPath), configured);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.deepStrictEqual(applied.actions, dryRun.actions);
      assert.deepStrictEqual(applied.changedPaths, dryRun.changedPaths);

      const reconciled = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(reconciled, ["build", "args", "RUST_TOOLCHAIN"]),
        rustChannel,
      );
      assert.strictEqual(
        structuredValuesEqual(
          withoutPointer(reconciled, ["build", "args", "RUST_TOOLCHAIN"]),
          withoutPointer(configured, ["build", "args", "RUST_TOOLCHAIN"]),
        ),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(
          withoutPointer(reconciled, ["build", "args"]),
          withoutPointer(configured, ["build", "args"]),
        ),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(reconciled.mounts, configured.mounts),
        true,
      );
      assert.strictEqual(
        structuredValuesEqual(
          reconciled.customizations,
          configured.customizations,
        ),
        true,
      );
      assert.strictEqual(
        await readFile(rustToolPath, "utf8"),
        `[toolchain]\nchannel = "${rustChannel}"\ncomponents = ["rustfmt", "clippy"]\n`,
      );

      // 幂等：协调后 M5 已等于现行根，重放加包不再报 devcontainer 动作。
      await writeJsonObject(configPath, reconciled);
      const repeated = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const replayed = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeated.plan.projectProjections,
      });
      if (!replayed.ok) throw new Error(JSON.stringify(replayed));
      assert.deepStrictEqual(
        actionsFor(replayed.actions, devcontainerPath),
        [],
      );
      assert.strictEqual(
        replayed.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.deepStrictEqual(await readJsonObject(configPath), reconciled);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("已有 Rust 仓库追加第二个 Rust 包时两侧声明相同且真实协调不写消费者文件", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-rust-first-"),
    );
    try {
      const targetDir = path.join(workspace, "project");
      await renderRustRepository(targetDir);
      const configPath = path.join(targetDir, devcontainerPath);
      const configured = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(configured, ["build", "args", "RUST_TOOLCHAIN"]),
        releaseToolchainSnapshot.rustVersion,
      );

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const beforeSlots = declaredMirrorSlotKeys(
        addition.plan.projectProjections.before.reconciliation,
        devcontainerPath,
      );
      const afterSlots = declaredMirrorSlotKeys(
        addition.plan.projectProjections.after.reconciliation,
        devcontainerPath,
      );
      // 首次 Rust 形状：声明只给位置，两侧清单相同，因此合法加包不因 M5 扩展变成策略不兼容。
      assert.deepStrictEqual(beforeSlots, afterSlots);
      assert.strictEqual(
        beforeSlots.some((slot) =>
          Object.is(
            slot,
            "rust-toolchain-build-arg|json-pointer|/build/args/RUST_TOOLCHAIN",
          ),
        ),
        true,
      );

      const treeBefore = await treeFingerprint(workspace);
      const bytesBefore = await readFile(configPath);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.deepStrictEqual(actionsFor(dryRun.actions, devcontainerPath), []);
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.deepStrictEqual(actionsFor(applied.actions, devcontainerPath), []);
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.strictEqual(
        Buffer.from(await readFile(configPath)).equals(bytesBefore),
        true,
      );
      assert.deepStrictEqual(await readJsonObject(configPath), configured);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("Node-only 仓库首次加 Rust 时真实计划从 Before 追加 M5 并写入用户根 channel", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-first-rust-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const configPath = path.join(targetDir, devcontainerPath);
      const rootRustPath = path.join(targetDir, rootRustDeclarationPath);
      const userNotesPath = path.join(targetDir, "USER_NOTES.md");
      // 用户预先提供合法根声明，channel 与现行发版快照不同：M5 的值必须来自目标根而非工具默认。
      const rootRust = rootRustDeclaration("stable");
      await writeFile(rootRustPath, rootRust);
      await writeFile(userNotesPath, "# 用户自有说明\n");
      const configured = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(configured, ["build", "args", "RUST_TOOLCHAIN"]),
        undefined,
      );

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const beforeSlots = declaredMirrorSlotKeys(
        addition.plan.projectProjections.before.reconciliation,
        devcontainerPath,
      );
      const afterSlots = declaredMirrorSlotKeys(
        addition.plan.projectProjections.after.reconciliation,
        devcontainerPath,
      );
      // 真实首次形状：Before 只有 M1，After 单调追加 M5，既有槽位形制按原序保持。
      assert.deepStrictEqual(beforeSlots, [
        "node-version-build-arg|json-pointer|/build/args/NODE_VERSION",
      ]);
      assert.deepStrictEqual(afterSlots, [
        ...beforeSlots,
        "rust-toolchain-build-arg|json-pointer|/build/args/RUST_TOOLCHAIN",
      ]);

      const treeBefore = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.strictEqual(
        actionsFor(dryRun.actions, devcontainerPath).length,
        1,
      );
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      const devcontainerAction = actionsFor(applied.actions, devcontainerPath);
      assert.strictEqual(devcontainerAction.length, 1);
      assert.strictEqual(devcontainerAction[0]?.driver, "structured");
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        true,
      );
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, rootRustDeclarationPath),
        ),
        false,
      );
      const written = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(written, ["build", "args", "NODE_VERSION"]),
        pointerValue(configured, ["build", "args", "NODE_VERSION"]),
      );
      assert.strictEqual(
        pointerValue(written, ["build", "args", "RUST_TOOLCHAIN"]),
        "stable",
      );
      // 既有挂载与定制按原序保留，Rust 能力只追加自己的缓存卷。
      const writtenMounts = written.mounts as readonly unknown[];
      const configuredMounts = configured.mounts as readonly unknown[];
      assert.deepStrictEqual(
        writtenMounts.slice(0, configuredMounts.length),
        configuredMounts,
      );
      assert.ok(writtenMounts.length > configuredMounts.length);
      assert.strictEqual(
        structuredValuesEqual(
          written.customizations,
          configured.customizations,
        ),
        true,
      );
      assert.strictEqual(written.name, configured.name);
      assert.strictEqual(await readFile(rootRustPath, "utf8"), rootRust);
      assert.strictEqual(
        await readFile(userNotesPath, "utf8"),
        "# 用户自有说明\n",
      );

      // 同一事务重放被包路径 must-not-exist 前置条件拒绝，不产生第二份半成品。
      const treeAfterApply = await treeFingerprint(workspace);
      const replay = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      assert.strictEqual(replay.ok, false);
      if (replay.ok) throw new Error("unreachable");
      assert.strictEqual(
        replay.conflicts.some((conflict) => conflict.driver === "precondition"),
        true,
      );
      assert.strictEqual(await treeFingerprint(workspace), treeAfterApply);

      // 幂等：接入 Rust 后再加第二个 Rust 包，两侧声明都已含 M5 且真实协调不再写消费者文件。
      const second = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "second",
        }),
      );
      assert.deepStrictEqual(
        declaredMirrorSlotKeys(
          second.plan.projectProjections.before.reconciliation,
          devcontainerPath,
        ),
        afterSlots,
      );
      const configAfterFirstRust = await readFile(configPath);
      const reconciled = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...second.plan.projectProjections,
      });
      if (!reconciled.ok) throw new Error(JSON.stringify(reconciled));
      assert.deepStrictEqual(
        actionsFor(reconciled.actions, devcontainerPath),
        [],
      );
      assert.strictEqual(
        reconciled.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.strictEqual(
        Buffer.from(await readFile(configPath)).equals(configAfterFirstRust),
        true,
      );
      assert.strictEqual(await readFile(rootRustPath, "utf8"), rootRust);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("目标已有任意合法手写根 Rust 声明时首次加 Rust 保留原正文并由根 channel 派生 M5", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-first-rust-custom-root-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const configPath = path.join(targetDir, devcontainerPath);
      const rootRustPath = path.join(targetDir, rootRustDeclarationPath);
      // 合法但非规范形制的手写根：含注释与未知字段，channel 与当前 CLI 快照不同。
      const customRootRust =
        '# 用户手写的根 Rust 注释\n[toolchain]\nchannel = "stable"\nvendor = true\n';
      await writeFile(rootRustPath, customRootRust);
      const configBefore = await readFile(configPath, "utf8");

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      // 旧 Blueprint 尚无 Rust 包不能把已有合法根声明当成不存在或盲覆盖。
      assert.strictEqual(
        addition.plan.developmentContainer.buildArguments.some((argument) =>
          isDeepStrictEqual(argument, {
            name: "RUST_TOOLCHAIN",
            value: "stable",
          }),
        ),
        true,
      );
      const treeBefore = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.deepStrictEqual(
        actionsFor(dryRun.actions, rootRustDeclarationPath),
        [],
      );
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        true,
      );
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, rootRustDeclarationPath),
        ),
        false,
      );
      assert.deepStrictEqual(
        actionsFor(applied.actions, rootRustDeclarationPath),
        [],
      );
      // 根正文逐字节保留，未知字段与注释不被快照或模板改写；M5 取根 channel 而非快照。
      assert.strictEqual(await readFile(rootRustPath, "utf8"), customRootRust);
      const written = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(written, ["build", "args", "RUST_TOOLCHAIN"]),
        "stable",
      );
      assert.strictEqual(
        pointerValue(written, ["build", "args", "NODE_VERSION"]),
        pointerValue(JSON.parse(configBefore) as unknown, [
          "build",
          "args",
          "NODE_VERSION",
        ]),
      );

      // 后续第二个 Rust 包沿用同一根正文，仍不写根文件。
      const second = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "second",
        }),
      );
      const reconciled = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...second.plan.projectProjections,
      });
      if (!reconciled.ok) throw new Error(JSON.stringify(reconciled));
      assert.strictEqual(
        reconciled.changedPaths.some((changedPath) =>
          Object.is(changedPath, rootRustDeclarationPath),
        ),
        false,
      );
      assert.strictEqual(await readFile(rootRustPath, "utf8"), customRootRust);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("槽位已等于根时缩进与键序差异不产生任何写入", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-noop-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      await writeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
        manifest.packageManager = additionTargetPnpm;
      });
      const configPath = path.join(targetDir, devcontainerPath);
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareAddition(targetDir)).plan.projectProjections,
      });
      const aligned = await readJsonObject(configPath);
      const reordered: MutableJsonObject = {
        mounts: aligned.mounts,
        customizations: aligned.customizations,
        name: aligned.name,
        build: aligned.build,
      };
      await writeFile(configPath, `${JSON.stringify(reordered, null, 4)}\r\n`);
      const before = await readFile(configPath);

      const addition = await prepareAddition(targetDir);
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(actionsFor(applied.actions, devcontainerPath), []);
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.strictEqual(
        Buffer.from(await readFile(configPath)).equals(before),
        true,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  const unexplainableSlotCases: readonly {
    readonly label: string;
    readonly reason: RegExp;
    readonly corrupt?: (raw: string) => string;
    readonly mutate?: (config: MutableJsonObject) => void;
  }[] = [
    {
      label: "JSONC 注释",
      reason: /Current structured content is not valid JSON/u,
      corrupt: (raw: string): string =>
        raw.replace('"name":', '// 用户留下的注释\n  "name":'),
    },
    {
      label: "数字槽位值",
      reason: /non-string Current value/u,
      mutate: (config: MutableJsonObject): void => {
        (config.build as MutableJsonObject).args = {
          ...((config.build as MutableJsonObject).args as MutableJsonObject),
          NODE_VERSION: 22.2,
        };
      },
    },
  ];

  for (const { label, reason, corrupt, mutate } of unexplainableSlotCases) {
    void it(`M1 槽位${label}时整次加包在写入前原子失败且零半成品`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-mirror-atomic-"),
      );
      try {
        const targetDir = await initTsLibRepository(workspace);
        await writeRootManifest(targetDir, (manifest) => {
          manifest.engines = { node: additionTargetNode };
          manifest.packageManager = additionTargetPnpm;
        });
        const configPath = path.join(targetDir, devcontainerPath);
        if (mutate === undefined) {
          await writeFile(
            configPath,
            corrupt!(await readFile(configPath, "utf8")),
          );
        } else {
          const config = await readJsonObject(configPath);
          mutate(config);
          await writeJsonObject(configPath, config);
        }
        const corrupted = await readFile(configPath, "utf8");
        const before = await treeFingerprint(workspace);

        const addition = await prepareAddition(targetDir);
        const applied = await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.plan.projectProjections,
        });
        assert.strictEqual(applied.ok, false);
        if (applied.ok) throw new Error("unreachable");
        const conflict = applied.conflicts.find(
          (candidate) => candidate.path === devcontainerPath,
        );
        if (conflict === undefined)
          throw new Error(JSON.stringify(applied.conflicts));
        assert.notStrictEqual(conflict, undefined);
        assert.strictEqual(conflict?.driver, "structured");
        assert.match(conflict?.reason, reason);
        assert.strictEqual(await treeFingerprint(workspace), before);
        assert.strictEqual(await readFile(configPath, "utf8"), corrupted);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  void it("纯协调路径删除整个 devcontainer.json 后加包成功且不重建文件", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-absent-file-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const configPath = path.join(targetDir, devcontainerPath);
      await rm(configPath);

      const addition = await prepareAddition(targetDir);
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(actionsFor(applied.actions, devcontainerPath), []);
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      await assert.rejects(readFile(configPath));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("消费者删除 M1 键后纯协调加包保持缺席且不报 presence 冲突", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-absent-key-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const configPath = path.join(targetDir, devcontainerPath);
      const configured = await readJsonObject(configPath);
      (configured.build as MutableJsonObject).args = withoutPointer(
        (configured.build as MutableJsonObject).args,
        ["NODE_VERSION"],
      );
      await writeJsonObject(configPath, configured);

      const addition = await prepareAddition(targetDir);
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(actionsFor(applied.actions, devcontainerPath), []);
      const after = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(after, ["build", "args", "NODE_VERSION"]),
        undefined,
      );
      assert.strictEqual(structuredValuesEqual(after, configured), true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("M5 槽位坏类型时真实 Rust 加包在写入前原子失败且零半成品", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-rust-atomic-"),
    );
    try {
      const targetDir = path.join(workspace, "project");
      await renderRustRepository(targetDir);
      const configPath = path.join(targetDir, devcontainerPath);
      // 现行根 Rust channel 与根 Node 声明同时改变，本应各产生一次槽位归一；用户把 M5 手改为数组。
      await writeFile(
        path.join(targetDir, rootRustDeclarationPath),
        rootRustDeclaration("stable"),
      );
      await writeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
      });
      const configured = await readJsonObject(configPath);
      (configured.build as MutableJsonObject).args = {
        ...((configured.build as MutableJsonObject).args as MutableJsonObject),
        RUST_TOOLCHAIN: ["stable"],
        USER_EXTRA_ARG: "keep-me",
      };
      await writeJsonObject(configPath, configured);
      const corrupted = await readFile(configPath, "utf8");
      const treeBefore = await treeFingerprint(workspace);

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      assert.strictEqual(dryRun.ok, false);
      if (dryRun.ok) throw new Error("unreachable");
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      assert.strictEqual(applied.ok, false);
      if (applied.ok) throw new Error("unreachable");
      assert.deepStrictEqual(applied.conflicts, dryRun.conflicts);
      const conflict = applied.conflicts.find(
        (candidate) => candidate.path === devcontainerPath,
      );
      if (conflict === undefined) {
        throw new Error(JSON.stringify(applied.conflicts));
      }
      assert.strictEqual(conflict.driver, "structured");
      assert.match(conflict.reason, /non-string Current value/u);
      assert.ok(conflict.reason.includes("rust-toolchain-build-arg"));
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);
      assert.strictEqual(await readFile(configPath, "utf8"), corrupted);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("消费者删除 M5 键后真实 Rust 加包保持缺席且同事务仍协调 M1", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror-rust-absent-key-"),
    );
    try {
      const targetDir = path.join(workspace, "project");
      await renderRustRepository(targetDir);
      const configPath = path.join(targetDir, devcontainerPath);
      await writeFile(
        path.join(targetDir, rootRustDeclarationPath),
        rootRustDeclaration("stable"),
      );
      await writeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
      });
      const configured = await readJsonObject(configPath);
      const args: MutableJsonObject = {
        ...((configured.build as MutableJsonObject).args as MutableJsonObject),
        NODE_VERSION: "用户手写的旧值",
      };
      delete args.RUST_TOOLCHAIN;
      (configured.build as MutableJsonObject).args = args;
      configured.customizations = {
        ...(configured.customizations as MutableJsonObject),
        "user-extension": "keep-me",
      };
      await writeJsonObject(configPath, configured);

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const treeBefore = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.deepStrictEqual(actionsFor(dryRun.actions, devcontainerPath), [
        { path: devcontainerPath, driver: "structured", action: "update" },
      ]);
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.deepStrictEqual(applied.actions, dryRun.actions);
      assert.deepStrictEqual(applied.changedPaths, dryRun.changedPaths);

      const reconciled = await readJsonObject(configPath);
      // 用户删除的槽位绝不补回，同文件的 M1 漂移仍被协调回现行根声明。
      assert.strictEqual(
        pointerValue(reconciled, ["build", "args", "RUST_TOOLCHAIN"]),
        undefined,
      );
      assert.strictEqual(
        pointerValue(reconciled, ["build", "args", "NODE_VERSION"]),
        additionTargetNode,
      );
      assert.strictEqual(
        structuredValuesEqual(
          reconciled.customizations,
          configured.customizations,
        ),
        true,
      );
      assert.strictEqual(
        await readFile(path.join(targetDir, rootRustDeclarationPath), "utf8"),
        rootRustDeclaration("stable"),
      );

      const repeated = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      const replayed = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeated.plan.projectProjections,
      });
      if (!replayed.ok) throw new Error(JSON.stringify(replayed));
      assert.deepStrictEqual(
        actionsFor(replayed.actions, devcontainerPath),
        [],
      );
      assert.strictEqual(
        replayed.changedPaths.some((changedPath) =>
          Object.is(changedPath, devcontainerPath),
        ),
        false,
      );
      assert.deepStrictEqual(await readJsonObject(configPath), reconciled);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

void describe("Package Addition builds the first Rust root from the current CLI snapshot", () => {
  const snapshotRust = releaseToolchainSnapshot.rustVersion;

  void it("Node-only 目标无根声明时首次加 Rust 以当前 CLI 快照精确建源且后续加包不再次建源", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-first-rust-bootstrap-"),
    );
    try {
      const targetDir = await initTsLibRepository(workspace);
      const configPath = path.join(targetDir, devcontainerPath);
      const rootRustPath = path.join(targetDir, rootRustDeclarationPath);
      const generationPath = path.join(targetDir, ".template/generation.json");
      const readRecordToolchain = async (): Promise<object> =>
        (
          JSON.parse(await readFile(generationPath, "utf8")) as {
            readonly toolchain: object;
          }
        ).toolchain;
      const recordToolchainBefore = await readRecordToolchain();
      // Generation Record v2 只保留派生的 Node/pnpm 历史；旧加包路径的缺省 stable 是需要与快照区分的历史形状。
      assert.deepStrictEqual(recordToolchainKeys(recordToolchainBefore), [
        "nodeLtsMajor",
        "packageManagerPin",
      ]);
      assert.notStrictEqual(snapshotRust, "stable");

      const addition = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        }),
      );
      assert.strictEqual(
        addition.plan.developmentContainer.buildArguments.some((argument) =>
          isDeepStrictEqual(argument, {
            name: "RUST_TOOLCHAIN",
            value: snapshotRust,
          }),
        ),
        true,
      );

      const treeBefore = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      assert.deepStrictEqual(
        actionsFor(dryRun.actions, rootRustDeclarationPath),
        [{ path: rootRustDeclarationPath, driver: "text", action: "create" }],
      );
      assert.strictEqual(await treeFingerprint(workspace), treeBefore);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(
        applied.changedPaths.some((changedPath) =>
          Object.is(changedPath, rootRustDeclarationPath),
        ),
        true,
      );
      const declared = await readFile(rootRustPath, "utf8");
      assert.ok(declared.includes(`channel = "${snapshotRust}"`));
      const written = await readJsonObject(configPath);
      assert.strictEqual(
        pointerValue(written, ["build", "args", "RUST_TOOLCHAIN"]),
        snapshotRust,
      );
      const blueprint = JSON.parse(
        await readFile(
          path.join(targetDir, ".template/blueprint.json"),
          "utf8",
        ),
      ) as { readonly packages: readonly { readonly path: string }[] };
      assert.strictEqual(
        blueprint.packages.some(
          (candidate) => candidate.path === "packages/worker",
        ),
        true,
      );
      // 历史记录只作历史：Generation Record 的 toolchain 既不被消费也不被改写。
      assert.deepStrictEqual(
        await readRecordToolchain(),
        recordToolchainBefore,
      );

      // 根声明由此拥有版本选择：第二个 Rust 包不再次建源、不写根文件。
      const second = requireReadyAddition(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "second",
        }),
      );
      const reconciled = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...second.plan.projectProjections,
      });
      if (!reconciled.ok) throw new Error(JSON.stringify(reconciled));
      assert.deepStrictEqual(
        actionsFor(reconciled.actions, rootRustDeclarationPath),
        [],
      );
      assert.strictEqual(
        reconciled.changedPaths.some((changedPath) =>
          Object.is(changedPath, rootRustDeclarationPath),
        ),
        false,
      );
      assert.strictEqual(await readFile(rootRustPath, "utf8"), declared);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  const unexplainedFirstRustRootCases: readonly {
    readonly actual: string;
    readonly declaration: string;
    readonly label: string;
    readonly message: RegExp;
  }[] = [
    {
      label: "坏 TOML",
      declaration: "[toolchain\nchannel = ",
      message:
        /rust-toolchain\.toml 的 \[toolchain\]\.channel 是有效 TOML 声明/u,
      actual: "无法解析",
    },
    {
      label: "错误的 channel 形状",
      declaration: '[toolchain]\nchannel = ["1.97.1"]\n',
      message: /rust-toolchain\.toml 的 \[toolchain\]\.channel 为非空字符串/u,
      actual: String.raw`["1.97.1"]`,
    },
  ] as const;

  for (const {
    label,
    declaration,
    message,
    actual,
  } of unexplainedFirstRustRootCases) {
    void it(`首次加 Rust 遇到目标根声明为${label}时可行动失败且零写入，不用快照掩盖`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-first-rust-unexplained-root-"),
      );
      try {
        const targetDir = await initTsLibRepository(workspace);
        const rootRustPath = path.join(targetDir, rootRustDeclarationPath);
        const configPath = path.join(targetDir, devcontainerPath);
        await writeFile(rootRustPath, declaration);
        const treeBefore = await treeFingerprint(workspace);

        const preparation = prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "rust-bin",
          packageLeafName: "worker",
        });
        assert.strictEqual(preparation.status, "operation-failure");
        if (preparation.status !== "operation-failure") {
          throw new Error("Expected invalid root Rust metadata");
        }
        assert.strictEqual(preparation.phase, "metadata");
        assert.ok(preparation.diagnostic);
        const diagnostic = preparation.diagnostic;
        assert.match(diagnostic.message, message);
        assert.ok(diagnostic.suggestion.includes(rootRustDeclarationPath));
        assert.ok(diagnostic.message.includes(actual));
        assert.strictEqual(await treeFingerprint(workspace), treeBefore);
        assert.strictEqual(await readFile(rootRustPath, "utf8"), declaration);
        assert.strictEqual(
          (await readFile(configPath, "utf8")).includes("RUST_TOOLCHAIN"),
          false,
        );

        // 恢复合法根声明后同一加包按修正后的根 channel 成功。
        await writeFile(rootRustPath, rootRustDeclaration("stable"));
        const recovery = requireReadyAddition(
          prepareGeneratedRepositoryPackageAddition({
            repositoryRoot: targetDir,
            preset: "rust-bin",
            packageLeafName: "worker",
          }),
        );
        assert.ok(
          recovery.plan.developmentContainer.buildArguments.some(
            (argument) =>
              argument.name === "RUST_TOOLCHAIN" && argument.value === "stable",
          ),
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

void describe("Generated Repository toolchain checker projection", () => {
  const checkerPath = "scripts/check-toolchain-versions.ts";
  type InitializationPlan = ReturnType<
    typeof planGeneratedRepositoryInitialization
  >;
  const context = createGenerationContext({
    targetDir: "/tmp/toolchain-checker-projection",
    toolchain: {
      ...toolchain,
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  });

  /** 槽位身份：路径 + id + 位置形制，携带清单与 plan 声明按同一口径比较。 */
  const slotKey = (
    path: string,
    id: string,
    location: Record<string, unknown>,
  ): string =>
    [
      path,
      id,
      location.kind,
      location.kind === "json-pointer" ? location.pointer : location.name,
    ].join("\u0000");

  const declaredSlotKeys = (plan: InitializationPlan): readonly string[] =>
    plan.reconciliation
      .flatMap((policy) =>
        policy.driver === "canonical"
          ? []
          : (policy.mirrorSlots ?? []).map((slot) =>
              slotKey(policy.path, slot.id, slot.location),
            ),
      )
      .toSorted();

  const carriedSlotKeys = (plan: InitializationPlan): readonly string[] => {
    const operation = plan.operations.find(
      (candidate) =>
        candidate.kind === "writeTextTemplate" && candidate.to === checkerPath,
    );
    if (operation === undefined || operation.kind !== "writeTextTemplate") {
      throw new Error(`初始化 plan 未以文本模板投影生成检查器 ${checkerPath}`);
    }
    const manifestText =
      operation.replacements["TOOLCHAIN_MIRROR_SLOT_MANIFEST"];
    if (typeof manifestText !== "string") {
      throw new Error(`生成检查器模板未携带槽位清单模板变量`);
    }
    const carried = JSON.parse(
      manifestText.replaceAll(String.raw`\$`, "$"),
    ) as {
      readonly id: string;
      readonly location: Record<string, unknown>;
      readonly path: string;
    }[];

    return carried
      .map((slot) => slotKey(slot.path, slot.id, slot.location))
      .toSorted();
  };

  void it("carries exactly the mirror slots its own plan declares", () => {
    let largestCarried = 0;
    for (const definition of builtInPresetRegistry.all()) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      assert.deepStrictEqual(carriedSlotKeys(plan), declaredSlotKeys(plan));
      largestCarried = Math.max(largestCarried, carriedSlotKeys(plan).length);
    }
    // 非空转：至少一个 Preset 同时携带结构化与文本锚点槽位。
    assert.ok(largestCarried >= 2);
  });

  void it("composes the checker into the root boundary task that Root Check runs", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsLibDefinition,
      context,
    });
    const rootManifest = plan.operations.find(
      (operation) =>
        operation.kind === "writeJson" && operation.to === "package.json",
    );
    if (rootManifest === undefined || rootManifest.kind !== "writeJson") {
      throw new Error("初始化 plan 未以 writeJson 投影根 package.json");
    }
    const scripts = (rootManifest.value as { scripts: Record<string, string> })
      .scripts;

    const boundariesScript = scripts.boundaries;
    const checkScript = scripts.check;
    if (boundariesScript === undefined || checkScript === undefined) {
      throw new Error("根 package.json 未声明 boundaries 或 check 任务");
    }

    assert.strictEqual(
      boundariesScript,
      "turbo boundaries --no-color && node --conditions=source scripts/check-toolchain-versions.ts",
    );
    assert.strictEqual(checkScript.startsWith("pnpm run boundaries &&"), true);
    assert.strictEqual("toolchain:prepare" in scripts, false);
  });
});
