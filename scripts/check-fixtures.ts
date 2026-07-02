#!/usr/bin/env node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { assembleGenerationContext } from "../src/generation-context.js";
import {
  renderPlaywrightBrowserInstallCommand,
  type CheckEnvironmentNeed,
} from "../src/module-graph.js";
import { planNextStepInstructions } from "../src/next-step-instructions.js";
import { PackageAdditionSupport } from "../src/package-addition-support.js";
import {
  builtInPresetProjections,
  findBuiltInPresetProjection,
} from "../templates/registry.js";

type SupportedFixturePreset =
  (typeof builtInPresetProjections)[number]["metadata"]["name"];

type FixtureScenario = {
  readonly basePreset: SupportedFixturePreset;
  readonly addedPreset?: SupportedFixturePreset;
  readonly linkFrom?: readonly string[];
};

type FixtureCommandStep = {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
};

type StoredBlueprint = {
  readonly packages?: readonly {
    readonly name: string;
    readonly path: string;
  }[];
};

type ExclusiveLock = {
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");
const deterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};
const defaultFixtureConcurrency = 2;

function createExclusiveLock(): ExclusiveLock {
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

const playwrightRootCheckLock = createExclusiveLock();

function supportedFixturePresets(): SupportedFixturePreset[] {
  return builtInPresetProjections
    .filter((projection) => projection.metadata.generation === "supported")
    .map((projection) => projection.metadata.name);
}

function addableFixturePresets(): SupportedFixturePreset[] {
  return builtInPresetProjections
    .filter(
      (projection) =>
        projection.metadata.generation === "supported" &&
        projection.metadata.packageAdditionSupport ===
          PackageAdditionSupport.Supported,
    )
    .map((projection) => projection.metadata.name);
}

function fixtureScenarios(): FixtureScenario[] {
  const basePresets = supportedFixturePresets();
  const addablePresets = addableFixturePresets();

  return [
    ...basePresets.map((basePreset) => ({ basePreset })),
    ...basePresets.flatMap((basePreset) =>
      addablePresets.map((addedPreset) => ({ basePreset, addedPreset })),
    ),
    {
      basePreset: "vue-hono-app",
      addedPreset: "ts-lib",
      linkFrom: ["apps/web"],
    },
  ];
}

function fixtureScenarioId(scenario: FixtureScenario): string {
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

function fixtureScenarioLabel(scenario: FixtureScenario): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
  }

  if (scenario.linkFrom && scenario.linkFrom.length > 0) {
    return `${scenario.basePreset} + ${scenario.addedPreset} linked from ${scenario.linkFrom.join(", ")}`;
  }

  return `${scenario.basePreset} + ${scenario.addedPreset}`;
}

function packageLeafNameForAddedPreset(
  presetName: SupportedFixturePreset,
): string {
  switch (presetName) {
    case "ts-lib":
      return "fixture-lib";
    case "hono-api":
      return "fixture-api";
    case "vue-app":
      return "fixture-web";
    default:
      throw new Error(
        `Missing fixture Package Addition leaf name for preset: ${presetName}`,
      );
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  options: {
    readonly env?: Record<string, string>;
    readonly logPrefix?: string;
  } = {},
): Promise<void> {
  const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";

  console.log(`${prefix}$ ${[command, ...args].join(" ")}`);
  await execa(command, args, {
    cwd,
    env: options.env,
    stdio: "inherit",
  });
}

async function generateScenario(
  scenario: FixtureScenario,
  workspace: string,
): Promise<string> {
  const label = fixtureScenarioLabel(scenario);
  const projectDir = path.join(
    workspace,
    `fixture-${fixtureScenarioId(scenario)}`,
  );

  await run(
    "pnpm",
    [
      "exec",
      "tsx",
      cliPath,
      "init",
      projectDir,
      "--preset",
      scenario.basePreset,
      "--yes",
    ],
    repoRoot,
    { env: deterministicToolchainEnv, logPrefix: label },
  );

  return projectDir;
}

async function applyPackageAddition(
  scenario: FixtureScenario,
  projectDir: string,
): Promise<string | undefined> {
  if (!scenario.addedPreset) {
    return undefined;
  }

  const packageLeafName = packageLeafNameForAddedPreset(scenario.addedPreset);
  const beforeConsumerSources = await linkedConsumerSourceSnapshots(
    projectDir,
    scenario.linkFrom ?? [],
  );
  await run(
    "pnpm",
    [
      "exec",
      "tsx",
      cliPath,
      "add",
      "package",
      "--preset",
      scenario.addedPreset,
      "--name",
      packageLeafName,
      ...linkFromArgs(scenario.linkFrom ?? []),
    ],
    projectDir,
    { logPrefix: fixtureScenarioLabel(scenario) },
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

  for (const entry of entries.sort((left, right) =>
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
  const blueprint = JSON.parse(
    await readFile(
      path.join(projectDir, ".template", "blueprint.json"),
      "utf8",
    ),
  ) as StoredBlueprint;
  const packageDefinition = blueprint.packages?.find(
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
  presetName: SupportedFixturePreset,
  projectDir: string,
  packageScope?: string,
) {
  const projection = findBuiltInPresetProjection(presetName);

  if (!projection) {
    throw new Error(
      `Missing Preset Projection for fixture preset ${presetName}`,
    );
  }

  const blueprint = projection.blueprint({
    targetDir: projectDir,
    scope: packageScope,
  });
  return projection.project(
    assembleGenerationContext({
      targetDir: projectDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  );
}

function machineVerifiableNextStepsForPreset(
  presetName: SupportedFixturePreset,
  projectDir: string,
): FixtureCommandStep[] {
  const projectionPlan = projectionPlanForPreset(presetName, projectDir);
  const plan = planNextStepInstructions({
    targetDir: projectDir,
    projectionPlan,
  });

  return plan.steps
    .filter((step) => step.machineVerifiable && step.kind === "command")
    .map((step) => ({
      id: step.id,
      command: step.command,
      args: step.args,
      cwd: step.cwd,
      display: step.display,
    }));
}

function addedPresetEnvironmentNeeds(
  scenario: FixtureScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
): CheckEnvironmentNeed[] {
  if (!scenario.addedPreset || !addedPackagePath) {
    return [];
  }

  return projectionPlanForPreset(
    scenario.addedPreset,
    projectDir,
    path.basename(projectDir),
  ).checkPlan.environmentNeeds.map((need) => {
    if (need.owner.kind !== "package-boundary") {
      return need;
    }

    return {
      ...need,
      owner: { kind: "package-boundary", path: addedPackagePath },
    };
  });
}

function environmentNeedStep(
  need: CheckEnvironmentNeed,
  projectDir: string,
): FixtureCommandStep {
  const display = renderPlaywrightBrowserInstallCommand(need);
  const [command, ...args] = display.split(" ");

  return {
    id: `install-${need.owner.path}-playwright-browsers`,
    command,
    args,
    cwd: projectDir,
    display,
  };
}

function fixtureQualityGateSteps(
  scenario: FixtureScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
): FixtureCommandStep[] {
  const steps = machineVerifiableNextStepsForPreset(
    scenario.basePreset,
    projectDir,
  );
  const addedEnvironmentSteps = addedPresetEnvironmentNeeds(
    scenario,
    projectDir,
    addedPackagePath,
  ).map((need) => environmentNeedStep(need, projectDir));
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

async function runFixtureQualityGate(
  scenario: FixtureScenario,
  projectDir: string,
  addedPackagePath: string | undefined,
): Promise<void> {
  const steps = fixtureQualityGateSteps(scenario, projectDir, addedPackagePath);
  const requiresSerializedPlaywrightRootCheck = steps.some((step) =>
    step.id.endsWith("-playwright-browsers"),
  );

  for (const step of steps) {
    const env = step.id === "run-root-check" ? { CI: "1" } : undefined;
    const runStep = async () => {
      await run(step.command, [...step.args], step.cwd, {
        env,
        logPrefix: fixtureScenarioLabel(scenario),
      });
    };

    if (step.id === "run-root-check" && requiresSerializedPlaywrightRootCheck) {
      await playwrightRootCheckLock.run(runStep);
      continue;
    }

    await runStep();
  }
}

async function checkScenario(
  scenario: FixtureScenario,
  workspace: string,
): Promise<void> {
  console.log(`\n== ${fixtureScenarioLabel(scenario)} ==`);
  const projectDir = await generateScenario(scenario, workspace);
  const addedPackagePath = await applyPackageAddition(scenario, projectDir);
  await runFixtureQualityGate(scenario, projectDir, addedPackagePath);
}

function fixtureConcurrency(scenarioCount: number): number {
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

function errorForFailedScenario(
  scenario: FixtureScenario,
  error: unknown,
): Error {
  if (error instanceof Error) {
    return new Error(
      `Fixture scenario failed: ${fixtureScenarioLabel(scenario)}`,
      { cause: error },
    );
  }

  return new Error(
    `Fixture scenario failed: ${fixtureScenarioLabel(scenario)}: ${String(error)}`,
  );
}

async function runScenariosConcurrently(
  scenarios: readonly FixtureScenario[],
  workspace: string,
  concurrency: number,
): Promise<void> {
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
        await checkScenario(scenario, workspace);
      } catch (error: unknown) {
        firstFailure ??= errorForFailedScenario(scenario, error);
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

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-fixtures-"));
  const scenarios = fixtureScenarios();
  const concurrency = fixtureConcurrency(scenarios.length);
  let shouldRemoveWorkspace = false;

  try {
    console.log(
      `Checking ${scenarios.length} fixture scenarios with concurrency ${concurrency}.`,
    );
    await runScenariosConcurrently(scenarios, workspace, concurrency);

    shouldRemoveWorkspace = true;
  } finally {
    if (shouldRemoveWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      console.error(`Fixture workspace preserved for debugging: ${workspace}`);
    }
  }
}

await main();
