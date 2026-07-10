import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PackageAdditionSupport } from "@ykdz/template-shared";
import { execa } from "execa";
import * as v from "valibot";

import { assembleGenerationContext } from "./generation-context.ts";
import {
  type CheckEnvironmentNeed,
  deploymentCheckEnvironmentNeeds,
  type DeploymentCheckEnvironmentNeed,
  playwrightBrowserAssetsEnvironmentNeed,
} from "./module-graph.ts";
import { planNextStepInstructions } from "./next-step-instructions.ts";
import {
  canPlanPackageLinkIntent,
  type PackageDefinition,
} from "./package-linking.ts";
import type {
  PresetSourceManifest,
  PresetSourceManifestPreset,
} from "./preset-source.ts";
import { findPresetSourceManifestPreset } from "./preset-source.ts";
import {
  blueprintForPresetSourcePreset,
  projectPresetSourcePreset,
  type PresetProjectionSourceRoots,
} from "./projection-capabilities.ts";

export type GeneratedScenarioSet =
  | "init"
  | "package-addition-matrix"
  | "focused";

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
  readonly environmentNeedKind?:
    | CheckEnvironmentNeed["kind"]
    | DeploymentCheckEnvironmentNeed["kind"];
  readonly phase?: "deployment-preparation" | "deployment";
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
  readonly replayCache?: GeneratedScenarioReplayCache | undefined;
};

export type ExclusiveLock = {
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>;
};

export type GeneratedScenarioReplayCache = {
  readonly directory: string;
  readonly read: boolean;
  readonly write: boolean;
};

type GeneratedScenarioInstallResult = {
  readonly fingerprint?: string | undefined;
  readonly baseQualityGateReplayed: boolean;
};

const defaultDeterministicToolchainEnv = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};
const defaultFixtureConcurrency = 2;
const scenarioFingerprintVersion = 2;
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
  const supportedInitPresets = manifest.presets.filter(
    (preset) => preset.generation === "supported",
  );
  const initScenarios = supportedInitPresets.map((preset) =>
    createGeneratedScenario("init", { basePreset: preset.name }),
  );

  if (set === "init") {
    return { runnable: initScenarios, skipped: [] };
  }

  const addablePresets = manifest.presets.filter(
    (preset) =>
      preset.packageAdditionSupport === PackageAdditionSupport.Supported,
  );
  const focusedScenarios = selectFocusedGeneratedScenarios(
    manifest,
    addablePresets,
  );

  if (set === "focused") {
    return {
      runnable: focusedScenarios,
      skipped: [],
    };
  }

  const matrixScenarios = supportedInitPresets.flatMap((basePreset) =>
    addablePresets.map((addedPreset) =>
      createGeneratedScenario("package-addition-matrix", {
        basePreset: basePreset.name,
        addedPreset: addedPreset.name,
      }),
    ),
  );

  return {
    runnable: [...matrixScenarios, ...focusedScenarios],
    skipped: [],
  };
}

function selectFocusedGeneratedScenarios(
  manifest: PresetSourceManifest,
  addablePresets: readonly PresetSourceManifestPreset[],
): GeneratedScenario[] {
  return manifest.presets
    .filter((preset) => preset.generation === "supported")
    .flatMap((basePreset) =>
      addablePresets.flatMap((addedPreset) => {
        const consumerPackagePath = focusedPackageLinkConsumerPath(
          basePreset,
          addedPreset,
        );

        return consumerPackagePath === undefined
          ? []
          : [
              createGeneratedScenario("focused", {
                basePreset: basePreset.name,
                addedPreset: addedPreset.name,
                linkFrom: [consumerPackagePath],
              }),
            ];
      }),
    );
}

function focusedPackageLinkConsumerPath(
  basePreset: PresetSourceManifestPreset,
  addedPreset: PresetSourceManifestPreset,
): string | undefined {
  const providers = packageLinkProviderDefinitions(addedPreset);

  return packageLinkConsumerDefinitions(basePreset).find((consumer) =>
    providers.some((provider) =>
      canPlanPackageLinkIntent({ consumer, provider }),
    ),
  )?.path;
}

function packageLinkProviderDefinitions(
  preset: PresetSourceManifestPreset,
): PackageDefinition[] {
  return (
    preset.projection?.capabilities.flatMap((capability) => {
      if (capability.kind !== "workspace-library-package") {
        return [];
      }

      const packageLeafName = `fixture-${preset.name}`;

      return [
        {
          name: `@fixture/${packageLeafName}`,
          path: `${packageCollection(capability.workspacePackageGlob)}/${packageLeafName}`,
          role: capability.packageRole,
          sourcePreset: capability.packageSourcePreset,
        },
      ];
    }) ?? []
  );
}

function packageLinkConsumerDefinitions(
  preset: PresetSourceManifestPreset,
): PackageDefinition[] {
  return (
    preset.projection?.capabilities.flatMap((capability) => {
      if (capability.kind !== "workspace-node-packages") {
        return [];
      }

      return capability.packages
        .filter((nodePackage) =>
          nodePackage.sourceFiles.some((sourceFile) =>
            hasSourceDirectoryPath(sourceFile),
          ),
        )
        .map((nodePackage) => ({
          name: `@fixture/${packageLeaf(nodePackage.path)}`,
          path: nodePackage.path,
          role: "runtime-service" as const,
          sourcePreset: nodePackage.kind,
        }));
    }) ?? []
  );
}

function packageCollection(workspacePackageGlob: string): string {
  const [collection, wildcard] = workspacePackageGlob.split("/");
  if (!collection || wildcard !== "*") {
    throw new Error(
      `Unsupported workspace package glob: ${workspacePackageGlob}`,
    );
  }

  return collection;
}

function packageLeaf(packagePath: string): string {
  return packagePath.split("/").at(-1) ?? packagePath;
}

function hasSourceDirectoryPath(sourceFile: string): boolean {
  return sourceFile.startsWith("src/") || sourceFile.includes("/src/");
}

function scenarioFingerprintPrefix(scenario: GeneratedScenario): string {
  return JSON.stringify({
    version: scenarioFingerprintVersion,
    scenario,
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split(".")[0],
    qualityGateProtocol: "lockfile-only-snapshot-then-fix-check",
  });
}

async function hashGeneratedScenarioDirectory(
  scenario: GeneratedScenario,
  projectDir: string,
): Promise<string> {
  const hash = createHash("sha256");

  hash.update(scenarioFingerprintPrefix(scenario));
  await hashDirectoryEntries(projectDir, projectDir, hash);

  return hash.digest("hex");
}

async function hashDirectoryEntries(
  rootDir: string,
  currentDir: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const entryPath = path.join(currentDir, entry.name);
    const relativePath = path
      .relative(rootDir, entryPath)
      .split(path.sep)
      .join("/");

    if (entry.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`);
      await hashDirectoryEntries(rootDir, entryPath, hash);
      continue;
    }

    if (!entry.isFile()) {
      const fileStat = await stat(entryPath);
      hash.update(`special\0${relativePath}\0${fileStat.mode.toString(8)}\0`);
      continue;
    }

    const fileStat = await stat(entryPath);
    hash.update(`file\0${relativePath}\0${fileStat.mode.toString(8)}\0`);
    hash.update(await readFile(entryPath));
    hash.update("\0");
  }
}

async function scenarioReplayMarkerExists(
  cache: GeneratedScenarioReplayCache,
  fingerprint: string,
): Promise<boolean> {
  try {
    await readFile(path.join(cache.directory, `${fingerprint}.passed`), "utf8");
    return true;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function writeScenarioReplayMarker(
  cache: GeneratedScenarioReplayCache,
  fingerprint: string,
  scenario: GeneratedScenario,
): Promise<void> {
  await mkdir(cache.directory, { recursive: true });
  await writeFile(
    path.join(cache.directory, `${fingerprint}.passed`),
    `${JSON.stringify({ scenario, fingerprint })}\n`,
    "utf8",
  );
}

function deploymentReplayFingerprint(fingerprint: string): string {
  return createHash("sha256")
    .update(`${fingerprint}\0docker-engine-available`)
    .digest("hex");
}

export function packageLeafNameForAddedPreset(
  manifest: PresetSourceManifest,
  presetName: string,
): string {
  const preset = manifest.presets.find((entry) => entry.name === presetName);

  if (!preset) {
    throw new Error(`Unknown fixture Package Addition preset: ${presetName}`);
  }

  if (preset.packageAdditionSupport !== PackageAdditionSupport.Supported) {
    throw new Error(
      `Preset ${presetName} cannot be used for fixture Package Addition`,
    );
  }

  const packageLeafName = `fixture-${presetName}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageLeafName)) {
    throw new Error(
      `Fixture Package Addition leaf name for preset ${presetName} must be a lowercase package leaf name using letters, numbers, and hyphens`,
    );
  }

  return packageLeafName;
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
    "node",
    [
      "--conditions=source",
      options.cliPath,
      "init",
      projectDir,
      "--preset",
      scenario.basePreset,
      "--yes",
    ],
    options.repoRoot,
    {
      env: options.deterministicToolchainEnv,
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
    "node",
    [
      "--conditions=source",
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
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.11.0" },
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

function deploymentStepsForPreset(
  presetName: string,
  scenario: GeneratedScenario,
  projectDir: string,
  manifest: PresetSourceManifest,
  options: RequiredRunnerOptions,
): GeneratedScenarioCommandStep[] {
  if (scenario.set === "init") {
    return [];
  }

  const deploymentChecks =
    projectionPlanForPreset(presetName, projectDir, manifest, options).checkPlan
      .deploymentChecks ?? [];
  const needsDocker = deploymentChecks.some((check) =>
    deploymentCheckEnvironmentNeeds(check).some(
      (need) => need.kind === "docker-engine",
    ),
  );

  if (!needsDocker) {
    return [];
  }

  return [
    {
      id: "check-docker-engine",
      command: "docker",
      args: ["info", "--format", "{{.ServerVersion}}"],
      cwd: projectDir,
      display: "docker info --format {{.ServerVersion}}",
      environmentNeedKind: "docker-engine",
      phase: "deployment-preparation",
    },
    {
      id: "run-deployment-check",
      command: "pnpm",
      args: ["run", "check:deployment"],
      cwd: projectDir,
      display: "pnpm run check:deployment",
      phase: "deployment",
    },
  ];
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
  const deploymentSteps = deploymentStepsForPreset(
    scenario.basePreset,
    scenario,
    projectDir,
    manifest,
    normalizedOptions,
  );

  if (extraEnvironmentSteps.length === 0) {
    return [...steps, ...deploymentSteps];
  }

  const rootCheckIndex = steps.findIndex(
    (step) => step.id === "run-root-check",
  );
  if (rootCheckIndex === -1) {
    return [...steps, ...extraEnvironmentSteps, ...deploymentSteps];
  }

  return [
    ...steps.slice(0, rootCheckIndex),
    ...extraEnvironmentSteps,
    ...steps.slice(rootCheckIndex),
    ...deploymentSteps,
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
  let replayFingerprint: string | undefined;
  let baseQualityGateReplayed = false;
  let baseQualityGateMarkerWritten = false;

  for (const step of steps) {
    if (step.id === "install-dependencies") {
      const installResult = await runGeneratedScenarioInstallStep(
        step,
        scenario,
        options,
      );
      replayFingerprint = installResult.fingerprint;
      baseQualityGateReplayed = installResult.baseQualityGateReplayed;
      continue;
    }

    if (
      baseQualityGateReplayed &&
      step.phase !== "deployment-preparation" &&
      step.phase !== "deployment"
    ) {
      continue;
    }

    const env = step.id === "run-root-check" ? { CI: "1" } : undefined;
    const runStep = async () => {
      await options.runCommand(step.command, [...step.args], step.cwd, {
        ...(env === undefined ? {} : { env }),
        logPrefix: scenario.label,
      });
    };

    if (step.environmentNeedKind === "docker-engine") {
      try {
        await runStep();
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        options.reporter.info?.(
          `-- Skipping deployment check for ${scenario.label}: Docker engine is unavailable (${reason})`,
        );
        break;
      }
      continue;
    }

    if (step.phase === "deployment") {
      const deploymentFingerprint =
        replayFingerprint === undefined
          ? undefined
          : deploymentReplayFingerprint(replayFingerprint);
      if (
        deploymentFingerprint !== undefined &&
        options.replayCache?.read &&
        (await scenarioReplayMarkerExists(
          options.replayCache,
          deploymentFingerprint,
        ))
      ) {
        options.reporter.info?.(
          `-- Replayed passed deployment fixture ${scenario.label}: ${deploymentFingerprint}`,
        );
        continue;
      }
      try {
        await runStep();
      } catch (error: unknown) {
        throw new Error(
          `Generated deployment command failed for ${scenario.label}; command: ${step.display}. See the cause for the deployment mode, phase, command output, and retained container logs.`,
          { cause: error },
        );
      }
      if (deploymentFingerprint !== undefined && options.replayCache?.write) {
        await writeScenarioReplayMarker(
          options.replayCache,
          deploymentFingerprint,
          scenario,
        );
        options.reporter.info?.(
          `-- Stored passed deployment fixture replay marker for ${scenario.label}: ${deploymentFingerprint}`,
        );
      }
      continue;
    }

    if (step.id === "run-root-check" && requiresSerializedPlaywrightRootCheck) {
      await options.rootCheckLock.run(runStep);
    } else {
      await runStep();
    }
    if (
      step.id === "run-root-check" &&
      options.replayCache?.write &&
      replayFingerprint !== undefined
    ) {
      await writeScenarioReplayMarker(
        options.replayCache,
        replayFingerprint,
        scenario,
      );
      baseQualityGateMarkerWritten = true;
      options.reporter.info?.(
        `-- Stored passed fixture replay marker for ${scenario.label}: ${replayFingerprint}`,
      );
    }
  }

  if (
    options.replayCache?.write &&
    replayFingerprint !== undefined &&
    !baseQualityGateMarkerWritten &&
    !baseQualityGateReplayed
  ) {
    await writeScenarioReplayMarker(
      options.replayCache,
      replayFingerprint,
      scenario,
    );
    options.reporter.info?.(
      `-- Stored passed fixture replay marker for ${scenario.label}: ${replayFingerprint}`,
    );
  }
}

async function runGeneratedScenarioInstallStep(
  step: GeneratedScenarioCommandStep,
  scenario: GeneratedScenario,
  options: RequiredRunnerOptions,
): Promise<GeneratedScenarioInstallResult> {
  await options.runCommand(
    step.command,
    ["install", "--lockfile-only", "--prefer-offline", "--no-frozen-lockfile"],
    step.cwd,
    { logPrefix: scenario.label },
  );
  let replayFingerprint: string | undefined;

  if (options.replayCache) {
    replayFingerprint = await hashGeneratedScenarioDirectory(
      scenario,
      step.cwd,
    );

    if (
      options.replayCache.read &&
      (await scenarioReplayMarkerExists(options.replayCache, replayFingerprint))
    ) {
      options.reporter.info?.(
        `-- Replayed passed base quality gate for ${scenario.label}: ${replayFingerprint}`,
      );
      return { fingerprint: replayFingerprint, baseQualityGateReplayed: true };
    }
  }

  await options.runCommand(step.command, ["fetch"], step.cwd, {
    logPrefix: scenario.label,
  });
  await options.runCommand(
    step.command,
    ["install", "--offline", "--frozen-lockfile"],
    step.cwd,
    { logPrefix: scenario.label },
  );

  return { fingerprint: replayFingerprint, baseQualityGateReplayed: false };
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
    | "replayCache"
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
    replayCache: options.replayCache,
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
