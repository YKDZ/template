#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInPresetDefinition,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  renderNewProject,
  renderProjectAtomically,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";

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

type GeneratedScenarioRunOptions = {
  readonly workspace: string;
  readonly reporter?: { readonly info?: (message: string) => void };
};

type GeneratedCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio?: "inherit" },
) => Promise<unknown>;

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
      // Deployment is intentionally a separate, Docker-required deep gate.
      // It covers every real addition path that can retain deployment checks.
      return checks.deriveFixtureMatrix();
  }
}

/**
 * Fast generated scenarios prepare only ordinary check requirements. The
 * focused deployment mode adds its explicitly declared deployment needs.
 */
export async function prepareGeneratedScenarioEnvironment(options: {
  readonly plan: ReturnType<typeof planGeneratedRepositoryInitialization>;
  readonly projectDir: string;
  readonly mode: GeneratedScenarioSet;
  readonly run?: GeneratedCommandRunner;
}): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const seen = new Set<string>();
  const needs = [
    ...options.plan.environmentNeeds.map((need) => need.nextStep),
    ...(options.mode === "deployment"
      ? options.plan.deploymentEnvironmentNeeds.map((need) => need.preparation)
      : []),
  ];
  for (const preparation of needs) {
    if (!preparation.machineVerifiable || seen.has(preparation.display)) {
      continue;
    }
    seen.add(preparation.display);
    await run(preparation.command, [...preparation.args], {
      cwd: options.projectDir,
      stdio: "inherit",
    });
  }
}

/**
 * A deployment scenario is only successful after its real deployment command
 * runs. Docker absence is a hard failure here, while fast scenario sets never
 * call this gate and therefore make no deployment-success claim.
 */
export async function runRequiredDeploymentQualityGate(options: {
  readonly plan: ReturnType<typeof planGeneratedRepositoryInitialization>;
  readonly projectDir: string;
  readonly run?: GeneratedCommandRunner;
}): Promise<void> {
  const hasDeploymentEntrypoint = options.plan.manifests.some((manifest) => {
    const scripts = manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>)["check:deployment"] ===
        "string"
    );
  });
  if (!hasDeploymentEntrypoint) return;
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], {
      cwd: options.projectDir,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for the deployment gate (${options.plan.definitionName}); check:deployment was not executed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await run("pnpm", ["run", "check:deployment"], {
    cwd: options.projectDir,
    stdio: "inherit",
  });
}

async function requireDockerForDeploymentGate(
  workspace: string,
): Promise<void> {
  try {
    await execa("docker", ["version", "--format", "{{.Server.Version}}"], {
      cwd: workspace,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for the deployment gate; check:deployment was not executed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runScenario(
  scenario: GeneratedScenario,
  options: GeneratedScenarioRunOptions,
  mode: GeneratedScenarioSet,
  checks: RegistryChecks,
): Promise<void> {
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

  const finalPlan =
    scenario.addition === undefined
      ? initialization
      : planGeneratedRepositoryPackageAddition({
          definition: scenario.addition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: `fixture-${scenario.addition.metadata.name}`,
          ...(scenario.linkFrom === undefined
            ? {}
            : { linkFrom: scenario.linkFrom }),
        });
  if (scenario.addition !== undefined) {
    await checks.validatePlanSources({
      definition: scenario.addition,
      plan: finalPlan,
    });
    checks.validatePlanDependencyCatalog(finalPlan);
    await renderProjectAtomically({
      targetRoot: projectDir,
      operations: [...finalPlan.operations],
    });
  }

  options.reporter?.info?.(`Checking generated scenario ${scenario.label}`);
  await execa("pnpm", ["install"], { cwd: projectDir, stdio: "inherit" });
  await prepareGeneratedScenarioEnvironment({
    plan: finalPlan,
    projectDir,
    mode,
  });
  await execa("pnpm", ["run", "check"], { cwd: projectDir, stdio: "inherit" });
  if (mode === "deployment") {
    await runRequiredDeploymentQualityGate({
      plan: finalPlan,
      projectDir,
    });
  }
}

/** Runs registry-derived generated repositories through their production plans. */
export async function runGeneratedScenarioSet(
  set: GeneratedScenarioSet,
  options: GeneratedScenarioRunOptions,
): Promise<void> {
  if (set === "deployment") {
    await requireDockerForDeploymentGate(options.workspace);
  }
  const checks = await sourceOnlyRegistryChecks();
  for (const scenario of await generatedScenariosFor(set)) {
    await runScenario(scenario, options, set, checks);
  }
}

async function main(): Promise<void> {
  const set = process.argv[2] as GeneratedScenarioSet | undefined;
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
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-generated-check-"),
  );
  try {
    await runGeneratedScenarioSet(set, { workspace, reporter: console });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
