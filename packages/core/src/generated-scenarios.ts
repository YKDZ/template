import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import * as v from "valibot";

import { assembleGenerationContext } from "./generation-context.js";
import {
  type CheckEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
} from "./module-graph.js";
import { planNextStepInstructions } from "./next-step-instructions.js";
import type { PresetSourceManifest } from "./preset-source.js";
import { findPresetSourceManifestPreset } from "./preset-source.js";
import {
  blueprintForPresetSourcePreset,
  projectPresetSourcePreset,
  type PresetProjectionSourceRoots,
} from "./projection-capabilities.js";

export type GeneratedScenarioSet = "init" | "package-addition-matrix";

export type GeneratedScenario = {
  readonly set: GeneratedScenarioSet;
  readonly basePreset: string;
  readonly addedPreset?: string;
  readonly linkFrom?: readonly string[];
  readonly id: string;
  readonly label: string;
};

export type SkippedGeneratedScenario = {
  readonly set: GeneratedScenarioSet;
  readonly basePreset: string;
  readonly addedPreset: string;
  readonly id: string;
  readonly label: string;
  readonly reason: string;
};

export type GeneratedScenarioSelection = {
  readonly runnable: readonly GeneratedScenario[];
  readonly skipped: readonly SkippedGeneratedScenario[];
};

export type GeneratedScenarioCommandStep = {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly environmentNeedKind?: CheckEnvironmentNeed["kind"];
};

export type GeneratedScenarioCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  options?: {
    readonly env?: Record<string, string> | undefined;
    readonly logPrefix?: string | undefined;
  },
) => Promise<void>;

export type GeneratedScenarioReporter = {
  readonly info?: (message: string) => void;
  readonly error?: (message: string) => void;
};

export type GeneratedScenarioRunnerOptions = {
  readonly repoRoot: string;
  readonly cliPath: string;
  readonly projectionSourceRoots: PresetProjectionSourceRoots;
  readonly runCommand?: GeneratedScenarioCommandRunner;
  readonly reporter?: GeneratedScenarioReporter;
  readonly deterministicToolchainEnv?: Record<string, string>;
  readonly rootCheckLock?: ExclusiveLock;
};

export type ExclusiveLock = {
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>;
};

const defaultDeterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};
const defaultFixtureConcurrency = 2;
const storedBlueprintSchema = v.object({
  packages: v.optional(
    v.array(
      v.object({
        name: v.string(),
        path: v.string(),
      }),
    ),
  ),
});

export function generatedScenarioChildProcessEnv(
  env: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };

  if (childEnv.NO_COLOR !== undefined && childEnv.FORCE_COLOR !== undefined) {
    delete childEnv.FORCE_COLOR;
  }

  return childEnv;
}

function cliSourceExecutionEnv(
  options: RequiredRunnerOptions,
  env: Record<string, string> = {},
): Record<string, string> {
  return {
    ...env,
    TSX_TSCONFIG_PATH: path.join(options.repoRoot, "tsconfig.json"),
  };
}

export function createExclusiveLock(): ExclusiveLock {
  let tail = Promise.resolve();

  return {
    async run<T>(callback: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;

      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

export function generatedScenarioId(
  scenario: Pick<GeneratedScenario, "basePreset" | "addedPreset" | "linkFrom">,
): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
  }

  if (scenario.linkFrom && scenario.linkFrom.length > 0) {
    const linkFromId = scenario.linkFrom
      .map((packagePath) => packagePath.replaceAll("/", "-"))
      .join("-");

    return `${scenario.basePreset}-add-${scenario.addedPreset}-link-from-${linkFromId}`;
  }

  return `${scenario.basePreset}-add-${scenario.addedPreset}`;
}

export function generatedScenarioLabel(
  scenario: Pick<GeneratedScenario, "basePreset" | "addedPreset" | "linkFrom">,
): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
  }

  if (scenario.linkFrom && scenario.linkFrom.length > 0) {
    return `${scenario.basePreset} + ${scenario.addedPreset} linked from ${scenario.linkFrom.join(", ")}`;
  }

  return `${scenario.basePreset} + ${scenario.addedPreset}`;
}

function createGeneratedScenario(
  set: GeneratedScenarioSet,
  input: Pick<GeneratedScenario, "basePreset" | "addedPreset" | "linkFrom">,
): GeneratedScenario {
  return {
    set,
    basePreset: input.basePreset,
    ...(input.addedPreset === undefined
      ? {}
      : { addedPreset: input.addedPreset }),
    ...(input.linkFrom === undefined ? {} : { linkFrom: [...input.linkFrom] }),
    id: generatedScenarioId(input),
    label: generatedScenarioLabel(input),
  };
}

export function selectGeneratedScenarios(
  manifest: PresetSourceManifest,
  set: GeneratedScenarioSet,
): GeneratedScenarioSelection {
  const contract = manifest.fixtureMatrix;

  if (!contract) {
    throw new Error(
      `Preset Source ${manifest.name} does not declare a Fixture Matrix Contract`,
    );
  }

  const initScenarios = contract.initSupport.map((support) =>
    createGeneratedScenario(set, { basePreset: support.preset }),
  );

  if (set === "init") {
    return { runnable: initScenarios, skipped: [] };
  }

  const matrixScenarios = contract.supportedCombinations.map((combination) =>
    createGeneratedScenario(set, {
      basePreset: combination.basePreset,
      addedPreset: combination.addedPreset,
      ...(combination.linkFrom === undefined
        ? {}
        : { linkFrom: combination.linkFrom }),
    }),
  );
  const skipped = contract.semanticSkips.map((skip) => ({
    set,
    basePreset: skip.basePreset,
    addedPreset: skip.addedPreset,
    id: generatedScenarioId(skip),
    label: generatedScenarioLabel(skip),
    reason: skip.reason,
  }));

  return {
    runnable: matrixScenarios,
    skipped,
  };
}

export function packageLeafNameForAddedPreset(
  manifest: PresetSourceManifest,
  presetName: string,
): string {
  const support = manifest.fixtureMatrix?.packageAdditionSupport.find(
    (entry) => entry.preset === presetName,
  );

  if (!support) {
    throw new Error(
      `Missing fixture Package Addition leaf name for preset: ${presetName}`,
    );
  }

  return support.packageLeafName;
}

export async function defaultGeneratedScenarioCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
  options: {
    readonly env?: Record<string, string> | undefined;
    readonly logPrefix?: string | undefined;
  } = {},
): Promise<void> {
  const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";

  console.log(`${prefix}$ ${[command, ...args].join(" ")}`);
  await execa(command, [...args], {
    cwd,
    env: generatedScenarioChildProcessEnv(options.env),
    extendEnv: false,
    stdio: "inherit",
  });
}

async function generateScenario(
  scenario: GeneratedScenario,
  workspace: string,
  options: RequiredRunnerOptions,
): Promise<string> {
  const projectDir = path.join(workspace, `fixture-${scenario.id}`);

  await options.runCommand(
    "pnpm",
    [
      "exec",
      "tsx",
      options.cliPath,
      "init",
      projectDir,
      "--preset",
      scenario.basePreset,
      "--yes",
    ],
    options.repoRoot,
    {
      env: cliSourceExecutionEnv(options, options.deterministicToolchainEnv),
      logPrefix: scenario.label,
    },
  );

  return projectDir;
}

async function applyPackageAddition(
  manifest: PresetSourceManifest,
  scenario: GeneratedScenario,
  projectDir: string,
  options: RequiredRunnerOptions,
): Promise<string | undefined> {
  if (!scenario.addedPreset) {
    return undefined;
  }

  const packageLeafName = packageLeafNameForAddedPreset(
    manifest,
    scenario.addedPreset,
  );
  const beforeConsumerSources = await linkedConsumerSourceSnapshots(
    projectDir,
    scenario.linkFrom ?? [],
  );
  await options.runCommand(
    "pnpm",
    [
      "exec",
      "tsx",
      options.cliPath,
      "add",
      "package",
      "--preset",
      scenario.addedPreset,
      "--name",
      packageLeafName,
      ...linkFromArgs(scenario.linkFrom ?? []),
    ],
    projectDir,
    {
      env: cliSourceExecutionEnv(options),
      logPrefix: scenario.label,
    },
  );
  await assertLinkedConsumerSourcesUnchanged(projectDir, beforeConsumerSources);

  return readAddedPackagePath(projectDir, packageLeafName);
}

function linkFromArgs(packagePaths: readonly string[]): string[] {
  return packagePaths.flatMap((packagePath) => ["--link-from", packagePath]);
}

async function linkedConsumerSourceSnapshots(
  projectDir: string,
  packagePaths: readonly string[],
): Promise<ReadonlyMap<string, Record<string, string>>> {
  const snapshots = new Map<string, Record<string, string>>();

  for (const packagePath of packagePaths) {
    snapshots.set(
      packagePath,
      await sourceFileSnapshot(path.join(projectDir, packagePath, "src")),
    );
  }

  return snapshots;
}

async function sourceFileSnapshot(
  sourceDir: string,
  currentDir = sourceDir,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await sourceFileSnapshot(sourceDir, entryPath));
      continue;
    }

    if (entry.isFile()) {
      snapshot[path.relative(sourceDir, entryPath)] = await readFile(
        entryPath,
        "utf8",
      );
    }
  }

  return snapshot;
}

async function assertLinkedConsumerSourcesUnchanged(
  projectDir: string,
  beforeSnapshots: ReadonlyMap<string, Record<string, string>>,
): Promise<void> {
  for (const [packagePath, beforeSnapshot] of beforeSnapshots) {
    const afterSnapshot = await sourceFileSnapshot(
      path.join(projectDir, packagePath, "src"),
    );

    if (JSON.stringify(afterSnapshot) !== JSON.stringify(beforeSnapshot)) {
      throw new Error(
        `Package Link Intent fixture modified consumer source files for ${packagePath}`,
      );
    }
  }
}

async function readAddedPackagePath(
  projectDir: string,
  packageLeafName: string,
): Promise<string> {
  const input = JSON.parse(
    await readFile(
      path.join(projectDir, ".template", "blueprint.json"),
      "utf8",
    ),
  ) as unknown;
  const result = v.safeParse(storedBlueprintSchema, input);
  if (!result.success) {
    throw new Error(
      `Generated Repository blueprint is invalid: ${result.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const packageDefinition = result.output.packages?.find(
    (pkg) => path.basename(pkg.path) === packageLeafName,
  );

  if (!packageDefinition) {
    throw new Error(
      `Package Addition fixture did not record package leaf ${packageLeafName}`,
    );
  }

  return packageDefinition.path;
}

function projectionPlanForPreset(
  presetName: string,
  projectDir: string,
  manifest: PresetSourceManifest,
  options: RequiredRunnerOptions,
  packageScope?: string,
) {
  const preset = findPresetSourceManifestPreset(manifest, presetName);

  if (!preset?.projection) {
    throw new Error(
      `Missing Preset Projection for fixture preset ${presetName}`,
    );
  }

  const blueprint = blueprintForPresetSourcePreset(preset, {
    targetDir: projectDir,
    ...(packageScope === undefined ? {} : { scope: packageScope }),
  });
  return projectPresetSourcePreset({
    preset,
    sourceRoots: options.projectionSourceRoots,
    context: assembleGenerationContext({
      targetDir: projectDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  });
}

function machineVerifiableNextStepsForPreset(
  presetName: string,
  projectDir: string,
  manifest: PresetSourceManifest,
  options: RequiredRunnerOptions,
): GeneratedScenarioCommandStep[] {
  const projectionPlan = projectionPlanForPreset(
    presetName,
    projectDir,
    manifest,
    options,
  );
  const plan = planNextStepInstructions({
    targetDir: projectDir,
    projectionPlan,
  });

  return plan.steps
    .filter((step) => step.machineVerifiable && step.kind === "command")
    .map((step) => {
      return {
        id: step.id,
        command: step.command,
        args: step.args,
        cwd: step.cwd,
        display: step.display,
        ...(step.environmentNeedKind === undefined
          ? {}
          : { environmentNeedKind: step.environmentNeedKind }),
      };
    });
}

function addedPresetEnvironmentNeeds(
  manifest: PresetSourceManifest,
  scenario: GeneratedScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
  options: RequiredRunnerOptions,
): CheckEnvironmentNeed[] {
  if (!scenario.addedPreset || !addedPackagePath) {
    return [];
  }

  return projectionPlanForPreset(
    scenario.addedPreset,
    projectDir,
    manifest,
    options,
    path.basename(projectDir),
  ).checkPlan.environmentNeeds.map((need) => {
    if (need.owner.kind !== "package-boundary") {
      return need;
    }

    return playwrightBrowserAssetsEnvironmentNeed({
      browser: need.browser,
      owner: { kind: "package-boundary", path: addedPackagePath },
      machineVerifiable: need.nextStep.machineVerifiable,
    });
  });
}

function environmentNeedStep(
  need: CheckEnvironmentNeed,
  projectDir: string,
): GeneratedScenarioCommandStep {
  return {
    id: need.nextStep.id,
    command: need.nextStep.command,
    args: [...need.nextStep.args],
    cwd: projectDir,
    display: need.nextStep.display,
    environmentNeedKind: need.kind,
  };
}

export function generatedScenarioEnvironmentNeedSteps(
  needs: readonly CheckEnvironmentNeed[],
  projectDir: string,
): GeneratedScenarioCommandStep[] {
  return needs
    .filter((need) => need.nextStep.machineVerifiable)
    .map((need) => environmentNeedStep(need, projectDir));
}

export function generatedScenarioRequiresSerializedRootCheck(
  steps: readonly GeneratedScenarioCommandStep[],
): boolean {
  return steps.some(
    (step) => step.environmentNeedKind === "playwright-browser-assets",
  );
}

export function generatedScenarioQualityGateSteps(
  manifest: PresetSourceManifest,
  scenario: GeneratedScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
  options: GeneratedScenarioRunnerOptions,
): GeneratedScenarioCommandStep[] {
  const normalizedOptions = normalizeRunnerOptions(options);
  const steps = machineVerifiableNextStepsForPreset(
    scenario.basePreset,
    projectDir,
    manifest,
    normalizedOptions,
  );
  const addedEnvironmentSteps = generatedScenarioEnvironmentNeedSteps(
    addedPresetEnvironmentNeeds(
      manifest,
      scenario,
      projectDir,
      addedPackagePath,
      normalizedOptions,
    ),
    projectDir,
  );
  const existingDisplays = new Set(steps.map((step) => step.display));
  const extraEnvironmentSteps = addedEnvironmentSteps.filter(
    (step) => !existingDisplays.has(step.display),
  );

  if (extraEnvironmentSteps.length === 0) {
    return steps;
  }

  const rootCheckIndex = steps.findIndex(
    (step) => step.id === "run-root-check",
  );
  if (rootCheckIndex === -1) {
    return [...steps, ...extraEnvironmentSteps];
  }

  return [
    ...steps.slice(0, rootCheckIndex),
    ...extraEnvironmentSteps,
    ...steps.slice(rootCheckIndex),
  ];
}

async function runGeneratedScenarioQualityGate(
  manifest: PresetSourceManifest,
  scenario: GeneratedScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
  options: RequiredRunnerOptions,
): Promise<void> {
  const steps = generatedScenarioQualityGateSteps(
    manifest,
    scenario,
    projectDir,
    addedPackagePath,
    options,
  );
  const requiresSerializedPlaywrightRootCheck =
    generatedScenarioRequiresSerializedRootCheck(steps);

  for (const step of steps) {
    const env = step.id === "run-root-check" ? { CI: "1" } : undefined;
    const runStep = async () => {
      await options.runCommand(step.command, [...step.args], step.cwd, {
        ...(env === undefined ? {} : { env }),
        logPrefix: scenario.label,
      });
    };

    if (step.id === "run-root-check" && requiresSerializedPlaywrightRootCheck) {
      await options.rootCheckLock.run(runStep);
      continue;
    }

    await runStep();
  }
}

async function checkGeneratedScenario(
  manifest: PresetSourceManifest,
  scenario: GeneratedScenario,
  workspace: string,
  options: RequiredRunnerOptions,
): Promise<void> {
  options.reporter.info?.(`\n== ${scenario.label} ==`);
  const projectDir = await generateScenario(scenario, workspace, options);
  const addedPackagePath = await applyPackageAddition(
    manifest,
    scenario,
    projectDir,
    options,
  );
  await runGeneratedScenarioQualityGate(
    manifest,
    scenario,
    projectDir,
    addedPackagePath,
    options,
  );
}

export function fixtureConcurrency(scenarioCount: number): number {
  const rawValue = process.env.TEMPLATE_FIXTURE_CONCURRENCY;

  if (rawValue === undefined || rawValue === "") {
    return Math.min(defaultFixtureConcurrency, scenarioCount);
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("TEMPLATE_FIXTURE_CONCURRENCY must be a positive integer");
  }

  return Math.min(value, scenarioCount);
}

export function errorForFailedGeneratedScenario(
  scenario: GeneratedScenario,
  error: unknown,
): Error {
  if (error instanceof Error) {
    return new Error(`Fixture scenario failed: ${scenario.label}`, {
      cause: error,
    });
  }

  return new Error(
    `Fixture scenario failed: ${scenario.label}: ${String(error)}`,
  );
}

type RequiredRunnerOptions = Required<
  Pick<
    GeneratedScenarioRunnerOptions,
    | "repoRoot"
    | "cliPath"
    | "projectionSourceRoots"
    | "runCommand"
    | "reporter"
    | "deterministicToolchainEnv"
    | "rootCheckLock"
  >
>;

function normalizeRunnerOptions(
  options: GeneratedScenarioRunnerOptions,
): RequiredRunnerOptions {
  return {
    repoRoot: options.repoRoot,
    cliPath: options.cliPath,
    projectionSourceRoots: options.projectionSourceRoots,
    runCommand: options.runCommand ?? defaultGeneratedScenarioCommandRunner,
    reporter: options.reporter ?? {
      info: console.log,
      error: console.error,
    },
    deterministicToolchainEnv:
      options.deterministicToolchainEnv ?? defaultDeterministicToolchainEnv,
    rootCheckLock: options.rootCheckLock ?? createExclusiveLock(),
  };
}

export async function runGeneratedScenariosConcurrently(
  manifest: PresetSourceManifest,
  scenarios: readonly GeneratedScenario[],
  workspace: string,
  concurrency: number,
  options: GeneratedScenarioRunnerOptions,
): Promise<void> {
  const normalizedOptions = normalizeRunnerOptions(options);
  let nextScenarioIndex = 0;
  let firstFailure: Error | undefined;

  async function worker(): Promise<void> {
    while (firstFailure === undefined) {
      const scenario = scenarios[nextScenarioIndex];
      nextScenarioIndex += 1;

      if (!scenario) {
        return;
      }

      try {
        await checkGeneratedScenario(
          manifest,
          scenario,
          workspace,
          normalizedOptions,
        );
      } catch (error: unknown) {
        firstFailure ??= errorForFailedGeneratedScenario(scenario, error);
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      await worker();
    }),
  );

  if (firstFailure) {
    throw firstFailure;
  }
}

export async function runGeneratedScenarioSet(
  manifest: PresetSourceManifest,
  set: GeneratedScenarioSet,
  workspace: string,
  options: GeneratedScenarioRunnerOptions,
): Promise<GeneratedScenarioSelection> {
  const normalizedOptions = normalizeRunnerOptions(options);
  const selection = selectGeneratedScenarios(manifest, set);
  const concurrency = fixtureConcurrency(selection.runnable.length);

  for (const skippedScenario of selection.skipped) {
    normalizedOptions.reporter.info?.(
      `-- Skipping ${skippedScenario.label}: ${skippedScenario.reason}`,
    );
  }

  normalizedOptions.reporter.info?.(
    `Checking ${selection.runnable.length} fixture scenarios with concurrency ${concurrency}.`,
  );
  await runGeneratedScenariosConcurrently(
    manifest,
    selection.runnable,
    workspace,
    concurrency,
    normalizedOptions,
  );

  return selection;
}
