#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execa } from "execa";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInPresetDefinition,
  type GeneratedRepositoryPlan,
} from "#template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

import {
  deploymentQualityExecutionResources,
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
  executeDeploymentQuality,
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
  createFixtureEvidenceScheduler,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  formatFixtureEvidenceHealthReport,
  initializeFixtureGitRepository,
  runFixtureEvidenceGate,
  stageFixtureGitRepository,
  writeGeneratedRepositoryTree,
  type FixtureEvidenceActivityLedger,
  type FixtureEvidenceInvocationEvent,
  type FixtureEvidenceLifecycleEvent,
  type FixtureEvidenceScheduler,
  type FixtureEvidenceSchedulerFactory,
  type FixtureEvidenceSchedulingOptions,
  type FixtureEvidenceStorage,
} from "./fixture-evidence/kernel/index.ts";

export { assertGeneratedTaskDiscovery } from "./fixture-evidence/gates/root-quality/index.ts";

type GeneratedScenarioSet =
  | "init"
  | "package-addition-matrix"
  | "focused"
  | "deployment";

/** Source-only repository check API; intentionally absent from package exports. */
type GeneratedScenario = {
  readonly id: string;
  readonly label: string;
  readonly base: BuiltInPresetDefinition;
  readonly addition?: BuiltInPresetDefinition;
  readonly linkFrom?: readonly string[];
};

type RegistryChecks = {
  readonly deriveFixtureMatrix: () => readonly GeneratedScenario[];
  readonly deriveFocusedProjectLinkScenarios: () => readonly GeneratedScenario[];
  readonly deriveInitializationScenarios: () => readonly GeneratedScenario[];
  readonly validatePlanDependencyCatalog: (
    plan: GeneratedRepositoryPlan,
  ) => void;
  readonly validatePlanSources: (options: {
    readonly definition: BuiltInPresetDefinition;
    readonly plan: GeneratedRepositoryPlan;
  }) => Promise<unknown>;
};

async function sourceOnlyRegistryChecks(): Promise<RegistryChecks> {
  const sourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "builtin-presets",
    "src",
    "registry-checks.ts",
  );
  return (await import(pathToFileURL(sourcePath).href)) as RegistryChecks;
}

export type GeneratedScenarioRunOptions = {
  readonly workspace: string;
  readonly reporter?: { readonly info?: (message: string) => void };
  readonly run?: GeneratedCommandRunner;
  readonly scheduling?: FixtureEvidenceSchedulingOptions;
  readonly schedulerFactory?: FixtureEvidenceSchedulerFactory;
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

export type GeneratedCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio?: "inherit" },
) => Promise<unknown>;

const fixtureEnvironment = {
  concurrency: "TEMPLATE_FIXTURE_CONCURRENCY",
  directory: "TEMPLATE_FIXTURE_EVIDENCE_DIR",
  read: "TEMPLATE_FIXTURE_EVIDENCE_READ",
  write: "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
  activityDirectory: "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
  runId: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
  runAttempt: "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
} as const;

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
  const checks = await sourceOnlyRegistryChecks();
  switch (set) {
    case "init":
      return checks.deriveInitializationScenarios();
    case "package-addition-matrix":
      return checks.deriveFixtureMatrix();
    case "focused":
      return checks.deriveFocusedProjectLinkScenarios();
    case "deployment":
      return checks.deriveFixtureMatrix();
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
  options: GeneratedScenarioRunOptions,
  mode: GeneratedScenarioSet,
  checks: RegistryChecks,
  evidenceScheduler?: FixtureEvidenceScheduler,
): Promise<"completed" | "not-applicable"> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const projectDir = path.join(options.workspace, scenario.id);
  const context = createGenerationContext({
    targetDir: projectDir,
    scope: "fixture",
    toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
  });
  const initialization = planGeneratedRepositoryInitialization({
    definition: scenario.base,
    context,
  });
  await checks.validatePlanSources({
    definition: scenario.base,
    plan: initialization,
  });
  checks.validatePlanDependencyCatalog(initialization);
  await renderNewProject({
    targetRoot: projectDir,
    operations: [...initialization.operations],
  });
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
    const additionPlan = planGeneratedRepositoryPackageAddition({
      definition: scenario.addition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: `fixture-${scenario.addition.metadata.name}`,
      ...(scenario.linkFrom === undefined
        ? {}
        : { linkFrom: scenario.linkFrom }),
    });
    finalPlan = additionPlan;
    await checks.validatePlanSources({
      definition: scenario.addition,
      plan: additionPlan,
    });
    checks.validatePlanDependencyCatalog(additionPlan);
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: projectDir,
      ...additionPlan.projectProjections,
    });
    if (!result.ok) {
      throw new Error(
        `Generated Package Addition reconciliation conflicted: ${JSON.stringify(result.conflicts)}`,
      );
    }
  }

  const deployment =
    mode === "deployment"
      ? deriveDeploymentQualityPlanInput(finalPlan)
      : undefined;
  if (mode === "deployment" && deployment === undefined) {
    return "not-applicable";
  }

  if (options.evidence?.activity === undefined) {
    options.reporter?.info?.(`Checking generated scenario ${scenario.label}`);
  }
  const includeFix =
    mode === "package-addition-matrix" || mode === "deployment";
  const executeRootQuality = async () => {
    const execute = async () =>
      await executeGeneratedRootQuality({
        plan: finalPlan,
        projectDir,
        fixtureWorkspace: options.workspace,
        includeFix,
        run,
      });
    return evidenceScheduler === undefined
      ? await execute()
      : await evidenceScheduler.run(
          generatedRootQualityExecutionResources(finalPlan),
          execute,
        );
  };

  const diagnostics = scenarioDiagnostics(scenario);
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
      { includeFix },
    );
    const rootEvidence = await runFixtureEvidenceGate({
      gate: "generated-root-quality",
      generatedContentIdentity,
      contractIdentity,
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
          const execute = async () =>
            await executeFocusedPackageLink({
              scenarioLabel: scenario.label,
              projectDir,
              fixtureWorkspace: options.workspace,
              consumerPackagePath: focusedPlan.consumerPackagePath,
              providerPackagePath: focusedPlan.providerPackagePath,
              run,
            });
          return evidenceScheduler === undefined
            ? await execute()
            : await evidenceScheduler.run([], execute);
        },
      });
    }
    if (mode === "deployment" && deployment !== undefined) {
      await runFixtureEvidenceGate({
        gate: "deployment-quality",
        rootEvidence,
        generatedContentIdentity,
        contractIdentity:
          await deriveDeploymentQualityContractIdentity(deployment),
        ...evidenceOptions,
        execute: async () => {
          const execute = async () =>
            await executeDeploymentQuality({
              deployment,
              projectDir,
              fixtureWorkspace: options.workspace,
              run,
            });
          return evidenceScheduler === undefined
            ? await execute()
            : await evidenceScheduler.run(
                deploymentQualityExecutionResources(deployment),
                execute,
              );
        },
      });
    }
  }
  return "completed";
}

/** Runs registry-derived generated repositories through their production plans. */
export async function runGeneratedScenarioSet(
  set: GeneratedScenarioSet,
  options: GeneratedScenarioRunOptions,
): Promise<void> {
  const checks = await sourceOnlyRegistryChecks();
  const scenarios = await generatedScenariosFor(set);
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
  const recordActivity = async (
    event: FixtureEvidenceInvocationEvent,
  ): Promise<void> => {
    if (invocation === undefined) return;
    try {
      await invocation.record(event);
    } catch (error) {
      activityErrors.push(failureMessage(error));
    }
  };
  await recordActivity({
    type: "invocation",
    outcome: "started",
    scenarios: scenarios.map(scenarioDiagnostics),
  });
  const callerRecordLifecycle = options.evidence?.recordLifecycle;
  const scenarioOptions: GeneratedScenarioRunOptions = {
    ...options,
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
        checks,
        scheduler,
      );
      await recordActivity({
        type: "scenario",
        scenario: scenarioDiagnostics(scenario),
        outcome,
      });
    } catch (error) {
      await recordActivity({
        type: "scenario",
        scenario: scenarioDiagnostics(scenario),
        outcome: "failed",
        error: failureMessage(error),
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
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) scenarioFailure = failed.reason;
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
        error: failureMessage(error),
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
          error: failureMessage(scenarioFailure),
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
  };
  const evidence = fixtureEvidenceFromEnvironment(options.environment);
  const managesWorkspace = options.workspace === undefined;
  const workspace =
    options.workspace ??
    (await mkdtemp(path.join(tmpdir(), "template-generated-check-")));
  try {
    await runGeneratedScenarioSet(set, {
      workspace,
      reporter: options.reporter ?? console,
      ...(options.run === undefined ? {} : { run: options.run }),
      scheduling,
      ...(evidence === undefined ? {} : { evidence }),
    });
  } finally {
    if (managesWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  await runGeneratedRegistryCli({
    scenarioSet: process.argv[2],
    environment: process.env,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
