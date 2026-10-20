import { describe, it, mock } from "node:test";

import { contentIdentityKey } from "@ykdz/template-core/content-identity";

import { findFixtureEvidenceArchitectureFindings } from "../src/check-fixture-evidence-architecture.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";
import {
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  access,
  assert,
  checkFixtureEvidenceHealth,
  chmod,
  createBlockedConcurrencyProbe,
  createFixtureEvidenceScheduler,
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  deriveGeneratedRootQualityContractIdentity,
  execa,
  fixtureExecutorTestRunner,
  focusedMarker,
  generatedRootQualityExecutionResources,
  generatedScenariosFor,
  isDeepStrictEqual,
  isolatedFixtureEnvironment,
  materializeFocusedProviderBuild,
  mkdir,
  normalizedFocusedPackageLinkPlan,
  path,
  readFile,
  readdir,
  releaseAfterActive,
  renderMatrixScenario,
  rm,
  runFixtureEvidenceGate,
  runGeneratedRegistryCli,
  runGeneratedScenarioSet,
  runGeneratedScenarioSetProduction,
  temporaryRepository,
  textBelow,
  writeFile,
  writeGeneratedRepositoryTree,
} from "./fixture-evidence.test-support.ts";
import type {
  FixtureEvidenceActivityLedger,
  FixtureEvidenceExecutionResource,
  FixtureEvidenceLifecycleEvent,
  FixtureEvidenceSchedulerFactory,
} from "./fixture-evidence.test-support.ts";

void describe("Fixture Verification Evidence", () => {
  void it("初始化内容树相同也不能将轻层证据复用为完整验收", async () => {
    const root = await temporaryRepository("fixture-canonical-init-");
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    let matrixExecutions = 0;
    try {
      const initialization = await generatedScenariosFor("init");
      const matrixInitialization = (
        await generatedScenariosFor("package-addition-matrix")
      ).filter((scenario) => scenario.addition === undefined);

      assert.deepStrictEqual(
        matrixInitialization.map((scenario) => scenario.id),
        initialization.map((scenario) => scenario.id),
      );
      for (const scenario of initialization) {
        const matrixScenario = matrixInitialization.find(
          (candidate) => candidate.id === scenario.id,
        );
        assert.notStrictEqual(matrixScenario, undefined);
        const rootProjection = await renderMatrixScenario({
          scenario,
          workspace: path.join(root, "root-init"),
        });
        const matrixProjection = await renderMatrixScenario({
          scenario: matrixScenario!,
          workspace: path.join(root, "matrix-init"),
        });
        assert.strictEqual(
          matrixProjection.generatedContentIdentity,
          rootProjection.generatedContentIdentity,
        );
        const rootContract = await deriveGeneratedRootQualityContractIdentity(
          rootProjection.receipt.result,
          { rootGate: "check", includeFix: false },
        );
        const matrixContract = await deriveGeneratedRootQualityContractIdentity(
          matrixProjection.receipt.result,
          { includeFix: true },
        );
        assert.notStrictEqual(matrixContract, rootContract);
        await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: rootProjection.generatedContentIdentity,
          contractIdentity: rootContract,
          scenario: {
            id: scenario.id,
            label: scenario.label,
            presetIdentities: [contentIdentityKey(scenario.base.identity)],
          },
          producerCommit: "same-run",
          storage,
          writeEnabled: true,
          execute: async () => undefined,
        });
        const matrixExecutor = mock.fn<() => Promise<void>>(
          async () => undefined,
        );
        const matrixResult = await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: matrixProjection.generatedContentIdentity,
          contractIdentity: matrixContract,
          scenario: {
            id: matrixScenario!.id,
            label: matrixScenario!.label,
            presetIdentities: [
              contentIdentityKey(matrixScenario!.base.identity),
            ],
          },
          producerCommit: "same-run",
          storage,
          writeEnabled: true,
          execute: matrixExecutor,
        });
        assert.strictEqual(matrixResult.status, "executed");
        assert.strictEqual(matrixExecutor.mock.callCount(), 1);
        matrixExecutions += 1;
      }
      assert.strictEqual(matrixExecutions, initialization.length);
      assert.strictEqual(matrixExecutions, 6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("continues semantic execution when the current-run activity ledger has I/O failure", async () => {
    const workspace = await temporaryRepository("fixture-activity-io-");
    const brokenLedger: FixtureEvidenceActivityLedger = {
      invocation: () => ({
        record: async () => {
          throw new Error("activity disk is read-only");
        },
      }),
      read: async () => {
        throw new Error("activity disk is read-only");
      },
    };
    let rootChecks = 0;
    try {
      await runGeneratedScenarioSet("init", {
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (
            command === "node" &&
            args[1] === "scripts/task-gates.ts" &&
            args[2] === "check"
          ) {
            rootChecks += 1;
          }
          return {};
        },
        evidence: {
          readEnabled: false,
          writeEnabled: false,
          activity: {
            ledger: brokenLedger,
            runId: "activity-io-run",
            runAttempt: "1",
          },
        },
      });

      assert.strictEqual(
        rootChecks,
        (await generatedScenariosFor("init")).length,
      );
      const health = await checkFixtureEvidenceHealth({
        ledger: brokenLedger,
        runId: "activity-io-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(health.healthy, false);
      assert.strictEqual(health.failures.length, 1);
      assert.strictEqual(health.failures[0]?.code, "activity-io-error");
      assert.ok(
        health.failures[0]?.detail.includes("activity disk is read-only"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("records initialization participation through the real scenario-set invocation", async () => {
    const root = await temporaryRepository("fixture-init-health-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    try {
      await runGeneratedScenarioSet("init", {
        workspace: path.join(root, "workspace"),
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          return {};
        },
        evidence: {
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: true,
          activity: {
            ledger,
            runId: "initialization-health",
            runAttempt: "1",
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("init")).length;
      const health = await checkFixtureEvidenceHealth({
        ledger,
        runId: "initialization-health",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(health.healthy, true);
      assert.strictEqual(health.stages.length, 1);
      assert.partialDeepStrictEqual(health.stages[0], {
        scenarioSet: "init",
        invocations: 1,
        scenarios: scenarioCount,
        misses: { absent: scenarioCount },
        executions: scenarioCount,
        issuances: scenarioCount,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it(
    "keeps a complete warm run healthy without invoking any expensive executor",
    { timeout: 240_000 },
    async () => {
      const root = await temporaryRepository("fixture-complete-health-");
      const evidenceRoot = path.join(root, "evidence");
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const sets = [
        "init",
        "package-addition-matrix",
        "focused",
        "deployment",
        "capabilities",
      ] as const;
      type Command = {
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string;
      };
      const createRunner =
        (commands: Command[]) =>
        async (
          command: string,
          args: readonly string[],
          options: { readonly cwd: string; readonly stdio?: "inherit" },
        ): Promise<unknown> => {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force")
          ) {
            await materializeFocusedProviderBuild(options.cwd);
          }
          if (command === "node" && args[1] !== "scripts/task-gates.ts") {
            return {
              stdout: await focusedMarker(
                path.dirname(path.dirname(options.cwd)),
              ),
            };
          }
          return {};
        };
      const coldCommands: Command[] = [];
      const warmCommands: Command[] = [];
      const runComplete = async (
        runId: string,
        workspace: string,
        commands: Command[],
      ) => {
        for (const set of sets) {
          await runGeneratedScenarioSet(set, {
            workspace: path.join(workspace, set),
            run: createRunner(commands),
            scheduling: { concurrency: 4 },
            evidence: {
              storage,
              clock: () => new Date("2026-07-28T00:00:00.000Z"),
              writeEnabled: true,
              activity: { ledger, runId, runAttempt: "1" },
            },
          });
        }
      };
      try {
        await runComplete(
          "complete-cold",
          path.join(root, "cold"),
          coldCommands,
        );
        const coldHealth = await checkFixtureEvidenceHealth({
          ledger,
          runId: "complete-cold",
          runAttempt: "1",
          enabledScenarioSets: sets,
        });
        assert.strictEqual(coldHealth.healthy, true);
        assert.ok(
          coldHealth.stages.some(
            (stage) =>
              stage.scenarioSet === "package-addition-matrix" &&
              stage.scenarios === 30 &&
              stage.hits === 0 &&
              stage.misses.absent === 30 &&
              stage.executions === 30 &&
              stage.issuances === 30,
          ),
        );
        assert.strictEqual(
          coldHealth.stages.some(
            (stage) =>
              (stage.cacheActivity["buildkit:configured"] ?? 0) > 0 &&
              (stage.cacheActivity["turbo:configured"] ?? 0) > 0,
          ),
          true,
        );
        await runComplete(
          "complete-warm",
          path.join(root, "warm"),
          warmCommands,
        );

        const warmHealth = await checkFixtureEvidenceHealth({
          ledger,
          runId: "complete-warm",
          runAttempt: "1",
          enabledScenarioSets: sets,
        });
        assert.strictEqual(warmHealth.healthy, true);
        assert.deepStrictEqual(
          warmHealth.stages.map(({ scenarioSet }) => scenarioSet),
          sets,
        );
        assert.strictEqual(
          warmHealth.stages.every(
            (stage) =>
              stage.hits > 0 && stage.executions === 0 && stage.issuances === 0,
          ),
          true,
        );
        assert.strictEqual(
          warmHealth.stages.every((stage) =>
            Object.values(stage.cacheActivity).every((count) => count === 0),
          ),
          true,
        );
        assert.deepStrictEqual(
          warmCommands.filter(({ command }) => command !== "git"),
          [],
        );
        assert.strictEqual(
          coldCommands.some(
            ({ command, args }) => command === "pnpm" && args[0] === "install",
          ),
          true,
        );
        assert.strictEqual(
          coldCommands.some(({ command }) => command === "node"),
          true,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("holds Docker capacity for each deployment-capable container session", async () => {
    const workspace = await temporaryRepository(
      "fixture-deployment-session-resources-",
    );
    const acquiredResources: (readonly FixtureEvidenceExecutionResource[])[] =
      [];
    const scheduledResources: (readonly FixtureEvidenceExecutionResource[])[] =
      [];
    const schedulerFactory: FixtureEvidenceSchedulerFactory = () => ({
      acquire: async (resources) => {
        acquiredResources.push(resources);
        return () => undefined;
      },
      run: async (resources, execute) => {
        scheduledResources.push(resources);
        return await execute();
      },
    });
    try {
      await runGeneratedScenarioSet("deployment", {
        workspace,
        schedulerFactory,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (command === "pnpm" && args[0] === "install") {
            await mkdir(path.join(options.cwd, "node_modules"), {
              recursive: true,
            });
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "fixture-created: true\n",
            );
          }
          return {};
        },
      });

      assert.notStrictEqual(acquiredResources.length, 0);
      assert.deepStrictEqual(
        acquiredResources,
        acquiredResources.map(() => [
          "development-container-session",
          "browser",
          "docker",
        ]),
      );
      assert.strictEqual(
        scheduledResources.some((resources) => resources.includes("docker")),
        false,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("serializes ordinary evidence misses when the CLI environment sets concurrency to one", async () => {
    const workspace = await temporaryRepository("fixture-cli-concurrency-");
    const installs = createBlockedConcurrencyProbe();
    try {
      const cli = runGeneratedRegistryCli({
        scenarioSet: "focused",
        environment: { TEMPLATE_FIXTURE_CONCURRENCY: "1" },
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await installs.enter();
          }
          if (
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force")
          ) {
            await materializeFocusedProviderBuild(options.cwd);
          }
          if (command === "node" && args[1] !== "scripts/task-gates.ts") {
            return {
              stdout: await focusedMarker(
                path.dirname(path.dirname(options.cwd)),
              ),
            };
          }
          return {};
        },
      });
      await releaseAfterActive({
        execution: cli,
        probe: installs,
        expected: 1,
      });

      assert.strictEqual(installs.maximum(), 1);
    } finally {
      installs.release();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("defaults the initialization CLI to two concurrent ordinary misses", async () => {
    const workspace = await temporaryRepository(
      "fixture-cli-default-concurrency-",
    );
    const installs = createBlockedConcurrencyProbe();
    try {
      const cli = runGeneratedRegistryCli({
        scenarioSet: "init",
        environment: {},
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await installs.enter();
          }
          return {};
        },
      });
      await releaseAfterActive({
        execution: cli,
        probe: installs,
        expected: Math.min(2, (await generatedScenariosFor("init")).length),
      });

      assert.strictEqual(installs.maximum(), 2);
    } finally {
      installs.release();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("uses a repository-local generated workspace by default", async () => {
    const workspaceRoot = path.join(process.cwd(), ".fixture-workspace");
    const observedProjectDirectories = new Set<string>();

    await runGeneratedRegistryCli({
      scenarioSet: "init",
      environment: isolatedFixtureEnvironment({}),
      run: async (command, args, options) => {
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (command === "node" && args[1] === "scripts/task-gates.ts") {
          observedProjectDirectories.add(options.cwd);
        }
        return {};
      },
    });

    assert.ok(observedProjectDirectories.size > 0);
    for (const directory of observedProjectDirectories) {
      assert.ok(
        directory.includes(
          `${workspaceRoot}${path.sep}template-generated-check-`,
        ),
      );
    }
    assert.strictEqual(await access(workspaceRoot), undefined);
    const ownedWorkspaces = new Set(
      [...observedProjectDirectories].map((directory) =>
        path.dirname(directory),
      ),
    );
    for (const workspace of ownedWorkspaces) {
      await assert.rejects(access(workspace), (error) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
        return true;
      });
    }
  });

  void it("rejects a malformed Development Container session override", async () => {
    await assert.rejects(
      runGeneratedRegistryCli({
        scenarioSet: "init",
        environment: {
          TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS: "0",
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS must be a positive integer",
        ),
    );
  });

  void it("applies the Development Container session environment override", async () => {
    const workspace = await temporaryRepository(
      "fixture-cli-container-session-concurrency-",
    );
    const installs = createBlockedConcurrencyProbe();
    try {
      const cli = runGeneratedRegistryCli({
        scenarioSet: "init",
        environment: {
          TEMPLATE_FIXTURE_CONCURRENCY: "4",
          TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS: "1",
        },
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await installs.enter();
          }
          return {};
        },
      });
      await releaseAfterActive({
        execution: cli,
        probe: installs,
        expected: 1,
      });

      assert.strictEqual(installs.maximum(), 1);
    } finally {
      installs.release();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it(
    "applies CLI ordinary concurrency to every scenario set",
    { timeout: 180_000 },
    async () => {
      const root = await temporaryRepository("fixture-cli-resource-caps-");
      const sets = [
        "init",
        "package-addition-matrix",
        "focused",
        "deployment",
        "capabilities",
      ] as const;
      const maxActiveInstalls = new Map<(typeof sets)[number], number>();
      const expectedMaxActiveInstalls = new Map<
        (typeof sets)[number],
        number
      >();
      try {
        for (const scenarioSet of sets) {
          const installs = createBlockedConcurrencyProbe();
          const cli = runGeneratedRegistryCli({
            scenarioSet,
            environment: {
              TEMPLATE_FIXTURE_CONCURRENCY: "4",
              TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS: "4",
            },
            workspace: path.join(root, scenarioSet),
            reporter: { info: () => undefined },
            run: async (command, args, options) => {
              if (command === "git") {
                return await execa(command, [...args], options);
              }
              if (args[0] === "install") {
                await installs.enter();
              }
              if (
                command === "pnpm" &&
                args.includes("build") &&
                args.includes("--force")
              ) {
                await materializeFocusedProviderBuild(options.cwd);
              }
              if (command === "node" && args[1] !== "scripts/task-gates.ts") {
                return {
                  stdout: await focusedMarker(
                    path.dirname(path.dirname(options.cwd)),
                  ),
                };
              }
              return {};
            },
          });
          const scenarios = await generatedScenariosFor(scenarioSet);
          const renderedScenarios = await Promise.all(
            scenarios.map(
              async (scenario) =>
                await renderMatrixScenario({
                  scenario,
                  workspace: path.join(root, "resource-oracle", scenarioSet),
                }),
            ),
          );
          const browserConstrained = renderedScenarios.filter(({ receipt }) =>
            generatedRootQualityExecutionResources(receipt.result, {
              rootGate:
                scenarioSet === "init" || scenarioSet === "focused"
                  ? "check"
                  : "check:full",
            }).includes("browser"),
          ).length;
          const ordinaryOnly = scenarios.length - browserConstrained;
          const expected =
            scenarioSet === "deployment"
              ? 1
              : Math.min(4, ordinaryOnly + Math.min(browserConstrained, 1));
          expectedMaxActiveInstalls.set(scenarioSet, expected);
          let observationFailure: unknown;
          try {
            await Promise.race([
              installs.whenActive(expected),
              cli.then(() => {
                throw new Error(
                  `Scenario set ${scenarioSet} completed before reaching ${expected} active installs`,
                );
              }),
            ]);
          } catch (error) {
            observationFailure = error;
          } finally {
            installs.release();
          }
          await cli;
          if (observationFailure !== undefined) throw observationFailure;
          maxActiveInstalls.set(scenarioSet, installs.maximum());
        }

        assert.deepStrictEqual(maxActiveInstalls, expectedMaxActiveInstalls);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("derives the Focused contract from actual blueprint intents and manifests", async () => {
    const workspace = await temporaryRepository("fixture-focused-contract-");
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const input = await deriveFocusedPackageLinkPlanInput({
        receipt: rendered.receipt,
        consumerPackagePaths: rendered.receipt.linkFrom,
      });

      const normalized = normalizedFocusedPackageLinkPlan(input);
      assert.partialDeepStrictEqual(normalized, {
        gate: "focused-package-link",
        consumer: { path: input.consumer.path },
        provider: { path: input.provider.path },
        intent: {
          consumerPackagePath: input.consumer.path,
          providerPackagePath: input.provider.path,
        },
      });
      assert.ok(
        typeof normalized === "object" &&
          normalized !== null &&
          !Array.isArray(normalized),
      );
      const normalizedRecord = normalized as Record<string, unknown>;
      const consumer = normalizedRecord.consumer;
      const provider = normalizedRecord.provider;
      assert.ok(
        typeof consumer === "object" &&
          consumer !== null &&
          !Array.isArray(consumer),
      );
      assert.ok(
        typeof provider === "object" &&
          provider !== null &&
          !Array.isArray(provider),
      );
      const consumerRecord = consumer as Record<string, unknown>;
      const providerRecord = provider as Record<string, unknown>;
      assert.ok(Object.hasOwn(consumerRecord, "name"));
      assert.strictEqual(typeof consumerRecord.name, "string");
      assert.ok(Object.hasOwn(consumerRecord, "role"));
      assert.strictEqual(typeof consumerRecord.role, "string");
      assert.ok(Object.hasOwn(providerRecord, "name"));
      assert.strictEqual(typeof providerRecord.name, "string");
      assert.ok(Object.hasOwn(providerRecord, "role"));
      assert.strictEqual(typeof providerRecord.role, "string");
      assert.match(
        await deriveFocusedPackageLinkContractIdentity(input),
        /^[0-9a-f]{64}$/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("selects the newly added provider from the actual final Package Link Intent", async () => {
    const workspace = await temporaryRepository(
      "fixture-focused-provider-intent-",
    );
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const input = await deriveFocusedPackageLinkPlanInput({
        receipt: rendered.receipt,
        consumerPackagePaths: rendered.receipt.linkFrom,
      });
      assert.ok(
        rendered.receipt.result.blueprint.packages.some(
          (definition) => definition.path === input.provider.path,
        ),
      );
      assert.ok(
        !rendered.receipt.initialization.blueprint.packages.some(
          (definition) => definition.path === input.provider.path,
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("reruns production initialization on a warm invocation without installing or executing Root Quality", async () => {
    const root = await temporaryRepository("fixture-init-evidence-");
    const evidenceRoot = path.join(root, "evidence");
    const firstWorkspace = path.join(root, "cold");
    const secondWorkspace = path.join(root, "warm");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");

    const createRunner =
      (
        commands: Array<{
          command: string;
          args: readonly string[];
          cwd: string;
        }>,
      ) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (args[0] === "install") {
          await mkdir(path.join(options.cwd, "node_modules"), {
            recursive: true,
          });
          await writeFile(
            path.join(options.cwd, "pnpm-lock.yaml"),
            "fixture-created: true\n",
          );
        }
        return {};
      };

    const coldCommands: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const warmCommands: typeof coldCommands = [];
    const warmOuterCommands: typeof coldCommands = [];
    const coldEvents: FixtureEvidenceLifecycleEvent[] = [];
    const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
    const coldTurboToken = "cold-turbo-token-must-not-persist";
    const warmTurboToken = "warm-turbo-token-must-not-persist";
    try {
      await runGeneratedScenarioSet("init", {
        workspace: firstWorkspace,
        containerEnvironment: {
          TURBO_TEAM: "fixture-team",
          TURBO_TOKEN: coldTurboToken,
          TURBO_REMOTE_CACHE_SIGNATURE_KEY: "cold-signature",
          TURBO_REMOTE_CACHE_READ_ONLY: "false",
        },
        run: createRunner(coldCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "cold-producer",
          recordLifecycle: (event) => {
            coldEvents.push(event);
          },
        },
      });
      const warmRunner = fixtureExecutorTestRunner(createRunner(warmCommands));
      await runGeneratedScenarioSetProduction("init", {
        workspace: secondWorkspace,
        containerEnvironment: {
          TURBO_TEAM: "fixture-team",
          TURBO_TOKEN: warmTurboToken,
          TURBO_REMOTE_CACHE_SIGNATURE_KEY: "warm-signature",
          TURBO_REMOTE_CACHE_READ_ONLY: "true",
        },
        run: async (command, args, options) => {
          warmOuterCommands.push({ command, args, cwd: options.cwd });
          return await warmRunner(command, args, options);
        },
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "warm-producer",
          recordLifecycle: (event) => {
            warmEvents.push(event);
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("init")).length;
      assert.strictEqual(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        coldCommands.filter(
          ({ command, args }) =>
            command === "node" &&
            args[1] === "scripts/task-gates.ts" &&
            args[2] === "check",
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        warmCommands.filter(({ command }) => command === "pnpm"),
        [],
      );
      assert.deepStrictEqual(
        new Set(warmCommands.map(({ command }) => command)),
        new Set(["git"]),
      );
      assert.deepStrictEqual(
        warmOuterCommands.filter(({ command }) => command !== "git"),
        [],
      );
      assert.strictEqual(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "add",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        coldEvents.filter(
          (event) => event.type === "issuance" && event.outcome === "issued",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        warmEvents.filter((event) => event.type === "execution"),
        [],
      );
      const persistedText = `${await textBelow(firstWorkspace)}\n${await textBelow(secondWorkspace)}\n${await textBelow(evidenceRoot)}`;
      assert.ok(!persistedText.includes(coldTurboToken));
      assert.ok(!persistedText.includes(warmTurboToken));
      for (const scenario of await generatedScenariosFor("init")) {
        assert.ok(
          (
            await readFile(
              path.join(secondWorkspace, scenario.id, "package.json"),
              "utf8",
            )
          ).includes('"packageManager"'),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("establishes Root Evidence before independent Focused lookup and skips every warm executor", async () => {
    const root = await temporaryRepository("fixture-focused-evidence-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    type Command = {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const focusedMisses = createBlockedConcurrencyProbe();
    const createRunner =
      (commands: Command[]) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (command === "pnpm" && args[0] === "install") {
          await writeFile(
            path.join(options.cwd, "pnpm-lock.yaml"),
            "fixture-created: true\n",
          );
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node" && args[1] !== "scripts/task-gates.ts") {
          const sourceProbe = args.includes("--conditions=source");
          if (sourceProbe) {
            await focusedMisses.enter();
          }
          return {
            stdout: await focusedMarker(
              path.dirname(path.dirname(options.cwd)),
            ),
          };
        }
        return {};
      };
    const coldCommands: Command[] = [];
    const warmCommands: Command[] = [];
    const rootChangedCommands: Command[] = [];
    const rootExpiredCommands: Command[] = [];
    const coldEvents: FixtureEvidenceLifecycleEvent[] = [];
    const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
    const rootChangedEvents: FixtureEvidenceLifecycleEvent[] = [];
    const rootExpiredEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await releaseAfterActive({
        execution: runGeneratedScenarioSet("focused", {
          workspace: path.join(root, "cold"),
          scheduling: { developmentContainerSessions: 2 },
          run: createRunner(coldCommands),
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "cold",
            recordLifecycle: (event) => {
              coldEvents.push(event);
            },
          },
        }),
        probe: focusedMisses,
        expected: 2,
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "warm"),
        run: createRunner(warmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "warm",
          recordLifecycle: (event) => {
            warmEvents.push(event);
          },
        },
      });
      await rm(path.join(evidenceRoot, "generated-root-quality"), {
        recursive: true,
        force: true,
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "root-changed"),
        run: createRunner(rootChangedCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "root-changed",
          recordLifecycle: (event) => {
            rootChangedEvents.push(event);
          },
        },
      });
      const rootEvidenceDirectory = path.join(
        evidenceRoot,
        "generated-root-quality",
      );
      for (const recordName of await readdir(rootEvidenceDirectory)) {
        const recordPath = path.join(rootEvidenceDirectory, recordName);
        const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
          string,
          unknown
        >;
        await writeFile(
          recordPath,
          `${JSON.stringify({
            ...record,
            issuedAt: "2026-07-01T00:00:00.000Z",
          })}\n`,
        );
      }
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "root-expired"),
        run: createRunner(rootExpiredCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "root-expired",
          recordLifecycle: (event) => {
            rootExpiredEvents.push(event);
          },
        },
      });

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      assert.strictEqual(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "generated-root-quality",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(focusedMisses.maximum(), 2);
      assert.strictEqual(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "focused-package-link",
        ).length,
        scenarioCount,
      );
      for (const command of coldCommands.filter(
        ({ command, args }) =>
          command === "node" &&
          args[1] !== "scripts/task-gates.ts" &&
          args.includes("--conditions=source"),
      )) {
        const projectDir = path.dirname(path.dirname(command.cwd));
        const scenarioCommands = coldCommands.filter(({ cwd }) =>
          cwd.startsWith(projectDir),
        );
        assert.ok(
          scenarioCommands.findIndex(
            ({ command: name, args }) =>
              name === "node" &&
              args[1] === "scripts/task-gates.ts" &&
              args[2] === "check",
          ) < scenarioCommands.indexOf(command),
        );
      }

      assert.deepStrictEqual(
        warmCommands.filter(({ command }) => command !== "git"),
        [],
      );
      assert.strictEqual(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ).length,
        scenarioCount * 2,
      );
      assert.deepStrictEqual(
        warmEvents.filter((event) => event.type === "execution"),
        [],
      );
      assert.strictEqual(
        rootChangedCommands.filter(
          ({ command, args }) =>
            command === "node" &&
            args[1] === "scripts/task-gates.ts" &&
            args[2] === "check",
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        rootChangedCommands.filter(
          ({ command, args }) =>
            command === "node" && args[1] !== "scripts/task-gates.ts",
        ),
        [],
      );
      assert.strictEqual(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "succeeded",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        rootChangedEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" && event.gate === "focused-package-link",
        ),
        [],
      );
      assert.strictEqual(
        rootExpiredCommands.filter(
          ({ command, args }) =>
            command === "node" &&
            args[1] === "scripts/task-gates.ts" &&
            args[2] === "check",
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        rootExpiredCommands.filter(
          ({ command, args }) =>
            command === "node" && args[1] !== "scripts/task-gates.ts",
        ),
        [],
      );
      assert.strictEqual(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "miss" &&
            event.reason === "stale",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ).length,
        scenarioCount,
      );
    } finally {
      focusedMisses.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("prepares dependencies when Root evidence hits and Focused evidence misses in a new workspace", async () => {
    const root = await temporaryRepository("fixture-focused-partial-warm-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    type Command = {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const createRunner =
      (commands: Command[]) =>
      async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly stdio?: "inherit" },
      ): Promise<unknown> => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          return await execa(command, [...args], options);
        }
        if (command === "pnpm" && args[0] === "install") {
          await mkdir(path.join(options.cwd, "node_modules"), {
            recursive: true,
          });
          return {};
        }
        if (command === "pnpm" || command === "node") {
          const dependencyRoot =
            command === "node" && args[1] !== "scripts/task-gates.ts"
              ? path.dirname(path.dirname(options.cwd))
              : options.cwd;
          try {
            await access(path.join(dependencyRoot, "node_modules"));
          } catch {
            throw new Error(
              `node_modules missing before ${command} ${args.join(" ")}`,
            );
          }
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node" && args[1] !== "scripts/task-gates.ts") {
          return {
            stdout: await focusedMarker(
              path.dirname(path.dirname(options.cwd)),
            ),
          };
        }
        return {};
      };
    const coldCommands: Command[] = [];
    const partialWarmCommands: Command[] = [];
    const completeWarmCommands: Command[] = [];
    const partialWarmEvents: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "cold"),
        run: createRunner(coldCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "cold",
        },
      });
      await rm(path.join(evidenceRoot, "focused-package-link"), {
        recursive: true,
        force: true,
      });

      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "partial-warm"),
        run: createRunner(partialWarmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "partial-warm",
          recordLifecycle: (event) => {
            partialWarmEvents.push(event);
          },
        },
      });
      await runGeneratedScenarioSet("focused", {
        workspace: path.join(root, "complete-warm"),
        run: createRunner(completeWarmCommands),
        evidence: {
          storage,
          clock,
          writeEnabled: true,
          producerCommit: "complete-warm",
        },
      });

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      assert.strictEqual(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "hit",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "miss",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        partialWarmCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force"),
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "node" &&
            args[1] !== "scripts/task-gates.ts" &&
            args.includes("--conditions=source"),
        ).length,
        scenarioCount,
      );
      assert.deepStrictEqual(
        completeWarmCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            (args[0] === "install" || args.includes("build")),
        ),
        [],
      );
      assert.deepStrictEqual(
        completeWarmCommands.filter(({ command }) => command === "node"),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("never looks up Focused evidence when the current Root prerequisite fails", async () => {
    const root = await temporaryRepository("fixture-focused-root-failure-");
    const fileStorage = new FileFixtureEvidenceStorage(
      path.join(root, "evidence"),
    );
    const reads: string[] = [];
    const events: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await assert.rejects(
        runGeneratedScenarioSet("focused", {
          workspace: path.join(root, "workspace"),
          run: async (command, args, options) => {
            if (command === "git") {
              return await execa(command, [...args], options);
            }
            if (
              command === "node" &&
              args[1] === "scripts/task-gates.ts" &&
              args[2] === "check"
            ) {
              throw new Error("Root Quality failed");
            }
            return {};
          },
          evidence: {
            storage: {
              read: async (gate, identity) => {
                reads.push(gate);
                return await fileStorage.read(gate, identity);
              },
              writeAtomically: fileStorage.writeAtomically.bind(fileStorage),
            },
            writeEnabled: true,
            recordLifecycle: (event) => {
              events.push(event);
            },
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("Root Quality failed"),
      );

      const scenarioCount = (await generatedScenariosFor("focused")).length;
      assert.strictEqual(
        events.filter(
          (event) =>
            event.type === "execution" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "failed",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(reads.length, scenarioCount);
      assert.deepStrictEqual(
        new Set(reads),
        new Set(["generated-root-quality"]),
      );
      assert.deepStrictEqual(
        events.filter((event) => event.gate === "focused-package-link"),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it(
    "reconciles the complete Package Addition Matrix before warm Root Quality lookup",
    { timeout: 180_000 },
    async () => {
      const root = await temporaryRepository("fixture-matrix-evidence-");
      const evidenceRoot = path.join(root, "evidence");
      const firstWorkspace = path.join(root, "cold");
      const secondWorkspace = path.join(root, "warm");
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const clock = () => new Date("2026-07-28T00:00:00.000Z");
      const gitSubcommand = (args: readonly string[]) =>
        args[0] === "-c" && args[1]?.startsWith("safe.directory=")
          ? args[2]
          : args[0];

      const createRunner =
        (
          commands: Array<{
            command: string;
            args: readonly string[];
            cwd: string;
          }>,
        ) =>
        async (
          command: string,
          args: readonly string[],
          options: { readonly cwd: string; readonly stdio?: "inherit" },
        ): Promise<unknown> => {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            await mkdir(path.join(options.cwd, "node_modules"), {
              recursive: true,
            });
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "fixture-created: true\n",
            );
          }
          return {};
        };

      const coldCommands: Array<{
        command: string;
        args: readonly string[];
        cwd: string;
      }> = [];
      const warmCommands: typeof coldCommands = [];
      const warmEvents: FixtureEvidenceLifecycleEvent[] = [];
      try {
        await runGeneratedScenarioSet("package-addition-matrix", {
          workspace: firstWorkspace,
          run: createRunner(coldCommands),
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "cold-producer",
          },
        });
        const invalidRecordPath = path.join(
          evidenceRoot,
          "generated-root-quality",
          "invalid.json",
        );
        await writeFile(invalidRecordPath, '{"schema":');
        await runGeneratedScenarioSet("package-addition-matrix", {
          workspace: secondWorkspace,
          run: createRunner(warmCommands),
          evidence: {
            storage,
            clock,
            writeEnabled: true,
            producerCommit: "warm-producer",
            recordLifecycle: (event) => {
              warmEvents.push(event);
            },
          },
        });

        const scenarioCount = (
          await generatedScenariosFor("package-addition-matrix")
        ).length;
        assert.strictEqual(
          coldCommands.filter(
            ({ command, args }) =>
              command === "git" && gitSubcommand(args) === "init",
          ).length,
          scenarioCount,
        );
        assert.strictEqual(
          coldCommands.filter(
            ({ command, args }) =>
              command === "git" && gitSubcommand(args) === "add",
          ).length,
          scenarioCount * 4,
        );
        assert.strictEqual(
          coldCommands.filter(
            ({ command, args }) =>
              command === "node" &&
              args[1] === "scripts/task-gates.ts" &&
              args[2] === "fix",
          ).length,
          scenarioCount,
        );
        const coldInstalls = coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        );
        assert.strictEqual(coldInstalls.length, scenarioCount);
        assert.strictEqual(
          new Set(coldInstalls.map(({ cwd }) => cwd)).size,
          scenarioCount,
        );
        for (const install of coldInstalls) {
          assert.strictEqual(path.dirname(install.cwd), firstWorkspace);
          assert.deepStrictEqual(install.args, [
            "install",
            "--store-dir",
            path.join(firstWorkspace, ".pnpm-store"),
          ]);
          const scenarioCommands = coldCommands.filter(
            ({ cwd }) => cwd === install.cwd,
          );
          assert.ok(
            scenarioCommands.findIndex(
              ({ command, args }) =>
                command === "git" && gitSubcommand(args) === "init",
            ) <
              scenarioCommands.findIndex(
                ({ command, args }) =>
                  command === "git" && gitSubcommand(args) === "add",
              ),
          );
        }
        assert.deepStrictEqual(
          warmCommands.filter(({ command }) => command === "pnpm"),
          [],
        );
        assert.deepStrictEqual(
          new Set(warmCommands.map(({ command }) => command)),
          new Set(["git"]),
        );
        assert.strictEqual(
          warmCommands.filter(
            ({ command, args }) =>
              command === "git" && gitSubcommand(args) === "init",
          ).length,
          scenarioCount,
        );
        assert.strictEqual(
          warmCommands.filter(
            ({ command, args }) =>
              command === "git" && gitSubcommand(args) === "add",
          ).length,
          scenarioCount * 2,
        );
        assert.strictEqual(
          warmCommands.filter(
            ({ command, args }) =>
              command === "git" && gitSubcommand(args) === "write-tree",
          ).length,
          scenarioCount,
        );
        assert.strictEqual(
          warmEvents.filter(
            (event) => event.type === "lookup" && event.outcome === "hit",
          ).length,
          scenarioCount,
        );
        assert.deepStrictEqual(
          warmEvents.filter((event) => event.type === "execution"),
          [],
        );
        await assert.rejects(readFile(invalidRecordPath, "utf8"), (error) => {
          assert.ok(error instanceof Error);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
          return true;
        });
        for (const scenario of await generatedScenariosFor(
          "package-addition-matrix",
        )) {
          const generation = JSON.parse(
            await readFile(
              path.join(
                secondWorkspace,
                scenario.id,
                ".template/generation.json",
              ),
              "utf8",
            ),
          ) as {
            readonly packages: readonly {
              readonly path: string;
              readonly definitionName: string;
            }[];
          };
          assert.ok(
            generation.packages
              .map(({ definitionName }) => definitionName)
              .includes(
                scenario.addition?.identity === undefined
                  ? contentIdentityKey(scenario.base.identity)
                  : contentIdentityKey(scenario.addition.identity),
              ),
          );
          assert.ok(
            (
              await readFile(
                path.join(
                  secondWorkspace,
                  scenario.id,
                  generation.packages.at(-1)!.path,
                  "package.json",
                ),
                "utf8",
              )
            ).includes('"name"'),
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("keeps stale and invalid records untouched in a read-only matrix run", async () => {
    const root = await temporaryRepository("fixture-read-only-matrix-");
    const evidenceRoot = path.join(root, "evidence");
    const workspace = path.join(root, "workspace");
    const fileStorage = new FileFixtureEvidenceStorage(evidenceRoot);
    try {
      const stale = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario: {
          id: "read-only-stale",
          label: "read-only stale",
          presetIdentities: [],
        },
        producerCommit: "seed",
        storage: fileStorage,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
        writeEnabled: true,
        execute: async () => undefined,
      });
      const gateRoot = path.join(evidenceRoot, "generated-root-quality");
      const stalePath = path.join(gateRoot, `${stale.identity}.json`);
      const invalidPath = path.join(gateRoot, "invalid.json");
      await writeFile(invalidPath, '{"schema":');
      const prune = mock.fn<typeof fileStorage.prune>(
        fileStorage.prune.bind(fileStorage),
      );
      const writeAtomically = mock.fn<typeof fileStorage.writeAtomically>(
        fileStorage.writeAtomically.bind(fileStorage),
      );

      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          return {};
        },
        evidence: {
          storage: {
            read: fileStorage.read.bind(fileStorage),
            writeAtomically,
            prune,
          },
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          writeEnabled: false,
          producerCommit: "read-only",
        },
      });

      assert.strictEqual(prune.mock.callCount(), 0);
      assert.strictEqual(writeAtomically.mock.callCount(), 0);
      assert.ok((await readFile(stalePath, "utf8")).includes(stale.identity));
      assert.strictEqual(await readFile(invalidPath, "utf8"), '{"schema":');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("schedules real matrix misses by final Environment Needs", async () => {
    const workspace = await temporaryRepository("fixture-matrix-scheduling-");
    const installedScenarios: string[] = [];
    const acquiredLeases: (readonly FixtureEvidenceExecutionResource[])[] = [];
    const scheduledRuns: (readonly FixtureEvidenceExecutionResource[])[] = [];
    const needsByScenario = new Map<
      string,
      {
        readonly check: readonly { readonly kind?: string }[];
        readonly deployment: readonly { readonly kind?: string }[];
      }
    >();
    const ordinaryScenarios = new Set<string>();
    const browserScenarios = new Set<string>();
    const schedulerFactory = mock.fn<FixtureEvidenceSchedulerFactory>(
      (scheduling) => {
        const scheduler = createFixtureEvidenceScheduler(scheduling);
        return {
          acquire: async (resources) => {
            acquiredLeases.push(resources);
            return await scheduler.acquire(resources);
          },
          run: async (resources, execute) => {
            scheduledRuns.push(resources);
            return await scheduler.run(resources, execute);
          },
        };
      },
    );
    try {
      await runGeneratedScenarioSet("package-addition-matrix", {
        workspace,
        scheduling: { concurrency: 4 },
        schedulerFactory,
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args[0] === "install") {
            const environmentNeeds = JSON.parse(
              await readFile(
                path.join(options.cwd, ".template/environment-needs.json"),
                "utf8",
              ),
            ) as {
              readonly check: readonly { readonly kind?: string }[];
              readonly deployment: readonly { readonly kind?: string }[];
            };
            const browser = environmentNeeds.check.some(
              (need) => need.kind === "playwright-browser-assets",
            );
            const scenarioId = path.basename(options.cwd);
            installedScenarios.push(scenarioId);
            needsByScenario.set(scenarioId, environmentNeeds);
            if (browser) {
              browserScenarios.add(scenarioId);
            } else {
              ordinaryScenarios.add(scenarioId);
            }
          }
          return {};
        },
      });

      const scenarios = await generatedScenariosFor("package-addition-matrix");
      const scenarioIds = scenarios.map(({ id }) => id).sort();
      assert.strictEqual(schedulerFactory.mock.callCount(), 1);
      assert.ok(
        schedulerFactory.mock.calls.some(({ arguments: actualArguments }) =>
          isDeepStrictEqual(actualArguments, [{ concurrency: 4 }]),
        ),
      );
      assert.strictEqual(scheduledRuns.length, scenarios.length);
      assert.deepStrictEqual(
        scheduledRuns,
        Array.from({ length: scenarios.length }, () => []),
      );
      assert.deepStrictEqual(installedScenarios.sort(), scenarioIds);
      assert.strictEqual(needsByScenario.size, scenarios.length);
      assert.ok(ordinaryScenarios.size >= 2);
      assert.ok(browserScenarios.size >= 2);
      const resourceSignature = (
        resources: readonly FixtureEvidenceExecutionResource[],
      ) => [...resources].toSorted().join(",");
      assert.deepStrictEqual(
        acquiredLeases.map(resourceSignature).toSorted(),
        scenarios
          .map((scenario) => {
            const finalNeeds = needsByScenario.get(scenario.id);
            assert.notStrictEqual(finalNeeds, undefined);
            const resources: readonly FixtureEvidenceExecutionResource[] = [
              "development-container-session",
              ...(finalNeeds!.deployment.some(
                (need) => need.kind === "docker-engine",
              )
                ? ["docker" as const]
                : []),
              ...(finalNeeds!.check.some(
                (need) => need.kind === "playwright-browser-assets",
              )
                ? ["browser" as const]
                : []),
            ];
            return resources;
          })
          .map(resourceSignature)
          .toSorted(),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it(
    "invalidates only final matrix states changed by a Preset-local addition output",
    { timeout: 450_000 },
    async () => {
      const root = await temporaryRepository("fixture-matrix-invalidation-");
      const evidenceRoot = path.join(root, "evidence");
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const clock = () => new Date("2026-07-28T00:00:00.000Z");

      try {
        const scenarios = await generatedScenariosFor(
          "package-addition-matrix",
        );
        const candidate = scenarios.find(
          (scenario) => scenario.addition !== undefined,
        );
        assert.ok(candidate?.addition !== undefined);
        const selectedAddition = candidate.addition;

        const baseline = new Map<
          string,
          {
            readonly generatedContentIdentity: string;
            readonly contractIdentity: string;
          }
        >();
        for (const scenario of scenarios) {
          const rendered = await renderMatrixScenario({
            scenario,
            workspace: path.join(root, "cold"),
          });
          const contractIdentity =
            await deriveGeneratedRootQualityContractIdentity(
              rendered.receipt.result,
              {
                includeFix: true,
              },
            );
          baseline.set(scenario.id, {
            generatedContentIdentity: rendered.generatedContentIdentity,
            contractIdentity,
          });
          await runFixtureEvidenceGate({
            gate: "generated-root-quality",
            generatedContentIdentity: rendered.generatedContentIdentity,
            contractIdentity,
            scenario: {
              id: scenario.id,
              label: scenario.label,
              presetIdentities: [
                contentIdentityKey(scenario.base.identity),
                ...(scenario.addition === undefined
                  ? []
                  : [contentIdentityKey(scenario.addition.identity)]),
              ],
            },
            producerCommit: "cold-producer",
            storage,
            clock,
            writeEnabled: true,
            execute: async () => undefined,
          });
        }

        await writeFile(
          path.join(root, "unrelated-documentation.md"),
          "does not belong to any Generated Repository\n",
        );
        for (const scenario of scenarios) {
          const rendered = await renderMatrixScenario({
            scenario,
            workspace: path.join(root, "documentation-change"),
          });
          const previous = baseline.get(scenario.id)!;
          assert.strictEqual(
            rendered.generatedContentIdentity,
            previous.generatedContentIdentity,
          );
          assert.partialDeepStrictEqual(
            await runFixtureEvidenceGate({
              gate: "generated-root-quality",
              generatedContentIdentity: rendered.generatedContentIdentity,
              contractIdentity: previous.contractIdentity,
              scenario: {
                id: scenario.id,
                label: scenario.label,
                presetIdentities: [],
              },
              producerCommit: "documentation-change",
              storage,
              clock,
              writeEnabled: false,
              execute: async () => {
                throw new Error("unrelated documentation must remain a hit");
              },
            }),
            { status: "hit" },
          );
        }

        const changedTrees: string[] = [];
        const executions: string[] = [];
        const hits: string[] = [];
        for (const scenario of scenarios) {
          const usesChangedAddition = scenario.addition === selectedAddition;
          const rendered = await renderMatrixScenario({
            scenario,
            workspace: path.join(root, "preset-local-change"),
          });
          if (usesChangedAddition) {
            await writeFile(
              path.join(
                rendered.receipt.projectDir,
                "fixture-evidence-change.txt",
              ),
              "Generated content changed for fixture evidence\n",
            );
          }
          const generatedContentIdentity = usesChangedAddition
            ? await writeGeneratedRepositoryTree({
                repositoryRoot: rendered.receipt.projectDir,
              })
            : rendered.generatedContentIdentity;
          const previous = baseline.get(scenario.id)!;
          if (generatedContentIdentity !== previous.generatedContentIdentity) {
            changedTrees.push(scenario.id);
          }
          const result = await runFixtureEvidenceGate({
            gate: "generated-root-quality",
            generatedContentIdentity,
            contractIdentity: await deriveGeneratedRootQualityContractIdentity(
              rendered.receipt.result,
              {
                includeFix: true,
              },
            ),
            scenario: {
              id: scenario.id,
              label: scenario.label,
              presetIdentities: [],
            },
            producerCommit: "preset-local-change",
            storage,
            clock,
            writeEnabled: false,
            execute: async () => {
              executions.push(scenario.id);
            },
          });
          if (result.status === "hit") hits.push(scenario.id);
        }
        const affectedScenarioIds = scenarios
          .filter((scenario) => scenario.addition === selectedAddition)
          .map((scenario) => scenario.id);
        const unaffectedScenarioIds = scenarios
          .filter((scenario) => scenario.addition !== selectedAddition)
          .map((scenario) => scenario.id);
        assert.deepStrictEqual(changedTrees, affectedScenarioIds);
        assert.deepStrictEqual(executions, affectedScenarioIds);
        assert.deepStrictEqual(hits, unaffectedScenarioIds);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("checks copied bytes against the actual projection source handle", async () => {
    const root = await temporaryRepository("fixture-source-handle-");
    try {
      const scenario = (
        await generatedScenariosFor("package-addition-matrix")
      ).find((candidate) => candidate.addition !== undefined);
      assert.ok(scenario?.addition !== undefined);
      const rendered = await renderMatrixScenario({
        scenario,
        workspace: path.join(root, "generated"),
      });
      const copy = rendered.receipt.result.projection.operations.find(
        (operation) =>
          operation.kind === "copyFile" && operation.to.endsWith(".ts"),
      );
      assert.ok(copy?.kind === "copyFile");
      const original = await readFile(
        sourceGeneratedScenarioRuntime.resolveTemplateSource(
          copy.source,
          copy.from,
        ),
      );
      assert.deepEqual(
        await readFile(path.join(rendered.receipt.projectDir, copy.to)),
        original,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it(
    "五种源码 CLI 场景集命中有效证据后跳过昂贵命令",
    { timeout: 180000 },
    async () => {
      const root = await temporaryRepository("fixture-evidence-cli-");
      const evidenceRoot = path.join(root, "evidence");
      const activityRoot = path.join(root, "activity");
      const binRoot = path.join(root, "bin");
      const commandLog = path.join(root, "expensive-commands.jsonl");
      const pnpmPath = path.join(binRoot, "pnpm");
      const nodePath = path.join(binRoot, "node");
      const dockerPath = path.join(binRoot, "docker");
      const devcontainerPath = path.join(binRoot, "devcontainer");
      const cliPath = path.join(
        process.cwd(),
        "src/check-generated-registry.ts",
      );
      const healthCliPath = path.join(
        process.cwd(),
        "src/check-fixture-evidence-health.ts",
      );
      try {
        await mkdir(binRoot, { recursive: true });
        await writeFile(
          pnpmPath,
          `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const commandArgs = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["pnpm", ...commandArgs]) + "\\n");

const manifests = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
    } else if (entry.name === "package.json") {
      manifests.push({
        root: path.dirname(entryPath),
        value: JSON.parse(readFileSync(entryPath, "utf8")),
      });
    }
  }
};
visit(process.cwd());

if (commandArgs.includes("build") && commandArgs.includes("--force")) {
  for (const { root, value: manifest } of manifests) {
    const source = manifest.exports?.["."]?.source;
    const target = manifest.exports?.["."]?.default;
    if (typeof source !== "string" || typeof target !== "string") continue;
    const sourcePath = path.resolve(root, source);
    const targetPath = path.resolve(root, target);
    if (!existsSync(sourcePath)) continue;
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}
`,
        );
        await writeFile(
          nodePath,
          `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";

appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["node", ...process.argv.slice(2)]) + "\\n");
if (process.argv[3] === "scripts/task-gates.ts") process.exit(0);
let marker;
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    try {
      marker ??= /focused-provider-marker:[0-9a-f]+/u.exec(readFileSync(entryPath, "utf8"))?.[0];
    } catch {}
  }
};
visit(path.resolve(process.cwd(), "../.."));
if (marker === undefined) throw new Error("focused marker was not materialized");
writeSync(1, marker + "\\n");
`,
        );
        await writeFile(
          dockerPath,
          `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["docker", ...process.argv.slice(2)]) + "\\n");
`,
        );
        await writeFile(
          devcontainerPath,
          `#!${process.execPath}
import { appendFileSync, writeSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(["devcontainer", ...args]) + "\\n");
if (args[0] !== "exec") process.exit(0);

const idLabelIndex = args.indexOf("--id-label");
let commandIndex = idLabelIndex === -1 ? 3 : idLabelIndex + 2;
while (args[commandIndex] === "--remote-env") commandIndex += 2;
let command = args[commandIndex];
let commandArgs = args.slice(commandIndex + 1);
let cwd = process.cwd();
if (command === "sh" && commandArgs[0] === "-c") {
  cwd = path.join(cwd, commandArgs[3]);
  command = commandArgs[4];
  commandArgs = commandArgs.slice(5);
}
const forwards =
  command === "node" ||
  command === "git" ||
  (command === "pnpm" &&
    (["install", "fetch", "run"].includes(commandArgs[0]) ||
      (commandArgs[0] === "exec" && commandArgs[1] === "turbo")));
if (!forwards) process.exit(0);
const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
writeSync(1, result.stdout ?? "");
writeSync(2, result.stderr ?? "");
process.exitCode = result.status ?? 1;
`,
        );
        await Promise.all([
          chmod(pnpmPath, 0o755),
          chmod(nodePath, 0o755),
          chmod(dockerPath, 0o755),
          chmod(devcontainerPath, 0o755),
        ]);

        const baseEnv = isolatedFixtureEnvironment({
          FIXTURE_COMMAND_LOG: commandLog,
          PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
          TEMPLATE_FIXTURE_EVIDENCE_DIR: evidenceRoot,
          TEMPLATE_FIXTURE_EVIDENCE_READ: "1",
          TEMPLATE_FIXTURE_EVIDENCE_WRITE: "1",
          TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR: activityRoot,
          TEMPLATE_FIXTURE_EVIDENCE_RUN_ID: "source-cli-run",
        });
        const sets = [
          "init",
          "package-addition-matrix",
          "focused",
          "deployment",
          "capabilities",
        ] as const;
        const invoke = async (runAttempt: string) => {
          const env = {
            ...baseEnv,
            TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: runAttempt,
          };
          for (const set of sets) {
            await execa(
              process.execPath,
              ["--conditions=source", cliPath, set],
              {
                cwd: process.cwd(),
                env,
              },
            );
          }
        };

        await invoke("1");
        const coldCommands = (await readFile(commandLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as readonly string[]);
        assert.notStrictEqual(
          coldCommands.filter(
            ([binary, command]) => binary === "pnpm" && command === "install",
          ).length,
          0,
        );
        assert.notStrictEqual(
          coldCommands.filter(
            ([binary, condition, script, task]) =>
              binary === "node" &&
              condition === "--conditions=source" &&
              script === "scripts/task-gates.ts" &&
              task === "check:full",
          ).length,
          0,
        );
        assert.strictEqual(
          coldCommands.some(([binary]) => binary === "node"),
          true,
        );
        assert.strictEqual(
          coldCommands.some(([binary]) => binary === "docker"),
          true,
        );
        const containerStarts = coldCommands.filter(
          ([binary, command]) => binary === "devcontainer" && command === "up",
        );
        assert.ok(containerStarts.length > 0);
        for (const command of containerStarts) {
          const cacheFrom = command.indexOf("--cache-from");
          const cacheTo = command.indexOf("--cache-to");
          assert.match(
            command[cacheFrom + 1]!,
            new RegExp(
              `^type=local,src=${path.join(evidenceRoot, "buildkit")}/(?:${sets.join("|")})/[0-9a-f]{64}$`,
              "u",
            ),
          );
          assert.match(
            command[cacheTo + 1]!,
            new RegExp(
              `^type=local,dest=${path.join(evidenceRoot, "buildkit")}/(?:${sets.join("|")})/[0-9a-f]{64},mode=max$`,
              "u",
            ),
          );
        }

        await invoke("2");
        const allCommands = (await readFile(commandLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as readonly string[]);
        assert.deepStrictEqual(allCommands, coldCommands);
        const warmEnv = {
          ...baseEnv,
          TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "2",
        };
        assert.strictEqual(
          (
            await execa(
              process.execPath,
              ["--conditions=source", healthCliPath],
              {
                cwd: process.cwd(),
                env: warmEnv,
              },
            )
          ).exitCode,
          0,
        );
        assert.deepStrictEqual(await readdir(activityRoot), ["activity.jsonl"]);
        await assert.rejects(
          execa(process.execPath, ["--conditions=source", healthCliPath], {
            cwd: process.cwd(),
            env: {
              ...baseEnv,
              TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "3",
            },
          }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(Object.hasOwn(error, "exitCode"));
            assert.strictEqual(Reflect.get(error, "exitCode"), 1);
            assert.ok(Object.hasOwn(error, "stderr"));
            const stderr = Reflect.get(error, "stderr");
            assert.strictEqual(typeof stderr, "string");
            assert.ok(
              (stderr as string).includes(
                "Enabled scenario set init has no current-run activity",
              ),
            );
            return true;
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  void it("structurally enforces gate, kernel, test-source, and orchestrator ownership", async () => {
    const root = await temporaryRepository("fixture-evidence-architecture-");
    try {
      await Promise.all([
        mkdir(path.join(root, "src/fixture-evidence/gates/root-quality"), {
          recursive: true,
        }),
        mkdir(path.join(root, "src/fixture-evidence/gates/focused"), {
          recursive: true,
        }),
        mkdir(path.join(root, "src/fixture-evidence/kernel"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "src/fixture-evidence/gates/root-quality/index.ts"),
          'import "../focused/index.ts";\nimport "../../../outside.ts";\n',
        ),
        writeFile(
          path.join(root, "src/fixture-evidence/gates/focused/index.ts"),
          "export {};\n",
        ),
        writeFile(
          path.join(root, "src/fixture-evidence/kernel/kernel.test.ts"),
          "export {};\n",
        ),
        writeFile(
          path.join(root, "src/fixture-evidence/kernel/index.ts"),
          'import "../gates/root-quality/index.ts";\n',
        ),
        writeFile(
          path.join(root, "src/check-generated-registry.ts"),
          'async function scenario() { await run("node", ["--conditions=source", "scripts/task-gates.ts", "check:full"], { cwd: "." }); await run("node", ["--conditions=source", "probe.mjs"], { cwd: "." }); await run("docker", ["version"], { cwd: "." }); }\n',
        ),
      ]);

      const architectureFindings0 =
        await findFixtureEvidenceArchitectureFindings(root);
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "cross-gate-runtime-import",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "gate-runtime-import-outside-contract",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "kernel-runtime-import-outside-kernel",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "production-test-source",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "hidden-root-quality-command",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "hidden-focused-package-link-command",
        ),
      );
      assert.ok(
        architectureFindings0.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "hidden-deployment-quality-command",
        ),
      );
      assert.deepStrictEqual(
        await findFixtureEvidenceArchitectureFindings(process.cwd()),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
