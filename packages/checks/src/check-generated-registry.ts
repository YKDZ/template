#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  deploymentQualityExecutionResources,
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
} from "./fixture-evidence/gates/deployment-quality/index.ts";
import {
  deriveFocusedPackageLinkContractIdentity,
  deriveFocusedPackageLinkPlanInput,
  executeFocusedPackageLink,
} from "./fixture-evidence/gates/focused-package-link/index.ts";
import {
  deriveGeneratedRootQualityContractIdentity,
  executeGeneratedRootQuality,
  generatedRootQualityExecutionResources,
} from "./fixture-evidence/gates/root-quality/index.ts";
import {
  checkFixtureEvidenceHealth,
  createDevelopmentContainerFixtureSession,
  createFixtureEvidenceScheduler,
  defaultDevelopmentContainerSessionConcurrency,
  deriveDevelopmentContainerBuildIdentity,
  fixtureCommandTimeoutMilliseconds,
  fixtureCleanupTimeoutMilliseconds,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  formatFixtureEvidenceHealthReport,
  initializeFixtureGitRepository,
  runFixtureEvidenceGate,
  stageFixtureGitRepository,
  writeGeneratedRepositoryTree,
  type FixtureEvidenceActivityLedger,
  type FixtureCommandOptions,
  type DevelopmentContainerFixtureDependencyCaches,
  type FixtureEvidenceInvocationEvent,
  type FixtureEvidenceLifecycleEvent,
  type FixtureEvidenceGate,
  type FixtureEvidencePhase,
  type FixtureEvidencePhaseScope,
  type FixtureEvidenceScenarioActivityEvent,
  type FixtureEvidenceExecutionResource,
  type FixtureEvidenceScheduler,
  type FixtureEvidenceSchedulerFactory,
  type FixtureEvidenceSchedulingOptions,
  type FixtureEvidenceStorage,
} from "./fixture-evidence/kernel/index.ts";
import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  validateGeneratedDevelopmentContainerProjection,
  validatePlanDependencyCatalog,
  validatePlanSources,
  type GeneratedScenario,
} from "./registry-checks.ts";

export { assertGeneratedTaskDiscovery } from "./fixture-evidence/gates/root-quality/index.ts";

type GeneratedScenarioSet =
  | "init"
  | "package-addition-matrix"
  | "focused"
  | "deployment";

const scenarioSetReproductionCommands: Record<GeneratedScenarioSet, string> = {
  init: "pnpm --filter @ykdz/template-checks check:generated",
  "package-addition-matrix":
    "pnpm --filter @ykdz/template-checks check:fixtures",
  focused: "pnpm --filter @ykdz/template-checks check:focused",
  deployment: "pnpm --filter @ykdz/template-checks check:deployment",
};

const fixtureFailureReportName = "fixture-failure.json";

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export type GeneratedScenarioRunOptions = {
  readonly workspace: string;
  readonly reporter?: { readonly info?: (message: string) => void };
  readonly run?: GeneratedCommandRunner;
  readonly cancelSignal?: AbortSignal;
  readonly scheduling?: FixtureEvidenceSchedulingOptions;
  readonly schedulerFactory?: FixtureEvidenceSchedulerFactory;
  readonly buildKitCacheDirectory?: string;
  readonly dependencyCaches?:
    | DevelopmentContainerFixtureDependencyCaches
    | undefined;
  readonly containerEnvironment?: NodeJS.ProcessEnv;
  readonly evidence?: {
    readonly storage?: FixtureEvidenceStorage;
    readonly clock?: () => Date;
    readonly freshnessMilliseconds?: number;
    readonly readEnabled?: boolean;
    readonly writeEnabled?: boolean;
    readonly producerCommit?: string;
    readonly recordLifecycle?: (
      event: FixtureEvidenceLifecycleEvent,
    ) => void | Promise<void>;
    readonly activity?: {
      readonly ledger: FixtureEvidenceActivityLedger;
      readonly runId: string;
      readonly runAttempt: string;
    };
  };
};

type InternalGeneratedScenarioRunOptions = GeneratedScenarioRunOptions & {
  readonly failureSecrets?: readonly string[];
  readonly onCleanupFailure?: (error: unknown) => void;
  readonly recordActivity?: (
    event: FixtureEvidenceScenarioActivityEvent,
  ) => void | Promise<void>;
};

export type GeneratedCommandRunner = (
  command: string,
  args: readonly string[],
  options: FixtureCommandOptions,
) => Promise<unknown>;

const fixtureEnvironment = {
  buildKitCacheDirectory: "TEMPLATE_FIXTURE_BUILDKIT_CACHE_DIR",
  cargoCacheDirectory: "TEMPLATE_FIXTURE_CARGO_CACHE_DIR",
  concurrency: "TEMPLATE_FIXTURE_CONCURRENCY",
  developmentContainerSessions:
    "TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS",
  directory: "TEMPLATE_FIXTURE_EVIDENCE_DIR",
  read: "TEMPLATE_FIXTURE_EVIDENCE_READ",
  write: "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
  activityDirectory: "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
  runId: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
  runAttempt: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
  pnpmCacheDirectory: "TEMPLATE_FIXTURE_PNPM_CACHE_DIR",
  workspaceDirectory: "TEMPLATE_FIXTURE_WORKSPACE_DIR",
} as const;

const fixtureFailureEnvironmentNames = [
  fixtureEnvironment.concurrency,
  fixtureEnvironment.developmentContainerSessions,
  fixtureEnvironment.directory,
  fixtureEnvironment.read,
  fixtureEnvironment.write,
  fixtureEnvironment.activityDirectory,
  fixtureEnvironment.runId,
  fixtureEnvironment.runAttempt,
  fixtureEnvironment.buildKitCacheDirectory,
  fixtureEnvironment.pnpmCacheDirectory,
  fixtureEnvironment.cargoCacheDirectory,
  fixtureEnvironment.workspaceDirectory,
] as const;

const defaultFixtureWorkspaceDirectory = path.join(
  defaultRepositoryRoot,
  ".fixture-workspace",
);

const fixtureTurboEnvironment = [
  ["TURBO_TEAM", "TEMPLATE_FIXTURE_TURBO_TEAM"],
  ["TURBO_TOKEN", "TEMPLATE_FIXTURE_TURBO_TOKEN"],
  [
    "TURBO_REMOTE_CACHE_SIGNATURE_KEY",
    "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY",
  ],
  [
    "TURBO_REMOTE_CACHE_READ_ONLY",
    "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY",
  ],
] as const;

export function fixtureContainerEnvironmentFromEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    fixtureTurboEnvironment.flatMap(([containerName, fixtureName]) => {
      const value = environment[fixtureName] ?? environment[containerName];
      return value === undefined || value.length === 0
        ? []
        : [[containerName, value]];
    }),
  );
}

export function fixtureDependencyCachesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DevelopmentContainerFixtureDependencyCaches | undefined {
  const configured = (
    name:
      | typeof fixtureEnvironment.pnpmCacheDirectory
      | typeof fixtureEnvironment.cargoCacheDirectory,
  ): string | undefined => {
    const value = environment[name];
    if (value === undefined) return undefined;
    if (value.length === 0) {
      throw new Error(`${name} must not be empty`);
    }
    return path.resolve(value);
  };
  const pnpm = configured(fixtureEnvironment.pnpmCacheDirectory);
  const cargo = configured(fixtureEnvironment.cargoCacheDirectory);
  if (pnpm === undefined && cargo === undefined) return undefined;
  return {
    ...(pnpm === undefined ? {} : { pnpm }),
    ...(cargo === undefined ? {} : { cargo }),
  };
}

function configuredBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined) return defaultValue;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

function configuredPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const value = environment[name];
  if (value === undefined) return defaultValue;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return `${error}`;
  }
  try {
    return JSON.stringify(error) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function hasFailureCause(
  error: unknown,
  expected: unknown,
  depth = 0,
): boolean {
  if (error === expected) return true;
  if (depth >= 12 || !(error instanceof Error) || error.cause === undefined) {
    return false;
  }
  return hasFailureCause(error.cause, expected, depth + 1);
}

function fixtureFailureSecretValues(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        value.length > 0 &&
        /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNATURE_KEY|CREDENTIAL)/iu.test(
          name,
        ),
    )
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
}

function redactFixtureFailureText(
  value: string,
  secrets: readonly string[],
): string {
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    value,
  );
}

function describeFixtureFailure(
  error: unknown,
  secrets: readonly string[],
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return { message: "Failure nesting exceeded report limit" };
  if (!(error instanceof Error)) {
    return {
      message: redactFixtureFailureText(failureMessage(error), secrets),
      type: typeof error,
    };
  }
  const description: Record<string, unknown> = {
    name: error.name,
    message: redactFixtureFailureText(error.message, secrets),
    ...(error.stack === undefined
      ? {}
      : { stack: redactFixtureFailureText(error.stack, secrets) }),
  };
  for (const property of [
    "code",
    "signal",
    "timedOut",
    "isCanceled",
    "exitCode",
    "killed",
  ] as const) {
    const value = (error as Error & Record<string, unknown>)[property];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      description[property] = value;
    }
  }
  for (const property of [
    "shortMessage",
    "command",
    "cwd",
    "stdout",
    "stderr",
  ] as const) {
    const value = (error as Error & Record<string, unknown>)[property];
    if (typeof value === "string") {
      const redacted = redactFixtureFailureText(value, secrets);
      const outputLimit = 64 * 1024;
      description[property] =
        (property === "stdout" || property === "stderr") &&
        redacted.length > outputLimit
          ? `[leading output truncated: ${redacted.length - outputLimit} characters]\n${redacted.slice(-outputLimit)}`
          : redacted;
    }
  }
  if (error instanceof AggregateError) {
    description.errors = error.errors.map((nested) =>
      describeFixtureFailure(nested, secrets, depth + 1),
    );
  }
  if (error.cause !== undefined) {
    description.cause = describeFixtureFailure(error.cause, secrets, depth + 1);
  }
  return description;
}

function reportFixtureFailure(
  reporter: GeneratedScenarioRunOptions["reporter"],
  message: string,
): void {
  try {
    reporter?.info?.(message);
  } catch {
    // 诊断输出失败时仍保留 Fixture 原始失败。
  }
}

async function persistFixtureFailureReport(options: {
  readonly scenarioSet: GeneratedScenarioSet;
  readonly workspace: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly error: unknown;
  readonly reporter?: GeneratedScenarioRunOptions["reporter"];
}): Promise<void> {
  const reportPath = path.join(options.workspace, fixtureFailureReportName);
  const secrets = fixtureFailureSecretValues(options.environment);
  const report = {
    schema: "template-fixture-failure/v1",
    scenarioSet: options.scenarioSet,
    reproductionCommand: scenarioSetReproductionCommands[options.scenarioSet],
    repositoryDirectory: defaultRepositoryRoot,
    generatedWorkspace: options.workspace,
    generatedArtifactDirectory: options.workspace,
    failureReport: reportPath,
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureCommandTimeoutMilliseconds,
    fixtureCleanupTimeoutMilliseconds,
    environment: Object.fromEntries(
      fixtureFailureEnvironmentNames.flatMap((name) =>
        options.environment[name] === undefined
          ? []
          : [[name, options.environment[name]]],
      ),
    ),
    failure: describeFixtureFailure(options.error, secrets),
  };
  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (reportError) {
    reportFixtureFailure(
      options.reporter,
      `[Fixture Evidence] Could not write failure report ${reportPath}: ${redactFixtureFailureText(failureMessage(reportError), secrets)}`,
    );
    return;
  }
  reportFixtureFailure(
    options.reporter,
    `[Fixture Evidence] Failure workspace retained: ${options.workspace}`,
  );
  reportFixtureFailure(
    options.reporter,
    `[Fixture Evidence] Failure report: ${reportPath}`,
  );
  reportFixtureFailure(
    options.reporter,
    `[Fixture Evidence] Reproduce with: ${scenarioSetReproductionCommands[options.scenarioSet]}`,
  );
}

function fixtureEvidenceFromEnvironment(
  environment: NodeJS.ProcessEnv,
): GeneratedScenarioRunOptions["evidence"] | undefined {
  const directory = environment[fixtureEnvironment.directory];
  if (directory === undefined) {
    if (
      environment[fixtureEnvironment.read] !== undefined ||
      environment[fixtureEnvironment.write] !== undefined ||
      environment[fixtureEnvironment.activityDirectory] !== undefined ||
      environment[fixtureEnvironment.runId] !== undefined ||
      environment[fixtureEnvironment.runAttempt] !== undefined
    ) {
      throw new Error(
        `${fixtureEnvironment.directory} is required when Fixture Verification Evidence is configured`,
      );
    }
    return undefined;
  }
  if (directory.length === 0) {
    throw new Error(`${fixtureEnvironment.directory} must not be empty`);
  }
  const activityDirectory = environment[fixtureEnvironment.activityDirectory];
  const runId = environment[fixtureEnvironment.runId];
  const runAttempt = environment[fixtureEnvironment.runAttempt];
  if (activityDirectory === undefined || activityDirectory.length === 0) {
    throw new Error(
      `${fixtureEnvironment.activityDirectory} is required when Fixture Verification Evidence is configured`,
    );
  }
  if (runId === undefined || runId.length === 0) {
    throw new Error(
      `${fixtureEnvironment.runId} is required when Fixture Verification Evidence is configured`,
    );
  }
  if (runAttempt === undefined || runAttempt.length === 0) {
    throw new Error(
      `${fixtureEnvironment.runAttempt} is required when Fixture Verification Evidence is configured`,
    );
  }
  const evidenceRoot = path.resolve(directory);
  return {
    storage: new FileFixtureEvidenceStorage(evidenceRoot),
    readEnabled: configuredBoolean(environment, fixtureEnvironment.read, true),
    writeEnabled: configuredBoolean(
      environment,
      fixtureEnvironment.write,
      false,
    ),
    activity: {
      ledger: new FileFixtureEvidenceActivityLedger({
        root: path.resolve(activityDirectory),
        evidenceRoot,
      }),
      runId,
      runAttempt,
    },
  };
}

export async function generatedScenariosFor(
  set: GeneratedScenarioSet,
): Promise<readonly GeneratedScenario[]> {
  switch (set) {
    case "init":
      return deriveInitializationScenarios();
    case "package-addition-matrix":
      return deriveFixtureMatrix();
    case "focused":
      return deriveFocusedProjectLinkScenarios();
    case "deployment":
      return deriveFixtureMatrix();
  }
}

function scenarioDiagnostics(scenario: GeneratedScenario) {
  return {
    id: scenario.id,
    label: scenario.label,
    presetIdentities: [
      scenario.base.metadata.name,
      ...(scenario.addition === undefined
        ? []
        : [scenario.addition.metadata.name]),
    ],
  };
}

async function runScenario(
  scenario: GeneratedScenario,
  options: InternalGeneratedScenarioRunOptions,
  mode: GeneratedScenarioSet,
  evidenceScheduler?: FixtureEvidenceScheduler,
): Promise<"completed" | "not-applicable"> {
  const rawRun =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const run: GeneratedCommandRunner = async (command, args, runOptions) => {
    const cancelSignal = runOptions.cancelSignal ?? options.cancelSignal;
    cancelSignal?.throwIfAborted();
    const commandOutput = { stdout: "", stderr: "" };
    const commandExecution = rawRun(command, args, {
      ...runOptions,
      ...(cancelSignal === undefined ? {} : { cancelSignal }),
      timeout: runOptions.timeout ?? fixtureCommandTimeoutMilliseconds,
      killDescendants: runOptions.killDescendants ?? true,
    }) as Promise<unknown> & {
      readonly stdout?: {
        on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
      };
      readonly stderr?: {
        on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
      };
    };
    commandExecution.stdout?.on("data", (chunk) => {
      commandOutput.stdout +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    commandExecution.stderr?.on("data", (chunk) => {
      commandOutput.stderr +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    try {
      return await commandExecution;
    } catch (error) {
      if (!cancelSignal?.aborted) throw error;
      const reason =
        cancelSignal.reason instanceof Error
          ? cancelSignal.reason
          : new Error("Fixture command cancelled");
      if (error === reason) {
        const commandError = new Error(
          `${failureMessage(reason)}; command stopped during cancellation`,
          { cause: reason },
        );
        Object.assign(commandError, {
          command,
          cwd: runOptions.cwd,
          ...(commandOutput.stdout.length === 0
            ? {}
            : { stdout: commandOutput.stdout }),
          ...(commandOutput.stderr.length === 0
            ? {}
            : { stderr: commandOutput.stderr }),
        });
        throw commandError;
      }
      throw new AggregateError(
        [reason, error],
        `${redactFixtureFailureText(failureMessage(reason), options.failureSecrets ?? [])}; command stopped during cancellation: ${redactFixtureFailureText(failureMessage(error), options.failureSecrets ?? [])}`,
        { cause: reason },
      );
    }
  };
  const projectDir = path.join(options.workspace, scenario.id);
  const context = createGenerationContext({
    targetDir: projectDir,
    defaultPackageScope: "fixture",
    toolchain: {
      nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
        0,
        releaseToolchainSnapshot.nodeVersion.indexOf("."),
      ),
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
      rustVersion: releaseToolchainSnapshot.rustVersion,
    },
  });
  options.cancelSignal?.throwIfAborted();
  const initialization = planGeneratedRepositoryInitialization({
    definition: scenario.base,
    context,
  });
  await validatePlanSources({
    definition: scenario.base,
    plan: initialization,
  });
  await validatePlanDependencyCatalog(initialization);
  await renderNewProject({
    targetRoot: projectDir,
    operations: [...initialization.operations],
  });
  await prepareGeneratedRepositoryForContainerWrites(projectDir);
  options.cancelSignal?.throwIfAborted();
  if (
    mode === "init" ||
    mode === "package-addition-matrix" ||
    mode === "focused" ||
    mode === "deployment"
  ) {
    await initializeFixtureGitRepository({
      repositoryRoot: projectDir,
      run,
    });
    if (
      mode === "package-addition-matrix" ||
      mode === "focused" ||
      mode === "deployment"
    ) {
      await stageFixtureGitRepository({
        repositoryRoot: projectDir,
        run,
      });
    }
  }

  let finalPlan: GeneratedRepositoryPlan = initialization;
  if (scenario.addition !== undefined) {
    const preparation = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: context.targetDir,
      preset: scenario.addition.metadata.name,
      packageLeafName: `fixture-${scenario.addition.metadata.name}`,
      ...(scenario.linkFrom === undefined
        ? {}
        : { linkFrom: scenario.linkFrom }),
    });
    if (preparation.status !== "ready") {
      // 加包验证现消费公开 CLI 的 prepare 接缝；非 ready 一律令场景失败，不回落旧 plan 或忽略错误。
      throw new Error(
        `Generated Package Addition prepare did not yield a plan (${preparation.status}): ${JSON.stringify(preparation)}`,
      );
    }
    finalPlan = preparation.plan;
    await validatePlanSources({
      definition: scenario.addition,
      plan: preparation.plan,
    });
    await validatePlanDependencyCatalog(preparation.plan);
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: projectDir,
      ...preparation.plan.projectProjections,
    });
    if (!result.ok) {
      throw new Error(
        `Generated Package Addition reconciliation conflicted: ${JSON.stringify(result.conflicts)}`,
      );
    }
  }

  await assertGeneratedManifestPublicationPolicy({
    plan: finalPlan,
    projectDir,
  });

  await validateGeneratedDevelopmentContainerProjection({
    plan: finalPlan,
    projectDir,
  });
  const deployment = deriveDeploymentQualityPlanInput(finalPlan);
  if (mode === "deployment" && deployment === undefined) {
    return "not-applicable";
  }
  const deploymentContractIdentity =
    deployment === undefined
      ? undefined
      : await deriveDeploymentQualityContractIdentity(deployment);

  const diagnostics = scenarioDiagnostics(scenario);
  const clock = options.evidence?.clock ?? (() => new Date());
  type ActivePhase = {
    readonly phase: FixtureEvidencePhase;
    readonly scope: FixtureEvidencePhaseScope;
    readonly startedAt: Date;
    finished: boolean;
  };
  const startPhase = async (
    phase: FixtureEvidencePhase,
    scope: FixtureEvidencePhaseScope,
  ): Promise<ActivePhase> => {
    const startedAt = clock();
    await options.recordActivity?.({
      type: "phase",
      phase,
      scope,
      scenario: diagnostics,
      at: startedAt.toISOString(),
      outcome: "started",
    });
    return { phase, scope, startedAt, finished: false };
  };
  const finishPhase = async (
    active: ActivePhase,
    result:
      | { readonly outcome: "succeeded" }
      | { readonly outcome: "failed"; readonly error: unknown },
  ): Promise<void> => {
    if (active.finished) return;
    active.finished = true;
    const finishedAt = clock();
    const durationMilliseconds =
      finishedAt.getTime() - active.startedAt.getTime();
    if (durationMilliseconds < 0) {
      throw new Error("Fixture activity clock moved backwards");
    }
    await options.recordActivity?.({
      type: "phase",
      phase: active.phase,
      scope: active.scope,
      scenario: diagnostics,
      at: finishedAt.toISOString(),
      durationMilliseconds,
      ...(result.outcome === "succeeded"
        ? { outcome: "succeeded" }
        : {
            outcome: "failed",
            classification: "not-retryable",
            error: redactFixtureFailureText(
              failureMessage(result.error),
              options.failureSecrets ?? [],
            ),
          }),
    });
  };
  const buildIdentity = await deriveDevelopmentContainerBuildIdentity({
    projectDir,
  });
  const containerSessionResources: readonly FixtureEvidenceExecutionResource[] =
    [
      ...new Set<FixtureEvidenceExecutionResource>([
        "development-container-session",
        ...generatedRootQualityExecutionResources(finalPlan),
        ...(deployment === undefined
          ? []
          : deploymentQualityExecutionResources(deployment)),
      ]),
    ];
  const containerSession = createDevelopmentContainerFixtureSession({
    projectDir,
    probes: finalPlan.developmentContainer.probes,
    ...(options.cancelSignal === undefined
      ? {}
      : { cancelSignal: options.cancelSignal }),
    ...(options.onCleanupFailure === undefined
      ? {}
      : { onCleanupFailure: options.onCleanupFailure }),
    build: {
      identity: buildIdentity,
      cacheDirectory:
        options.buildKitCacheDirectory ??
        path.join(options.workspace, ".buildkit-cache"),
    },
    environment: options.containerEnvironment ?? process.env,
    ...(options.evidence?.clock === undefined
      ? {}
      : { clock: options.evidence.clock }),
    ...(options.dependencyCaches === undefined
      ? {}
      : { dependencyCaches: options.dependencyCaches }),
    ...(evidenceScheduler === undefined
      ? {}
      : {
          acquireSession: async (cancelSignal) => {
            const queue = await startPhase(
              "scheduler-queue",
              "development-container-session",
            );
            try {
              const release = await evidenceScheduler.acquire(
                containerSessionResources,
                cancelSignal === undefined ? undefined : { cancelSignal },
              );
              await finishPhase(queue, { outcome: "succeeded" });
              return release;
            } catch (error) {
              await finishPhase(queue, { outcome: "failed", error });
              throw error;
            }
          },
        }),
    recordActivity: async (event) => {
      await options.recordActivity?.(
        event.type === "cache"
          ? { ...event, scenario: diagnostics }
          : {
              ...event,
              scope: "development-container-session",
              scenario: diagnostics,
            },
      );
    },
    run,
  });
  return await containerSession.execute<"completed">(async () => {
    if (options.evidence?.activity === undefined) {
      options.reporter?.info?.(`Checking generated scenario ${scenario.label}`);
    }
    const includeFix = true;
    const executeSemanticGate = async (gateOptions: {
      readonly gate: FixtureEvidenceGate;
      readonly resources: Parameters<FixtureEvidenceScheduler["run"]>[0];
      readonly execute: () => Promise<void>;
    }): Promise<void> => {
      await containerSession.reserve();
      const semantic = async (): Promise<void> => {
        await containerSession.prepare();
        const phase = await startPhase("semantic-gate", gateOptions.gate);
        try {
          await gateOptions.execute();
          await finishPhase(phase, { outcome: "succeeded" });
        } catch (error) {
          await finishPhase(phase, { outcome: "failed", error });
          throw error;
        }
      };
      if (evidenceScheduler === undefined) {
        await semantic();
        return;
      }
      const queue = await startPhase("scheduler-queue", gateOptions.gate);
      const gateResources = gateOptions.resources.filter(
        (resource) => !containerSessionResources.includes(resource),
      );
      let entered = false;
      try {
        await evidenceScheduler.run(
          gateResources,
          async () => {
            entered = true;
            await finishPhase(queue, { outcome: "succeeded" });
            await semantic();
          },
          options.cancelSignal === undefined
            ? undefined
            : { cancelSignal: options.cancelSignal },
        );
      } catch (error) {
        if (!entered) {
          await finishPhase(queue, { outcome: "failed", error });
        }
        throw error;
      }
    };
    const executeRootQuality = async () => {
      await executeSemanticGate({
        gate: "generated-root-quality",
        resources: generatedRootQualityExecutionResources(finalPlan),
        execute: async () => {
          await executeGeneratedRootQuality({
            plan: finalPlan,
            projectDir,
            fixtureWorkspace: options.workspace,
            gitSafeDirectory: path.posix.join(
              "/workspaces",
              path.basename(projectDir),
            ),
            includeFix,
            run: containerSession.run,
          });
        },
      });
    };

    const evidenceOptions = {
      scenario: diagnostics,
      producerCommit:
        options.evidence?.producerCommit ?? process.env.GITHUB_SHA ?? "local",
      ...(options.evidence?.storage === undefined
        ? {}
        : { storage: options.evidence.storage }),
      ...(options.evidence?.clock === undefined
        ? {}
        : { clock: options.evidence.clock }),
      ...(options.evidence?.freshnessMilliseconds === undefined
        ? {}
        : {
            freshnessMilliseconds: options.evidence.freshnessMilliseconds,
          }),
      ...(options.evidence?.readEnabled === undefined
        ? {}
        : { readEnabled: options.evidence.readEnabled }),
      ...(options.cancelSignal === undefined
        ? {}
        : { cancelSignal: options.cancelSignal }),
      writeEnabled: options.evidence?.writeEnabled ?? false,
      ...(options.evidence?.recordLifecycle === undefined
        ? {}
        : { recordLifecycle: options.evidence.recordLifecycle }),
    };

    if (
      mode === "init" ||
      mode === "package-addition-matrix" ||
      mode === "focused" ||
      mode === "deployment"
    ) {
      const generatedContentIdentity = await writeGeneratedRepositoryTree({
        repositoryRoot: projectDir,
        run,
      });
      const contractIdentity = await deriveGeneratedRootQualityContractIdentity(
        finalPlan,
        {
          includeFix,
          ...(deploymentContractIdentity === undefined
            ? {}
            : { deploymentContractIdentity }),
        },
      );
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity,
        contractIdentity,
        ...(deploymentContractIdentity === undefined
          ? {}
          : {
              coversDeploymentContractIdentity: deploymentContractIdentity,
            }),
        ...evidenceOptions,
        execute: executeRootQuality,
      });

      if (mode === "focused") {
        const focusedPlan = deriveFocusedPackageLinkPlanInput({
          initialPlan: initialization,
          finalPlan,
          consumerPackagePaths: scenario.linkFrom ?? [],
        });
        await runFixtureEvidenceGate({
          gate: "focused-package-link",
          rootEvidence,
          generatedContentIdentity,
          contractIdentity:
            await deriveFocusedPackageLinkContractIdentity(focusedPlan),
          ...evidenceOptions,
          execute: async () => {
            await executeSemanticGate({
              gate: "focused-package-link",
              resources: [],
              execute: async () => {
                await executeFocusedPackageLink({
                  scenarioLabel: scenario.label,
                  projectDir,
                  fixtureWorkspace: options.workspace,
                  consumerPackagePath: focusedPlan.consumerPackagePath,
                  providerPackagePath: focusedPlan.providerPackagePath,
                  run: containerSession.run,
                });
              },
            });
          },
        });
      }
      if (
        mode === "deployment" &&
        deployment !== undefined &&
        deploymentContractIdentity !== undefined
      ) {
        await runFixtureEvidenceGate({
          gate: "deployment-quality",
          rootEvidence,
          generatedContentIdentity,
          contractIdentity: deploymentContractIdentity,
          ...evidenceOptions,
          execute: async () => {
            throw new Error(
              "部署验收必须由成功的 Root Quality check:full 路径覆盖",
            );
          },
        });
      }
    }
    return "completed";
  });
}

async function assertGeneratedManifestPublicationPolicy(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly projectDir: string;
}): Promise<void> {
  const manifestPaths = [
    "package.json",
    ...options.plan.blueprint.packages.map(
      (definition) => `${definition.path}/package.json`,
    ),
  ];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(
      await readFile(path.join(options.projectDir, manifestPath), "utf8"),
    ) as unknown;
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      !Array.isArray(manifest) &&
      (manifest as Record<string, unknown>).private === true &&
      Object.hasOwn(manifest, "version")
    ) {
      throw new Error(
        `Generated Repository private Node manifest ${manifestPath} must not declare version`,
      );
    }
  }
}

async function prepareGeneratedRepositoryForContainerWrites(
  projectDir: string,
): Promise<void> {
  const turboDirectory = path.join(projectDir, ".turbo");
  await mkdir(turboDirectory, { recursive: true });
  await chmod(turboDirectory, 0o777);
}

/** Runs registry-derived generated repositories through their production plans. */
export async function runGeneratedScenarioSet(
  set: GeneratedScenarioSet,
  options: GeneratedScenarioRunOptions,
): Promise<void> {
  options.cancelSignal?.throwIfAborted();
  const scenarios = await generatedScenariosFor(set);
  const failureSecrets = fixtureFailureSecretValues({
    ...process.env,
    ...options.containerEnvironment,
  });
  const activity = options.evidence?.activity;
  const invocation = activity?.ledger.invocation({
    runId: activity.runId,
    runAttempt: activity.runAttempt,
    invocationId: randomUUID(),
    scenarioSet: set,
    writeEnabled: options.evidence?.writeEnabled ?? false,
    ...(options.evidence?.clock === undefined
      ? {}
      : { clock: options.evidence.clock }),
  });
  const activityErrors: string[] = [];
  const cleanupFailureController = new AbortController();
  let cleanupFailure: unknown;
  let cleanupFailureObserved = false;
  const scenarioCancelSignal =
    options.cancelSignal === undefined
      ? cleanupFailureController.signal
      : AbortSignal.any([
          options.cancelSignal,
          cleanupFailureController.signal,
        ]);
  const recordActivity = async (
    event: FixtureEvidenceInvocationEvent,
  ): Promise<void> => {
    if (invocation === undefined) return;
    try {
      await invocation.record(event);
    } catch (error) {
      activityErrors.push(
        redactFixtureFailureText(failureMessage(error), failureSecrets),
      );
    }
  };
  await recordActivity({
    type: "invocation",
    outcome: "started",
    scenarios: scenarios.map(scenarioDiagnostics),
  });
  const callerRecordLifecycle = options.evidence?.recordLifecycle;
  const scenarioOptions: InternalGeneratedScenarioRunOptions = {
    ...options,
    cancelSignal: scenarioCancelSignal,
    onCleanupFailure: (error) => {
      if (cleanupFailureObserved) return;
      cleanupFailureObserved = true;
      cleanupFailure = error;
      cleanupFailureController.abort(error);
    },
    failureSecrets,
    recordActivity,
    ...(options.evidence === undefined
      ? {}
      : {
          evidence: {
            ...options.evidence,
            recordLifecycle: async (
              event: FixtureEvidenceLifecycleEvent,
            ): Promise<void> => {
              await recordActivity(event);
              await callerRecordLifecycle?.(event);
            },
          },
        }),
  };
  let scenarioFailure: unknown;
  const executeScenario = async (
    scenario: GeneratedScenario,
    scheduler?: FixtureEvidenceScheduler,
  ): Promise<void> => {
    try {
      const outcome = await runScenario(
        scenario,
        scenarioOptions,
        set,
        scheduler,
      );
      await recordActivity({
        type: "scenario",
        scenario: scenarioDiagnostics(scenario),
        outcome,
      });
    } catch (error) {
      const diagnostic = redactFixtureFailureText(
        failureMessage(error),
        failureSecrets,
      );
      reportFixtureFailure(
        options.reporter,
        `[Fixture Evidence] ${set} ${scenario.label} (${scenario.id}) failed: ${diagnostic}. Reproduce the scenario set with ${scenarioSetReproductionCommands[set]}; generated artifact: ${path.join(options.workspace, scenario.id)}`,
      );
      await recordActivity({
        type: "scenario",
        scenario: scenarioDiagnostics(scenario),
        outcome: "failed",
        error: diagnostic,
      });
      throw error;
    }
  };
  const scheduler = (
    options.schedulerFactory ?? createFixtureEvidenceScheduler
  )(options.scheduling ?? {});
  const results = await Promise.allSettled(
    scenarios.map(
      async (scenario) => await executeScenario(scenario, scheduler),
    ),
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const preferredFailure =
    rejected.find(
      (result) =>
        !cleanupFailureObserved ||
        !hasFailureCause(result.reason, cleanupFailure),
    ) ?? rejected[0];
  if (preferredFailure !== undefined) {
    const preferredReason = preferredFailure.reason;
    const additionalFailures = [
      ...new Set(
        rejected
          .map((result) => result.reason)
          .filter((reason) => reason !== preferredReason),
      ),
    ];
    scenarioFailure =
      scenarioCancelSignal.aborted &&
      preferredReason === scenarioCancelSignal.reason &&
      additionalFailures.length > 0
        ? new AggregateError(
            additionalFailures,
            `Fixture scenario set was cancelled: ${failureMessage(preferredReason)}`,
            { cause: preferredReason },
          )
        : preferredReason;
  }
  if (set !== "init" && options.evidence?.writeEnabled === true) {
    try {
      await options.evidence.storage?.prune?.({
        ...(options.evidence.clock === undefined
          ? {}
          : { clock: options.evidence.clock }),
        ...(options.evidence.freshnessMilliseconds === undefined
          ? {}
          : {
              freshnessMilliseconds: options.evidence.freshnessMilliseconds,
            }),
      });
    } catch (error) {
      await recordActivity({
        type: "lifecycle-error",
        stage: "prune",
        at: (options.evidence.clock ?? (() => new Date()))().toISOString(),
        error: redactFixtureFailureText(failureMessage(error), failureSecrets),
      });
      scenarioFailure ??= error;
    }
  }
  if (activityErrors.length > 0 && invocation !== undefined) {
    try {
      await invocation.record({
        type: "lifecycle-error",
        stage: "activity",
        at: (options.evidence?.clock ?? (() => new Date()))().toISOString(),
        error: activityErrors.join("; "),
      });
    } catch {
      // A permanently unavailable ledger remains incomplete and fails health.
    }
  }
  await recordActivity(
    scenarioFailure === undefined
      ? { type: "invocation", outcome: "completed" }
      : {
          type: "invocation",
          outcome: "failed",
          error: redactFixtureFailureText(
            failureMessage(scenarioFailure),
            failureSecrets,
          ),
        },
  );
  if (activity !== undefined) {
    const report = await checkFixtureEvidenceHealth({
      ledger: activity.ledger,
      runId: activity.runId,
      runAttempt: activity.runAttempt,
      enabledScenarioSets: [set],
    });
    for (const line of formatFixtureEvidenceHealthReport(report)) {
      options.reporter?.info?.(line);
    }
  }
  if (scenarioFailure !== undefined) {
    throw scenarioFailure;
  }
}

export async function runGeneratedRegistryCli(options: {
  readonly scenarioSet: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly workspace?: string;
  readonly reporter?: { readonly info?: (message: string) => void };
  readonly run?: GeneratedCommandRunner;
  readonly schedulerFactory?: FixtureEvidenceSchedulerFactory;
  readonly cancelSignal?: AbortSignal;
}): Promise<void> {
  const set = options.scenarioSet;
  if (
    set !== "init" &&
    set !== "package-addition-matrix" &&
    set !== "focused" &&
    set !== "deployment"
  ) {
    throw new Error(
      "Expected generated scenario set: init, package-addition-matrix, focused, or deployment",
    );
  }
  const scheduling = {
    concurrency: configuredPositiveInteger(
      options.environment,
      fixtureEnvironment.concurrency,
      2,
    ),
    developmentContainerSessions: configuredPositiveInteger(
      options.environment,
      fixtureEnvironment.developmentContainerSessions,
      defaultDevelopmentContainerSessionConcurrency(),
    ),
  };
  const buildKitCacheDirectory =
    options.environment[fixtureEnvironment.buildKitCacheDirectory] ??
    path.join(
      options.environment[fixtureEnvironment.directory] ??
        path.resolve(".fixture-evidence"),
      "buildkit",
    );
  if (buildKitCacheDirectory.length === 0) {
    throw new Error(
      `${fixtureEnvironment.buildKitCacheDirectory} must not be empty`,
    );
  }
  const evidence = fixtureEvidenceFromEnvironment(options.environment);
  const dependencyCaches = fixtureDependencyCachesFromEnvironment(
    options.environment,
  );
  const managesWorkspace = options.workspace === undefined;
  const configuredWorkspace =
    options.environment[fixtureEnvironment.workspaceDirectory];
  if (configuredWorkspace !== undefined && configuredWorkspace.length === 0) {
    throw new Error(
      `${fixtureEnvironment.workspaceDirectory} must not be empty`,
    );
  }
  let workspace = options.workspace;
  if (workspace === undefined) {
    if (configuredWorkspace === undefined) {
      const workspaceRoot = path.resolve(defaultFixtureWorkspaceDirectory);
      await mkdir(workspaceRoot, { recursive: true });
      workspace = await mkdtemp(
        path.join(workspaceRoot, "template-generated-check-"),
      );
    } else {
      const workspaceRoot = path.resolve(configuredWorkspace);
      await mkdir(workspaceRoot, { recursive: true });
      workspace = await mkdtemp(
        path.join(workspaceRoot, "template-generated-check-"),
      );
    }
  }
  let failed = false;
  let failure: unknown;
  try {
    await runGeneratedScenarioSet(set, {
      workspace,
      reporter: options.reporter ?? console,
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.cancelSignal === undefined
        ? {}
        : { cancelSignal: options.cancelSignal }),
      ...(options.schedulerFactory === undefined
        ? {}
        : { schedulerFactory: options.schedulerFactory }),
      scheduling,
      buildKitCacheDirectory: path.resolve(buildKitCacheDirectory),
      containerEnvironment: fixtureContainerEnvironmentFromEnvironment(
        options.environment,
      ),
      ...(dependencyCaches === undefined ? {} : { dependencyCaches }),
      ...(evidence === undefined ? {} : { evidence }),
    });
    options.cancelSignal?.throwIfAborted();
  } catch (error) {
    failed = true;
    failure = error;
    await persistFixtureFailureReport({
      scenarioSet: set,
      workspace,
      environment: options.environment,
      error,
      reporter: options.reporter ?? console,
    });
  }
  if (failed) throw failure;
  if (managesWorkspace) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      await persistFixtureFailureReport({
        scenarioSet: set,
        workspace,
        environment: options.environment,
        error,
        reporter: options.reporter ?? console,
      });
      throw error;
    }
  }
}

class FixtureCliCancellationError extends Error {
  readonly signal: "SIGINT" | "SIGTERM";
  readonly exitCode: number;

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`Fixture scenario set cancelled by ${signal}`);
    this.name = "FixtureCliCancellationError";
    this.signal = signal;
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

function findFixtureCliCancellation(
  error: unknown,
  depth = 0,
): FixtureCliCancellationError | undefined {
  if (depth > 12) return undefined;
  if (error instanceof FixtureCliCancellationError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const cancellation = findFixtureCliCancellation(nested, depth + 1);
      if (cancellation !== undefined) return cancellation;
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findFixtureCliCancellation(error.cause, depth + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const cancellation = new AbortController();
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (!cancellation.signal.aborted) {
      cancellation.abort(new FixtureCliCancellationError(signal));
    }
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await runGeneratedRegistryCli({
      scenarioSet: process.argv[2],
      environment: process.env,
      cancelSignal: cancellation.signal,
    });
  } catch (error) {
    const reason = findFixtureCliCancellation(error);
    if (reason === undefined) throw error;
    console.error(`[Fixture Evidence] ${reason.message}`);
    process.exitCode = reason.exitCode;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
