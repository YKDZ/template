import assert from "node:assert/strict";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
  type BuiltInPresetDefinition,
  type GeneratedRepositoryPlan,
  type PackageContribution,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  createTemplateSourceHandle,
  renderNewProject,
  type RenderOperation,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { findFixtureEvidenceArchitectureFindings } from "../packages/checks/src/check-fixture-evidence-architecture.ts";
import {
  fixtureContainerEnvironmentFromEnvironment,
  fixtureDependencyCachesFromEnvironment,
  generatedScenariosFor,
  runGeneratedRegistryCli as runGeneratedRegistryCliProduction,
  runGeneratedScenarioSet as runGeneratedScenarioSetProduction,
} from "../packages/checks/src/check-generated-registry.ts";
import {
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  executeFocusedPackageLink,
  normalizedFocusedPackageLinkPlan,
} from "../packages/checks/src/fixture-evidence/gates/focused-package-link/index.ts";
import {
  deriveGeneratedRootQualityContractIdentity,
  executeGeneratedRootQuality,
  generatedRootQualityExecutionResources,
} from "../packages/checks/src/fixture-evidence/gates/root-quality/index.ts";
import {
  checkFixtureEvidenceHealth,
  createFixtureEvidenceScheduler,
  deriveFixtureGateContractIdentity,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  formatFixtureEvidenceHealthReport,
  initializeFixtureGitRepository,
  runFixtureEvidenceGate,
  type FixtureCommandRunner,
  type FixtureEvidenceActivityLedger,
  type FixtureEvidenceExecutionResource,
  type FixtureEvidenceGate,
  type FixtureEvidenceInvocationEvent,
  type FixtureEvidenceLifecycleEvent,
  type FixtureEvidencePhase,
  type FixtureEvidencePhaseScope,
  type FixtureEvidenceScenarioDiagnostics,
  type FixtureEvidenceSchedulerFactory,
  type FixtureEvidenceStorage,
  writeGeneratedRepositoryTree,
} from "../packages/checks/src/fixture-evidence/kernel/index.ts";
import {
  validatePlanDependencyCatalog,
  validatePlanSources,
} from "../packages/checks/src/registry-checks.ts";
import {
  any,
  arrayContaining,
  assertContainsEqual,
  assertDeepStrictEqualWithMatchers,
  assertLength,
  assertMockCalledWith,
  assertNotLength,
  assertPartialDeepStrictEqual,
  objectContaining,
  stringContaining,
  stringMatching,
  waitFor,
} from "./assertions.ts";

afterEach(() => mock.restoreAll());

async function temporaryRepository(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

type FixtureActivityRecorder = (
  event: FixtureEvidenceInvocationEvent,
) => Promise<void>;

async function recordSuccessfulFixturePhase(options: {
  readonly record: FixtureActivityRecorder;
  readonly scenario: FixtureEvidenceScenarioDiagnostics;
  readonly phase: FixtureEvidencePhase;
  readonly scope: FixtureEvidencePhaseScope;
  readonly offsetMilliseconds: number;
  readonly execute?: () => Promise<void>;
}): Promise<void> {
  const startedAt = new Date(options.offsetMilliseconds);
  await options.record({
    type: "phase",
    phase: options.phase,
    scope: options.scope,
    scenario: options.scenario,
    at: startedAt.toISOString(),
    outcome: "started",
  });
  await options.execute?.();
  const finishedAt = new Date(options.offsetMilliseconds + 1);
  await options.record({
    type: "phase",
    phase: options.phase,
    scope: options.scope,
    scenario: options.scenario,
    at: finishedAt.toISOString(),
    outcome: "succeeded",
    durationMilliseconds: 1,
  });
}

function createSuccessfulFixturePhaseExecutor(options: {
  readonly record: FixtureActivityRecorder;
  readonly scenario: FixtureEvidenceScenarioDiagnostics;
}): (
  gate: FixtureEvidenceGate,
  execute?: () => Promise<void>,
) => Promise<void> {
  let prepared = false;
  let offsetMilliseconds = 0;
  const record = async (
    phase: FixtureEvidencePhase,
    scope: FixtureEvidencePhaseScope,
    execute?: () => Promise<void>,
  ): Promise<void> => {
    await recordSuccessfulFixturePhase({
      ...options,
      phase,
      scope,
      offsetMilliseconds,
      ...(execute === undefined ? {} : { execute }),
    });
    offsetMilliseconds += 2;
  };
  return async (gate, execute = async () => undefined): Promise<void> => {
    if (!prepared) {
      prepared = true;
      await record("scheduler-queue", "development-container-session");
      await record("container-preparation", "development-container-session");
      await record("dependency-installation", "development-container-session");
    }
    await record("scheduler-queue", gate);
    await record("semantic-gate", gate, execute);
  };
}

async function textBelow(root: string): Promise<string> {
  const contents: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        contents.push(await readFile(entryPath, "utf8"));
      }
    }
  }
  await visit(root);
  return contents.join("\n");
}

function fixtureExecutorTestRunner(
  run: FixtureCommandRunner,
): FixtureCommandRunner {
  return async (command, args, options) => {
    if (command === "docker") return {};
    if (command !== "devcontainer") {
      return await run(command, args, options);
    }
    if (args[0] !== "exec") return {};
    const idLabelIndex = args.indexOf("--id-label");
    let nestedCommandIndex = idLabelIndex === -1 ? 3 : idLabelIndex + 2;
    while (args[nestedCommandIndex] === "--remote-env") {
      nestedCommandIndex += 2;
    }
    let nestedCommand = args[nestedCommandIndex];
    let nestedArgs = args.slice(nestedCommandIndex + 1);
    let cwd = options.cwd;
    if (nestedCommand === "sh" && nestedArgs[0] === "-c") {
      cwd = path.join(options.cwd, nestedArgs[3]!);
      nestedCommand = nestedArgs[4];
      nestedArgs = nestedArgs.slice(5);
    }
    if (nestedCommand === undefined) {
      throw new Error("Dev Container exec test command is missing");
    }
    if (nestedCommand === "pnpm" && nestedArgs.includes("--lockfile-only")) {
      return await run(
        "pnpm",
        [
          "install",
          "--store-dir",
          path.join(path.dirname(options.cwd), ".pnpm-store"),
        ],
        { ...options, cwd },
      );
    }
    if (
      nestedCommand === "pnpm" &&
      (nestedArgs[0] === "fetch" || nestedArgs.includes("--offline"))
    ) {
      return {};
    }
    const isQualityCommand =
      nestedCommand === "git" ||
      nestedCommand === "node" ||
      (nestedCommand === "pnpm" &&
        (nestedArgs[0] === "run" ||
          (nestedArgs[0] === "exec" && nestedArgs[1] === "turbo")));
    return isQualityCommand
      ? await run(nestedCommand, nestedArgs, { ...options, cwd })
      : {};
  };
}

const runGeneratedScenarioSet = async (
  ...[set, options]: Parameters<typeof runGeneratedScenarioSetProduction>
): Promise<void> =>
  await runGeneratedScenarioSetProduction(set, {
    ...options,
    ...(options.run === undefined
      ? {}
      : { run: fixtureExecutorTestRunner(options.run) }),
  });

const runGeneratedRegistryCli = async (
  options: Parameters<typeof runGeneratedRegistryCliProduction>[0],
): Promise<void> =>
  await runGeneratedRegistryCliProduction({
    ...options,
    ...(options.run === undefined
      ? {}
      : { run: fixtureExecutorTestRunner(options.run) }),
  });

function isolatedFixtureEnvironment(
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "TEMPLATE_FIXTURE_BUILDKIT_CACHE_DIR",
    "TEMPLATE_FIXTURE_CARGO_CACHE_DIR",
    "TEMPLATE_FIXTURE_CONCURRENCY",
    "TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS",
    "TEMPLATE_FIXTURE_EVIDENCE_DIR",
    "TEMPLATE_FIXTURE_EVIDENCE_READ",
    "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
    "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
    "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
    "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
    "TEMPLATE_FIXTURE_PNPM_CACHE_DIR",
    "TEMPLATE_FIXTURE_WORKSPACE_DIR",
    "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY",
    "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY",
    "TEMPLATE_FIXTURE_TURBO_TEAM",
    "TEMPLATE_FIXTURE_TURBO_TOKEN",
  ]) {
    delete environment[name];
  }
  return { ...environment, ...overrides };
}

async function successfulRootEvidence(
  generatedContentIdentity: string,
  contractIdentity = "0".repeat(64),
) {
  return await runFixtureEvidenceGate({
    gate: "generated-root-quality",
    generatedContentIdentity,
    contractIdentity,
    scenario: {
      id: "root-prerequisite",
      label: "root prerequisite",
      presetIdentities: [],
    },
    producerCommit: "test",
    readEnabled: false,
    writeEnabled: false,
    execute: async () => undefined,
  });
}

async function generatedTaskIds(root: string): Promise<readonly string[]> {
  const taskIds: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
          readonly name: string;
          readonly scripts?: Record<string, string>;
        };
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          taskIds.push(
            `${manifest.name.startsWith("@") ? manifest.name : "//"}#${taskName}`,
          );
        }
      }
    }
  }

  await visit(root);
  return taskIds;
}

async function materializeFocusedProviderBuild(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
        readonly exports?: {
          readonly "."?: {
            readonly source?: unknown;
            readonly default?: unknown;
          };
        };
      };
      const source = manifest.exports?.["."]?.source;
      const target = manifest.exports?.["."]?.default;
      if (
        typeof source !== "string" ||
        !source.startsWith("./") ||
        typeof target !== "string" ||
        !target.startsWith("./")
      ) {
        continue;
      }
      const packageRoot = path.dirname(entryPath);
      const sourcePath = path.resolve(packageRoot, source);
      const targetPath = path.resolve(packageRoot, target);
      try {
        const contents = await readFile(sourcePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, contents);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }

  await visit(root);
}

async function focusedMarker(root: string): Promise<string> {
  async function visit(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(entryPath);
        if (nested !== undefined) return nested;
        continue;
      }
      const match = /focused-provider-marker:[0-9a-f]+/u.exec(
        await readFile(entryPath, "utf8"),
      );
      if (match !== null) return match[0];
    }
    return undefined;
  }

  const marker = await visit(root);
  if (marker === undefined) {
    throw new Error("Focused marker was not injected into the provider");
  }
  return marker;
}

function createBlockedConcurrencyProbe() {
  let active = 0;
  let maximum = 0;
  let released = false;
  const waiters = new Set<() => void>();
  return {
    enter: async (): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (!released) {
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
      active -= 1;
    },
    release: (): void => {
      released = true;
      for (const resolve of waiters) resolve();
      waiters.clear();
    },
    active: (): number => active,
    maximum: (): number => maximum,
  };
}

function createBlockedWorkProbe() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let maximum = 0;
  return {
    run: async (name: string): Promise<void> => {
      started.push(name);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        releases.set(name, resolve);
      });
      active -= 1;
    },
    release: (name: string): void => {
      releases.get(name)?.();
    },
    releaseAll: (): void => {
      for (const release of releases.values()) release();
    },
    started: (): readonly string[] => started,
    maximum: (): number => maximum,
  };
}

async function releaseAfterActive(options: {
  readonly execution: Promise<void>;
  readonly probe: ReturnType<typeof createBlockedConcurrencyProbe>;
  readonly expected: number;
}): Promise<void> {
  let observationFailure: unknown;
  try {
    await waitFor(
      () => {
        assert.strictEqual(options.probe.active(), options.expected);
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    observationFailure = error;
  } finally {
    options.probe.release();
  }
  await options.execution;
  if (observationFailure !== undefined) throw observationFailure;
}

type MatrixScenario = Awaited<ReturnType<typeof generatedScenariosFor>>[number];

function replaceTemplateSource(options: {
  readonly operation: RenderOperation;
  readonly from: TemplateSourceHandle;
  readonly to: TemplateSourceHandle;
}): RenderOperation {
  if (
    "source" in options.operation &&
    options.operation.source === options.from
  ) {
    return { ...options.operation, source: options.to };
  }
  if (options.operation.kind === "writeTextFromFragments") {
    return {
      ...options.operation,
      fragments: options.operation.fragments.map((fragment) =>
        fragment.source === options.from
          ? { ...fragment, source: options.to }
          : fragment,
      ),
    };
  }
  return options.operation;
}

function replaceContributionTemplateSource<
  Contribution extends PackageContribution,
>(options: {
  readonly contribution: Contribution;
  readonly from: TemplateSourceHandle;
  readonly to: TemplateSourceHandle;
}): Contribution {
  return {
    ...options.contribution,
    operations: options.contribution.operations.map((operation) =>
      replaceTemplateSource({ operation, from: options.from, to: options.to }),
    ),
  };
}

async function renderMatrixScenario(options: {
  readonly scenario: MatrixScenario;
  readonly workspace: string;
  readonly addition?: BuiltInPresetDefinition;
}): Promise<{
  readonly generatedContentIdentity: string;
  readonly plan: GeneratedRepositoryPlan;
}> {
  const projectDir = path.join(options.workspace, options.scenario.id);
  const context = createGenerationContext({
    targetDir: projectDir,
    defaultPackageScope: "fixture",
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  });
  const initialization = planGeneratedRepositoryInitialization({
    definition: options.scenario.base,
    context,
  });
  await validatePlanSources({
    definition: options.scenario.base,
    plan: initialization,
  });
  await validatePlanDependencyCatalog(initialization);
  await renderNewProject({
    targetRoot: projectDir,
    operations: [...initialization.operations],
  });
  await initializeFixtureGitRepository({ repositoryRoot: projectDir });
  await writeGeneratedRepositoryTree({ repositoryRoot: projectDir });

  let plan: GeneratedRepositoryPlan = initialization;
  const addition = options.addition ?? options.scenario.addition;
  if (addition !== undefined) {
    const additionPlan = planGeneratedRepositoryPackageAddition({
      definition: addition,
      localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
      packageLeafName: `fixture-${addition.metadata.name}`,
      ...(options.scenario.linkFrom === undefined
        ? {}
        : { linkFrom: options.scenario.linkFrom }),
    });
    await validatePlanSources({ definition: addition, plan: additionPlan });
    await validatePlanDependencyCatalog(additionPlan);
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: projectDir,
      ...additionPlan.projectProjections,
    });
    if (!result.ok) {
      throw new Error(
        `Generated Package Addition reconciliation conflicted: ${JSON.stringify(result.conflicts)}`,
      );
    }
    plan = additionPlan;
  }

  return {
    generatedContentIdentity: await writeGeneratedRepositoryTree({
      repositoryRoot: projectDir,
    }),
    plan,
  };
}

void describe("Fixture Verification Evidence", () => {
  void it("renders root and matrix initialization to the same canonical tree identity", async () => {
    const root = await temporaryRepository("fixture-canonical-init-");
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    let matrixHits = 0;
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
          rootProjection.plan,
          { includeFix: true },
        );
        const matrixContract = await deriveGeneratedRootQualityContractIdentity(
          matrixProjection.plan,
          { includeFix: true },
        );
        assert.strictEqual(matrixContract, rootContract);
        await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: rootProjection.generatedContentIdentity,
          contractIdentity: rootContract,
          scenario: {
            id: scenario.id,
            label: scenario.label,
            presetIdentities: [scenario.base.metadata.name],
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
            presetIdentities: [matrixScenario!.base.metadata.name],
          },
          producerCommit: "same-run",
          storage,
          writeEnabled: true,
          execute: matrixExecutor,
        });
        assert.strictEqual(matrixResult.status, "hit");
        assert.strictEqual(matrixExecutor.mock.callCount(), 0);
        matrixHits += 1;
      }
      assert.strictEqual(matrixHits, initialization.length);
      assert.strictEqual(matrixHits, 6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("accepts a complete writable miss only for its current run activity", async () => {
    const root = await temporaryRepository("fixture-evidence-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const scenario = {
      id: "fixture-current-run",
      label: "fixture current run",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: activityRoot,
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "run-42",
        runAttempt: "2",
        invocationId: "init-current-run",
        scenarioSet: "init",
        writeEnabled: true,
        clock: () => new Date("2026-07-28T00:00:00.000Z"),
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "run-42",
          runAttempt: "2",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: true,
          stages: [
            objectContaining({
              scenarioSet: "init",
              hits: 0,
              misses: { absent: 1 },
              executions: 1,
              issuances: 1,
            }),
          ],
        },
      );
      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "run-42",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: [
            objectContaining({
              code: "missing-scenario-set",
              scenarioSet: "init",
            }),
          ],
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("reports deterministic cache activity alongside stage timing", async () => {
    const root = await temporaryRepository("fixture-evidence-cache-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "cache-activity",
      label: "cache activity",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "cache-run",
        runAttempt: "1",
        invocationId: "cache-invocation",
        scenarioSet: "package-addition-matrix",
        writeEnabled: true,
        clock: (() => {
          const timestamps = [
            "2026-07-28T00:00:00.000Z",
            "2026-07-28T00:00:00.025Z",
            "2026-07-28T00:00:00.050Z",
            "2026-07-28T00:00:00.075Z",
            "2026-07-28T00:00:00.100Z",
            "2026-07-28T00:00:00.125Z",
            "2026-07-28T00:00:00.150Z",
            "2026-07-28T00:00:00.175Z",
          ];
          let index = 0;
          return () => new Date(timestamps[index++] ?? timestamps.at(-1)!);
        })(),
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          for (const fact of [
            { cache: "buildkit", outcome: "configured" },
            { cache: "pnpm-downloads", outcome: "mounted" },
            { cache: "cargo-downloads", outcome: "mounted" },
            { cache: "turbo", outcome: "configured" },
          ] as const) {
            await invocation.record({
              type: "cache",
              ...fact,
              scenario,
              at: "2026-07-28T00:00:00.050Z",
            });
          }
          await executePhases("generated-root-quality");
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "cache-run",
        runAttempt: "1",
        enabledScenarioSets: ["package-addition-matrix"],
      });
      assertPartialDeepStrictEqual(report, {
        healthy: true,
        stages: [
          objectContaining({
            scenarioSet: "package-addition-matrix",
            cacheActivity: {
              "buildkit:configured": 1,
              "pnpm-downloads:mounted": 1,
              "cargo-downloads:mounted": 1,
              "turbo:configured": 1,
            },
            hits: 0,
            misses: { absent: 1 },
            executions: 1,
            issuances: 1,
            durationMilliseconds: 175,
          }),
        ],
      });
      assert.ok(
        formatFixtureEvidenceHealthReport(report).includes(
          "[Fixture Evidence] package-addition-matrix: scenarios=1 hits=0 misses=absent=1 executions=1 issuances=1 lifecycle-errors=0 duration-ms=175 phase-duration-ms=scheduler-queue=2,container-preparation=1,dependency-installation=1,semantic-gate=1 retries=0 recoveries=0 retry-duration-ms=0 cache-activity=buildkit:configured=1,cargo-downloads:mounted=1,pnpm-downloads:mounted=1,turbo:configured=1",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("reports paired phase duration and a recovered retry as healthy", async () => {
    const root = await temporaryRepository("fixture-phase-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "phase-recovery",
      label: "phase recovery",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "phase-run",
        runAttempt: "1",
        invocationId: "phase-invocation",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          for (const [phase, offsetMilliseconds] of [
            ["scheduler-queue", 0],
            ["container-preparation", 20],
          ] as const) {
            await invocation.record({
              type: "phase",
              phase,
              scope: "development-container-session",
              scenario,
              at: new Date(offsetMilliseconds).toISOString(),
              outcome: "started",
            });
            await invocation.record({
              type: "phase",
              phase,
              scope: "development-container-session",
              scenario,
              at: new Date(offsetMilliseconds + 10).toISOString(),
              outcome: "succeeded",
              durationMilliseconds: 10,
            });
          }
          await invocation.record({
            type: "phase",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(40).toISOString(),
            outcome: "started",
          });
          await invocation.record({
            type: "retry",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(45).toISOString(),
            outcome: "started",
            classification: "npm-registry-transport-transient",
            firstError:
              "GET https://registry.npmjs.org/tinypool: read ECONNRESET",
          });
          await invocation.record({
            type: "retry",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(55).toISOString(),
            outcome: "recovered",
            durationMilliseconds: 10,
          });
          await invocation.record({
            type: "phase",
            phase: "dependency-installation",
            scope: "development-container-session",
            scenario,
            at: new Date(60).toISOString(),
            outcome: "succeeded",
            durationMilliseconds: 20,
          });
          await recordSuccessfulFixturePhase({
            record: invocation.record,
            scenario,
            phase: "scheduler-queue",
            scope: "generated-root-quality",
            offsetMilliseconds: 70,
          });
          await recordSuccessfulFixturePhase({
            record: invocation.record,
            scenario,
            phase: "semantic-gate",
            scope: "generated-root-quality",
            offsetMilliseconds: 80,
          });
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "phase-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assertPartialDeepStrictEqual(report, {
        healthy: true,
        stages: [
          objectContaining({
            phaseDurations: {
              "scheduler-queue": 11,
              "container-preparation": 10,
              "dependency-installation": 20,
              "semantic-gate": 1,
            },
            retries: 1,
            recoveries: 1,
            retryDurationMilliseconds: 10,
          }),
        ],
      });
      assertContainsEqual(
        formatFixtureEvidenceHealthReport(report),
        stringContaining(
          "phase-duration-ms=scheduler-queue=11,container-preparation=10,dependency-installation=20,semantic-gate=1 retries=1 recoveries=1 retry-duration-ms=10 cache-activity=none",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a cache hit carries preparation and retry activity", async () => {
    const root = await temporaryRepository("fixture-hit-preparation-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "hit-preparation",
      label: "hit preparation",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "hit-preparation-run",
        runAttempt: "1",
        invocationId: "hit-preparation",
        scenarioSet: "init",
        writeEnabled: false,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "cache",
        cache: "buildkit",
        outcome: "configured",
        scenario,
        at: new Date(0).toISOString(),
      });
      await invocation.record({
        type: "phase",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(0).toISOString(),
        outcome: "started",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(1).toISOString(),
        outcome: "started",
        classification: "npm-registry-transport-transient",
        firstError: "GET https://registry.npmjs.org/pkg: read ECONNRESET",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(2).toISOString(),
        outcome: "recovered",
        durationMilliseconds: 1,
      });
      await invocation.record({
        type: "phase",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(3).toISOString(),
        outcome: "succeeded",
        durationMilliseconds: 3,
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "a".repeat(64),
        scenario,
        at: new Date(4).toISOString(),
        outcome: "hit",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "hit-preparation-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
            }),
            objectContaining({
              code: "invalid-retry-lifecycle",
              scenarioId: scenario.id,
            }),
            objectContaining({
              code: "lifecycle-error",
              scenarioId: scenario.id,
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when successful gate spans remain outside a cold execution", async () => {
    const root = await temporaryRepository("fixture-unused-gate-spans-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "unused-gate-spans",
      label: "unused gate spans",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "unused-gate-spans-run",
        runAttempt: "1",
        invocationId: "unused-gate-spans",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "b".repeat(40),
        contractIdentity: "c".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "scheduler-queue",
        scope: "generated-root-quality",
        offsetMilliseconds: 20,
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "semantic-gate",
        scope: "generated-root-quality",
        offsetMilliseconds: 22,
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "unused-gate-spans-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when lookup causality has no matching execution", async () => {
    const root = await temporaryRepository("fixture-lookup-causality-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "lookup-causality",
      label: "lookup causality",
      presetIdentities: ["fixture"],
    };
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    try {
      const afterExecution = ledger.invocation({
        runId: "lookup-causality-run",
        runAttempt: "1",
        invocationId: "lookup-after-execution",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await afterExecution.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const identity = "d".repeat(64);
      await afterExecution.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(0).toISOString(),
        outcome: "started",
      });
      await afterExecution.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(1).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: afterExecution.record,
        scenario,
      });
      await executePhases("generated-root-quality");
      await afterExecution.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(20).toISOString(),
        outcome: "succeeded",
      });
      await afterExecution.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(21).toISOString(),
        outcome: "issued",
      });
      await afterExecution.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await afterExecution.record({
        type: "invocation",
        outcome: "completed",
      });

      const withoutExecution = ledger.invocation({
        runId: "lookup-causality-run",
        runAttempt: "1",
        invocationId: "miss-without-execution",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await withoutExecution.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await withoutExecution.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "e".repeat(64),
        scenario,
        at: new Date(0).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      await withoutExecution.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await withoutExecution.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "lookup-causality-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assertPartialDeepStrictEqual(report, {
        healthy: false,
        failures: arrayContaining([
          objectContaining({
            code: "lifecycle-error",
            invocationId: "lookup-after-execution",
          }),
          objectContaining({
            code: "lifecycle-error",
            invocationId: "miss-without-execution",
          }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails hard-cut activity when a cold execution omits required phases", async () => {
    const root = await temporaryRepository("fixture-missing-cold-phases-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "missing-cold-phases",
      label: "missing cold phases",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "missing-cold-phases",
        runAttempt: "1",
        invocationId: "missing-cold-phases",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario,
        producerCommit: "test",
        storage: new FileFixtureEvidenceStorage(evidenceRoot),
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => undefined,
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "missing-cold-phases",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
              gate: "generated-root-quality",
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when complete preparation spans follow semantic execution", async () => {
    const root = await temporaryRepository("fixture-issuance-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "issuance-order",
      label: "issuance order",
      presetIdentities: ["fixture"],
    };
    const identity = "b".repeat(64);
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "issuance-order-run",
        runAttempt: "1",
        invocationId: "issuance-order",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.000Z",
        outcome: "miss",
        reason: "absent",
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.010Z",
        outcome: "started",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: "2026-07-28T00:00:00.020Z",
        outcome: "started",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: "2026-07-28T00:00:00.021Z",
        outcome: "succeeded",
        durationMilliseconds: 1,
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.030Z",
        outcome: "succeeded",
      });
      await invocation.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: "2026-07-28T00:00:00.040Z",
        outcome: "issued",
      });
      for (const [phase, scope, offsetMilliseconds] of [
        ["scheduler-queue", "development-container-session", 50],
        ["container-preparation", "development-container-session", 60],
        ["dependency-installation", "development-container-session", 70],
        ["scheduler-queue", "generated-root-quality", 80],
      ] as const) {
        await recordSuccessfulFixturePhase({
          record: invocation.record,
          scenario,
          phase,
          scope,
          offsetMilliseconds,
        });
      }
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "issuance-order-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
              gate: "generated-root-quality",
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a semantic span starts before its execution", async () => {
    const root = await temporaryRepository("fixture-semantic-span-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "semantic-span-order",
      label: "semantic span order",
      presetIdentities: ["fixture"],
    };
    const identity = "c".repeat(64);
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "semantic-span-order-run",
        runAttempt: "1",
        invocationId: "semantic-span-order",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(1).toISOString(),
        outcome: "miss",
        reason: "absent",
      });
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: new Date(2).toISOString(),
        outcome: "started",
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(3).toISOString(),
        outcome: "started",
      });
      for (const [phase, scope, offsetMilliseconds] of [
        ["scheduler-queue", "development-container-session", 4],
        ["container-preparation", "development-container-session", 6],
        ["dependency-installation", "development-container-session", 8],
        ["scheduler-queue", "generated-root-quality", 10],
      ] as const) {
        await recordSuccessfulFixturePhase({
          record: invocation.record,
          scenario,
          phase,
          scope,
          offsetMilliseconds,
        });
      }
      await invocation.record({
        type: "phase",
        phase: "semantic-gate",
        scope: "generated-root-quality",
        scenario,
        at: new Date(12).toISOString(),
        outcome: "succeeded",
        durationMilliseconds: 10,
      });
      await invocation.record({
        type: "execution",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(13).toISOString(),
        outcome: "succeeded",
      });
      await invocation.record({
        type: "issuance",
        gate: "generated-root-quality",
        identity,
        scenario,
        at: new Date(14).toISOString(),
        outcome: "issued",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "semantic-span-order-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
              gate: "generated-root-quality",
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when a retry finishes before its enclosing phase starts", async () => {
    const root = await temporaryRepository("fixture-retry-span-order-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "retry-span-order",
      label: "retry span order",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "retry-span-order-run",
        runAttempt: "1",
        invocationId: "retry-span-order",
        scenarioSet: "init",
        writeEnabled: false,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(10).toISOString(),
        outcome: "started",
        classification: "npm-registry-transport-transient",
        firstError: "GET https://registry.npmjs.org/tinypool: read ECONNRESET",
      });
      await invocation.record({
        type: "retry",
        phase: "dependency-installation",
        scope: "development-container-session",
        scenario,
        at: new Date(11).toISOString(),
        outcome: "recovered",
        durationMilliseconds: 1,
      });
      await recordSuccessfulFixturePhase({
        record: invocation.record,
        scenario,
        phase: "dependency-installation",
        scope: "development-container-session",
        offsetMilliseconds: 20,
      });
      await invocation.record({
        type: "lookup",
        gate: "generated-root-quality",
        identity: "d".repeat(64),
        scenario,
        at: new Date(30).toISOString(),
        outcome: "hit",
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "retry-span-order-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-retry-lifecycle",
              scenarioId: scenario.id,
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when multiple gates repeat scenario preparation", async () => {
    const root = await temporaryRepository("fixture-duplicate-preparation-");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "duplicate-preparation",
      label: "duplicate preparation",
      presetIdentities: ["fixture"],
    };
    try {
      const ledger = new FileFixtureEvidenceActivityLedger({
        root: path.join(root, "activity"),
        evidenceRoot,
      });
      const invocation = ledger.invocation({
        runId: "duplicate-preparation-run",
        runAttempt: "1",
        invocationId: "duplicate-preparation",
        scenarioSet: "package-addition-matrix",
        writeEnabled: true,
      });
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const executeRootPhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "1".repeat(64),
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executeRootPhases("generated-root-quality"),
      });
      const executeFocusedPhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "focused-package-link",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        rootEvidence,
        scenario,
        producerCommit: "test",
        storage,
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => await executeFocusedPhases("focused-package-link"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "duplicate-preparation-run",
          runAttempt: "1",
          enabledScenarioSets: ["package-addition-matrix"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "invalid-phase-lifecycle",
              scenarioId: scenario.id,
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("isolates activity from evidence through canonical paths and rejects either parent", async () => {
    const root = await temporaryRepository("fixture-activity-isolation-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const activityAlias = path.join(root, "activity-alias");
    const evidenceAlias = path.join(root, "evidence-alias");
    try {
      await Promise.all([
        mkdir(evidenceRoot, { recursive: true }),
        mkdir(activityRoot, { recursive: true }),
      ]);
      await Promise.all([
        symlink(evidenceRoot, activityAlias, "dir"),
        symlink(activityRoot, evidenceAlias, "dir"),
      ]);

      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityAlias,
            evidenceRoot,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: evidenceAlias,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: path.join(evidenceRoot, "activity"),
            evidenceRoot,
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
      assert.throws(
        () =>
          new FileFixtureEvidenceActivityLedger({
            root: activityRoot,
            evidenceRoot: path.join(activityRoot, "evidence"),
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Fixture Evidence activity must be isolated from shared evidence storage",
          ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("preserves every JSONL record across concurrent ledger instances", async () => {
    const root = await temporaryRepository("fixture-concurrent-ledgers-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const ledgers = Array.from(
      { length: 8 },
      () =>
        new FileFixtureEvidenceActivityLedger({
          root: activityRoot,
          evidenceRoot,
        }),
    );
    try {
      const writes = ledgers.flatMap((ledger, ledgerIndex) => {
        const invocation = ledger.invocation({
          runId: "concurrent-run",
          runAttempt: "1",
          invocationId: `ledger-${ledgerIndex}`,
          scenarioSet: "init",
          writeEnabled: false,
        });
        return Array.from({ length: 50 }, (_, recordIndex) =>
          invocation.record({
            type: "invocation",
            outcome: "failed",
            error: `ledger-${ledgerIndex}-record-${recordIndex}`,
          }),
        );
      });
      await Promise.all(writes);

      const records = await new FileFixtureEvidenceActivityLedger({
        root: activityRoot,
        evidenceRoot,
      }).read();
      assertLength(records, 400);
      assert.strictEqual(
        new Set(
          records.map((record) =>
            record.event.type === "invocation" &&
            record.event.outcome === "failed"
              ? record.event.error
              : "",
          ),
        ).size,
        400,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects activity outside the closed schema before it reaches the ledger", async () => {
    const root = await temporaryRepository("fixture-activity-schema-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "schema-run",
      runAttempt: "1",
      invocationId: "schema-invocation",
      scenarioSet: "init",
      writeEnabled: true,
    });
    try {
      await assert.rejects(
        invocation.record({
          type: "lookup",
          gate: "generated-root-quality",
          identity: "1".repeat(64),
          scenario: {
            id: "schema",
            label: "schema",
            presetIdentities: [],
          },
          at: new Date().toISOString(),
          outcome: "miss",
          reason: "unbounded-human-reason",
        } as unknown as FixtureEvidenceInvocationEvent),
        (error) =>
          error instanceof Error &&
          error.message.includes("invalid Fixture Evidence lookup activity"),
      );
      for (const [cache, outcome] of [
        ["buildkit", "mounted"],
        ["turbo", "mounted"],
        ["pnpm-downloads", "configured"],
        ["cargo-downloads", "configured"],
      ] as const) {
        await assert.rejects(
          invocation.record({
            type: "cache",
            cache,
            scenario: {
              id: "schema",
              label: "schema",
              presetIdentities: [],
            },
            at: new Date().toISOString(),
            outcome,
          } as unknown as FixtureEvidenceInvocationEvent),
          (error) =>
            error instanceof Error &&
            error.message.includes("invalid Fixture Evidence cache activity"),
        );
      }
      assert.deepStrictEqual(await ledger.read(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects invocation activity with no lookup or no writable issuance", async () => {
    const root = await temporaryRepository("fixture-incomplete-activity-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "incomplete-lifecycle",
      label: "incomplete lifecycle",
      presetIdentities: [],
    };
    try {
      const noLookup = ledger.invocation({
        runId: "incomplete-run",
        runAttempt: "1",
        invocationId: "no-lookup",
        scenarioSet: "init",
        writeEnabled: true,
      });
      await noLookup.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await noLookup.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await noLookup.record({ type: "invocation", outcome: "completed" });

      const noIssuance = ledger.invocation({
        runId: "incomplete-run",
        runAttempt: "1",
        invocationId: "no-issuance",
        scenarioSet: "focused",
        writeEnabled: true,
      });
      await noIssuance.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "3".repeat(40),
        contractIdentity: "4".repeat(64),
        scenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: true,
        recordLifecycle: noIssuance.record,
        execute: async () => undefined,
      });
      await noIssuance.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await noIssuance.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "incomplete-run",
        runAttempt: "1",
        enabledScenarioSets: ["init", "focused"],
      });
      assert.strictEqual(report.healthy, false);
      assertDeepStrictEqualWithMatchers(
        report.failures,
        arrayContaining([
          objectContaining({
            code: "no-lookup",
            invocationId: "no-lookup",
          }),
          objectContaining({
            code: "missing-issuance",
            invocationId: "no-issuance",
            gate: "generated-root-quality",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects failed fixture executions in current-run activity", async () => {
    const root = await temporaryRepository("fixture-failed-execution-health-");
    const evidenceRoot = path.join(root, "evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "semantic-failure",
      label: "semantic failure",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "failed-execution-run",
      runAttempt: "1",
      invocationId: "failed-execution",
      scenarioSet: "focused",
      writeEnabled: true,
    });
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: "5".repeat(40),
          contractIdentity: "6".repeat(64),
          scenario,
          producerCommit: "test",
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            await invocation.record({
              type: "phase",
              phase: "semantic-gate",
              scope: "generated-root-quality",
              scenario,
              at: "2026-07-28T00:00:00.000Z",
              outcome: "started",
            });
            await invocation.record({
              type: "phase",
              phase: "semantic-gate",
              scope: "generated-root-quality",
              scenario,
              at: "2026-07-28T00:00:00.001Z",
              outcome: "failed",
              durationMilliseconds: 1,
              classification: "not-retryable",
              error: "semantic fixture failure",
            });
            throw new Error("semantic fixture failure");
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("semantic fixture failure"),
      );
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "failed",
        error: "semantic fixture failure",
      });
      await invocation.record({
        type: "invocation",
        outcome: "failed",
        error: "semantic fixture failure",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "failed-execution-run",
        runAttempt: "1",
        enabledScenarioSets: ["focused"],
      });
      assert.strictEqual(report.healthy, false);
      assertContainsEqual(
        report.failures,
        objectContaining({
          code: "failed-execution",
          invocationId: "failed-execution",
          scenarioId: "semantic-failure",
          gate: "generated-root-quality",
          detail: stringContaining("semantic fixture failure"),
        }),
      );
      assertDeepStrictEqualWithMatchers(
        formatFixtureEvidenceHealthReport(report),
        arrayContaining([
          stringMatching(
            /failure code=failed-phase .*scenario=semantic-failure .*semantic-gate.*not-retryable.*semantic fixture failure/u,
          ),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("executes the semantic gate after storage read failure but leaves health failed", async () => {
    const root = await temporaryRepository("fixture-storage-health-");
    const evidenceRoot = path.join(root, "evidence");
    const fileStorage = new FileFixtureEvidenceStorage(evidenceRoot);
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const scenario = {
      id: "storage-read-failure",
      label: "storage read failure",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "storage-failure-run",
      runAttempt: "1",
      invocationId: "storage-read-failure",
      scenarioSet: "init",
      writeEnabled: true,
    });
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "5".repeat(40),
        contractIdentity: "6".repeat(64),
        scenario,
        producerCommit: "test",
        storage: {
          read: async () => {
            throw new Error("evidence volume unavailable");
          },
          writeAtomically: fileStorage.writeAtomically.bind(fileStorage),
        },
        writeEnabled: true,
        recordLifecycle: invocation.record,
        execute: async () => {
          executions += 1;
        },
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({
        type: "invocation",
        outcome: "completed",
      });

      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "storage-failure-run",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(executions, 1);
      assert.strictEqual(report.healthy, false);
      assertContainsEqual(
        report.failures,
        objectContaining({
          code: "lifecycle-error",
          detail: stringContaining("evidence volume unavailable"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("keeps invalid individual evidence as executable healthy misses", async () => {
    const root = await temporaryRepository("fixture-invalid-health-");
    const cases = [
      { name: "missing", reason: "absent" },
      { name: "stale", reason: "stale" },
      { name: "corrupt", reason: "invalid" },
      { name: "partial", reason: "invalid" },
      { name: "unknown-schema", reason: "invalid" },
    ] as const;
    try {
      for (const evidenceCase of cases) {
        const caseRoot = path.join(root, evidenceCase.name);
        const evidenceRoot = path.join(caseRoot, "evidence");
        const storage = new FileFixtureEvidenceStorage(evidenceRoot);
        const ledger = new FileFixtureEvidenceActivityLedger({
          root: path.join(caseRoot, "activity"),
          evidenceRoot,
        });
        const scenario = {
          id: evidenceCase.name,
          label: evidenceCase.name,
          presetIdentities: [],
        };
        const input = {
          gate: "generated-root-quality" as const,
          generatedContentIdentity: "7".repeat(40),
          contractIdentity: "8".repeat(64),
          scenario,
          producerCommit: "test",
          storage,
          writeEnabled: true,
        };
        if (evidenceCase.name !== "missing") {
          const seeded = await runFixtureEvidenceGate({
            ...input,
            clock: () =>
              new Date(
                evidenceCase.name === "stale"
                  ? "2026-07-01T00:00:00.000Z"
                  : "2026-07-28T00:00:00.000Z",
              ),
            execute: async () => undefined,
          });
          const recordPath = path.join(
            evidenceRoot,
            "generated-root-quality",
            `${seeded.identity}.json`,
          );
          if (evidenceCase.name === "corrupt") {
            await writeFile(recordPath, '{"schema":');
          } else if (evidenceCase.name === "partial") {
            const record = JSON.parse(
              await readFile(recordPath, "utf8"),
            ) as Record<string, unknown>;
            delete record.producerCommit;
            await writeFile(recordPath, `${JSON.stringify(record)}\n`);
          } else if (evidenceCase.name === "unknown-schema") {
            const record = JSON.parse(
              await readFile(recordPath, "utf8"),
            ) as Record<string, unknown>;
            await writeFile(
              recordPath,
              `${JSON.stringify({
                ...record,
                schema: "fixture-verification-evidence/v999",
              })}\n`,
            );
          }
        }

        const invocation = ledger.invocation({
          runId: `invalid-${evidenceCase.name}`,
          runAttempt: "1",
          invocationId: evidenceCase.name,
          scenarioSet: "init",
          writeEnabled: true,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        });
        await invocation.record({
          type: "invocation",
          outcome: "started",
          scenarios: [scenario],
        });
        const executePhases = createSuccessfulFixturePhaseExecutor({
          record: invocation.record,
          scenario,
        });
        let executions = 0;
        const result = await runFixtureEvidenceGate({
          ...input,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          recordLifecycle: invocation.record,
          execute: async () =>
            await executePhases("generated-root-quality", async () => {
              executions += 1;
            }),
        });
        await invocation.record({
          type: "scenario",
          scenario,
          outcome: "completed",
        });
        await invocation.record({
          type: "invocation",
          outcome: "completed",
        });

        assertPartialDeepStrictEqual(result, {
          status: "executed",
          missReason: evidenceCase.reason,
        });
        assert.strictEqual(executions, 1);
        assertPartialDeepStrictEqual(
          await checkFixtureEvidenceHealth({
            ledger,
            runId: `invalid-${evidenceCase.name}`,
            runAttempt: "1",
            enabledScenarioSets: ["init"],
          }),
          { healthy: true },
        );
      }
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (args[0] === "run" && args[1] === "check") {
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
        (await generatedScenariosFor("init")).length * 2,
      );
      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger: brokenLedger,
          runId: "activity-io-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: [
            objectContaining({
              code: "activity-io-error",
              detail: stringContaining("activity disk is read-only"),
            }),
          ],
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("uses all four scenario sets by default and validates Health CLI arguments and exits", async () => {
    const root = await temporaryRepository("fixture-health-cli-");
    const evidenceRoot = path.join(root, "evidence");
    const activityRoot = path.join(root, "activity");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: activityRoot,
      evidenceRoot,
    });
    const scenario = {
      id: "health-cli-init",
      label: "health CLI init",
      presetIdentities: [],
    };
    const invocation = ledger.invocation({
      runId: "health-cli-run",
      runAttempt: "1",
      invocationId: "health-cli-init",
      scenarioSet: "init",
      writeEnabled: false,
    });
    const healthCliPath = path.join(
      process.cwd(),
      "packages/checks/src/check-fixture-evidence-health.ts",
    );
    const env = isolatedFixtureEnvironment({
      TEMPLATE_FIXTURE_EVIDENCE_DIR: evidenceRoot,
      TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR: activityRoot,
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ID: "health-cli-run",
      TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT: "1",
    });
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const executePhases = createSuccessfulFixturePhaseExecutor({
        record: invocation.record,
        scenario,
      });
      await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "a".repeat(40),
        contractIdentity: "b".repeat(64),
        scenario,
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        recordLifecycle: invocation.record,
        execute: async () => await executePhases("generated-root-quality"),
      });
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await execa("node", ["--conditions=source", healthCliPath, "init"], {
          cwd: process.cwd(),
          env,
        }),
        { exitCode: 0 },
      );
      await assert.rejects(
        execa("node", ["--conditions=source", healthCliPath], {
          cwd: process.cwd(),
          env,
        }),
        (error) => {
          assertPartialDeepStrictEqual(error, {
            exitCode: 1,
            stderr: stringContaining(
              "Enabled scenario set package-addition-matrix has no current-run activity",
            ),
          });
          return true;
        },
      );
      await assert.rejects(
        execa("node", ["--conditions=source", healthCliPath, "unknown"], {
          cwd: process.cwd(),
          env,
        }),
        (error) => {
          assertPartialDeepStrictEqual(error, {
            exitCode: 1,
            stderr: stringContaining(
              "Expected enabled scenario set: init, package-addition-matrix, focused, or deployment",
            ),
          });
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
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
      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "initialization-health",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: true,
          stages: [
            objectContaining({
              scenarioSet: "init",
              invocations: 1,
              scenarios: scenarioCount,
              misses: { absent: scenarioCount },
              executions: scenarioCount,
              issuances: scenarioCount,
            }),
          ],
        },
      );
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force")
          ) {
            await materializeFocusedProviderBuild(options.cwd);
          }
          if (command === "node") {
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
        assertPartialDeepStrictEqual(coldHealth, {
          healthy: true,
          stages: arrayContaining([
            objectContaining({
              scenarioSet: "package-addition-matrix",
              scenarios: 30,
              hits: 6,
              misses: { absent: 24 },
              executions: 24,
              issuances: 24,
            }),
          ]),
        });
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

  void it("enforces configured ordinary, browser, and Docker capacities with queued work", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });

    const ordinary = createBlockedWorkProbe();
    const ordinaryJobs = ["a", "b", "c", "d", "e"].map(
      async (name) =>
        await scheduler.run(
          [],
          async () => await ordinary.run(`ordinary-${name}`),
        ),
    );
    await waitFor(() => {
      assert.deepStrictEqual(ordinary.started(), [
        "ordinary-a",
        "ordinary-b",
        "ordinary-c",
        "ordinary-d",
      ]);
    });
    ordinary.release("ordinary-a");
    await waitFor(() => {
      assert.ok(ordinary.started().includes("ordinary-e"));
    });
    ordinary.releaseAll();
    await Promise.all(ordinaryJobs);

    const browser = createBlockedWorkProbe();
    const browserJobs = [
      scheduler.run(["browser"], async () => await browser.run("browser-a")),
    ];
    await waitFor(() => {
      assert.deepStrictEqual(browser.started(), ["browser-a"]);
    });
    browserJobs.push(
      scheduler.run(["browser"], async () => await browser.run("browser-b")),
      scheduler.run(["browser"], async () => await browser.run("browser-c")),
      scheduler.run(["browser"], async () => await browser.run("browser-d")),
    );
    assert.deepStrictEqual(browser.started(), ["browser-a"]);
    for (const [current, next] of [
      ["browser-a", "browser-b"],
      ["browser-b", "browser-c"],
      ["browser-c", "browser-d"],
    ] as const) {
      browser.release(current);
      await waitFor(() => {
        assert.ok(browser.started().includes(next));
      });
    }
    browser.release("browser-d");
    await Promise.all(browserJobs);

    const docker = createBlockedWorkProbe();
    const dockerJobs = ["a", "b", "c"].map(
      async (name) =>
        await scheduler.run(
          ["docker"],
          async () => await docker.run(`docker-${name}`),
        ),
    );
    await waitFor(() => {
      assert.deepStrictEqual(docker.started(), ["docker-a"]);
    });
    docker.release("docker-a");
    await waitFor(() => {
      assert.deepStrictEqual(docker.started(), ["docker-a", "docker-b"]);
    });
    docker.release("docker-b");
    await waitFor(() => {
      assert.deepStrictEqual(docker.started(), [
        "docker-a",
        "docker-b",
        "docker-c",
      ]);
    });
    docker.release("docker-c");
    await Promise.all(dockerJobs);

    assert.strictEqual(ordinary.maximum(), 4);
    assert.strictEqual(browser.maximum(), 1);
    assert.strictEqual(docker.maximum(), 1);
  });

  void it("bounds Development Container sessions independently of ordinary work", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 2,
    });
    const sessions = createBlockedWorkProbe();
    const jobs = ["a", "b", "c"].map(
      async (name) =>
        await scheduler.run(
          ["development-container-session"],
          async () => await sessions.run(`session-${name}`),
        ),
    );

    await waitFor(() => {
      assert.deepStrictEqual(sessions.started(), ["session-a", "session-b"]);
    });
    sessions.release("session-a");
    await waitFor(() => {
      assert.deepStrictEqual(sessions.started(), [
        "session-a",
        "session-b",
        "session-c",
      ]);
    });
    sessions.releaseAll();
    await Promise.all(jobs);

    assert.strictEqual(sessions.maximum(), 2);
  });

  void it("does not retain Development Container sessions for browser-queued work", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 4,
    });
    const browser = createBlockedConcurrencyProbe();
    const ordinary = createBlockedConcurrencyProbe();
    const browserJobs = [
      scheduler.run(
        ["development-container-session", "browser"],
        async () => await browser.enter(),
      ),
    ];

    try {
      await waitFor(() => {
        assert.strictEqual(browser.active(), 1);
      });
      browserJobs.push(
        scheduler.run(
          ["development-container-session", "browser"],
          async () => await browser.enter(),
        ),
        scheduler.run(
          ["development-container-session", "browser"],
          async () => await browser.enter(),
        ),
      );
      const ordinaryJobs = ["a", "b", "c"].map(
        async () =>
          await scheduler.run(
            ["development-container-session"],
            async () => await ordinary.enter(),
          ),
      );

      await waitFor(() => {
        assert.strictEqual(ordinary.active(), 3);
      });

      ordinary.release();
      browser.release();
      await Promise.all([...browserJobs, ...ordinaryJobs]);
    } finally {
      ordinary.release();
      browser.release();
    }
  });

  void it("holds a Development Container session lease until explicit release", async () => {
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 4,
      developmentContainerSessions: 1,
    });
    const releaseFirst = await scheduler.acquire([
      "development-container-session",
    ]);
    let secondAcquired = false;
    const second = scheduler
      .acquire(["development-container-session"])
      .then((release) => {
        secondAcquired = true;
        return release;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(secondAcquired, false);
    releaseFirst();
    const releaseSecond = await second;
    assert.strictEqual(secondAcquired, true);
    releaseSecond();
  });

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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
      });

      assertNotLength(acquiredResources, 0);
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force")
          ) {
            await materializeFocusedProviderBuild(options.cwd);
          }
          if (command === "node") {
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
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
        if (args.includes("--dry-run=json")) {
          observedProjectDirectories.add(options.cwd);
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (command === "pnpm" && args[0] === "run") {
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
        assertPartialDeepStrictEqual(error, { code: "ENOENT" });
        return true;
      });
    }
  });

  void it("rejects malformed concurrency at the real generated-registry CLI environment boundary", async () => {
    const cliPath = path.join(
      process.cwd(),
      "packages/checks/src/check-generated-registry.ts",
    );
    for (const value of [
      "0",
      "-1",
      "1.5",
      "",
      " ",
      "1 ",
      "1worker",
      "NaN",
      "9007199254740992",
    ]) {
      const result = await execa(
        process.execPath,
        ["--conditions=source", cliPath, "init"],
        {
          env: isolatedFixtureEnvironment({
            TEMPLATE_FIXTURE_CONCURRENCY: value,
          }),
          reject: false,
        },
      );

      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(
        result.stderr.includes(
          "TEMPLATE_FIXTURE_CONCURRENCY must be a positive integer",
        ),
      );
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

  void it("translates only non-empty fixture Turbo inputs for container execution", () => {
    assert.deepStrictEqual(
      fixtureContainerEnvironmentFromEnvironment({
        TEMPLATE_FIXTURE_TURBO_TEAM: "fixture-team",
        TEMPLATE_FIXTURE_TURBO_TOKEN: "",
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY: "fixture-signature",
        TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY: "true",
        TURBO_TOKEN: "must-not-override-an-explicit-empty-fixture-token",
        UNRELATED_SECRET: "must-not-be-forwarded",
      }),
      {
        TURBO_TEAM: "fixture-team",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY: "fixture-signature",
        TURBO_REMOTE_CACHE_READ_ONLY: "true",
      },
    );
    assert.deepStrictEqual(
      fixtureContainerEnvironmentFromEnvironment({
        TURBO_TEAM: "local-team",
        TURBO_TOKEN: "local-token",
      }),
      {
        TURBO_TEAM: "local-team",
        TURBO_TOKEN: "local-token",
      },
    );
  });

  void it("parses only external fixture dependency-download cache directories", () => {
    const pnpmCache = path.resolve(".fixture-native-cache/pnpm");
    const cargoCache = path.resolve(".fixture-native-cache/cargo");

    assert.deepStrictEqual(
      fixtureDependencyCachesFromEnvironment({
        TEMPLATE_FIXTURE_PNPM_CACHE_DIR: pnpmCache,
        TEMPLATE_FIXTURE_CARGO_CACHE_DIR: cargoCache,
      }),
      { pnpm: pnpmCache, cargo: cargoCache },
    );
    assert.strictEqual(fixtureDependencyCachesFromEnvironment({}), undefined);
    assert.throws(
      () =>
        fixtureDependencyCachesFromEnvironment({
          TEMPLATE_FIXTURE_PNPM_CACHE_DIR: "",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "TEMPLATE_FIXTURE_PNPM_CACHE_DIR must not be empty",
        ),
    );
    assert.throws(
      () =>
        fixtureDependencyCachesFromEnvironment({
          TEMPLATE_FIXTURE_CARGO_CACHE_DIR: "",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "TEMPLATE_FIXTURE_CARGO_CACHE_DIR must not be empty",
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
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

  void it("applies CLI ordinary concurrency to every scenario set", async () => {
    const root = await temporaryRepository("fixture-cli-resource-caps-");
    const sets = [
      "init",
      "package-addition-matrix",
      "focused",
      "deployment",
    ] as const;
    const maxActiveInstalls = new Map<(typeof sets)[number], number>();
    const expectedMaxActiveInstalls = new Map<(typeof sets)[number], number>();
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
            if (args.includes("--dry-run=json")) {
              return {
                stdout: JSON.stringify({
                  tasks: (await generatedTaskIds(options.cwd)).map(
                    (taskId) => ({ taskId }),
                  ),
                }),
              };
            }
            if (
              command === "pnpm" &&
              args.includes("build") &&
              args.includes("--force")
            ) {
              await materializeFocusedProviderBuild(options.cwd);
            }
            if (command === "node") {
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
        const browserConstrained = renderedScenarios.filter(({ plan }) =>
          generatedRootQualityExecutionResources(plan).includes("browser"),
        ).length;
        const ordinaryOnly = scenarios.length - browserConstrained;
        const expected =
          scenarioSet === "deployment"
            ? 1
            : Math.min(4, ordinaryOnly + Math.min(browserConstrained, 1));
        expectedMaxActiveInstalls.set(scenarioSet, expected);
        let observationFailure: unknown;
        try {
          await waitFor(
            () => {
              assert.deepStrictEqual(
                { scenarioSet, active: installs.active() },
                {
                  scenarioSet,
                  active: expected,
                },
              );
            },
            { timeout: 30_000 },
          );
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
  });

  void it("serializes Docker execution regardless of the ordinary concurrency override", async () => {
    const scheduler = createFixtureEvidenceScheduler({ concurrency: 4 });
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let activeDocker = 0;
    let maxActiveDocker = 0;
    const work = async (name: string): Promise<void> => {
      started.push(name);
      activeDocker += 1;
      maxActiveDocker = Math.max(maxActiveDocker, activeDocker);
      await new Promise<void>((resolve) => {
        releases.set(name, resolve);
      });
      activeDocker -= 1;
    };

    const jobs = [
      scheduler.run(["docker"], async () => await work("docker-a")),
    ];
    await waitFor(() => {
      assert.deepStrictEqual(started, ["docker-a"]);
    });
    jobs.push(
      scheduler.run(["docker"], async () => await work("docker-b")),
      scheduler.run(["docker"], async () => await work("docker-c")),
    );
    assert.deepStrictEqual(started, ["docker-a"]);
    releases.get("docker-a")!();
    await waitFor(() => {
      assert.deepStrictEqual(started, ["docker-a", "docker-b"]);
    });
    releases.get("docker-b")!();
    await waitFor(() => {
      assert.deepStrictEqual(started, ["docker-a", "docker-b", "docker-c"]);
    });
    releases.get("docker-c")!();
    await Promise.all(jobs);

    assert.strictEqual(maxActiveDocker, 1);
  });

  void it("classifies Root Quality browser resources from real Check Environment Needs", async () => {
    const classifications = (await generatedScenariosFor("init")).map(
      (scenario) => {
        const plan = planGeneratedRepositoryInitialization({
          definition: scenario.base,
          context: createGenerationContext({
            targetDir: path.join("/tmp/resource-classification", scenario.id),
            defaultPackageScope: "fixture",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          }),
        });
        return {
          hasBrowserNeed: plan.environmentNeeds.some(
            (need) => need.kind === "playwright-browser-assets",
          ),
          resources: generatedRootQualityExecutionResources(plan),
        };
      },
    );

    assert.strictEqual(
      classifications.some(({ hasBrowserNeed }) => hasBrowserNeed),
      true,
    );
    assert.strictEqual(
      classifications.some(({ hasBrowserNeed }) => !hasBrowserNeed),
      true,
    );
    for (const classification of classifications) {
      assert.deepStrictEqual(
        classification.resources,
        classification.hasBrowserNeed ? ["browser"] : [],
      );
    }
  });

  void it("identifies Generated Repository content from the prospective Git tree", async () => {
    const first = await temporaryRepository("fixture-evidence-first-");
    const second = await temporaryRepository("fixture-evidence-second-");
    try {
      for (const repositoryRoot of [first, second]) {
        await writeFile(
          path.join(repositoryRoot, ".gitignore"),
          "node_modules/\nlocal.txt\n",
        );
        await writeFile(path.join(repositoryRoot, "source.txt"), "same\n");
        await initializeFixtureGitRepository({ repositoryRoot });
      }
      await writeFile(path.join(first, "local.txt"), "first runtime value\n");
      await writeFile(path.join(second, "local.txt"), "second runtime value\n");

      const firstIdentity = await writeGeneratedRepositoryTree({
        repositoryRoot: first,
      });
      const secondIdentity = await writeGeneratedRepositoryTree({
        repositoryRoot: second,
      });

      assert.match(firstIdentity, /^[0-9a-f]{40}$/u);
      assert.strictEqual(secondIdentity, firstIdentity);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  void it("lets Git identify bytes, paths, executable modes, symlinks, and rendered lockfiles", async () => {
    const roots: string[] = [];
    const identity = async (variant: {
      readonly content?: string;
      readonly filePath?: string;
      readonly executable?: boolean;
      readonly symlinkTarget?: string;
      readonly lockfile?: string;
    }) => {
      const root = await temporaryRepository("fixture-git-identity-");
      roots.push(root);
      const filePath = path.join(root, variant.filePath ?? "script.sh");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, variant.content ?? "echo baseline\n");
      if (variant.executable === true) await chmod(filePath, 0o755);
      await symlink(
        variant.symlinkTarget ?? variant.filePath ?? "script.sh",
        path.join(root, "entrypoint"),
      );
      if (variant.lockfile !== undefined) {
        await writeFile(path.join(root, "pnpm-lock.yaml"), variant.lockfile);
      }
      await initializeFixtureGitRepository({ repositoryRoot: root });
      return await writeGeneratedRepositoryTree({ repositoryRoot: root });
    };

    try {
      const baseline = await identity({});
      assert.notStrictEqual(
        await identity({ content: "echo changed\n" }),
        baseline,
      );
      assert.notStrictEqual(
        await identity({ filePath: "nested/script.sh" }),
        baseline,
      );
      assert.notStrictEqual(await identity({ executable: true }), baseline);
      assert.notStrictEqual(
        await identity({ symlinkTarget: "missing-target" }),
        baseline,
      );
      assert.notStrictEqual(
        await identity({ lockfile: "lockfileVersion: '9.0'\n" }),
        baseline,
      );
    } finally {
      await Promise.all(
        roots.map(
          async (root) => await rm(root, { recursive: true, force: true }),
        ),
      );
    }
  });

  void it("derives contract identity from a normalized plan and owned production source", async () => {
    const root = await temporaryRepository("fixture-contract-");
    const gateRoot = path.join(root, "gates/root-quality");
    const kernelRoot = path.join(root, "kernel");
    const testRoot = path.join(root, "test");
    try {
      await Promise.all([
        mkdir(gateRoot, { recursive: true }),
        mkdir(kernelRoot, { recursive: true }),
        mkdir(testRoot, { recursive: true }),
      ]);
      await writeFile(
        path.join(gateRoot, "index.ts"),
        "export const gate = 1;\n",
      );
      await writeFile(
        path.join(kernelRoot, "index.ts"),
        "export const kernel = 1;\n",
      );
      await writeFile(path.join(testRoot, "root.test.ts"), "expect(true);\n");

      const derive = async (plan: unknown) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: plan,
          sourceProjections: [
            { name: "root-quality", root: gateRoot },
            { name: "kernel", root: kernelRoot },
          ],
        });
      const initial = await derive({ command: "check", args: ["--all"] });

      await writeFile(path.join(testRoot, "root.test.ts"), "expect(false);\n");
      assert.strictEqual(
        await derive({ args: ["--all"], command: "check" }),
        initial,
      );

      await writeFile(
        path.join(gateRoot, "index.ts"),
        "export const gate = 2;\n",
      );
      const gateChanged = await derive({
        command: "check",
        args: ["--all"],
      });
      assert.notStrictEqual(gateChanged, initial);

      await writeFile(
        path.join(kernelRoot, "index.ts"),
        "export const kernel = 2;\n",
      );
      assert.notStrictEqual(
        await derive({ command: "check", args: ["--all"] }),
        gateChanged,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("invalidates only the owning gate for plan and implementation changes while kernel changes invalidate every gate", async () => {
    const root = await temporaryRepository("fixture-contract-boundaries-");
    const rootGate = path.join(root, "root-quality");
    const focusedGate = path.join(root, "focused-package-link");
    const deploymentGate = path.join(root, "deployment-quality");
    const kernel = path.join(root, "kernel");
    try {
      await Promise.all([
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/root-quality",
          ),
          rootGate,
          { recursive: true },
        ),
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/focused-package-link",
          ),
          focusedGate,
          { recursive: true },
        ),
        cp(
          path.resolve(
            "packages/checks/src/fixture-evidence/gates/deployment-quality",
          ),
          deploymentGate,
          { recursive: true },
        ),
        cp(
          path.resolve("packages/checks/src/fixture-evidence/kernel"),
          kernel,
          { recursive: true },
        ),
      ]);
      const deriveRoot = async () =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "generated-root-quality",
            rootCheck: true,
          },
          sourceProjections: [
            { name: "generated-root-quality", root: rootGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const deriveFocused = async (probe: string) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "focused-package-link",
            consumer: "@fixture/consumer",
            provider: "@fixture/provider",
            probe,
          },
          sourceProjections: [
            { name: "focused-package-link", root: focusedGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const deriveDeployment = async (command: string) =>
        await deriveFixtureGateContractIdentity({
          normalizedPlan: {
            gate: "deployment-quality",
            resources: ["docker"],
            command,
          },
          sourceProjections: [
            { name: "deployment-quality", root: deploymentGate },
            { name: "fixture-evidence-kernel", root: kernel },
          ],
        });
      const initialRoot = await deriveRoot();
      const initialFocused = await deriveFocused("source-and-default");
      const initialDeployment = await deriveDeployment(
        "pnpm run check:deployment",
      );

      const deploymentIndex = path.join(deploymentGate, "index.ts");
      await writeFile(
        deploymentIndex,
        `${await readFile(deploymentIndex, "utf8")}\n// deployment implementation change\n`,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      assert.strictEqual(
        await deriveFocused("source-and-default"),
        initialFocused,
      );
      const deploymentImplementationChanged = await deriveDeployment(
        "pnpm run check:deployment",
      );
      assert.notStrictEqual(deploymentImplementationChanged, initialDeployment);

      const deploymentPlanChanged = await deriveDeployment(
        "pnpm run check:deployment:changed",
      );
      assert.notStrictEqual(
        deploymentPlanChanged,
        deploymentImplementationChanged,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      assert.strictEqual(
        await deriveFocused("source-and-default"),
        initialFocused,
      );

      const focusedIndex = path.join(focusedGate, "index.ts");
      await writeFile(
        focusedIndex,
        `${await readFile(focusedIndex, "utf8")}\n// focused implementation change\n`,
      );
      assert.strictEqual(await deriveRoot(), initialRoot);
      const focusedImplementationChanged =
        await deriveFocused("source-and-default");
      assert.notStrictEqual(focusedImplementationChanged, initialFocused);
      assert.strictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );

      const focusedPlanChanged = await deriveFocused("different-plan");
      assert.notStrictEqual(focusedPlanChanged, focusedImplementationChanged);
      assert.strictEqual(await deriveRoot(), initialRoot);

      const rootIndex = path.join(rootGate, "index.ts");
      await writeFile(
        rootIndex,
        `${await readFile(rootIndex, "utf8")}\n// root implementation change\n`,
      );
      const rootImplementationChanged = await deriveRoot();
      assert.notStrictEqual(rootImplementationChanged, initialRoot);
      assert.strictEqual(
        await deriveFocused("different-plan"),
        focusedPlanChanged,
      );
      assert.strictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );

      const kernelIndex = path.join(kernel, "index.ts");
      await writeFile(
        kernelIndex,
        `${await readFile(kernelIndex, "utf8")}\n// kernel change\n`,
      );
      assert.notStrictEqual(await deriveRoot(), rootImplementationChanged);
      assert.notStrictEqual(
        await deriveFocused("different-plan"),
        focusedPlanChanged,
      );
      assert.notStrictEqual(
        await deriveDeployment("pnpm run check:deployment:changed"),
        deploymentPlanChanged,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("keeps selective invalidation and expiry healthy through the activity protocol", async () => {
    const root = await temporaryRepository("fixture-selective-health-");
    const baseline = {
      generatedContent: "a".repeat(40),
      rootContract: "1".repeat(64),
      focusedContract: "2".repeat(64),
      deploymentContract: "3".repeat(64),
    };
    const cases = [
      {
        name: "generated-content",
        current: { generatedContent: "b".repeat(40) },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "root-contract",
        current: { rootContract: "4".repeat(64) },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "focused-contract",
        current: { focusedContract: "5".repeat(64) },
        executions: ["focused-package-link"],
      },
      {
        name: "deployment-contract",
        current: { deploymentContract: "6".repeat(64) },
        executions: ["deployment-quality"],
      },
      {
        name: "shared-kernel",
        current: {
          rootContract: "7".repeat(64),
          focusedContract: "8".repeat(64),
          deploymentContract: "9".repeat(64),
        },
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
      },
      {
        name: "seven-day-expiry",
        current: {},
        executions: [
          "generated-root-quality",
          "focused-package-link",
          "deployment-quality",
        ],
        expired: true,
      },
    ] as const;
    const scenario = {
      id: "selective-invalidation",
      label: "selective invalidation",
      presetIdentities: [],
    };
    try {
      for (const invalidation of cases) {
        const caseRoot = path.join(root, invalidation.name);
        const evidenceRoot = path.join(caseRoot, "evidence");
        const storage = new FileFixtureEvidenceStorage(evidenceRoot);
        const seedClock = () => new Date("2026-07-01T00:00:00.000Z");
        const seedShared = {
          generatedContentIdentity: baseline.generatedContent,
          scenario,
          producerCommit: "seed",
          storage,
          clock: seedClock,
          writeEnabled: true,
          execute: async () => undefined,
        };
        const seedRoot = await runFixtureEvidenceGate({
          ...seedShared,
          gate: "generated-root-quality",
          contractIdentity: baseline.rootContract,
        });
        await runFixtureEvidenceGate({
          ...seedShared,
          gate: "focused-package-link",
          rootEvidence: seedRoot,
          contractIdentity: baseline.focusedContract,
        });
        await runFixtureEvidenceGate({
          ...seedShared,
          gate: "deployment-quality",
          rootEvidence: seedRoot,
          contractIdentity: baseline.deploymentContract,
        });

        const current = { ...baseline, ...invalidation.current };
        const ledger = new FileFixtureEvidenceActivityLedger({
          root: path.join(caseRoot, "activity"),
          evidenceRoot,
        });
        const invocation = ledger.invocation({
          runId: invalidation.name,
          runAttempt: "1",
          invocationId: invalidation.name,
          scenarioSet: "focused",
          writeEnabled: true,
          clock: () =>
            new Date(
              "expired" in invalidation && invalidation.expired
                ? "2026-07-08T00:00:00.000Z"
                : "2026-07-01T00:00:00.000Z",
            ),
        });
        await invocation.record({
          type: "invocation",
          outcome: "started",
          scenarios: [scenario],
        });
        const executePhases = createSuccessfulFixturePhaseExecutor({
          record: invocation.record,
          scenario,
        });
        const executions: string[] = [];
        const currentShared = {
          generatedContentIdentity: current.generatedContent,
          scenario,
          producerCommit: "current",
          storage,
          clock: () =>
            new Date(
              "expired" in invalidation && invalidation.expired
                ? "2026-07-08T00:00:00.000Z"
                : "2026-07-01T00:00:00.000Z",
            ),
          writeEnabled: true,
          recordLifecycle: invocation.record,
        };
        const rootEvidence = await runFixtureEvidenceGate({
          ...currentShared,
          gate: "generated-root-quality",
          contractIdentity: current.rootContract,
          execute: async () =>
            await executePhases("generated-root-quality", async () => {
              executions.push("generated-root-quality");
            }),
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "focused-package-link",
          rootEvidence,
          contractIdentity: current.focusedContract,
          execute: async () =>
            await executePhases("focused-package-link", async () => {
              executions.push("focused-package-link");
            }),
        });
        await runFixtureEvidenceGate({
          ...currentShared,
          gate: "deployment-quality",
          rootEvidence,
          contractIdentity: current.deploymentContract,
          execute: async () =>
            await executePhases("deployment-quality", async () => {
              executions.push("deployment-quality");
            }),
        });
        await invocation.record({
          type: "scenario",
          scenario,
          outcome: "completed",
        });
        await invocation.record({
          type: "invocation",
          outcome: "completed",
        });

        assert.deepStrictEqual(executions, invalidation.executions);
        assertPartialDeepStrictEqual(
          await checkFixtureEvidenceHealth({
            ledger,
            runId: invalidation.name,
            runAttempt: "1",
            enabledScenarioSets: ["focused"],
          }),
          { healthy: true },
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("executes a cold gate once and reuses its schema-validated evidence while warm", async () => {
    const root = await temporaryRepository("fixture-evidence-store-");
    const events: FixtureEvidenceLifecycleEvent[] = [];
    const storage = new FileFixtureEvidenceStorage(root);
    let executions = 0;
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    try {
      const cold = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario: {
          id: "fixture-first-init",
          label: "first diagnostic",
          presetIdentities: ["first"],
        },
        producerCommit: "cold-commit",
        storage,
        clock,
        writeEnabled: true,
        recordLifecycle: (event) => {
          events.push(event);
        },
        execute: async () => {
          executions += 1;
        },
      });

      assert.strictEqual(cold.status, "executed");
      assert.strictEqual(cold.missReason, "absent");
      assert.strictEqual(executions, 1);
      const gateDirectory = path.join(root, "generated-root-quality");
      const [recordName] = await readdir(gateDirectory);
      assert.strictEqual(recordName, `${cold.identity}.json`);
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(path.join(gateDirectory, recordName!), "utf8"),
        ),
        {
          schema: "fixture-verification-evidence/v1",
          gate: "generated-root-quality",
          identity: cold.identity,
          components: {
            generatedContent: "1".repeat(40),
            contract: "2".repeat(64),
          },
          issuedAt: "2026-07-28T00:00:00.000Z",
          scenario: {
            id: "fixture-first-init",
            label: "first diagnostic",
            presetIdentities: ["first"],
          },
          producerCommit: "cold-commit",
        },
      );

      const warm = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity: "1".repeat(40),
        contractIdentity: "2".repeat(64),
        scenario: {
          id: "fixture-equivalent-init",
          label: "different diagnostics",
          presetIdentities: ["different"],
        },
        producerCommit: "warm-commit",
        storage,
        clock,
        writeEnabled: true,
        recordLifecycle: (event) => {
          events.push(event);
        },
        execute: async () => {
          executions += 1;
        },
      });

      assertPartialDeepStrictEqual(warm, {
        status: "hit",
        identity: cold.identity,
      });
      assert.strictEqual(executions, 1);
      assertDeepStrictEqualWithMatchers(
        events,
        arrayContaining([
          objectContaining({
            type: "lookup",
            outcome: "miss",
            reason: "absent",
          }),
          objectContaining({
            type: "execution",
            outcome: "succeeded",
          }),
          objectContaining({
            type: "issuance",
            outcome: "issued",
          }),
          objectContaining({ type: "lookup", outcome: "hit" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues and reuses Focused Package Link evidence independently from Root Quality", async () => {
    const root = await temporaryRepository("fixture-independent-gates-");
    const storage = new FileFixtureEvidenceStorage(root);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    let rootExecutions = 0;
    let focusedExecutions = 0;
    const shared = {
      generatedContentIdentity: "3".repeat(40),
      scenario: {
        id: "focused-independent",
        label: "focused independent",
        presetIdentities: ["consumer", "provider"],
      },
      producerCommit: "producer",
      storage,
      clock,
      writeEnabled: true,
    } as const;
    try {
      const coldRoot = await runFixtureEvidenceGate({
        ...shared,
        gate: "generated-root-quality",
        contractIdentity: "4".repeat(64),
        execute: async () => {
          rootExecutions += 1;
        },
      });
      const coldFocused = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "5".repeat(64),
        rootEvidence: coldRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });

      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...shared,
          gate: "generated-root-quality",
          contractIdentity: "4".repeat(64),
          execute: async () => {
            rootExecutions += 1;
          },
        }),
        { status: "hit", identity: coldRoot.identity },
      );
      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...shared,
          gate: "focused-package-link",
          contractIdentity: "5".repeat(64),
          rootEvidence: coldRoot,
          scenario: {
            id: "different-focused-scenario",
            label: "different focused diagnostics",
            presetIdentities: ["different-consumer", "different-provider"],
          },
          producerCommit: "different-producer",
          execute: async () => {
            focusedExecutions += 1;
          },
        }),
        {
          status: "hit",
          identity: coldFocused.identity,
        },
      );

      const changedRoot = await runFixtureEvidenceGate({
        ...shared,
        gate: "generated-root-quality",
        contractIdentity: "6".repeat(64),
        execute: async () => {
          rootExecutions += 1;
        },
      });
      const changedFocused = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "5".repeat(64),
        rootEvidence: changedRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });
      const focusedContractChanged = await runFixtureEvidenceGate({
        ...shared,
        gate: "focused-package-link",
        contractIdentity: "7".repeat(64),
        rootEvidence: changedRoot,
        execute: async () => {
          focusedExecutions += 1;
        },
      });

      assert.notStrictEqual(changedRoot.identity, coldRoot.identity);
      assert.notStrictEqual(changedFocused.identity, coldFocused.identity);
      assert.notStrictEqual(
        focusedContractChanged.identity,
        changedFocused.identity,
      );
      assertPartialDeepStrictEqual(
        JSON.parse(
          await readFile(
            path.join(
              root,
              "focused-package-link",
              `${changedFocused.identity}.json`,
            ),
            "utf8",
          ),
        ),
        {
          components: { rootEvidence: changedRoot.identity },
        },
      );
      assert.strictEqual(rootExecutions, 2);
      assert.strictEqual(focusedExecutions, 3);
      assertLength(await readdir(path.join(root, "generated-root-quality")), 2);
      assertLength(await readdir(path.join(root, "focused-package-link")), 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues and reuses Deployment Quality evidence with its Root prerequisite proof", async () => {
    const root = await temporaryRepository("fixture-deployment-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const generatedContentIdentity = "d".repeat(40);
    const rootEvidence = await successfulRootEvidence(generatedContentIdentity);
    let executions = 0;
    const input = {
      gate: "deployment-quality" as const,
      rootEvidence,
      generatedContentIdentity,
      contractIdentity: "e".repeat(64),
      scenario: {
        id: "deployment-independent",
        label: "deployment independent",
        presetIdentities: ["deployment"],
      },
      producerCommit: "producer",
      storage,
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
      writeEnabled: true,
      execute: async () => {
        executions += 1;
      },
    };
    try {
      const cold = await runFixtureEvidenceGate(input);
      const warm = await runFixtureEvidenceGate(input);

      assert.strictEqual(cold.status, "executed");
      assertPartialDeepStrictEqual(warm, {
        status: "hit",
        identity: cold.identity,
      });
      const changedRootEvidence = await successfulRootEvidence(
        generatedContentIdentity,
        "f".repeat(64),
      );
      const rootChanged = await runFixtureEvidenceGate({
        ...input,
        rootEvidence: changedRootEvidence,
      });
      const deploymentChanged = await runFixtureEvidenceGate({
        ...input,
        rootEvidence: changedRootEvidence,
        contractIdentity: "a".repeat(64),
      });

      assert.notStrictEqual(rootChanged.identity, cold.identity);
      assert.notStrictEqual(deploymentChanged.identity, rootChanged.identity);
      assert.strictEqual(executions, 3);
      assert.ok(
        (
          await readFile(
            path.join(root, "deployment-quality", `${cold.identity}.json`),
            "utf8",
          )
        ).includes(`"rootEvidence": "${rootEvidence.identity}"`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects a fabricated Root prerequisite before Focused evidence lookup", async () => {
    const read = mock.fn<FixtureEvidenceStorage["read"]>(async () => undefined);
    const generatedContentIdentity = "8".repeat(40);
    const fabricatedRootEvidence = {
      gate: "generated-root-quality",
      status: "hit",
      identity: "9".repeat(64),
      generatedContentIdentity,
      contractIdentity: "a".repeat(64),
    } as unknown as Awaited<ReturnType<typeof successfulRootEvidence>>;

    await assert.rejects(
      runFixtureEvidenceGate({
        gate: "focused-package-link",
        rootEvidence: fabricatedRootEvidence,
        generatedContentIdentity,
        contractIdentity: "b".repeat(64),
        scenario: {
          id: "fabricated-root",
          label: "fabricated root",
          presetIdentities: [],
        },
        producerCommit: "test",
        storage: {
          read,
          writeAtomically: async () => undefined,
        },
        execute: async () => undefined,
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "requires successful Root Quality evidence for the same Generated Repository content",
        ),
    );
    assert.strictEqual(read.mock.callCount(), 0);
  });

  void it("fails closed for corrupt, partial, unknown-schema, and mismatched records", async () => {
    const root = await temporaryRepository("fixture-invalid-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const clock = () => new Date("2026-07-28T00:00:00.000Z");
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "a".repeat(40),
      contractIdentity: "b".repeat(64),
      scenario: {
        id: "invalid-record",
        label: "invalid record",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      clock,
      writeEnabled: true,
    };
    let executions = 0;
    try {
      const seeded = await runFixtureEvidenceGate({
        ...input,
        execute: async () => {
          executions += 1;
        },
      });
      const recordPath = path.join(
        root,
        "generated-root-quality",
        `${seeded.identity}.json`,
      );
      const valid = JSON.parse(await readFile(recordPath, "utf8")) as Record<
        string,
        unknown
      >;
      const invalidRecords: readonly (string | Record<string, unknown>)[] = [
        '{"schema":',
        { ...valid, schema: "fixture-verification-evidence/v2" },
        Object.fromEntries(
          Object.entries(valid).filter(([key]) => key !== "producerCommit"),
        ),
        {
          ...valid,
          components: {
            ...(valid.components as Record<string, unknown>),
            contract: "c".repeat(64),
          },
        },
        { ...valid, issuedAt: "2026-07-28" },
      ];

      for (const invalid of invalidRecords) {
        await writeFile(
          recordPath,
          typeof invalid === "string"
            ? invalid
            : `${JSON.stringify(invalid)}\n`,
        );
        assertPartialDeepStrictEqual(
          await runFixtureEvidenceGate({
            ...input,
            execute: async () => {
              executions += 1;
            },
          }),
          {
            status: "executed",
            missReason: "invalid",
          },
        );
      }
      assert.strictEqual(executions, 1 + invalidRecords.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not expose evidence when atomic issuance writes only a partial temporary file", async () => {
    const root = await temporaryRepository("fixture-partial-issuance-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot, {
      writeTemporary: async (temporary, contents) => {
        await writeFile(temporary, contents.slice(0, 24), { flag: "wx" });
        throw new Error("simulated partial write");
      },
    });
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "partial-issuance-run",
      runAttempt: "1",
      invocationId: "partial-issuance",
      scenarioSet: "init",
      writeEnabled: true,
    });
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "7".repeat(40),
      contractIdentity: "8".repeat(64),
      scenario: {
        id: "partial-issuance",
        label: "partial issuance",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    };
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [input.scenario],
      });
      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed-unissued",
          issuanceError: "simulated partial write",
        },
      );
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed",
          missReason: "absent",
        },
      );
      assert.strictEqual(executions, 2);
      assert.deepStrictEqual(
        await readdir(path.join(evidenceRoot, "generated-root-quality")),
        [],
      );
      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "partial-issuance-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "lifecycle-error",
              detail: stringContaining("simulated partial write"),
            }),
            objectContaining({
              code: "missing-issuance",
              gate: "generated-root-quality",
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not expose evidence when atomic replacement fails after the temporary write", async () => {
    const root = await temporaryRepository("fixture-replace-issuance-");
    const evidenceRoot = path.join(root, "evidence");
    const storage = new FileFixtureEvidenceStorage(evidenceRoot, {
      replace: async () => {
        throw new Error("simulated replace failure");
      },
    });
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "replace-issuance-run",
      runAttempt: "1",
      invocationId: "replace-issuance",
      scenarioSet: "init",
      writeEnabled: true,
    });
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "9".repeat(40),
      contractIdentity: "a".repeat(64),
      scenario: {
        id: "replace-issuance",
        label: "replace issuance",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    };
    let executions = 0;
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [input.scenario],
      });
      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage,
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed-unissued",
          issuanceError: "simulated replace failure",
        },
      );
      await invocation.record({
        type: "scenario",
        scenario: input.scenario,
        outcome: "completed",
      });
      await invocation.record({ type: "invocation", outcome: "completed" });

      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: false,
          execute: async () => {
            executions += 1;
          },
        }),
        {
          status: "executed",
          missReason: "absent",
        },
      );
      assert.strictEqual(executions, 2);
      assert.deepStrictEqual(
        await readdir(path.join(evidenceRoot, "generated-root-quality")),
        [],
      );
      assertPartialDeepStrictEqual(
        await checkFixtureEvidenceHealth({
          ledger,
          runId: "replace-issuance-run",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
        {
          healthy: false,
          failures: arrayContaining([
            objectContaining({
              code: "lifecycle-error",
              detail: stringContaining("simulated replace failure"),
            }),
            objectContaining({
              code: "missing-issuance",
              gate: "generated-root-quality",
            }),
          ]),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("expires at seven days and never refreshes evidence after failed execution", async () => {
    const root = await temporaryRepository("fixture-stale-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    let now = new Date("2026-07-01T00:00:00.000Z");
    const input = {
      gate: "generated-root-quality" as const,
      generatedContentIdentity: "d".repeat(40),
      contractIdentity: "e".repeat(64),
      scenario: {
        id: "stale-record",
        label: "stale record",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      clock: () => now,
      writeEnabled: true,
    };
    try {
      const seeded = await runFixtureEvidenceGate({
        ...input,
        execute: async () => undefined,
      });
      const recordPath = path.join(
        root,
        "generated-root-quality",
        `${seeded.identity}.json`,
      );

      now = new Date("2026-07-07T23:59:59.999Z");
      assertPartialDeepStrictEqual(
        await runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("fresh evidence should not execute");
          },
        }),
        { status: "hit" },
      );

      now = new Date("2026-07-08T00:00:00.000Z");
      await assert.rejects(
        runFixtureEvidenceGate({
          ...input,
          execute: async () => {
            throw new Error("root quality failed");
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("root quality failed"),
      );
      assertPartialDeepStrictEqual(
        JSON.parse(await readFile(recordPath, "utf8")),
        {
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("prunes stale and structurally invalid records before publication", async () => {
    const root = await temporaryRepository("fixture-pruned-evidence-");
    const storage = new FileFixtureEvidenceStorage(root);
    const input = {
      gate: "generated-root-quality" as const,
      contractIdentity: "c".repeat(64),
      scenario: {
        id: "pruning",
        label: "pruning",
        presetIdentities: ["fixture"],
      },
      producerCommit: "producer",
      storage,
      writeEnabled: true,
      execute: async () => undefined,
    };
    try {
      const stale = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "1".repeat(40),
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      });
      const fresh = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "2".repeat(40),
        clock: () => new Date("2026-07-27T00:00:00.000Z"),
      });
      const gateRoot = path.join(root, "generated-root-quality");
      await writeFile(path.join(gateRoot, "invalid.json"), '{"schema":');

      assert.deepStrictEqual(
        await storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
        { removed: 2 },
      );
      assert.deepStrictEqual(await readdir(gateRoot), [
        `${fresh.identity}.json`,
      ]);
      await assert.rejects(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
        (error) => {
          assertPartialDeepStrictEqual(error, { code: "ENOENT" });
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("prunes stale and invalid Focused records without removing fresh evidence", async () => {
    const root = await temporaryRepository("fixture-pruned-focused-");
    const storage = new FileFixtureEvidenceStorage(root);
    const input = {
      gate: "focused-package-link" as const,
      contractIdentity: "d".repeat(64),
      scenario: {
        id: "focused-pruning",
        label: "focused pruning",
        presetIdentities: ["consumer", "provider"],
      },
      producerCommit: "producer",
      storage,
      writeEnabled: true,
      execute: async () => undefined,
    };
    try {
      const stale = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "3".repeat(40),
        rootEvidence: await successfulRootEvidence("3".repeat(40)),
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      });
      const fresh = await runFixtureEvidenceGate({
        ...input,
        generatedContentIdentity: "4".repeat(40),
        rootEvidence: await successfulRootEvidence("4".repeat(40)),
        clock: () => new Date("2026-07-27T00:00:00.000Z"),
      });
      const gateRoot = path.join(root, "focused-package-link");
      await writeFile(path.join(gateRoot, "invalid.json"), '{"schema":');

      assert.deepStrictEqual(
        await storage.prune({
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
        { removed: 2 },
      );
      assert.deepStrictEqual(await readdir(gateRoot), [
        `${fresh.identity}.json`,
      ]);
      await assert.rejects(
        readFile(path.join(gateRoot, `${stale.identity}.json`), "utf8"),
        (error) => {
          assertPartialDeepStrictEqual(error, { code: "ENOENT" });
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("owns the normalized Generated Root Quality contract and complete executor", async () => {
    const root = await temporaryRepository("fixture-root-contract-");
    const definition = builtInPresetRegistry.all()[0]!;
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: "/different/temporary/paths/do-not-identify-contracts",
        defaultPackageScope: "fixture",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const expectedTasks = plan.manifests.flatMap((manifest) => {
      if (
        typeof manifest.name !== "string" ||
        typeof manifest.scripts !== "object" ||
        manifest.scripts === null
      ) {
        return [];
      }
      const packageName = manifest.name;
      return Object.keys(manifest.scripts).map((taskName) => ({
        taskId: `${packageName.startsWith("@") ? packageName : "//"}#${taskName}`,
      }));
    });

    try {
      const contractIdentity =
        await deriveGeneratedRootQualityContractIdentity(plan);
      assert.match(contractIdentity, /^[0-9a-f]{64}$/u);

      await executeGeneratedRootQuality({
        plan,
        projectDir: path.join(root, "project"),
        fixtureWorkspace: root,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? { stdout: JSON.stringify({ tasks: expectedTasks }) }
            : {};
        },
      });

      assert.deepStrictEqual(calls[0], {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "format:check",
          "lint",
          "typecheck",
          "build",
          "test",
          "test:e2e",
          "--dry-run=json",
        ],
      });
      assertContainsEqual(calls, {
        command: "pnpm",
        args: ["run", "check"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("derives the Focused contract from the normalized consumer and provider plan", async () => {
    const workspace = await temporaryRepository("fixture-focused-contract-");
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const consumerPackagePath = scenario.linkFrom![0]!;
      const providerPackagePath =
        rendered.plan.blueprint.packageLinkIntents!.find(
          (intent) =>
            intent.consumerPackagePath === consumerPackagePath &&
            !planGeneratedRepositoryInitialization({
              definition: scenario.base,
              context: createGenerationContext({
                targetDir: path.join(workspace, scenario.id),
                defaultPackageScope: "focused",
                toolchain: {
                  nodeLtsMajor: "24",
                  packageManagerPin: "pnpm@11.11.0",
                  nodeVersion: releaseToolchainSnapshot.nodeVersion,
                },
              }),
            }).blueprint.packages.some(
              (definition) => definition.path === intent.providerPackagePath,
            ),
        )!.providerPackagePath;
      const input = {
        plan: rendered.plan,
        consumerPackagePath,
        providerPackagePath,
      } as const;

      assertPartialDeepStrictEqual(normalizedFocusedPackageLinkPlan(input), {
        gate: "focused-package-link",
        consumer: objectContaining({
          path: consumerPackagePath,
          name: any(String),
          role: any(String),
        }),
        provider: objectContaining({
          path: providerPackagePath,
          name: any(String),
          role: any(String),
        }),
        intent: {
          consumerPackagePath,
          providerPackagePath,
        },
      });
      assert.match(
        await deriveFocusedPackageLinkContractIdentity(input),
        /^[0-9a-f]{64}$/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("selects the Focused provider from the final Package Link Intent when addition also creates a helper package", async () => {
    const workspace = await temporaryRepository(
      "fixture-focused-provider-intent-",
    );
    try {
      const scenario = (await generatedScenariosFor("focused"))[0]!;
      const rendered = await renderMatrixScenario({ scenario, workspace });
      const consumerPackagePath = scenario.linkFrom![0]!;
      const expectedIntent = rendered.plan.blueprint.packageLinkIntents?.find(
        (intent) =>
          intent.consumerPackagePath === consumerPackagePath &&
          !planGeneratedRepositoryInitialization({
            definition: scenario.base,
            context: createGenerationContext({
              targetDir: path.join(workspace, scenario.id),
              defaultPackageScope: "fixture",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.11.0",
                nodeVersion: releaseToolchainSnapshot.nodeVersion,
              },
            }),
          }).blueprint.packages.some(
            (definition) => definition.path === intent.providerPackagePath,
          ),
      );
      assert.notStrictEqual(expectedIntent, undefined);
      const finalPlan = {
        ...rendered.plan,
        blueprint: {
          ...rendered.plan.blueprint,
          packages: [
            ...rendered.plan.blueprint.packages,
            {
              name: "@fixture/addition-helper",
              packageDefinitionId: `package-${"f".repeat(64)}` as const,
              path: "packages/addition-helper",
              role: "shared-library" as const,
            },
          ],
        },
      };

      assert.strictEqual(
        deriveFocusedPackageLinkPlanInput({
          initialPlan: planGeneratedRepositoryInitialization({
            definition: scenario.base,
            context: createGenerationContext({
              targetDir: path.join(workspace, "initial"),
              defaultPackageScope: "fixture",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.11.0",
                nodeVersion: releaseToolchainSnapshot.nodeVersion,
              },
            }),
          }),
          finalPlan,
          consumerPackagePaths: [consumerPackagePath],
        }).providerPackagePath,
        expectedIntent!.providerPackagePath,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("issues no Focused evidence when a provider probe fails after source consumption", async () => {
    const root = await temporaryRepository("fixture-focused-failure-");
    const projectDir = path.join(root, "project");
    const consumerPackagePath = "apps/consumer";
    const providerPackagePath = "packages/provider";
    const consumerRoot = path.join(projectDir, consumerPackagePath);
    const providerRoot = path.join(projectDir, providerPackagePath);
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    try {
      await Promise.all([
        mkdir(consumerRoot, { recursive: true }),
        mkdir(path.join(providerRoot, "src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(consumerRoot, "package.json"),
          `${JSON.stringify({ name: "@fixture/consumer" })}\n`,
        ),
        writeFile(
          path.join(providerRoot, "package.json"),
          `${JSON.stringify({
            name: "@fixture/provider",
            exports: {
              ".": {
                source: "./src/index.ts",
                default: "./dist/index.js",
              },
            },
          })}\n`,
        ),
        writeFile(
          path.join(providerRoot, "src/index.ts"),
          "export const provider = true;\n",
        ),
      ]);

      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "focused-package-link",
          generatedContentIdentity: "6".repeat(40),
          contractIdentity: "7".repeat(64),
          rootEvidence: await successfulRootEvidence("6".repeat(40)),
          scenario: {
            id: "focused-failure",
            label: "focused failure",
            presetIdentities: ["consumer", "provider"],
          },
          producerCommit: "producer",
          storage,
          clock: () => new Date("2026-07-28T00:00:00.000Z"),
          writeEnabled: true,
          execute: async () =>
            await executeFocusedPackageLink({
              scenarioLabel: "focused failure",
              projectDir,
              fixtureWorkspace: root,
              consumerPackagePath,
              providerPackagePath,
              run: async (command, args) => {
                if (args[0] === "install") return {};
                if (command === "node") {
                  return { stdout: await focusedMarker(projectDir) };
                }
                throw new Error("provider build cancelled");
              },
            }),
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("provider build cancelled"),
      );
      await assert.rejects(
        readdir(path.join(root, "evidence", "focused-package-link")),
        (error) => {
          assertPartialDeepStrictEqual(error, { code: "ENOENT" });
          return true;
        },
      );
      assert.deepStrictEqual(
        (await readdir(consumerRoot)).filter((entry) =>
          entry.includes("focused-provider-probe"),
        ),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
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
      assertLength(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
        scenarioCount,
      );
      assertLength(
        coldCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
        scenarioCount * 2,
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
      assertLength(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
        scenarioCount,
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "add",
        ),
        scenarioCount,
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ),
        scenarioCount,
      );
      assertLength(
        coldEvents.filter(
          (event) => event.type === "issuance" && event.outcome === "issued",
        ),
        scenarioCount,
      );
      assertLength(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
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
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node") {
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
      assertLength(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "generated-root-quality",
        ),
        scenarioCount,
      );
      assertLength(
        coldCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
        scenarioCount,
      );
      assert.strictEqual(focusedMisses.maximum(), 2);
      assertLength(
        coldEvents.filter(
          (event) =>
            event.type === "issuance" &&
            event.outcome === "issued" &&
            event.gate === "focused-package-link",
        ),
        scenarioCount,
      );
      for (const command of coldCommands.filter(
        ({ command, args }) =>
          command === "node" && args.includes("--conditions=source"),
      )) {
        const projectDir = path.dirname(path.dirname(command.cwd));
        const scenarioCommands = coldCommands.filter(({ cwd }) =>
          cwd.startsWith(projectDir),
        );
        assert.ok(
          scenarioCommands.findIndex(
            ({ command: name, args }) =>
              name === "pnpm" && args[0] === "run" && args[1] === "check",
          ) < scenarioCommands.indexOf(command),
        );
      }

      assert.deepStrictEqual(
        warmCommands.filter(({ command }) => command !== "git"),
        [],
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "init",
        ),
        scenarioCount,
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) => command === "git" && args[0] === "write-tree",
        ),
        scenarioCount,
      );
      assertLength(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
        scenarioCount * 2,
      );
      assert.deepStrictEqual(
        warmEvents.filter((event) => event.type === "execution"),
        [],
      );
      assertLength(
        rootChangedCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
        scenarioCount * 2,
      );
      assert.deepStrictEqual(
        rootChangedCommands.filter(({ command }) => command === "node"),
        [],
      );
      assertLength(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "succeeded",
        ),
        scenarioCount,
      );
      assertLength(
        rootChangedEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ),
        scenarioCount,
      );
      assert.deepStrictEqual(
        rootChangedEvents.filter(
          (event) =>
            event.type === "execution" && event.gate === "focused-package-link",
        ),
        [],
      );
      assertLength(
        rootExpiredCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "check",
        ),
        scenarioCount * 2,
      );
      assert.deepStrictEqual(
        rootExpiredCommands.filter(({ command }) => command === "node"),
        [],
      );
      assertLength(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "miss" &&
            event.reason === "stale",
        ),
        scenarioCount,
      );
      assertLength(
        rootExpiredEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "hit",
        ),
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
            command === "node"
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
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
        }
        if (
          command === "pnpm" &&
          args.includes("build") &&
          args.includes("--force")
        ) {
          await materializeFocusedProviderBuild(options.cwd);
        }
        if (command === "node") {
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
      assertLength(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "hit",
        ),
        scenarioCount,
      );
      assertLength(
        partialWarmEvents.filter(
          (event) =>
            event.type === "lookup" &&
            event.gate === "focused-package-link" &&
            event.outcome === "miss",
        ),
        scenarioCount,
      );
      assertLength(
        partialWarmCommands.filter(
          ({ command, args }) => command === "pnpm" && args[0] === "install",
        ),
        scenarioCount,
      );
      assertLength(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "pnpm" &&
            args.includes("build") &&
            args.includes("--force"),
        ),
        scenarioCount,
      );
      assertLength(
        partialWarmCommands.filter(
          ({ command, args }) =>
            command === "node" && args.includes("--conditions=source"),
        ),
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
            if (args.includes("--dry-run=json")) {
              return {
                stdout: JSON.stringify({
                  tasks: (await generatedTaskIds(options.cwd)).map(
                    (taskId) => ({ taskId }),
                  ),
                }),
              };
            }
            if (
              command === "pnpm" &&
              args[0] === "run" &&
              args[1] === "check"
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
      await waitFor(
        () => {
          assertLength(
            events.filter(
              (event) =>
                event.type === "execution" &&
                event.gate === "generated-root-quality" &&
                event.outcome === "failed",
            ),
            scenarioCount,
          );
        },
        { timeout: 5_000 },
      );
      assertLength(reads, scenarioCount);
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

  void it("reconciles the complete Package Addition Matrix before warm Root Quality lookup", async () => {
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
        if (args.includes("--dry-run=json")) {
          return {
            stdout: JSON.stringify({
              tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                taskId,
              })),
            }),
          };
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
      assertLength(
        coldCommands.filter(
          ({ command, args }) =>
            command === "git" && gitSubcommand(args) === "init",
        ),
        scenarioCount,
      );
      assertLength(
        coldCommands.filter(
          ({ command, args }) =>
            command === "git" && gitSubcommand(args) === "add",
        ),
        scenarioCount * 4,
      );
      assertLength(
        coldCommands.filter(
          ({ command, args }) =>
            command === "pnpm" && args[0] === "run" && args[1] === "fix",
        ),
        scenarioCount,
      );
      const coldInstalls = coldCommands.filter(
        ({ command, args }) => command === "pnpm" && args[0] === "install",
      );
      assertLength(coldInstalls, scenarioCount);
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
      assertLength(
        warmCommands.filter(
          ({ command, args }) =>
            command === "git" && gitSubcommand(args) === "init",
        ),
        scenarioCount,
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) =>
            command === "git" && gitSubcommand(args) === "add",
        ),
        scenarioCount * 2,
      );
      assertLength(
        warmCommands.filter(
          ({ command, args }) =>
            command === "git" && gitSubcommand(args) === "write-tree",
        ),
        scenarioCount,
      );
      assertLength(
        warmEvents.filter(
          (event) => event.type === "lookup" && event.outcome === "hit",
        ),
        scenarioCount,
      );
      assert.deepStrictEqual(
        warmEvents.filter((event) => event.type === "execution"),
        [],
      );
      await assert.rejects(readFile(invalidRecordPath, "utf8"), (error) => {
        assertPartialDeepStrictEqual(error, {
          code: "ENOENT",
        });
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
              scenario.addition?.metadata.name ?? scenario.base.metadata.name,
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
  });

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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
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

  void it("schedules real matrix misses by final Check Environment Needs", async () => {
    const workspace = await temporaryRepository("fixture-matrix-scheduling-");
    const installedScenarios: string[] = [];
    const acquiredLeases: (readonly FixtureEvidenceExecutionResource[])[] = [];
    const scheduledRuns: (readonly FixtureEvidenceExecutionResource[])[] = [];
    const needsByScenario = new Map<
      string,
      { readonly check: readonly { readonly kind?: string }[] }
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
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          return {};
        },
      });

      const scenarios = await generatedScenariosFor("package-addition-matrix");
      const scenarioIds = scenarios.map(({ id }) => id).sort();
      assert.strictEqual(schedulerFactory.mock.callCount(), 1);
      assertMockCalledWith(schedulerFactory, { concurrency: 4 });
      assertLength(scheduledRuns, scenarios.length);
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
    { timeout: 180000 },
    async () => {
      const root = await temporaryRepository("fixture-matrix-invalidation-");
      const evidenceRoot = path.join(root, "evidence");
      const storage = new FileFixtureEvidenceStorage(evidenceRoot);
      const clock = () => new Date("2026-07-28T00:00:00.000Z");

      try {
        const scenarios = await generatedScenariosFor(
          "package-addition-matrix",
        );
        const candidate = scenarios.find((scenario) => {
          const addition = scenario.addition;
          if (addition?.planPackageAddition === undefined) return false;
          const context = createGenerationContext({
            targetDir: path.join(root, "candidate"),
            defaultPackageScope: "fixture",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          });
          const packageLeafName = `fixture-${addition.metadata.name}`;
          const packagePath = addition.defaultPackagePath?.({
            context,
            packageLeafName,
          });
          if (packagePath === undefined) return false;
          const contribution = addition.planPackageAddition({
            context,
            packageLeafName,
            packagePath,
          });
          return contribution.operations.some(
            (operation) =>
              "source" in operation && operation.source === addition.source,
          );
        });
        assert.notStrictEqual(candidate?.addition, undefined);
        const selectedAddition = candidate!.addition!;
        const sourceRoot = resolveBuiltInTemplateSource(
          selectedAddition.source,
          ".",
        );
        const changedSourceRoot = path.join(root, "changed-preset-source");
        await cp(sourceRoot, changedSourceRoot, { recursive: true });
        const sampleContext = createGenerationContext({
          targetDir: path.join(root, "sample"),
          defaultPackageScope: "fixture",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        });
        const sampleLeafName = `fixture-${selectedAddition.metadata.name}`;
        const samplePackagePath = selectedAddition.defaultPackagePath!({
          context: sampleContext,
          packageLeafName: sampleLeafName,
        });
        const sampleContribution = selectedAddition.planPackageAddition!({
          context: sampleContext,
          packageLeafName: sampleLeafName,
          packagePath: samplePackagePath,
        });
        const changedOperation = sampleContribution.operations.find(
          (operation) =>
            "source" in operation &&
            operation.source === selectedAddition.source &&
            "from" in operation &&
            typeof operation.from === "string",
        );
        assert.notStrictEqual(changedOperation, undefined);
        if (
          changedOperation === undefined ||
          !("from" in changedOperation) ||
          typeof changedOperation.from !== "string"
        ) {
          throw new Error(
            "Expected a Preset-local source-backed Package Addition output",
          );
        }
        const changedSourceFile = path.join(
          changedSourceRoot,
          changedOperation.from,
        );
        const originalSource = await readFile(changedSourceFile);
        await writeFile(
          changedSourceFile,
          Buffer.concat([
            originalSource,
            Buffer.from("\n// Preset-local fixture evidence change\n"),
          ]),
        );
        const changedSource = createTemplateSourceHandle(changedSourceRoot);
        const changedAddition: BuiltInPresetDefinition = {
          ...selectedAddition,
          source: changedSource,
          planPackageAddition(options) {
            return replaceContributionTemplateSource({
              contribution: selectedAddition.planPackageAddition!(options),
              from: selectedAddition.source,
              to: changedSource,
            });
          },
        };

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
            await deriveGeneratedRootQualityContractIdentity(rendered.plan, {
              includeFix: true,
            });
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
                scenario.base.metadata.name,
                ...(scenario.addition === undefined
                  ? []
                  : [scenario.addition.metadata.name]),
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
          assertPartialDeepStrictEqual(
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
            ...(usesChangedAddition ? { addition: changedAddition } : {}),
          });
          const previous = baseline.get(scenario.id)!;
          if (
            rendered.generatedContentIdentity !==
            previous.generatedContentIdentity
          ) {
            changedTrees.push(scenario.id);
          }
          const result = await runFixtureEvidenceGate({
            gate: "generated-root-quality",
            generatedContentIdentity: rendered.generatedContentIdentity,
            contractIdentity: await deriveGeneratedRootQualityContractIdentity(
              rendered.plan,
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

  void it(
    "runs all four source CLI scenario sets warm without an expensive command",
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
        "packages/checks/src/check-generated-registry.ts",
      );
      const healthCliPath = path.join(
        process.cwd(),
        "packages/checks/src/check-fixture-evidence-health.ts",
      );
      try {
        await mkdir(binRoot, { recursive: true });
        await writeFile(
          pnpmPath,
          `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeSync } from "node:fs";
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

if (commandArgs.includes("--dry-run=json")) {
  const tasks = [];
  for (const { value: manifest } of manifests) {
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          tasks.push({
            taskId: (manifest.name.startsWith("@") ? manifest.name : "//") + "#" + taskName,
          });
        }
  }
  writeSync(1, JSON.stringify({ tasks }));
}

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
        assertNotLength(
          coldCommands.filter(
            ([binary, command]) => binary === "pnpm" && command === "install",
          ),
          0,
        );
        assertNotLength(
          coldCommands.filter(
            ([binary, command, task]) =>
              binary === "pnpm" && command === "run" && task === "check",
          ),
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
              `^type=local,src=${path.join(evidenceRoot, "buildkit")}/[0-9a-f]{64}$`,
              "u",
            ),
          );
          assert.match(
            command[cacheTo + 1]!,
            new RegExp(
              `^type=local,dest=${path.join(evidenceRoot, "buildkit")}/[0-9a-f]{64},mode=max$`,
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
        assertPartialDeepStrictEqual(
          await execa(
            process.execPath,
            ["--conditions=source", healthCliPath],
            {
              cwd: process.cwd(),
              env: warmEnv,
            },
          ),
          { exitCode: 0 },
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
            assertPartialDeepStrictEqual(error, {
              exitCode: 1,
              stderr: stringContaining(
                "Enabled scenario set init has no current-run activity",
              ),
            });
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
        mkdir(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/root-quality",
          ),
          { recursive: true },
        ),
        mkdir(
          path.join(root, "packages/checks/src/fixture-evidence/gates/focused"),
          { recursive: true },
        ),
        mkdir(path.join(root, "packages/checks/src/fixture-evidence/kernel"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/root-quality/index.ts",
          ),
          'import "../focused/index.ts";\nimport "../../../outside.ts";\n',
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/gates/focused/index.ts",
          ),
          "export {};\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/kernel/kernel.test.ts",
          ),
          "export {};\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/checks/src/fixture-evidence/kernel/index.ts",
          ),
          'import "../gates/root-quality/index.ts";\n',
        ),
        writeFile(
          path.join(root, "packages/checks/src/check-generated-registry.ts"),
          'async function scenario() { await run("pnpm", ["run", "check"], { cwd: "." }); await run("node", ["--conditions=source", "probe.mjs"], { cwd: "." }); await run("docker", ["version"], { cwd: "." }); await run("pnpm", ["run", "check:deployment"], { cwd: "." }); }\n',
        ),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
          objectContaining({
            rule: "gate-runtime-import-outside-contract",
          }),
          objectContaining({
            rule: "kernel-runtime-import-outside-kernel",
          }),
          objectContaining({ rule: "production-test-source" }),
          objectContaining({ rule: "hidden-root-quality-command" }),
          objectContaining({
            rule: "hidden-focused-package-link-command",
          }),
          objectContaining({
            rule: "hidden-deployment-quality-command",
          }),
        ]),
      );
      assert.deepStrictEqual(
        await findFixtureEvidenceArchitectureFindings(process.cwd()),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("enforces gate and kernel ownership for dynamic imports and concatenated specifiers", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-import-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused",
    );
    const kernel = path.join(
      root,
      "packages/checks/src/fixture-evidence/kernel",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
        mkdir(kernel, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          'await import("../focused/" + "index.ts");\n',
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
        writeFile(
          path.join(kernel, "index.ts"),
          [
            'const gateModule = "../gates/root-quality/index.ts";',
            "await import(gateModule);",
            "",
          ].join("\n"),
        ),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
          objectContaining({
            rule: "kernel-runtime-import-outside-kernel",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects createRequire property calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire } from "node:module";',
            'createRequire(import.meta.url).require("../focused-package-link/index.ts");',
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects direct CommonJS require calls that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-direct-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.cts"),
          'require("../focused-package-link/index.ts");\n',
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects callable createRequire results that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-callable-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire } from "node:module";',
            'createRequire(import.meta.url)("../focused-package-link/index.ts");',
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects aliased createRequire loaders that cross gate ownership", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-create-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    const focusedGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/focused-package-link",
    );
    try {
      await Promise.all([
        mkdir(rootGate, { recursive: true }),
        mkdir(focusedGate, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(rootGate, "index.ts"),
          [
            'import { createRequire as makeRequire } from "node:module";',
            "const loadModule = makeRequire(import.meta.url);",
            "const loadAlias = loadModule;",
            'const target = "../focused-package-link/index.ts";',
            "loadAlias(target);",
            "",
          ].join("\n"),
        ),
        writeFile(path.join(focusedGate, "index.ts"), "export {};\n"),
      ]);

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({ rule: "cross-gate-runtime-import" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an aliased CommonJS loader target is dynamic", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-require-architecture-",
    );
    const rootGate = path.join(
      root,
      "packages/checks/src/fixture-evidence/gates/root-quality",
    );
    try {
      await mkdir(rootGate, { recursive: true });
      await writeFile(
        path.join(rootGate, "index.ts"),
        [
          'import { createRequire } from "node:module";',
          "const loadModule = createRequire(import.meta.url);",
          "const loadAlias = loadModule;",
          "loadAlias(process.env.GATE_TARGET);",
          "",
        ].join("\n"),
      );

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({
            rule: "gate-runtime-import-outside-contract",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects hidden Root Quality commands regardless of orchestrator invocation form", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-boundary-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    const bypasses = [
      'const invoke = run;\ninvoke("pnpm", ["run", "check"], { cwd: "." });\n',
      'options.run("pnpm", ["install"], { cwd: "." });\n',
      'execa("pnpm", ["run", "fix"], { cwd: "." });\n',
      'const invoke = (command, args) => processRunner(command, args);\ninvoke("pnpm", ["run", "check"]);\n',
      'const args = ["run", "check"];\nrun("pnpm", args, { cwd: "." });\n',
      'run("p" + "npm", ["r" + "un", `ch${"eck"}`], { cwd: "." });\n',
    ] as const;
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      for (const source of bypasses) {
        await writeFile(orchestrator, source);
        assertDeepStrictEqualWithMatchers(
          await findFixtureEvidenceArchitectureFindings(root),
          arrayContaining([
            objectContaining({ rule: "hidden-root-quality-command" }),
          ]),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an orchestrator executor receives dynamic gate arguments", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "async function scenario(run) {",
          '  await run("pnpm", ["run", process.env.TASK ?? "check:deployment"], { cwd: "." });',
          "}",
          "",
        ].join("\n"),
      );

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed for dynamically computed gate arguments through a runner alias", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-aliased-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "type GeneratedCommandRunner = (command: string, args: readonly string[]) => Promise<unknown>;",
          "async function scenario(options: { readonly run: GeneratedCommandRunner }) {",
          "  const { run: invoke } = options;",
          '  await invoke("pnpm", ["run", process.env.TASK ?? "check:deployment"]);',
          "}",
          "",
        ].join("\n"),
      );

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed when an ordinary orchestrator function forwards dynamic commands", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-forwarded-dynamic-orchestrator-command-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          "async function scenario(command, args) {",
          "  await run(command, args);",
          "}",
          'await scenario("pnpm", ["run", "check:deployment"]);',
          "",
        ].join("\n"),
      );

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({
            rule: "unassigned-orchestrator-command",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects dependency installation contracts owned by the scenario orchestrator", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-orchestrator-install-contract-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          'import { fixtureDependencyInstallationPlan as installPlan } from "./fixture-evidence/kernel/index.ts";',
          'const dependencyInstallArgs = ["install", "--store-dir", "/tmp/store"];',
          "await executeDeploymentQuality({ dependencyInstallArgs, installPlan });",
          "",
        ].join("\n"),
      );

      assertDeepStrictEqualWithMatchers(
        await findFixtureEvidenceArchitectureFindings(root),
        arrayContaining([
          objectContaining({
            rule: "orchestrator-dependency-install-contract",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("allows command-runner adapters and ignores unrelated command-like values", async () => {
    const root = await temporaryRepository(
      "fixture-evidence-command-false-positive-",
    );
    const orchestrator = path.join(
      root,
      "packages/checks/src/check-generated-registry.ts",
    );
    try {
      await mkdir(path.dirname(orchestrator), { recursive: true });
      await writeFile(
        orchestrator,
        [
          'import { execa } from "execa";',
          "type GeneratedCommandRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<unknown>;",
          "const run: GeneratedCommandRunner = async (command, args, options) =>",
          "  await execa(command, [...args], options);",
          'const documentation = ["install", "check", "fix"];',
          'const markerExample = "focused-provider-marker:";',
          'const sourceConditionDocumentation = "--conditions=source";',
          "const renderExample = (command: string, args: readonly unknown[]) => ({ command, args });",
          'renderExample("pnpm", ["run", process.env.TASK ?? "check:deployment"]);',
          "const scheduler = { run: async (resources: readonly string[], work: () => Promise<void>) => await work() };",
          'await scheduler.run([process.env.RESOURCE ?? "docker"], async () => undefined);',
          "export { documentation, markerExample, run, sourceConditionDocumentation };",
          "",
        ].join("\n"),
      );

      assert.deepStrictEqual(
        await findFixtureEvidenceArchitectureFindings(root),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
