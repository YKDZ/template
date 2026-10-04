import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { assertPackageContribution } from "@ykdz/template-core/package-contribution";
import {
  reconcileAndApplyProjectProjections,
  reconcileProjectProjections,
  type ProjectProjection,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  createTemplateSourceHandle,
  renderNewProject,
} from "@ykdz/template-core/renderer";
import { describe, expect, it } from "vitest";

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  discoverPresetLocalBehaviorTests,
  deriveVerificationPlans,
  validateGeneratedDevelopmentContainerProjection,
  validatePlanCheckerMirrorSlotManifest,
  validatePlanDependencyCatalog,
  validatePlanMirrorSlotProjections,
  validatePlanPublicationSources,
  validatePlanSources,
  validateRegistryMirrorSlotProjections,
} from "../packages/checks/src/registry-checks.ts";

const rustPresetName = ["rust", "bin"].join("-");

// 直接规划新建初始化会派生新建公开 ts-cli 候选，需要发版快照中与 major 一致的精确三段版本。
const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.11.0",
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
} as const;

describe("Preset Registry generated scenarios", () => {
  it("makes every real TypeScript config dependency an explicit Package Contribution fact", () => {
    let declaredTypeScriptPackageCount = 0;
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", definition.metadata.name),
        defaultPackageScope: "explicit-typescript-config",
        toolchain,
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
    expect(
      matrix
        .filter((scenario) => scenario.addition === undefined)
        .map((scenario) => scenario.id),
    ).toEqual(initialization.map((scenario) => scenario.id));
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
        toolchain,
      });
      expect(
        planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context,
        }).blueprint.schemaVersion,
      ).toBe(3);
    }
  });

  it("derives packed-source verification from every initialization and addition plan", async () => {
    const verificationPlans = await deriveVerificationPlans();
    expect(verificationPlans).toHaveLength(
      deriveFixtureMatrix().length +
        deriveFixtureMatrix().filter(
          (scenario) => scenario.addition !== undefined,
        ).length,
    );
    await expect(
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
    ).rejects.toThrow(/packed Built-in Presets artifact omits/);
  });

  it("rejects generated debris from a packed Built-in Presets artifact", async () => {
    const debris = [
      `package/templates/.template-packages-rust-bin-leaked/package.json`,
      `package/dist/src/rust-bin/behavior.test.js`,
      "package/templates/shared/node_modules/left-pad/package.json",
      "package/dist/node_modules/leaked/index.js",
      "package/src/foundation/node_modules/leaked/index.js",
      "package/.turbo/cache/abcdef.tar.zst",
    ];
    for (const packedPath of debris) {
      await expect(
        validatePlanPublicationSources({
          packageRoot: process.cwd(),
          packedPaths: [packedPath],
          verificationPlans: [],
        }),
      ).rejects.toThrow(/generated or test artifact/);
    }
  });

  it("accepts the native root-level bundleDependencies payload of a packed artifact", async () => {
    await expect(
      validatePlanPublicationSources({
        packageRoot: process.cwd(),
        packedPaths: [
          "package/package.json",
          "package/node_modules/npm-package-arg/package.json",
          "package/node_modules/hosted-git-info/LICENSE",
          "package/node_modules/hosted-git-info/node_modules/lru-cache/package.json",
        ],
        verificationPlans: [],
      }),
    ).resolves.toBeUndefined();
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
          toolchain,
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
        expect(provider?.role).toBe("shared-library");
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
              }),
            }),
          ]),
        );
      }
      expect(consumerRoles).toContain("cli-tool");
      expect(providerRoles).toEqual(new Set(["shared-library"]));
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
      toolchain,
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
      toolchain,
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

      let identityConflict: unknown;
      try {
        planGeneratedRepositoryPackageAddition({
          definition: scenario.addition!,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName,
        });
      } catch (error) {
        identityConflict = error;
      }
      expect(identityConflict).toBeDefined();
      expect(identityConflict).toMatchObject({
        kind: "identity",
        existing: {
          name: contribution.definition.name,
          path: contribution.definition.path,
          role: "native-package",
        },
        requested: {
          name: contribution.definition.name,
          path: contribution.definition.path,
          role: contribution.definition.role,
        },
      });

      await writeFile(
        blueprintPath,
        `${JSON.stringify(occupied.blueprint, null, 2)}\n`,
      );
      let missingLinkConflict: unknown;
      try {
        planGeneratedRepositoryPackageAddition({
          definition: scenario.addition!,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName,
          linkFrom: scenario.linkFrom!,
        });
      } catch (error) {
        missingLinkConflict = error;
      }
      expect(missingLinkConflict).toBeDefined();
      expect(missingLinkConflict).toMatchObject({
        kind: "missing-link",
        existing: {
          name: contribution.definition.name,
          path: contribution.definition.path,
          role: contribution.definition.role,
        },
        requested: {
          name: contribution.definition.name,
          path: contribution.definition.path,
          role: contribution.definition.role,
        },
        missingLink: {
          consumerPackagePath: scenario.linkFrom![0],
          providerPackagePath: contribution.definition.path,
        },
      });
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
          toolchain,
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
      toolchain,
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

describe("V-8 plan-derived mirror slot self-check", () => {
  const mirrorPointer = "/build/args/NODE_VERSION";
  const mirrorSelfCheckContext = createGenerationContext({
    targetDir: path.join("generated-repository", "mirror-selfcheck"),
    toolchain,
  });
  // 按真实 plan 的镜像投影能力选取基线 Definition，不按 Preset 身份分支。
  const mirrorBaseline = builtInPresetRegistry
    .all()
    .map((definition) => ({
      definition,
      plan: planGeneratedRepositoryInitialization({
        definition,
        context: mirrorSelfCheckContext,
      }),
    }))
    .find(({ plan }) =>
      plan.reconciliation.some((policy) => {
        if (policy.driver === "canonical") return false;
        const projected = plan.operations.some(
          (operation) => "to" in operation && operation.to === policy.path,
        );
        return (
          projected &&
          policy.mirrorSlots?.some(
            (slot) =>
              slot.location.kind === "json-pointer" &&
              slot.location.pointer === mirrorPointer,
          ) === true
        );
      }),
    );
  if (mirrorBaseline === undefined) {
    throw new Error(
      "Expected a Built-in Preset projecting a structured mirror slot",
    );
  }
  const mirrorBasePlan = mirrorBaseline.plan;

  const structuredPlan = (
    rootNode: string,
    projectedNode: string,
    pointer = mirrorPointer,
  ): GeneratedRepositoryPlan => ({
    ...mirrorBasePlan,
    operations: [
      {
        kind: "writeJson",
        to: "package.json",
        value: {
          name: "mirror-root",
          private: true,
          engines: { node: rootNode },
        },
      },
      {
        kind: "writeJson",
        to: ".devcontainer/devcontainer.json",
        value: { build: { args: { NODE_VERSION: projectedNode } } },
      },
    ],
    reconciliation: [
      {
        path: ".devcontainer/devcontainer.json",
        driver: "structured",
        mirrorSlots: [
          { id: "m1", location: { kind: "json-pointer", pointer } },
        ],
      },
    ],
  });

  const textPlan = (
    rootNode: string,
    dockerfile: string,
  ): GeneratedRepositoryPlan => ({
    ...mirrorBasePlan,
    operations: [
      {
        kind: "writeJson",
        to: "package.json",
        value: {
          name: "mirror-root",
          private: true,
          engines: { node: rootNode },
        },
      },
      { kind: "writeText", to: "Dockerfile", text: dockerfile },
    ],
    reconciliation: [
      {
        path: "Dockerfile",
        driver: "text",
        mirrorSlots: [
          {
            id: "m2",
            location: { kind: "text-anchor", name: "NODE_VERSION" },
          },
        ],
      },
    ],
  });

  const check = (plan: GeneratedRepositoryPlan) =>
    validatePlanMirrorSlotProjections({
      definition: mirrorBaseline.definition,
      plan,
    });

  const carrier = (value: string): string =>
    [
      "# @template-mirror NODE_VERSION",
      `ARG NODE_VERSION="${value}"`,
      "# @end-template-mirror",
      "",
    ].join("\n");

  it("passes every real registry initialization and addition plan", async () => {
    await expect(
      validateRegistryMirrorSlotProjections(await deriveVerificationPlans()),
    ).resolves.toBeUndefined();
  });

  it("counts real declared-and-projected mirror slots so the self-check is not vacuous", async () => {
    // 复现自检的过滤条件（driver 非 canonical、声明了槽位、且路径被该 plan 投影），
    // 直接从真实 plan 数据统计被核对的槽位数，证明集成门不会空转。
    const verificationPlans = await deriveVerificationPlans();
    let checkedSlots = 0;
    for (const { plan } of verificationPlans) {
      const projectedPaths = new Set(
        plan.operations
          .map((operation) => ("to" in operation ? operation.to : undefined))
          .filter((to): to is string => to !== undefined),
      );
      for (const policy of plan.reconciliation) {
        if (policy.driver === "canonical" || !projectedPaths.has(policy.path)) {
          continue;
        }
        checkedSlots += policy.mirrorSlots?.length ?? 0;
      }
    }
    expect(checkedSlots).toBeGreaterThan(0);
  });

  it("accepts a structured mirror slot equal to the root-derived value", async () => {
    await expect(
      check(structuredPlan("24.16.0", "24.16.0")),
    ).resolves.toBeUndefined();
  });

  it("fails when a declared JSON pointer has no position in the real projection", async () => {
    await expect(
      check(structuredPlan("24.16.0", "24.16.0", "/build/args/MISSING")),
    ).rejects.toThrow(/声明位置在真实投影中不存在/u);
  });

  it("fails when the structured projection drifts from the root engines.node", async () => {
    await expect(check(structuredPlan("24.16.0", "22.2.2"))).rejects.toThrow(
      /漂移/u,
    );
  });

  it("accepts a well-formed single-line text anchor equal to the root value", async () => {
    await expect(
      check(textPlan("24.16.0", carrier("24.16.0"))),
    ).resolves.toBeUndefined();
  });

  it("fails when the text anchor markers are missing", async () => {
    await expect(
      check(textPlan("24.16.0", 'ARG NODE_VERSION="24.16.0"\n')),
    ).rejects.toThrow(/锚点区域缺失/u);
  });

  it("fails when the text anchor region is duplicated", async () => {
    await expect(
      check(textPlan("24.16.0", carrier("24.16.0") + carrier("24.16.0"))),
    ).rejects.toThrow(/锚点区域缺失、重复/u);
  });

  it("rejects extra body inside the owned text anchor region", async () => {
    await expect(
      check(
        textPlan(
          "24.16.0",
          [
            "# @template-mirror NODE_VERSION",
            'ARG NODE_VERSION="24.16.0"',
            "RUN echo unrelated",
            "# @end-template-mirror",
            "",
          ].join("\n"),
        ),
      ),
    ).rejects.toThrow(/含额外正文/u);
  });

  it("rejects a text anchor whose region is not the protocol ARG carrier", async () => {
    await expect(
      check(
        textPlan(
          "24.16.0",
          [
            "# @template-mirror NODE_VERSION",
            'FROM node:"24.16.0"',
            "# @end-template-mirror",
            "",
          ].join("\n"),
        ),
      ),
    ).rejects.toThrow(/不是协议定义的 ARG NODE_VERSION 承载行/u);
  });

  it("fails when the text anchor ARG default drifts from the root value", async () => {
    await expect(check(textPlan("24.16.0", carrier("22.2.2")))).rejects.toThrow(
      /漂移/u,
    );
  });

  it("restores passing after reverting a controlled drift mutation", async () => {
    await expect(check(structuredPlan("24.16.0", "22.2.2"))).rejects.toThrow(
      /漂移/u,
    );
    await expect(
      check(structuredPlan("24.16.0", "24.16.0")),
    ).resolves.toBeUndefined();
    await expect(check(textPlan("24.16.0", carrier("22.2.2")))).rejects.toThrow(
      /漂移/u,
    );
    await expect(
      check(textPlan("24.16.0", carrier("24.16.0"))),
    ).resolves.toBeUndefined();
  });

  // T28-1/T28-3：M5 从根 rust-toolchain.toml 的 [toolchain].channel 派生，非 Rust 槽位不受影响。
  const rustPointer = "/build/args/RUST_TOOLCHAIN";
  const channelFile = (channel: string): string =>
    `[toolchain]\nchannel = "${channel}"\n`;

  const rustPlan = (
    rootNode: string,
    rustFileText: string | undefined,
    projectedRust: string,
  ): GeneratedRepositoryPlan => ({
    ...mirrorBasePlan,
    operations: [
      {
        kind: "writeJson",
        to: "package.json",
        value: {
          name: "mirror-root",
          private: true,
          engines: { node: rootNode },
        },
      },
      {
        kind: "writeJson",
        to: ".devcontainer/devcontainer.json",
        value: {
          build: {
            args: { NODE_VERSION: rootNode, RUST_TOOLCHAIN: projectedRust },
          },
        },
      },
      ...(rustFileText === undefined
        ? []
        : [
            {
              kind: "writeText" as const,
              to: "rust-toolchain.toml",
              text: rustFileText,
            },
          ]),
    ],
    reconciliation: [
      {
        path: ".devcontainer/devcontainer.json",
        driver: "structured",
        mirrorSlots: [
          {
            id: "m1",
            location: { kind: "json-pointer", pointer: mirrorPointer },
          },
          {
            id: "m5",
            location: { kind: "json-pointer", pointer: rustPointer },
          },
        ],
      },
    ],
  });

  it("accepts an M5 slot equal to the root rust-toolchain.toml channel", async () => {
    await expect(
      check(rustPlan("24.16.0", channelFile("1.97.1"), "1.97.1")),
    ).resolves.toBeUndefined();
  });

  it("accepts a legitimate historical channel such as stable without version inference", async () => {
    await expect(
      check(rustPlan("24.16.0", channelFile("stable"), "stable")),
    ).resolves.toBeUndefined();
  });

  it("fails when the structured Rust projection drifts from the root channel", async () => {
    const error = await check(
      rustPlan("24.16.0", channelFile("1.97.1"), "9.9.9"),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/漂移/u);
    // 漂移诊断必须点名 Rust 根真源，而非误指向 engines.node。
    expect(error?.message).toMatch(
      /rust-toolchain\.toml \[toolchain\]\.channel/u,
    );
    expect(error?.message).not.toMatch(/engines\.node/u);
  });

  it("fails when a Rust slot is declared but the root rust-toolchain.toml is absent", async () => {
    await expect(
      check(rustPlan("24.16.0", undefined, "1.97.1")),
    ).rejects.toThrow(/缺少根 rust-toolchain\.toml 真源/u);
  });

  it("fails when the root channel is unexplainable", async () => {
    await expect(
      check(rustPlan("24.16.0", "[other]\nformat = true\n", "1.97.1")),
    ).rejects.toThrow(/不可解释/u);
  });

  it("leaves a Node-only projection unaffected by the Rust source", async () => {
    // 无 Rust 槽位的投影不读取 rust-toolchain.toml，也不因缺该文件而失败。
    await expect(
      check(structuredPlan("24.16.0", "24.16.0")),
    ).resolves.toBeUndefined();
  });
});

describe("T28 first-Rust mirror slot reconciliation extends monotonically", () => {
  const nodeSlot = {
    id: "node",
    location: { kind: "json-pointer", pointer: "/build/args/NODE_VERSION" },
  } as const;
  const rustSlot = {
    id: "rust",
    location: {
      kind: "json-pointer",
      pointer: "/build/args/RUST_TOOLCHAIN",
    },
  } as const;
  const devcontainerPath = ".devcontainer/devcontainer.json";
  const devcontainer = (
    args: Record<string, string>,
  ): {
    path: string;
    kind: "file";
    content: Uint8Array;
    mode: number;
  } => ({
    content: new TextEncoder().encode(
      `${JSON.stringify({ build: { args } }, null, 2)}\n`,
    ),
    kind: "file",
    mode: 0,
    path: devcontainerPath,
  });
  const projection = (
    slots: readonly (typeof nodeSlot | typeof rustSlot)[],
    args: Record<string, string>,
  ): ProjectProjection => ({
    entries: [devcontainer(args)],
    reconciliation: [
      {
        driver: "structured",
        mirrorSlots: slots,
        path: devcontainerPath,
      },
    ],
  });
  const decode = (content: Uint8Array): Record<string, unknown> =>
    JSON.parse(new TextDecoder("utf8").decode(content)) as Record<
      string,
      unknown
    >;

  it("reconciles a real first-Rust addition that appends an M5 slot over a Node-only before", async () => {
    const before = projection([nodeSlot], { NODE_VERSION: "24.16.0" });
    const after = projection([nodeSlot, rustSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    const result = await reconcileProjectProjections({
      after,
      before,
      readCurrent: async () => devcontainer({ NODE_VERSION: "24.16.0" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mutated = result.mutations.find(
      (entry) => entry.path === devcontainerPath,
    );
    expect(mutated).toBeDefined();
    if (mutated === undefined) return;
    const build = decode(mutated.content).build as {
      args: Record<string, string>;
    };
    expect(build.args.RUST_TOOLCHAIN).toBe("stable");
  });

  it("rejects a policy that removes an existing mirror slot", async () => {
    const before = projection([nodeSlot, rustSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    const after = projection([nodeSlot], { NODE_VERSION: "24.16.0" });
    await expect(
      reconcileProjectProjections({
        after,
        before,
        readCurrent: async () => before.entries[0],
      }),
    ).rejects.toThrow(/reconciliation policy changed/u);
  });

  it("rejects a policy that reorders existing mirror slots", async () => {
    const before = projection([nodeSlot, rustSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    const after = projection([rustSlot, nodeSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    await expect(
      reconcileProjectProjections({
        after,
        before,
        readCurrent: async () => before.entries[0],
      }),
    ).rejects.toThrow(/reconciliation policy changed/u);
  });
});

describe("T26-3 checker carried mirror slot manifest gate", () => {
  const checkerPath = "scripts/check-toolchain-versions.ts";
  const checkerContext = createGenerationContext({
    targetDir: path.join("generated-repository", "checker-manifest-gate"),
    toolchain,
  });
  const checkerPlans = builtInPresetRegistry.all().map((definition) => ({
    definition,
    plan: planGeneratedRepositoryInitialization({
      definition,
      context: checkerContext,
    }),
  }));
  const declaredSlotCount = (plan: GeneratedRepositoryPlan): number =>
    plan.reconciliation.reduce(
      (total, policy) =>
        policy.driver === "canonical"
          ? total
          : total + (policy.mirrorSlots?.length ?? 0),
      0,
    );
  // 反例基线取真实携带槽位最多的初始化 plan，不按 Preset 身份分支。
  const richest = checkerPlans.reduce((best, candidate) =>
    declaredSlotCount(candidate.plan) > declaredSlotCount(best.plan)
      ? candidate
      : best,
  );

  type CarriedSlot = {
    readonly id: string;
    readonly location: Record<string, unknown>;
    readonly path: string;
  };
  const carriedManifestText = (plan: GeneratedRepositoryPlan): string => {
    const operation = plan.operations.find(
      (candidate) => "to" in candidate && candidate.to === checkerPath,
    );
    if (operation?.kind !== "writeTextTemplate") {
      throw new Error(
        `真实初始化 plan 未以文本模板投影生成检查器 ${checkerPath}`,
      );
    }
    const manifestText = operation.replacements.TOOLCHAIN_MIRROR_SLOT_MANIFEST;
    if (typeof manifestText !== "string") {
      throw new Error(
        `生成检查器 ${checkerPath} 的模板替换缺少 TOOLCHAIN_MIRROR_SLOT_MANIFEST`,
      );
    }

    return manifestText;
  };
  const carriedSlots = (plan: GeneratedRepositoryPlan): CarriedSlot[] =>
    JSON.parse(
      carriedManifestText(plan).replaceAll(String.raw`\$`, "$"),
    ) as CarriedSlot[];
  const withCarriedSlots = (
    plan: GeneratedRepositoryPlan,
    slots: readonly CarriedSlot[],
  ): GeneratedRepositoryPlan => ({
    ...plan,
    operations: plan.operations.map((operation) =>
      operation.kind === "writeTextTemplate" &&
      "to" in operation &&
      operation.to === checkerPath
        ? {
            ...operation,
            replacements: {
              TOOLCHAIN_MIRROR_SLOT_MANIFEST: JSON.stringify(
                slots,
                null,
                2,
              ).replaceAll("$", String.raw`\$`),
            },
          }
        : operation,
    ),
  });
  const withoutChecker = (
    plan: GeneratedRepositoryPlan,
  ): GeneratedRepositoryPlan => ({
    ...plan,
    operations: plan.operations.filter(
      (operation) => !("to" in operation && operation.to === checkerPath),
    ),
  });
  const checkCarried = (scenario: {
    readonly definition: (typeof checkerPlans)[number]["definition"];
    readonly plan: GeneratedRepositoryPlan;
  }) =>
    validatePlanCheckerMirrorSlotManifest({
      definition: scenario.definition,
      plan: scenario.plan,
    });
  // 结构化槽位的错误位置反例需要一个确实携带 json-pointer 的真实 plan。
  const pointerCarrier = checkerPlans.find(({ plan }) =>
    carriedSlots(plan).some((slot) => slot.location.kind === "json-pointer"),
  );
  if (pointerCarrier === undefined) {
    throw new Error("Expected a real plan to carry a structured mirror slot");
  }

  it("passes every real initialization plan and carries more than one slot", async () => {
    for (const scenario of checkerPlans) {
      await expect(checkCarried(scenario)).resolves.toBeUndefined();
    }
    expect(declaredSlotCount(richest.plan)).toBeGreaterThanOrEqual(2);
  });

  it("fails when the checker drops a slot the plan declares", async () => {
    await expect(
      checkCarried({
        definition: richest.definition,
        plan: withCarriedSlots(
          richest.plan,
          carriedSlots(richest.plan).slice(1),
        ),
      }),
    ).rejects.toThrow(/未携带 plan 声明的槽位/u);
  });

  it("fails when the checker carries a position the plan does not declare", async () => {
    const mutated = carriedSlots(pointerCarrier.plan).map((slot) =>
      slot.location.kind === "json-pointer"
        ? {
            ...slot,
            location: {
              ...slot.location,
              pointer: "/build/args/SOMETHING_ELSE",
            },
          }
        : slot,
    );
    await expect(
      checkCarried({
        definition: pointerCarrier.definition,
        plan: withCarriedSlots(pointerCarrier.plan, mutated),
      }),
    ).rejects.toThrow(/携带了 plan 未声明的槽位/u);
  });

  it("fails when the projection has no checker script at all", async () => {
    await expect(
      checkCarried({
        definition: richest.definition,
        plan: withoutChecker(richest.plan),
      }),
    ).rejects.toThrow(/真实投影缺少生成仓库工具链检查器/u);
  });

  it("fails when the checker no longer carries exactly one parsed manifest", async () => {
    await expect(
      checkCarried({
        definition: richest.definition,
        plan: {
          ...richest.plan,
          operations: richest.plan.operations.map((operation) =>
            "to" in operation && operation.to === checkerPath
              ? { kind: "writeText", to: checkerPath, text: "export {};\n" }
              : operation,
          ),
        },
      }),
    ).rejects.toThrow(/恰好以一份/u);
  });

  it("fails when a carried slot location has no known shape", async () => {
    const malformed = carriedSlots(pointerCarrier.plan).map((slot) =>
      slot.location.kind === "json-pointer"
        ? { ...slot, location: { kind: "regex", pattern: "NODE_VERSION" } }
        : slot,
    );
    await expect(
      checkCarried({
        definition: pointerCarrier.definition,
        plan: withCarriedSlots(pointerCarrier.plan, malformed),
      }),
    ).rejects.toThrow(/location 形制非法/u);
  });

  it("restores passing after reverting a carried manifest mutation", async () => {
    const carried = carriedSlots(richest.plan);
    await expect(
      checkCarried({
        definition: richest.definition,
        plan: withCarriedSlots(richest.plan, carried.slice(1)),
      }),
    ).rejects.toThrow(/未携带 plan 声明的槽位/u);
    await expect(checkCarried(richest)).resolves.toBeUndefined();
  });
});
