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
import { afterEach, mock } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { execa } from "execa";

import { findFixtureEvidenceArchitectureFindings } from "../src/check-fixture-evidence-architecture.ts";
import {
  fixtureContainerEnvironmentFromEnvironment,
  fixtureDependencyCachesFromEnvironment,
  generatedScenariosFor,
  runGeneratedRegistryCli as runGeneratedRegistryCliProduction,
  runGeneratedScenarioSet as runGeneratedScenarioSetProduction,
} from "../src/check-generated-registry.ts";
import {
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  executeFocusedPackageLink,
  normalizedFocusedPackageLinkPlan,
} from "../src/fixture-evidence/gates/focused-package-link/index.ts";
import {
  deriveGeneratedRootQualityContractIdentity,
  executeGeneratedRootQuality,
  generatedRootQualityExecutionResources,
} from "../src/fixture-evidence/gates/root-quality/index.ts";
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
} from "../src/fixture-evidence/kernel/index.ts";
import { materializeGeneratedScenario } from "../src/generated-content.ts";
import {
  validatePlanDependencyCatalog,
  validatePlanSources,
} from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";
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
  const activeWaiters = new Set<{
    readonly expected: number;
    readonly resolve: () => void;
  }>();
  return {
    enter: async (): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      for (const waiter of activeWaiters) {
        if (active === waiter.expected) {
          activeWaiters.delete(waiter);
          waiter.resolve();
        }
      }
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
    whenActive: (expected: number): Promise<void> => {
      if (active === expected) return Promise.resolve();
      return new Promise<void>((resolve) => {
        activeWaiters.add({ expected, resolve });
      });
    },
    active: (): number => active,
    maximum: (): number => maximum,
  };
}

function createBlockedWorkProbe() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const startWaiters = new Set<{
    readonly expected: number;
    readonly resolve: () => void;
  }>();
  let active = 0;
  let maximum = 0;
  return {
    run: async (name: string): Promise<void> => {
      started.push(name);
      for (const waiter of startWaiters) {
        if (started.length >= waiter.expected) {
          startWaiters.delete(waiter);
          waiter.resolve();
        }
      }
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
    whenStarted: (expected: number): Promise<void> => {
      if (started.length >= expected) return Promise.resolve();
      return new Promise<void>((resolve) => {
        startWaiters.add({ expected, resolve });
      });
    },
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
    await Promise.race([
      options.probe.whenActive(options.expected),
      options.execution.then(() => {
        throw new Error(
          `Fixture execution completed before ${options.expected} probe tasks were active`,
        );
      }),
    ]);
  } catch (error) {
    observationFailure = error;
  } finally {
    options.probe.release();
  }
  await options.execution;
  if (observationFailure !== undefined) throw observationFailure;
}

type MatrixScenario = Awaited<ReturnType<typeof generatedScenariosFor>>[number];

async function renderMatrixScenario(options: {
  readonly scenario: MatrixScenario;
  readonly workspace: string;
}): Promise<{
  readonly generatedContentIdentity: string;
  readonly receipt: import("../src/generated-content.ts").GeneratedScenarioReceipt;
}> {
  const receipt = await materializeGeneratedScenario({
    runtime: sourceGeneratedScenarioRuntime,
    scenario: options.scenario,
    workspace: options.workspace,
  });
  if (receipt.status === "not-applicable") {
    throw new Error(
      `${options.scenario.id}: not applicable for matrix rendering`,
    );
  }
  await validatePlanSources({
    receipt,
    runtime: sourceGeneratedScenarioRuntime,
  });
  await validatePlanDependencyCatalog(
    receipt.result,
    receipt.projectDir,
    receipt.scenario.id,
  );
  await initializeFixtureGitRepository({ repositoryRoot: receipt.projectDir });

  return {
    generatedContentIdentity: await writeGeneratedRepositoryTree({
      repositoryRoot: receipt.projectDir,
    }),
    receipt,
  };
}
export {
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  access,
  afterEach,
  assert,
  checkFixtureEvidenceHealth,
  chmod,
  cp,
  createBlockedConcurrencyProbe,
  createBlockedWorkProbe,
  createFixtureEvidenceScheduler,
  createSuccessfulFixturePhaseExecutor,
  deriveFixtureGateContractIdentity,
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  deriveGeneratedRootQualityContractIdentity,
  execa,
  executeFocusedPackageLink,
  executeGeneratedRootQuality,
  findFixtureEvidenceArchitectureFindings,
  fixtureContainerEnvironmentFromEnvironment,
  fixtureDependencyCachesFromEnvironment,
  fixtureExecutorTestRunner,
  focusedMarker,
  formatFixtureEvidenceHealthReport,
  generatedRootQualityExecutionResources,
  generatedScenariosFor,
  initializeFixtureGitRepository,
  isDeepStrictEqual,
  isolatedFixtureEnvironment,
  materializeFocusedProviderBuild,
  mkdir,
  mkdtemp,
  normalizedFocusedPackageLinkPlan,
  path,
  readFile,
  readdir,
  recordSuccessfulFixturePhase,
  releaseAfterActive,
  renderMatrixScenario,
  rm,
  runFixtureEvidenceGate,
  runGeneratedRegistryCli,
  runGeneratedRegistryCliProduction,
  runGeneratedScenarioSet,
  runGeneratedScenarioSetProduction,
  successfulRootEvidence,
  symlink,
  temporaryRepository,
  textBelow,
  tmpdir,
  validatePlanDependencyCatalog,
  validatePlanSources,
  writeFile,
  writeGeneratedRepositoryTree,
};

export type {
  FixtureActivityRecorder,
  FixtureCommandRunner,
  FixtureEvidenceActivityLedger,
  FixtureEvidenceExecutionResource,
  FixtureEvidenceGate,
  FixtureEvidenceInvocationEvent,
  FixtureEvidenceLifecycleEvent,
  FixtureEvidencePhase,
  FixtureEvidencePhaseScope,
  FixtureEvidenceScenarioDiagnostics,
  FixtureEvidenceSchedulerFactory,
  FixtureEvidenceStorage,
  MatrixScenario,
};
