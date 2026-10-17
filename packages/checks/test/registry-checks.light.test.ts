import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
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

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  deriveVerificationPlans,
  validateGeneratedDevelopmentContainerProjection,
  validatePlanCheckerMirrorSlotManifest,
  validatePlanDependencyCatalog,
  validatePlanMirrorSlotProjections,
  validatePlanSources,
  validateRegistryMirrorSlotProjections,
} from "../src/registry-checks.ts";
const rustPresetName = ["rust", "bin"].join("-");

// 直接规划新建初始化会派生新建公开 ts-cli 候选，需要发版快照中与 major 一致的精确三段版本。
const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
} as const;

void describe("Preset Registry generated scenarios", () => {
  void it("makes every real TypeScript config dependency an explicit Package Contribution fact", () => {
    let declaredTypeScriptPackageCount = 0;
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", definition.metadata.name),
        defaultPackageScope: "explicit-typescript-config",
        toolchain,
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      const contributions = plan.packageContributions;
      for (const contribution of contributions) {
        const configuration =
          contribution.referenceBindings?.["@ykdz/reference-typescript-config"];
        if (configuration === undefined) continue;
        assert.match(
          (
            {
              ...(contribution.manifest.dependencies as Record<string, string>),
              ...(contribution.manifest.devDependencies as Record<
                string,
                string
              >),
            } as Record<string, string>
          )[configuration.name]!,
          /^(?:workspace:|link:)/u,
          `${definition.metadata.name}:${contribution.definition.path}`,
        );
        assert.ok(
          plan.blueprint.packages.some(
            (candidate) => candidate.name === configuration.name,
          ),
        );
        declaredTypeScriptPackageCount += 1;
      }
    }
    assert.ok(declaredTypeScriptPackageCount > 0);
  });

  void it("derives one initialization scenario per Definition and the complete addition matrix", () => {
    const definitions = builtInPresetRegistry.all();
    const initialization = deriveInitializationScenarios();
    const matrix = deriveFixtureMatrix();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    assert.deepStrictEqual(
      initialization.map((scenario) => scenario.base.metadata.name),
      definitions.map((definition) => definition.metadata.name),
    );
    assert.strictEqual(
      matrix.length,
      definitions.length * (addableDefinitions.length + 1),
    );
    assert.strictEqual(
      matrix.filter((scenario) => scenario.addition === undefined).length,
      definitions.length,
    );
    assert.deepStrictEqual(
      matrix
        .filter((scenario) => scenario.addition === undefined)
        .map((scenario) => scenario.id),
      initialization.map((scenario) => scenario.id),
    );
    const rustDefinition = definitions.find(
      (definition) => definition.metadata.name === rustPresetName,
    );
    if (rustDefinition?.planPackageAddition === undefined) {
      throw new Error("Expected Rust preset to support Package Addition");
    }
    assert.deepStrictEqual(
      matrix
        .filter(
          (scenario) =>
            scenario.addition?.metadata.name === rustDefinition?.metadata.name,
        )
        .map((scenario) => scenario.base.metadata.name),
      definitions.map((definition) => definition.metadata.name),
    );

    for (const scenario of matrix) {
      const context = createGenerationContext({
        targetDir: path.join("generated-repository", scenario.id),
        toolchain,
      });
      assert.strictEqual(
        planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context,
        }).blueprint.schemaVersion,
        3,
      );
    }
  });

  void it("derives packed-source verification from every initialization and addition plan", async () => {
    const verificationPlans = await deriveVerificationPlans();
    assert.strictEqual(
      verificationPlans.length,
      deriveFixtureMatrix().length +
        deriveFixtureMatrix().filter(
          (scenario) => scenario.addition !== undefined,
        ).length,
    );
  });

  void it("derives focused Project Link scenarios from Definition contributions", async () => {
    const focused = deriveFocusedProjectLinkScenarios();
    const consumerRoles = new Set<string>();
    const providerRoles = new Set<string>();
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-focused-registry-"),
    );
    try {
      for (const scenario of focused) {
        assert.strictEqual(
          scenario.addition?.planPackageAddition !== undefined,
          true,
        );
        assert.ok(scenario.linkFrom);
        assert.strictEqual(scenario.linkFrom.length, 1);
        assert.ok(scenario.id.includes(scenario.base.metadata.name));

        const context = createGenerationContext({
          targetDir: path.join(workspace, scenario.id),
          defaultPackageScope: "focused",
          toolchain,
        });
        assert.strictEqual(path.dirname(context.targetDir), workspace);
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
          linkFrom: scenario.linkFrom,
        });
        assert.strictEqual(
          await validatePlanDependencyCatalog(addition),
          undefined,
        );
        const consumerPath = scenario.linkFrom[0]!;
        const consumerRole = initialization.blueprint.packages.find(
          (definition) => definition.path === consumerPath,
        )?.role;
        assert.notStrictEqual(consumerRole, "native-package");
        consumerRoles.add(consumerRole!);
        const provider = addition.blueprint.packages.find(
          (definition) =>
            definition.path ===
            scenario.addition!.defaultPackagePath?.({
              context,
              packageLeafName: `focused-${scenario.addition!.metadata.name}`,
            }),
        );
        assert.strictEqual(provider?.role, "shared-library");
        providerRoles.add(provider.role);
        assert.ok(addition.blueprint.packageLinkIntents);
        assert.ok(
          addition.blueprint.packageLinkIntents.some((intent) =>
            isDeepStrictEqual(intent, {
              consumerPackagePath: consumerPath,
              providerPackagePath: provider?.path,
            }),
          ),
        );
        const consumerManifestMerge = addition.operations.find(
          (operation) =>
            operation.kind === "mergeJson" &&
            operation.to === `${consumerPath}/package.json`,
        );
        assert.ok(consumerManifestMerge);
        assert.ok(consumerManifestMerge.kind === "mergeJson");
        assert.partialDeepStrictEqual(consumerManifestMerge.value, {
          dependencies: { [provider.name]: "workspace:*" },
        });
      }
      assert.ok(consumerRoles.has("cli-tool"));
      assert.deepStrictEqual(providerRoles, new Set(["shared-library"]));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("plans an exact repeated Package Addition as a no-op", async () => {
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

      assert.deepStrictEqual(repeatedAddition.blueprint, addition.blueprint);
      assert.deepStrictEqual(repeatedAddition.operations, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects mismatched Package Definition and Link Intent occupancy", async () => {
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
      assert.notStrictEqual(identityConflict, undefined);
      assert.ok(
        typeof identityConflict === "object" && identityConflict !== null,
      );
      const identityRecord = identityConflict as Record<string, unknown>;
      assert.ok(Object.hasOwn(identityRecord, "kind"));
      assert.strictEqual(identityRecord.kind, "identity");
      assert.ok(Object.hasOwn(identityRecord, "existing"));
      assert.partialDeepStrictEqual(identityRecord.existing, {
        name: contribution.definition.name,
        path: contribution.definition.path,
        role: "native-package",
      });
      assert.ok(Object.hasOwn(identityRecord, "requested"));
      assert.partialDeepStrictEqual(identityRecord.requested, {
        name: contribution.definition.name,
        path: contribution.definition.path,
        role: contribution.definition.role,
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
      assert.notStrictEqual(missingLinkConflict, undefined);
      assert.ok(
        typeof missingLinkConflict === "object" && missingLinkConflict !== null,
      );
      const missingLinkRecord = missingLinkConflict as Record<string, unknown>;
      assert.ok(Object.hasOwn(missingLinkRecord, "kind"));
      assert.strictEqual(missingLinkRecord.kind, "missing-link");
      assert.ok(Object.hasOwn(missingLinkRecord, "existing"));
      assert.partialDeepStrictEqual(missingLinkRecord.existing, {
        name: contribution.definition.name,
        path: contribution.definition.path,
        role: contribution.definition.role,
      });
      assert.ok(Object.hasOwn(missingLinkRecord, "requested"));
      assert.partialDeepStrictEqual(missingLinkRecord.requested, {
        name: contribution.definition.name,
        path: contribution.definition.path,
        role: contribution.definition.role,
      });
      assert.ok(Object.hasOwn(missingLinkRecord, "missingLink"));
      assert.partialDeepStrictEqual(missingLinkRecord.missingLink, {
        consumerPackagePath: scenario.linkFrom![0],
        providerPackagePath: contribution.definition.path,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("exposes focused links and Docker-required deployment as distinct runnable check modes", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    const focusedScript = packageJson.scripts["check:focused"];
    const deploymentScript = packageJson.scripts["check:deployment"];
    assert.ok(focusedScript !== undefined);
    assert.ok(deploymentScript !== undefined);
    assert.ok(focusedScript.includes("focused"));
    assert.ok(deploymentScript.includes("deployment"));
  });

  void it("derives source and catalog checks from real plans", async () => {
    const definitions = builtInPresetRegistry.all();

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
      const diagnostics = await validatePlanSources({ definition, plan });
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            Object.hasOwn(diagnostic, "definitionName") &&
            diagnostic.definitionName === definition.metadata.name,
        ),
      );
      assert.strictEqual(await validatePlanDependencyCatalog(plan), undefined);
    }
  });

  void it("validates protected Tool Layer fields while allowing unrelated preserved Development Container additions", async () => {
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
      assert.strictEqual(result.ok, true);

      assert.strictEqual(
        await validateGeneratedDevelopmentContainerProjection({
          plan: addition,
          projectDir: context.targetDir,
        }),
        undefined,
      );
      assert.ok(
        addition.developmentContainer.toolLayers
          .map((layer) => layer.identity)
          .includes("rust"),
      );

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

      assert.strictEqual(
        await validateGeneratedDevelopmentContainerProjection({
          plan: addition,
          projectDir: context.targetDir,
        }),
        undefined,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("reports Definition, planner, output, and ownership rule for invalid real-plan inputs", async () => {
    const definition = builtInPresetRegistry.all()[0]!;
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "provenance"),
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      },
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
    await assert.rejects(
      validatePlanSources({ definition, plan: invalidPlan }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `${definition.metadata.name}: ${definition.plannerSourceFile} references undeclared or escaping Template Source for a generated output: generated packages/demo-lib/escape.ts`,
        ),
    );
    await assert.rejects(
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
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `${definition.metadata.name}: ${definition.plannerSourceFile} references missing Template Source`,
        ),
    );

    const contribution = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions[0]!;
    assert.throws(
      () =>
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
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `${definition.metadata.name}: planInitialization Package Contribution may not write a sibling Package Boundary; ${contribution.definition.path} attempted apps/sibling/package.json`,
        ),
    );
    assert.throws(
      () =>
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
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `${definition.metadata.name}: planPackageAddition Package Contribution may not write a coordinated root output; ${contribution.definition.path} attempted turbo.json`,
        ),
    );
  });
});

void describe("V-8 plan-derived mirror slot self-check", () => {
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

  void it(
    "passes every real registry initialization and addition plan",
    { timeout: 180_000 },
    async () => {
      assert.strictEqual(
        await validateRegistryMirrorSlotProjections(
          await deriveVerificationPlans(),
        ),
        undefined,
      );
    },
  );

  void it("counts real declared-and-projected mirror slots so the self-check is not vacuous", async () => {
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
    assert.ok(checkedSlots > 0);
  });

  void it("accepts a structured mirror slot equal to the root-derived value", async () => {
    assert.strictEqual(
      await check(structuredPlan("24.16.0", "24.16.0")),
      undefined,
    );
  });

  void it("fails when a declared JSON pointer has no position in the real projection", async () => {
    await assert.rejects(
      check(structuredPlan("24.16.0", "24.16.0", "/build/args/MISSING")),
      (error: unknown) =>
        error instanceof Error &&
        /声明位置在真实投影中不存在/u.test(error.message),
    );
  });

  void it("fails when the structured projection drifts from the root engines.node", async () => {
    await assert.rejects(
      check(structuredPlan("24.16.0", "22.2.2")),
      (error: unknown) => error instanceof Error && /漂移/u.test(error.message),
    );
  });

  void it("accepts a well-formed single-line text anchor equal to the root value", async () => {
    assert.strictEqual(
      await check(textPlan("24.16.0", carrier("24.16.0"))),
      undefined,
    );
  });

  void it("fails when the text anchor markers are missing", async () => {
    await assert.rejects(
      check(textPlan("24.16.0", 'ARG NODE_VERSION="24.16.0"\n')),
      (error: unknown) =>
        error instanceof Error && /锚点区域缺失/u.test(error.message),
    );
  });

  void it("fails when the text anchor region is duplicated", async () => {
    await assert.rejects(
      check(textPlan("24.16.0", carrier("24.16.0") + carrier("24.16.0"))),
      (error: unknown) =>
        error instanceof Error && /锚点区域缺失、重复/u.test(error.message),
    );
  });

  void it("rejects extra body inside the owned text anchor region", async () => {
    await assert.rejects(
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
      (error: unknown) =>
        error instanceof Error && /含额外正文/u.test(error.message),
    );
  });

  void it("rejects a text anchor whose region is not the protocol ARG carrier", async () => {
    await assert.rejects(
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
      (error: unknown) =>
        error instanceof Error &&
        /不是协议定义的 ARG NODE_VERSION 承载行/u.test(error.message),
    );
  });

  void it("fails when the text anchor ARG default drifts from the root value", async () => {
    await assert.rejects(
      check(textPlan("24.16.0", carrier("22.2.2"))),
      (error: unknown) => error instanceof Error && /漂移/u.test(error.message),
    );
  });

  void it("restores passing after reverting a controlled drift mutation", async () => {
    await assert.rejects(
      check(structuredPlan("24.16.0", "22.2.2")),
      (error: unknown) => error instanceof Error && /漂移/u.test(error.message),
    );
    assert.strictEqual(
      await check(structuredPlan("24.16.0", "24.16.0")),
      undefined,
    );
    await assert.rejects(
      check(textPlan("24.16.0", carrier("22.2.2"))),
      (error: unknown) => error instanceof Error && /漂移/u.test(error.message),
    );
    assert.strictEqual(
      await check(textPlan("24.16.0", carrier("24.16.0"))),
      undefined,
    );
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

  void it("accepts an M5 slot equal to the root rust-toolchain.toml channel", async () => {
    assert.strictEqual(
      await check(rustPlan("24.16.0", channelFile("1.97.1"), "1.97.1")),
      undefined,
    );
  });

  void it("accepts a legitimate historical channel such as stable without version inference", async () => {
    assert.strictEqual(
      await check(rustPlan("24.16.0", channelFile("stable"), "stable")),
      undefined,
    );
  });

  void it("fails when the structured Rust projection drifts from the root channel", async () => {
    const error = await check(
      rustPlan("24.16.0", channelFile("1.97.1"), "9.9.9"),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    assert.ok(error instanceof Error);
    assert.match(error?.message, /漂移/u);
    // 漂移诊断必须点名 Rust 根真源，而非误指向 engines.node。
    assert.match(
      error?.message,
      /rust-toolchain\.toml \[toolchain\]\.channel/u,
    );
    assert.doesNotMatch(error?.message, /engines\.node/u);
  });

  void it("fails when a Rust slot is declared but the root rust-toolchain.toml is absent", async () => {
    await assert.rejects(
      check(rustPlan("24.16.0", undefined, "1.97.1")),
      (error: unknown) =>
        error instanceof Error &&
        /缺少根 rust-toolchain\.toml 真源/u.test(error.message),
    );
  });

  void it("fails when the root channel is unexplainable", async () => {
    await assert.rejects(
      check(rustPlan("24.16.0", "[other]\nformat = true\n", "1.97.1")),
      (error: unknown) =>
        error instanceof Error && /不可解释/u.test(error.message),
    );
  });

  void it("leaves a Node-only projection unaffected by the Rust source", async () => {
    // 无 Rust 槽位的投影不读取 rust-toolchain.toml，也不因缺该文件而失败。
    assert.strictEqual(
      await check(structuredPlan("24.16.0", "24.16.0")),
      undefined,
    );
  });
});

void describe("T28 first-Rust mirror slot reconciliation extends monotonically", () => {
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

  void it("reconciles a real first-Rust addition that appends an M5 slot over a Node-only before", async () => {
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
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    const mutated = result.mutations.find(
      (entry) => entry.path === devcontainerPath,
    );
    assert.notStrictEqual(mutated, undefined);
    if (mutated === undefined) return;
    const build = decode(mutated.content).build as {
      args: Record<string, string>;
    };
    assert.strictEqual(build.args.RUST_TOOLCHAIN, "stable");
  });

  void it("rejects a policy that removes an existing mirror slot", async () => {
    const before = projection([nodeSlot, rustSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    const after = projection([nodeSlot], { NODE_VERSION: "24.16.0" });
    await assert.rejects(
      reconcileProjectProjections({
        after,
        before,
        readCurrent: async () => before.entries[0],
      }),
      (error: unknown) =>
        error instanceof Error &&
        /reconciliation policy changed/u.test(error.message),
    );
  });

  void it("rejects a policy that reorders existing mirror slots", async () => {
    const before = projection([nodeSlot, rustSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    const after = projection([rustSlot, nodeSlot], {
      NODE_VERSION: "24.16.0",
      RUST_TOOLCHAIN: "stable",
    });
    await assert.rejects(
      reconcileProjectProjections({
        after,
        before,
        readCurrent: async () => before.entries[0],
      }),
      (error: unknown) =>
        error instanceof Error &&
        /reconciliation policy changed/u.test(error.message),
    );
  });
});

void describe("T26-3 checker carried mirror slot manifest gate", () => {
  const checkerPath = "scripts/toolchain-mirrors.json";
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
  const carriedSlots = (plan: GeneratedRepositoryPlan): CarriedSlot[] => {
    const operation = plan.operations.find(
      (candidate) => "to" in candidate && candidate.to === checkerPath,
    );
    assert.ok(operation?.kind === "writeJson");
    return operation.value as CarriedSlot[];
  };
  const withCarriedSlots = (
    plan: GeneratedRepositoryPlan,
    slots: readonly CarriedSlot[],
  ): GeneratedRepositoryPlan => ({
    ...plan,
    operations: plan.operations.map((operation) =>
      operation.kind === "writeJson" && operation.to === checkerPath
        ? { ...operation, value: slots }
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

  void it("passes every real initialization plan and carries more than one slot", async () => {
    for (const scenario of checkerPlans) {
      assert.strictEqual(await checkCarried(scenario), undefined);
    }
    assert.ok(declaredSlotCount(richest.plan) >= 2);
  });

  void it("fails when the checker drops a slot the plan declares", async () => {
    await assert.rejects(
      checkCarried({
        definition: richest.definition,
        plan: withCarriedSlots(
          richest.plan,
          carriedSlots(richest.plan).slice(1),
        ),
      }),
      (error: unknown) =>
        error instanceof Error && /未携带 plan 声明的槽位/u.test(error.message),
    );
  });

  void it("fails when the checker carries a position the plan does not declare", async () => {
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
    await assert.rejects(
      checkCarried({
        definition: pointerCarrier.definition,
        plan: withCarriedSlots(pointerCarrier.plan, mutated),
      }),
      (error: unknown) =>
        error instanceof Error &&
        /携带了 plan 未声明的槽位/u.test(error.message),
    );
  });

  void it("fails when the projection has no checker script at all", async () => {
    await assert.rejects(
      checkCarried({
        definition: richest.definition,
        plan: withoutChecker(richest.plan),
      }),
      (error: unknown) =>
        error instanceof Error &&
        /真实投影缺少生成仓库工具链槽位清单/u.test(error.message),
    );
  });

  void it("fails when the checker receives invalid JSON manifest data", async () => {
    await assert.rejects(
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
      (error: unknown) => error instanceof SyntaxError,
    );
  });

  void it("fails when a carried slot location has no known shape", async () => {
    const malformed = carriedSlots(pointerCarrier.plan).map((slot) =>
      slot.location.kind === "json-pointer"
        ? { ...slot, location: { kind: "regex", pattern: "NODE_VERSION" } }
        : slot,
    );
    await assert.rejects(
      checkCarried({
        definition: pointerCarrier.definition,
        plan: withCarriedSlots(pointerCarrier.plan, malformed),
      }),
      (error: unknown) =>
        error instanceof Error && /location 形制非法/u.test(error.message),
    );
  });

  void it("restores passing after reverting a carried manifest mutation", async () => {
    const carried = carriedSlots(richest.plan);
    await assert.rejects(
      checkCarried({
        definition: richest.definition,
        plan: withCarriedSlots(richest.plan, carried.slice(1)),
      }),
      (error: unknown) =>
        error instanceof Error && /未携带 plan 声明的槽位/u.test(error.message),
    );
    assert.strictEqual(await checkCarried(richest), undefined);
  });
});

void describe("最终投影的外部依赖目录归属", () => {
  const catalogPlan = () => {
    for (const definition of builtInPresetRegistry.all()) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: "generated-repository/catalog-policy",
          toolchain,
        }),
      });
      if (
        plan.packageContributions.some(
          (contribution) =>
            contribution.referenceBindings?.[
              "@ykdz/reference-typescript-config"
            ] !== undefined,
        )
      ) {
        return plan;
      }
    }
    throw new Error("Expected a TypeScript configuration package consumer");
  };

  void it("拒绝最终链接合并写入的外部版本并报告完整位置", async () => {
    const plan = catalogPlan();
    await assert.rejects(
      validatePlanDependencyCatalog({
        ...plan,
        operations: [
          ...plan.operations,
          {
            kind: "mergeJson",
            to: "package.json",
            value: { optionalDependencies: { rogue: "^1.0.0" } },
          },
        ],
      }),
      (error: unknown) =>
        error instanceof Error &&
        /package\.json.*optionalDependencies.*rogue.*\^1\.0\.0/.test(
          error.message,
        ),
    );
  });
  for (const [field, specifier] of [
    ["dependencies", "1.0.0"],
    ["devDependencies", "latest"],
    ["optionalDependencies", "https://example.com/rogue.tgz"],
    ["peerDependencies", ">=1 <2"],
    ["dependencies", "workspace:*"],
    ["devDependencies", "link:../typescript-config"],
    ["dependencies", "catalog:other"],
    ["dependencies", "catalog:"],
  ] as const) {
    void it(`拒绝 ${field} 中没有有效默认目录的声明 ${specifier}`, async () => {
      const plan = catalogPlan();
      await assert.rejects(
        validatePlanDependencyCatalog({
          ...plan,
          operations: [
            ...plan.operations,
            {
              kind: "mergeJson",
              to: "package.json",
              value: { [field]: { rogue: specifier } },
            },
          ],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `package.json ${field} rogue ${JSON.stringify(specifier)}`,
          ),
      );
    });
  }

  void it("保留 catalog 别名以及真实内部配置链接", async () => {
    const plan = catalogPlan();
    assert.strictEqual(await validatePlanDependencyCatalog(plan), undefined);
  });

  void it("拒绝真实引用所需目录条目被后续投影移除", async () => {
    const plan = catalogPlan();
    await assert.rejects(
      validatePlanDependencyCatalog({
        ...plan,
        operations: [
          ...plan.operations.filter(
            (operation) =>
              !("to" in operation && operation.to === "pnpm-workspace.yaml"),
          ),
          {
            kind: "writeText",
            to: "pnpm-workspace.yaml",
            text: "packages: []\ncatalog: {}\n",
          },
        ],
      }),
      (error: unknown) =>
        error instanceof Error &&
        /package\.json.*(?:dependencies|devDependencies).*catalog:/.test(
          error.message,
        ),
    );
  });

  void it("拒绝内部配置包身份正确而链接目标错误", async () => {
    const plan = catalogPlan();
    const consumer = plan.packageContributions.find(
      (item) =>
        item.referenceBindings?.["@ykdz/reference-typescript-config"] !==
        undefined,
    )!;
    const configuration = plan.blueprint.packages.find(
      (item) => item.path === "packages/typescript-config",
    )!;
    await assert.rejects(
      validatePlanDependencyCatalog({
        ...plan,
        operations: [
          ...plan.operations,
          {
            kind: "mergeJson",
            to: `${consumer.definition.path}/package.json`,
            value: {
              devDependencies: { [configuration.name]: "link:../unrelated" },
            },
          },
        ],
      }),
      configuration.name,
    );
  });

  void it("真实新增包保留消费者清单中的无关手动版本", async () => {
    const scenario = deriveFocusedProjectLinkScenarios()[0]!;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-catalog-customization-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "consumer"),
      toolchain,
    });
    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: scenario.base,
        context,
      });
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const manifestPath = path.join(
        context.targetDir,
        scenario.linkFrom![0]!,
        "package.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.optionalDependencies = { "consumer-only": "^3.0.0" };
      await writeFile(manifestPath, JSON.stringify(manifest));
      const addition = planGeneratedRepositoryPackageAddition({
        definition: scenario.addition!,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "catalog-provider",
        linkFrom: scenario.linkFrom!,
      });
      assert.strictEqual(
        await validatePlanDependencyCatalog(addition),
        undefined,
      );
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(
        JSON.parse(await readFile(manifestPath, "utf8")).optionalDependencies,
        { "consumer-only": "^3.0.0" },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  for (const specifier of ["catalog:other", "^0.0.0"]) {
    void it(`拒绝已有默认目录条目的绕过声明 ${specifier}`, async () => {
      const plan = catalogPlan();
      await assert.rejects(
        validatePlanDependencyCatalog({
          ...plan,
          operations: [
            ...plan.operations,
            {
              kind: "mergeJson",
              to: "package.json",
              value: { devDependencies: { oxfmt: specifier } },
            },
          ],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `package.json devDependencies oxfmt ${JSON.stringify(specifier)}`,
          ),
      );
    });
  }
  void it("目录条目漂移时仍报告依赖清单和字段", async () => {
    const plan = catalogPlan();
    const operations = plan.operations.map((operation) =>
      operation.kind === "writeText" && operation.to === "pnpm-workspace.yaml"
        ? {
            ...operation,
            text: operation.text.replace(/"?oxfmt"?: [^\n]*/u, "oxfmt: latest"),
          }
        : operation,
    );
    await assert.rejects(
      validatePlanDependencyCatalog({ ...plan, operations }),
      (error: unknown) =>
        error instanceof Error &&
        /package\.json devDependencies oxfmt "catalog:"/.test(error.message),
    );
  });
});
