import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
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
  validateGeneratedDevelopmentContainerProjection,
  validatePlanDependencyCatalog,
  validatePlanPublicationSources,
  validatePlanSources,
} from "../packages/checks/src/registry-checks.ts";

const rustPresetName = ["rust", "bin"].join("-");

describe("Preset Registry generated scenarios", () => {
  it("makes every real TypeScript config dependency an explicit Package Contribution fact", () => {
    let declaredTypeScriptPackageCount = 0;
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", definition.metadata.name),
        defaultPackageScope: "explicit-typescript-config",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      });
      const contributions = planGeneratedRepositoryInitialization({
        definition,
        context,
      }).packageContributions;
      for (const contribution of contributions) {
        const writesTypeScriptConfig = contribution.operations.some(
          (operation) =>
            "to" in operation &&
            operation.to === `${contribution.definition.path}/tsconfig.json`,
        );
        expect(
          contribution.foundation.typescriptConfigurationPackage,
          `${definition.metadata.name}:${contribution.definition.path}`,
        ).toEqual(
          writesTypeScriptConfig ? { dependency: "required" } : undefined,
        );
        if (writesTypeScriptConfig) declaredTypeScriptPackageCount += 1;
      }
    }
    expect(declaredTypeScriptPackageCount).toBeGreaterThan(0);
  });

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
    const rustDefinition = definitions.find(
      (definition) => definition.metadata.name === rustPresetName,
    );
    if (rustDefinition?.planPackageAddition === undefined) {
      throw new Error("Expected Rust preset to support Package Addition");
    }
    expect(
      matrix
        .filter(
          (scenario) =>
            scenario.addition?.metadata.name === rustDefinition?.metadata.name,
        )
        .map((scenario) => scenario.base.metadata.name),
    ).toEqual(definitions.map((definition) => definition.metadata.name));

    for (const scenario of matrix) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", scenario.id),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      });
      expect(
        planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context,
        }).blueprint.schemaVersion,
      ).toBe(3);
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
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-focused-registry-"),
    );
    try {
      for (const scenario of focused) {
        expect(scenario.addition?.planPackageAddition !== undefined).toBe(true);
        expect(scenario.linkFrom).toHaveLength(1);
        expect(scenario.id).toContain(scenario.base.metadata.name);

        const context = createGenerationContext({
          targetDir: path.join(workspace, scenario.id),
          defaultPackageScope: "focused",
          toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
        });
        expect(path.dirname(context.targetDir)).toBe(workspace);
        const initialization = planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context,
        });
        await renderNewProject({
          targetRoot: context.targetDir,
          operations: [...initialization.operations],
        });
        const addition = planGeneratedRepositoryPackageAddition({
          definition: scenario.addition!,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("plans an exact repeated Package Addition as a no-op", async () => {
    const scenario = deriveFocusedProjectLinkScenarios()[0]!;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-repeat-addition-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, scenario.id),
      defaultPackageScope: "focused",
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName,
        linkFrom: scenario.linkFrom!,
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });
      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName,
        linkFrom: scenario.linkFrom!,
      });

      expect(repeatedAddition.blueprint).toEqual(addition.blueprint);
      expect(repeatedAddition.operations).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects mismatched Package Definition and Link Intent occupancy", async () => {
    const scenario = deriveFocusedProjectLinkScenarios()[0]!;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-occupied-addition-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, scenario.id),
      defaultPackageScope: "focused",
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
    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const occupied = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName,
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...occupied.projectProjections,
      });
      const blueprintPath = path.join(
        context.targetDir,
        ".template/blueprint.json",
      );
      await writeFile(
        blueprintPath,
        `${JSON.stringify(
          {
            ...occupied.blueprint,
            packages: occupied.blueprint.packages.map((definition) =>
              definition.path === contribution.definition.path
                ? { ...definition, role: "native-package" as const }
                : definition,
            ),
          },
          null,
          2,
        )}\n`,
      );

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition: scenario.addition!,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName,
        }),
      ).toThrow(
        `Package Addition conflicts with existing Package Definition ${contribution.definition.name} at ${contribution.definition.path} (native-package); requested ${contribution.definition.name} at ${contribution.definition.path} (${contribution.definition.role})`,
      );

      await writeFile(
        blueprintPath,
        `${JSON.stringify(occupied.blueprint, null, 2)}\n`,
      );
      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition: scenario.addition!,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName,
          linkFrom: scenario.linkFrom!,
        }),
      ).toThrow(
        `requested Package Link Intent ${scenario.linkFrom![0]} -> ${contribution.definition.path} does not already exist`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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

  it("validates protected Tool Layer fields while allowing unrelated preserved Development Container additions", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-final-tool-layer-projection-"),
    );
    const definitions = builtInPresetRegistry.all();
    const rustDefinition = definitions.find(
      (definition) => definition.metadata.name === rustPresetName,
    );
    const base = definitions.find(
      (definition) => definition.metadata.name !== rustPresetName,
    );
    if (rustDefinition === undefined || base === undefined) {
      throw new Error("Expected Rust and non-Rust Built-in Presets");
    }
    const context = createGenerationContext({
      targetDir: path.join(workspace, "generated"),
      defaultPackageScope: "fixture",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: base,
        context,
      });
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: rustDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "worker",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });
      expect(result.ok).toBe(true);

      await expect(
        validateGeneratedDevelopmentContainerProjection({
          plan: addition,
          projectDir: context.targetDir,
        }),
      ).resolves.toBeUndefined();
      expect(
        addition.developmentContainer.toolLayers.map((layer) => layer.identity),
      ).toContain("rust");

      const configPath = path.join(
        context.targetDir,
        ".devcontainer/devcontainer.json",
      );
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        build: { args: Record<string, string> };
        mounts: Record<string, unknown>[];
      };
      config.build.args.USER_IMAGE_FLAVOR = "custom";
      config.mounts.push({
        type: "bind",
        source: "/tmp/user-cache",
        target: "/workspaces/user-cache",
        consistency: "cached",
      });
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      await expect(
        validateGeneratedDevelopmentContainerProjection({
          plan: addition,
          projectDir: context.targetDir,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
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

    const contribution = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions[0]!;
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
      `${definition.metadata.name}: planInitialization Package Contribution may not write a sibling Package Boundary; ${contribution.definition.path} attempted apps/sibling/package.json`,
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
      `${definition.metadata.name}: planPackageAddition Package Contribution may not write a coordinated root output; ${contribution.definition.path} attempted turbo.json`,
    );
  });
});
