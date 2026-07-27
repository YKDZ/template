#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  readonly run?: GeneratedCommandRunner;
};

type GeneratedCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio?: "inherit" },
) => Promise<unknown>;

type FocusedProviderManifest = {
  readonly name: string;
  readonly sourceTarget: string;
  readonly defaultTarget: string;
};

const qualityTaskNames = [
  "boundaries",
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:e2e",
] as const;

const fixTaskNames = ["lint:fix", "format:write"] as const;

export function generatedScenarioInstallArgs(
  workspace: string,
): readonly string[] {
  return ["install", "--store-dir", path.join(workspace, ".pnpm-store")];
}

function packageTargetPath(options: {
  readonly packageRoot: string;
  readonly target: unknown;
  readonly condition: "source" | "default";
}): string {
  if (typeof options.target !== "string" || !options.target.startsWith("./")) {
    throw new Error(
      `root ${options.condition} export must be a package-relative string`,
    );
  }
  const resolved = path.resolve(options.packageRoot, options.target);
  const relative = path.relative(options.packageRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `root ${options.condition} export escapes the provider Package Boundary`,
    );
  }
  return resolved;
}

async function readFocusedProviderManifest(
  providerRoot: string,
): Promise<FocusedProviderManifest> {
  const manifest = JSON.parse(
    await readFile(path.join(providerRoot, "package.json"), "utf8"),
  ) as {
    readonly name?: unknown;
    readonly exports?: { readonly "."?: unknown };
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("provider package manifest must declare a package name");
  }
  const rootExport = manifest.exports?.["."];
  if (
    typeof rootExport !== "object" ||
    rootExport === null ||
    Array.isArray(rootExport)
  ) {
    throw new Error(
      "provider package manifest must declare conditional root exports",
    );
  }
  const conditions = rootExport as Record<string, unknown>;
  return {
    name: manifest.name,
    sourceTarget: packageTargetPath({
      packageRoot: providerRoot,
      target: conditions.source,
      condition: "source",
    }),
    defaultTarget: packageTargetPath({
      packageRoot: providerRoot,
      target: conditions.default,
      condition: "default",
    }),
  };
}

async function readPackageName(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { readonly name?: unknown };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("consumer package manifest must declare a package name");
  }
  return manifest.name;
}

function commandStdout(result: unknown): string {
  return typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
    ? result.stdout.trim()
    : "";
}

/**
 * Proves one focused Package Link consumes the current provider manifest in
 * both source and built-distribution modes.
 */
export async function runFocusedProviderConsumptionProbe(options: {
  readonly scenarioLabel: string;
  readonly projectDir: string;
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
  readonly run?: GeneratedCommandRunner;
}): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const consumerRoot = path.join(
    options.projectDir,
    options.consumerPackagePath,
  );
  const providerRoot = path.join(
    options.projectDir,
    options.providerPackagePath,
  );
  const diagnostic = `${options.scenarioLabel} (consumer ${options.consumerPackagePath}, provider ${options.providerPackagePath})`;
  let consumerName: string;
  let provider: FocusedProviderManifest;
  try {
    [consumerName, provider] = await Promise.all([
      readPackageName(consumerRoot),
      readFocusedProviderManifest(providerRoot),
    ]);
  } catch (error) {
    throw new Error(
      `Focused provider probe could not read manifests for ${diagnostic}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const id = randomUUID().replaceAll("-", "");
  const exportName = `templateFocusedExport${id}`;
  const marker = `focused-provider-marker:${id}`;
  const probeName = `.focused-provider-probe-${id}.mjs`;
  const probePath = path.join(consumerRoot, probeName);
  try {
    const originalSource = await readFile(provider.sourceTarget, "utf8");
    await Promise.all([
      writeFile(
        provider.sourceTarget,
        `${originalSource}${originalSource.endsWith("\n") ? "" : "\n"}export const ${exportName} = ${JSON.stringify(marker)};\n`,
      ),
      writeFile(
        probePath,
        [
          `import { ${exportName} } from ${JSON.stringify(provider.name)};`,
          `console.log(${exportName});`,
          "",
        ].join("\n"),
      ),
    ]);
    const sourceResult = await run("node", ["--conditions=source", probeName], {
      cwd: consumerRoot,
    });
    if (commandStdout(sourceResult) !== marker) {
      throw new Error("source probe did not print the injected marker");
    }

    await run(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        `--filter=${consumerName}`,
        `--filter=${provider.name}`,
        "--force",
      ],
      { cwd: options.projectDir, stdio: "inherit" },
    );
    await readFile(provider.defaultTarget);
    await rm(provider.sourceTarget);

    const defaultResult = await run("node", [probeName], {
      cwd: consumerRoot,
    });
    if (commandStdout(defaultResult) !== marker) {
      throw new Error("default probe did not print the built marker");
    }
  } catch (error) {
    throw new Error(
      `Focused provider consumption failed for ${diagnostic} (${provider.name}): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(probePath, { force: true });
  }
}

function expectedTaskIds(options: {
  readonly plan: ReturnType<typeof planGeneratedRepositoryInitialization>;
  readonly taskNames: readonly string[];
}): readonly string[] {
  return options.plan.manifests.flatMap((manifest) => {
    const name = manifest.name;
    const scripts = manifest.scripts;
    if (
      typeof name !== "string" ||
      typeof scripts !== "object" ||
      scripts === null
    ) {
      return [];
    }
    return options.taskNames.flatMap((taskName) =>
      typeof (scripts as Record<string, unknown>)[taskName] !== "string"
        ? []
        : [`${name.startsWith("@") ? name : "//"}#${taskName}`],
    );
  });
}

/**
 * Validates the real Turbo action graph rather than treating a successful
 * command launch as proof that every generated Package Boundary was selected.
 */
export async function assertGeneratedTaskDiscovery(options: {
  readonly plan: ReturnType<typeof planGeneratedRepositoryInitialization>;
  readonly projectDir: string;
  readonly taskNames: readonly string[];
  readonly run?: GeneratedCommandRunner;
}): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const result = await run(
    "pnpm",
    ["exec", "turbo", "run", ...options.taskNames, "--dry-run=json"],
    { cwd: options.projectDir },
  );
  let taskIds: Set<string>;
  try {
    const stdout =
      typeof result === "object" &&
      result !== null &&
      "stdout" in result &&
      typeof result.stdout === "string"
        ? result.stdout
        : "";
    const dryRun = JSON.parse(stdout) as {
      tasks?: readonly { taskId?: unknown }[];
    };
    if (!Array.isArray(dryRun.tasks)) throw new Error("tasks is missing");
    taskIds = new Set(
      dryRun.tasks.flatMap((task) =>
        typeof task.taskId === "string" ? [task.taskId] : [],
      ),
    );
  } catch (error) {
    throw new Error(
      `Turbo dry-run did not return a task graph for ${options.taskNames.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const missing = expectedTaskIds(options).filter(
    (taskId) => !taskIds.has(taskId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Turbo dry-run omitted generated task(s): ${missing.join(", ")}`,
    );
  }
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

async function assertDockerAvailableForDeploymentGate(
  options: GeneratedScenarioRunOptions,
): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], {
      cwd: options.workspace,
    });
  } catch (error) {
    throw new Error(
      `Docker is required for the deployment scenario set; check:deployment was not executed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runScenario(
  scenario: GeneratedScenario,
  options: GeneratedScenarioRunOptions,
  mode: GeneratedScenarioSet,
  checks: RegistryChecks,
): Promise<void> {
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

  options.reporter?.info?.(`Checking generated scenario ${scenario.label}`);
  await run("pnpm", generatedScenarioInstallArgs(options.workspace), {
    cwd: projectDir,
    stdio: "inherit",
  });
  await assertGeneratedTaskDiscovery({
    plan: finalPlan,
    projectDir,
    taskNames: qualityTaskNames,
    run,
  });
  if (mode === "package-addition-matrix" || mode === "deployment") {
    await assertGeneratedTaskDiscovery({
      plan: finalPlan,
      projectDir,
      taskNames: fixTaskNames,
      run,
    });
  }
  if (mode === "deployment") {
    await assertGeneratedTaskDiscovery({
      plan: finalPlan,
      projectDir,
      taskNames: ["deployment"],
      run,
    });
  }
  await prepareGeneratedScenarioEnvironment({
    plan: finalPlan,
    projectDir,
    mode,
    run,
  });
  if (mode === "package-addition-matrix" || mode === "deployment") {
    await run("pnpm", ["run", "fix"], {
      cwd: projectDir,
      stdio: "inherit",
    });
  }
  await run("pnpm", ["run", "check"], {
    cwd: projectDir,
    stdio: "inherit",
  });
  if (mode === "focused") {
    const initialPackagePaths = new Set(
      initialization.blueprint.packages.map((item) => item.path),
    );
    const addedProviders = finalPlan.blueprint.packages.filter(
      (item) => !initialPackagePaths.has(item.path),
    );
    const consumerPackagePath = scenario.linkFrom?.[0];
    if (consumerPackagePath === undefined || addedProviders.length !== 1) {
      throw new Error(
        `Focused scenario ${scenario.label} did not identify exactly one consumer and added provider`,
      );
    }
    await runFocusedProviderConsumptionProbe({
      scenarioLabel: scenario.label,
      projectDir,
      consumerPackagePath,
      providerPackagePath: addedProviders[0]!.path,
      run,
    });
  }
  if (mode === "deployment") {
    await runRequiredDeploymentQualityGate({
      plan: finalPlan,
      projectDir,
      run,
    });
  }
}

/** Runs registry-derived generated repositories through their production plans. */
export async function runGeneratedScenarioSet(
  set: GeneratedScenarioSet,
  options: GeneratedScenarioRunOptions,
): Promise<void> {
  if (set === "deployment") {
    await assertDockerAvailableForDeploymentGate(options);
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
