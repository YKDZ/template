#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");
const deterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

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
  ];
}

function fixtureScenarioId(scenario: FixtureScenario): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
  }

  return `${scenario.basePreset}-add-${scenario.addedPreset}`;
}

function fixtureScenarioLabel(scenario: FixtureScenario): string {
  if (!scenario.addedPreset) {
    return scenario.basePreset;
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
  env?: Record<string, string>,
): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  await execa(command, args, { cwd, env, stdio: "inherit" });
}

async function generateScenario(
  scenario: FixtureScenario,
  workspace: string,
): Promise<string> {
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
    deterministicToolchainEnv,
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
    ],
    projectDir,
  );

  return readAddedPackagePath(projectDir, packageLeafName);
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
  for (const step of fixtureQualityGateSteps(
    scenario,
    projectDir,
    addedPackagePath,
  )) {
    const env = step.id === "run-root-check" ? { CI: "1" } : undefined;
    await run(step.command, [...step.args], step.cwd, env);
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

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-fixtures-"));
  let shouldRemoveWorkspace = false;

  try {
    for (const scenario of fixtureScenarios()) {
      await checkScenario(scenario, workspace);
    }

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
