import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
} from "#template-builtin-presets";
import { assertPackageContribution } from "#template-core/package-contribution";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import {
  createTemplateSourceHandle,
  renderNewProject,
} from "#template-core/renderer";

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  discoverPresetLocalBehaviorTests,
  deriveVerificationPlans,
  validatePlanDependencyCatalog,
  validatePlanPublicationSources,
  validatePlanSources,
} from "../packages/builtin-presets/src/registry-checks.ts";

describe("Preset Registry generated scenarios", () => {
  it("derives one initialization scenario per Definition and the complete addition matrix", () => {
    const definitions = builtInPresetRegistry.all();
    const initialization = deriveInitializationScenarios();
    const matrix = deriveFixtureMatrix();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    expect(
      initialization.map((scenario) => scenario.base.metadata.name),
    ).toEqual(definitions.map((definition) => definition.metadata.name));
    expect(matrix).toHaveLength(
      definitions.length * (addableDefinitions.length + 1),
    );
    expect(
      matrix.filter((scenario) => scenario.addition === undefined),
    ).toHaveLength(definitions.length);

    for (const scenario of matrix) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", scenario.id),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      });
      expect(scenario.base.blueprint(context).schemaVersion).toBe(2);
    }
  });

  it("derives packed-source verification from every initialization and addition plan", () => {
    const verificationPlans = deriveVerificationPlans();
    expect(verificationPlans).toHaveLength(
      deriveFixtureMatrix().length +
        deriveFixtureMatrix().filter(
          (scenario) => scenario.addition !== undefined,
        ).length,
    );
    expect(() =>
      validatePlanPublicationSources({
        packageRoot: path.resolve(
          resolveBuiltInTemplateSource(
            verificationPlans[0]!.definition.source,
            ".",
          ),
          "..",
          "..",
        ),
        packedPaths: [],
        verificationPlans,
      }),
    ).toThrow(/packed Built-in Presets artifact omits/);
  });

  it("rejects generated debris from a packed Built-in Presets artifact", () => {
    expect(() =>
      validatePlanPublicationSources({
        packageRoot: process.cwd(),
        packedPaths: [
          `package/templates/.template-packages-rust-${"bin"}-leaked/package.json`,
          `package/dist/src/rust-${"bin"}/behavior.test.js`,
        ],
        verificationPlans: [],
      }),
    ).toThrow(/generated or test artifact/);
  });

  it("derives focused Project Link scenarios from Definition contributions", async () => {
    const focused = deriveFocusedProjectLinkScenarios();
    const consumerRoles = new Set<string>();
    const providerRoles = new Set<string>();
    for (const scenario of focused) {
      expect(scenario.addition?.planPackageAddition !== undefined).toBe(true);
      expect(scenario.linkFrom).toHaveLength(1);
      expect(scenario.id).toContain(scenario.base.metadata.name);

      const context = createGenerationContext({
        targetDir: path.join("generated-repository", scenario.id),
        scope: "focused",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: scenario.base,
        context,
      });
      await rm(context.targetDir, { recursive: true, force: true });
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: `focused-${scenario.addition!.metadata.name}`,
        linkFrom: scenario.linkFrom!,
      });
      const consumerPath = scenario.linkFrom![0]!;
      const consumerRole = initialization.blueprint.packages.find(
        (definition) => definition.path === consumerPath,
      )?.role;
      expect(consumerRole).not.toBe("native-package");
      consumerRoles.add(consumerRole!);
      const provider = addition.blueprint.packages.find(
        (definition) =>
          definition.path ===
          scenario.addition!.defaultPackagePath?.({
            context,
            packageLeafName: `focused-${scenario.addition!.metadata.name}`,
          }),
      );
      expect(["shared-library", "cli-tool"]).toContain(provider?.role);
      providerRoles.add(provider!.role);
      expect(addition.blueprint.packageLinkIntents).toEqual(
        expect.arrayContaining([
          {
            consumerPackagePath: consumerPath,
            providerPackagePath: provider?.path,
          },
        ]),
      );
      expect(addition.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "mergeJson",
            to: `${consumerPath}/package.json`,
            value: expect.objectContaining({
              dependencies: expect.objectContaining({
                [provider!.name]: "workspace:*",
              }),
              dependenciesMeta: expect.objectContaining({
                [provider!.name]: { injected: false },
              }),
            }),
          }),
        ]),
      );
    }
    expect(consumerRoles).toContain("cli-tool");
    expect(providerRoles).toContain("cli-tool");
  });

  it("plans an exact repeated Package Addition as a no-op", async () => {
    const scenario = deriveFocusedProjectLinkScenarios()[0]!;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-repeat-addition-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, scenario.id),
      scope: "focused",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const packageLeafName = `focused-${scenario.addition!.metadata.name}`;
    const initialization = planGeneratedRepositoryInitialization({
      definition: scenario.base,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        context,
        blueprint: initialization.blueprint,
        packageLeafName,
        linkFrom: scenario.linkFrom!,
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });
      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        context,
        blueprint: addition.blueprint,
        packageLeafName,
        linkFrom: scenario.linkFrom!,
      });

      expect(repeatedAddition.blueprint).toBe(addition.blueprint);
      expect(repeatedAddition.operations).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects mismatched Package Definition and Link Intent occupancy", () => {
    const scenario = deriveFocusedProjectLinkScenarios()[0]!;
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", scenario.id),
      scope: "focused",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const packageLeafName = `focused-${scenario.addition!.metadata.name}`;
    const packagePath = scenario.addition!.defaultPackagePath!({
      context,
      packageLeafName,
    });
    const contribution = scenario.addition!.planPackageAddition!({
      context,
      packageLeafName,
      packagePath,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: scenario.base,
      context,
    });
    const occupiedBlueprint = {
      ...initialization.blueprint,
      packages: [...initialization.blueprint.packages, contribution.definition],
    };

    expect(() =>
      planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        context,
        blueprint: {
          ...occupiedBlueprint,
          packages: occupiedBlueprint.packages.map((definition) =>
            definition.path === contribution.definition.path
              ? { ...definition, role: "native-package" as const }
              : definition,
          ),
        },
        packageLeafName,
      }),
    ).toThrow(
      `existing Package Definition ${contribution.definition.name} at ${contribution.definition.path} (native-package); requested ${contribution.definition.name} at ${contribution.definition.path} (${contribution.definition.role})`,
    );

    expect(() =>
      planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        context,
        blueprint: occupiedBlueprint,
        packageLeafName,
        linkFrom: scenario.linkFrom!,
      }),
    ).toThrow(
      `requested Package Link Intent ${scenario.linkFrom![0]} -> ${contribution.definition.path} does not already exist`,
    );
  });

  it("exposes focused links and Docker-required deployment as distinct runnable check modes", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve("packages/checks/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["check:focused"]).toContain("focused");
    expect(packageJson.scripts["check:deployment"]).toContain("deployment");
  });

  it("discovers every owned behavior test and derives source and catalog checks from real plans", async () => {
    const definitions = builtInPresetRegistry.all();
    await expect(discoverPresetLocalBehaviorTests()).resolves.toHaveLength(
      definitions.length,
    );

    for (const definition of definitions) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join(
            "generated-repository",
            definition.metadata.name,
          ),
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        }),
      });
      await expect(validatePlanSources({ definition, plan })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ definitionName: definition.metadata.name }),
        ]),
      );
      expect(() => validatePlanDependencyCatalog(plan)).not.toThrow();
    }
  });

  it("reports Definition, planner, output, and ownership rule for invalid real-plan inputs", async () => {
    const definition = builtInPresetRegistry.all()[0]!;
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "provenance"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const plan = planGeneratedRepositoryInitialization({ definition, context });
    const source = createTemplateSourceHandle(process.cwd());
    const invalidPlan = {
      ...plan,
      operations: [
        ...plan.operations,
        {
          kind: "copyFile" as const,
          source,
          from: "../escape.ts",
          to: "packages/demo-lib/escape.ts",
        },
      ],
    };
    await expect(
      validatePlanSources({ definition, plan: invalidPlan }),
    ).rejects.toThrow(
      `${definition.metadata.name}: ${definition.plannerSourceFile} references undeclared or escaping Template Source for a generated output: generated packages/demo-lib/escape.ts`,
    );
    await expect(
      validatePlanSources({
        definition,
        plan: {
          ...plan,
          operations: [
            ...plan.operations,
            {
              kind: "copyFile" as const,
              source,
              from: "definitely-missing-template-source.ts",
              to: "packages/demo-lib/missing.ts",
            },
          ],
        },
      }),
    ).rejects.toThrow(
      `${definition.metadata.name}: ${definition.plannerSourceFile} references missing Template Source`,
    );

    const contribution = definition.planInitialization(context);
    expect(() =>
      assertPackageContribution(
        {
          ...contribution,
          operations: [
            { kind: "writeJson", to: "apps/sibling/package.json", value: {} },
          ],
        },
        {
          definitionName: definition.metadata.name,
          planner: "planInitialization",
        },
      ),
    ).toThrow(
      `${definition.metadata.name}: planInitialization Package Contribution may not write a sibling Package Boundary; packages/provenance attempted apps/sibling/package.json`,
    );
    expect(() =>
      assertPackageContribution(
        {
          ...contribution,
          operations: [{ kind: "writeJson", to: "turbo.json", value: {} }],
        },
        {
          definitionName: definition.metadata.name,
          planner: "planPackageAddition",
        },
      ),
    ).toThrow(
      `${definition.metadata.name}: planPackageAddition Package Contribution may not write a coordinated root output; packages/provenance attempted turbo.json`,
    );
  });
});
