import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "#template-core/dependency-catalog";
import { browserTestToolLayer } from "#template-core/devcontainer";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
} from "#template-core/editor-customization";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "#template-core/module-graph";
import {
  checkEnvironmentNeedFact,
  checkEnvironmentNeedFromFact,
  deploymentEnvironmentNeedFact,
  deploymentEnvironmentNeedFromFact,
  renderDeploymentCheckCommand,
  renderFixCommand,
  renderRootCheckCommand,
} from "#template-core/module-graph";
import type {
  CheckEnvironmentNeedFact,
  ComponentOwner,
  DeploymentEnvironmentNeedFact,
} from "#template-core/module-graph";
import {
  assertPackageContribution,
  type PackageContribution,
} from "#template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
} from "#template-core/preset-definition";
import {
  assertProjectBlueprintV2,
  validateProjectBlueprintV2 as validateCoreProjectBlueprintV2,
  type ProjectBlueprintV2,
} from "#template-core/project-blueprint-v2";
import type { DependencyMaintenancePolicy } from "#template-core/project-github";
import {
  projectCheckWorkflowTemplateReplacements,
  projectDependabotTemplateReplacements,
} from "#template-core/project-github";
import { planExplicitProjectLinks } from "#template-core/project-linking-v2";
import type {
  MaterializeProjectProjectionOptions,
  ProjectProjectionPathPrecondition,
  ProjectProjectionReconciliation,
} from "#template-core/project-projection";
import type { RenderOperation } from "#template-core/renderer";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "#template-core/renderer";

import { rustBinDefinition } from "./rust-bin/definition.ts";
import { vuePnpmDependencyOverrides } from "./shared/vue.ts";
import { templateSources } from "./template-sources.ts";
import { tsCliDefinition } from "./ts-cli/definition.ts";
import { tsLibDefinition } from "./ts-lib/definition.ts";
import { vikeAppDefinition } from "./vike-app/definition.ts";
import { vueAppDefinition } from "./vue-app/definition.ts";
import { vueHonoAppDefinition } from "./vue-hono-app/definition.ts";

export type {
  PackageDefinition,
  PackageLinkIntent,
  PackageRole,
  ProjectBlueprintV2,
} from "#template-core/project-blueprint-v2";
export type { PackageContribution } from "#template-core/package-contribution";

export type BuiltInGenerationContext = GenerationContext;
export type { BuiltInPresetDefinition } from "#template-core/preset-definition";

export type NextStepInstruction = {
  readonly display: string;
};

type GeneratedPackagePlanningRecord = {
  readonly path: string;
  readonly definitionName: string;
  readonly planningContribution: "planInitialization" | "planPackageAddition";
};

type GenerationRecord = {
  readonly schemaVersion: 1;
  readonly preset: string;
  readonly templateVersion: "0.0.0";
  readonly toolchain: BuiltInGenerationContext["toolchain"];
  readonly packages: readonly GeneratedPackagePlanningRecord[];
};

export type GeneratedRepositoryPlan = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly planningContribution: "planInitialization" | "planPackageAddition";
  readonly blueprint: ProjectBlueprintV2;
  readonly generationRecord: GenerationRecord;
  readonly operations: readonly RenderOperation[];
  readonly reconciliation: readonly ProjectProjectionReconciliation[];
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
  readonly deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[];
  /** Structured manifests used to derive the generated Dependency Catalog. */
  readonly manifests: readonly Readonly<Record<string, unknown>>[];
  readonly dependencyCatalog: Readonly<Record<string, string>>;
  readonly dependencyMaintenancePolicy: DependencyMaintenancePolicy;
  readonly nextStepInstructions: readonly NextStepInstruction[];
};

export type GeneratedRepositoryPackageAdditionPlan = GeneratedRepositoryPlan & {
  readonly projectProjections: {
    readonly before: MaterializeProjectProjectionOptions;
    readonly after: MaterializeProjectProjectionOptions;
    readonly preconditions: readonly ProjectProjectionPathPrecondition[];
  };
};

type PersistedEnvironmentNeeds = {
  readonly schemaVersion: 1;
  readonly check: readonly CheckEnvironmentNeedFact[];
  readonly deployment: readonly DeploymentEnvironmentNeedFact[];
};

const environmentNeedsPath = ".template/environment-needs.json";

const packageManifestKeyOrder = [
  "name",
  "version",
  "private",
  "bin",
  "files",
  "type",
  "types",
  "imports",
  "exports",
  "publishConfig",
  "scripts",
  "dependencies",
  "devDependencies",
  "dependenciesMeta",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "packageManager",
] as const;
const packageConditionKeyOrder = ["source", "types", "default"] as const;

/** One independently checkable initial Package Contribution and its real plan. */
export type BuiltInPresetTemplateSourceCheckContext = {
  readonly definition: BuiltInPresetDefinition;
  readonly contribution: PackageContribution;
  readonly plan: GeneratedRepositoryPlan;
};

/**
 * The Foundation persists the non-rendering half of every Package
 * Contribution with the Generated Repository.  Package Addition cannot infer
 * fix, deployment, or maintenance semantics from a package name (or
 * from a lossy subset of scripts), so this is the durable topology it reads.
 */
/** Resolve an owned source handle for diagnostics and source checks. */
export function resolveBuiltInTemplateSource(
  source: TemplateSourceHandle,
  relativePath: string,
): string {
  return resolveTemplateSource(source, relativePath);
}

export function validateProjectBlueprintV2(value: unknown) {
  return validateCoreProjectBlueprintV2(value);
}

class PresetRegistry {
  readonly #definitions: readonly BuiltInPresetDefinition[];
  constructor(definitions: readonly BuiltInPresetDefinition[]) {
    const names = definitions.map((definition) => definition.metadata.name);
    if (
      names.some((name) => name.length === 0) ||
      new Set(names).size !== names.length
    ) {
      throw new Error(
        "Preset Registry requires unique non-empty Definition names",
      );
    }
    this.#definitions = [...definitions].toSorted((left, right) =>
      left.metadata.name.localeCompare(right.metadata.name),
    );
  }
  all(): readonly BuiltInPresetDefinition[] {
    return this.#definitions;
  }
  require(name: string): BuiltInPresetDefinition {
    const definition = this.#definitions.find(
      (item) => item.metadata.name === name,
    );
    if (!definition) throw new Error(`Unknown Built-in Preset: ${name}`);
    return definition;
  }
}

export const builtInPresetRegistry = new PresetRegistry([
  tsCliDefinition,
  tsLibDefinition,
  rustBinDefinition,
  vueAppDefinition,
  vueHonoAppDefinition,
  vikeAppDefinition,
]);

/** Registry-derived Template Source roots checked independently of render plans. */
export function builtInPresetTemplateSourceContexts(): readonly {
  readonly name: string;
  readonly root: string;
}[] {
  return [
    ...builtInPresetRegistry.all().map((definition) => ({
      name: definition.metadata.name,
      root: resolveBuiltInTemplateSource(definition.source, "."),
    })),
    {
      name: "foundation",
      root: resolveBuiltInTemplateSource(templateSources.foundation, "."),
    },
    {
      name: "shared-devcontainer",
      root: resolveBuiltInTemplateSource(
        templateSources.sharedDevcontainer,
        ".",
      ),
    },
    {
      name: "shared-oxc",
      root: resolveBuiltInTemplateSource(templateSources.sharedOxc, "."),
    },
    {
      name: "shared-vue",
      root: resolveBuiltInTemplateSource(templateSources.vue, "."),
    },
  ];
}

/**
 * Derives direct Template Source checks from every registered Definition's
 * actual initial contributions, without maintaining a second Preset catalog.
 */
export function builtInPresetTemplateSourceCheckContexts(): readonly BuiltInPresetTemplateSourceCheckContext[] {
  return builtInPresetRegistry.all().flatMap((definition) => {
    const context = createGenerationContext({
      targetDir: path.join(
        "generated-repository",
        "template-source",
        definition.metadata.name,
      ),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const plan = planGeneratedRepositoryInitialization({ definition, context });
    const contributions = definition.planInitializationContributions?.(
      context,
    ) ?? [definition.planInitialization(context)];

    return contributions.map((contribution) => ({
      definition,
      contribution,
      plan,
    }));
  });
}

export function createGenerationContext(options: {
  readonly targetDir: string;
  readonly scope?: string;
  readonly toolchain: BuiltInGenerationContext["toolchain"];
}): BuiltInGenerationContext {
  const projectName = path.basename(path.resolve(options.targetDir));
  return {
    targetDir: options.targetDir,
    projectName,
    scope: options.scope ?? projectName,
    toolchain: options.toolchain,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGenerationRecord(options: {
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
}): GenerationRecord {
  const generationPath = path.join(
    options.context.targetDir,
    ".template/generation.json",
  );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(generationPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Package Addition requires valid Generation Record facts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (
        ![
          "schemaVersion",
          "preset",
          "templateVersion",
          "toolchain",
          "packages",
        ].includes(key)
      ) {
        throw new Error(
          `Package Addition Generation Record contains unknown field: ${key}`,
        );
      }
    }
    if (isRecord(value.toolchain)) {
      for (const key of Object.keys(value.toolchain)) {
        if (!["nodeLtsMajor", "packageManagerPin"].includes(key)) {
          throw new Error(
            `Package Addition Generation Record toolchain contains unknown field: ${key}`,
          );
        }
      }
    }
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.preset !== "string" ||
    value.templateVersion !== "0.0.0" ||
    !isRecord(value.toolchain) ||
    typeof value.toolchain.nodeLtsMajor !== "string" ||
    typeof value.toolchain.packageManagerPin !== "string" ||
    !Array.isArray(value.packages)
  ) {
    throw new Error(
      "Package Addition requires a supported Generation Record in .template/generation.json",
    );
  }
  const packages: GeneratedPackagePlanningRecord[] = [];
  for (const [index, item] of value.packages.entries()) {
    if (isRecord(item)) {
      for (const key of Object.keys(item)) {
        if (!["path", "definitionName", "planningContribution"].includes(key)) {
          throw new Error(
            `Package Addition Generation Record packages[${index}] contains unknown field: ${key}`,
          );
        }
      }
    }
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.definitionName !== "string" ||
      !["planInitialization", "planPackageAddition"].includes(
        String(item.planningContribution),
      )
    ) {
      throw new Error(
        `Package Addition requires valid package planning facts at .template/generation.json packages[${index}]`,
      );
    }
    packages.push(item as GeneratedPackagePlanningRecord);
  }
  const blueprintPaths = options.blueprint.packages
    .map((definition) => definition.path)
    .toSorted();
  const recordedPaths = packages.map((item) => item.path).toSorted();
  if (
    JSON.stringify(blueprintPaths) !== JSON.stringify(recordedPaths) ||
    new Set(recordedPaths).size !== recordedPaths.length
  ) {
    throw new Error(
      "Package Addition requires Generation Record packages to match the current Project Blueprint",
    );
  }
  const generationRecord: GenerationRecord = {
    schemaVersion: 1,
    preset: value.preset,
    templateVersion: value.templateVersion,
    toolchain: {
      nodeLtsMajor: value.toolchain.nodeLtsMajor,
      packageManagerPin: value.toolchain.packageManagerPin,
    },
    packages,
  };
  assertGenerationRecordFoundationConsistency({
    context: options.context,
    blueprint: options.blueprint,
    generationRecord,
  });
  return generationRecord;
}

function assertGenerationRecordFoundationConsistency(options: {
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
  readonly generationRecord: GenerationRecord;
}): void {
  const initialRecords = options.generationRecord.packages.filter(
    (record) => record.planningContribution === "planInitialization",
  );
  if (initialRecords.length === 0) {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} has no initial Package provenance`,
    );
  }
  const conflictingRecord = initialRecords.find(
    (record) => record.definitionName !== options.generationRecord.preset,
  );
  if (conflictingRecord !== undefined) {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} conflicts with initial Package provenance ${conflictingRecord.definitionName} for Blueprint package ${conflictingRecord.path}`,
    );
  }

  let rootDefinition: BuiltInPresetDefinition;
  try {
    rootDefinition = builtInPresetRegistry.require(
      options.generationRecord.preset,
    );
  } catch {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} is not a registered Built-in Preset`,
    );
  }
  const initialBlueprint = rootDefinition.blueprint(options.context);
  assertProjectBlueprintV2(initialBlueprint);
  const expectedPaths = initialBlueprint.packages
    .map((definition) => definition.path)
    .toSorted();
  const recordedInitialPaths = initialRecords
    .map((record) => record.path)
    .toSorted();
  if (JSON.stringify(recordedInitialPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} expects initial Blueprint packages ${expectedPaths.join(", ")}, but initial provenance records ${recordedInitialPaths.join(", ")}`,
    );
  }
  for (const expectedDefinition of initialBlueprint.packages) {
    const currentDefinition = options.blueprint.packages.find(
      (definition) => definition.path === expectedDefinition.path,
    );
    if (
      currentDefinition === undefined ||
      !packageDefinitionsEqual(currentDefinition, expectedDefinition)
    ) {
      throw new Error(
        `Package Addition Generation Record preset ${options.generationRecord.preset} cannot reproduce initial Blueprint Package Definition ${expectedDefinition.name} at ${expectedDefinition.path} (${expectedDefinition.role})`,
      );
    }
  }
  for (const expectedIntent of initialBlueprint.packageLinkIntents ?? []) {
    if (
      !(options.blueprint.packageLinkIntents ?? []).some((currentIntent) =>
        packageLinkIntentsEqual(currentIntent, expectedIntent),
      )
    ) {
      throw new Error(
        `Package Addition Generation Record preset ${options.generationRecord.preset} cannot reproduce initial Blueprint Package Link Intent ${expectedIntent.consumerPackagePath} -> ${expectedIntent.providerPackagePath}`,
      );
    }
  }
}

function environmentNeedOwner(value: unknown): ComponentOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "workspace-orchestration" && value.path === ".") {
    return { kind: "workspace-orchestration", path: "." };
  }
  if (value.kind === "package-boundary" && typeof value.path === "string") {
    return { kind: "package-boundary", path: value.path };
  }
  return undefined;
}

function assertEnvironmentNeedFactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(
        `Package Addition Environment Need ${context} contains unknown field: ${key}`,
      );
    }
  }
}

function persistedCheckEnvironmentNeedFact(
  value: unknown,
  index: number,
): CheckEnvironmentNeedFact | undefined {
  if (!isRecord(value)) return undefined;
  const context = `check[${index}]`;
  switch (value.kind) {
    case "playwright-browser-assets":
      assertEnvironmentNeedFactKeys(
        value,
        ["kind", "browser", "owner"],
        context,
      );
      break;
    case "shellcheck-command":
      assertEnvironmentNeedFactKeys(value, ["kind", "owner"], context);
      break;
    case "rust-toolchain":
      assertEnvironmentNeedFactKeys(
        value,
        ["kind", "owner", "toolchain"],
        context,
      );
      break;
    default:
      return undefined;
  }
  if (isRecord(value.owner)) {
    assertEnvironmentNeedFactKeys(
      value.owner,
      ["kind", "path"],
      `${context}.owner`,
    );
  }
  const owner = environmentNeedOwner(value.owner);
  if (owner === undefined) return undefined;
  switch (value.kind) {
    case "playwright-browser-assets":
      return value.browser === "chromium"
        ? { kind: value.kind, browser: value.browser, owner }
        : undefined;
    case "shellcheck-command":
      return { kind: value.kind, owner };
    case "rust-toolchain":
      return value.toolchain === "stable"
        ? { kind: value.kind, toolchain: value.toolchain, owner }
        : undefined;
    default:
      return undefined;
  }
}

function readPersistedEnvironmentNeeds(targetDir: string): {
  readonly check: readonly CheckEnvironmentNeed[];
  readonly deployment: readonly DeploymentEnvironmentNeed[];
} {
  const filePath = path.join(targetDir, environmentNeedsPath);
  if (!existsSync(filePath)) {
    throw new Error(
      `Package Addition requires explicit Check Environment Need facts: ${environmentNeedsPath} is missing`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Package Addition requires valid Check Environment Need facts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (!["schemaVersion", "check", "deployment"].includes(key)) {
        throw new Error(
          `Package Addition Environment Need facts contain unknown field: ${key}`,
        );
      }
    }
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.check) ||
    !Array.isArray(value.deployment)
  ) {
    throw new Error(
      `Package Addition requires valid Check Environment Need facts in ${environmentNeedsPath}`,
    );
  }
  const check = value.check.map(persistedCheckEnvironmentNeedFact);
  if (check.some((fact) => fact === undefined)) {
    throw new Error(
      `Package Addition requires supported Check Environment Need facts in ${environmentNeedsPath}`,
    );
  }
  if (
    value.deployment.some((fact, index) => {
      if (!isRecord(fact) || fact.kind !== "docker-engine") return true;
      assertEnvironmentNeedFactKeys(fact, ["kind"], `deployment[${index}]`);
      return false;
    })
  ) {
    throw new Error(
      `Package Addition requires supported deployment Environment Need facts in ${environmentNeedsPath}`,
    );
  }
  return {
    check: (check as CheckEnvironmentNeedFact[]).map(
      checkEnvironmentNeedFromFact,
    ),
    deployment: value.deployment.map((fact) =>
      deploymentEnvironmentNeedFromFact(fact as DeploymentEnvironmentNeedFact),
    ),
  };
}

function uniqueEnvironmentNeeds<T>(needs: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return needs.filter((need) => {
    const key = JSON.stringify(need);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readExistingPackageAdditionState(options: {
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
}): {
  readonly contributions: readonly PackageContribution[];
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[];
  readonly generationRecord: GenerationRecord;
} {
  const generationRecord = readGenerationRecord(options);
  const persistedEnvironmentNeeds = readPersistedEnvironmentNeeds(
    options.context.targetDir,
  );
  const manifestTruthByPackagePath = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const contributions = generationRecord.packages.map((record) => {
    const expectedDefinition = options.blueprint.packages.find(
      (definition) => definition.path === record.path,
    )!;
    const definition = builtInPresetRegistry.require(record.definitionName);
    let candidates: readonly PackageContribution[];
    if (record.planningContribution === "planInitialization") {
      candidates = definition.planInitializationContributions?.(
        options.context,
      ) ?? [definition.planInitialization(options.context)];
    } else {
      if (definition.planPackageAddition === undefined) {
        throw new Error(
          `Generation Record Definition ${record.definitionName} no longer supports Package Addition`,
        );
      }
      const packageLeafName = expectedDefinition.name.split("/")[1];
      if (!packageLeafName) {
        throw new Error(
          `Generation Record package has an invalid name: ${expectedDefinition.name}`,
        );
      }
      candidates = [
        definition.planPackageAddition({
          context: options.context,
          packageLeafName,
          packagePath: expectedDefinition.path,
        }),
      ];
    }
    const contribution = candidates.find((candidate) =>
      packageDefinitionsEqual(candidate.definition, expectedDefinition),
    );
    if (contribution === undefined) {
      throw new Error(
        `Generation Record cannot reproduce Package Definition ${expectedDefinition.name} at ${expectedDefinition.path}`,
      );
    }
    const manifestPath = path.join(
      options.context.targetDir,
      expectedDefinition.path,
      "package.json",
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Package Addition requires manifest truth for ${expectedDefinition.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(manifest) || manifest.name !== expectedDefinition.name) {
      throw new Error(
        `Package Addition requires manifest truth for ${expectedDefinition.path}: expected name ${expectedDefinition.name}`,
      );
    }
    manifestTruthByPackagePath.set(expectedDefinition.path, manifest);
    return contribution;
  });
  const reconstructedCheckFacts = uniqueEnvironmentNeeds(
    contributions.flatMap((contribution) => contribution.environmentNeeds),
  ).map(checkEnvironmentNeedFact);
  const reconstructedDeploymentFacts = uniqueEnvironmentNeeds(
    contributions.flatMap(
      (contribution) => contribution.deploymentEnvironmentNeeds ?? [],
    ),
  ).map(deploymentEnvironmentNeedFact);
  const persistedCheckFacts = persistedEnvironmentNeeds.check.map(
    checkEnvironmentNeedFact,
  );
  const persistedDeploymentFacts = persistedEnvironmentNeeds.deployment.map(
    deploymentEnvironmentNeedFact,
  );
  if (
    JSON.stringify(reconstructedCheckFacts) !==
      JSON.stringify(persistedCheckFacts) ||
    JSON.stringify(reconstructedDeploymentFacts) !==
      JSON.stringify(persistedDeploymentFacts)
  ) {
    throw new Error(
      "Package Addition requires persisted Environment Need facts to match the reproducible Project Projection",
    );
  }
  return {
    contributions,
    manifestTruthByPackagePath,
    deploymentEnvironmentNeeds: persistedEnvironmentNeeds.deployment,
    generationRecord,
  };
}

function packageDefinitionsEqual(
  left: ProjectBlueprintV2["packages"][number],
  right: ProjectBlueprintV2["packages"][number],
): boolean {
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.role === right.role
  );
}

function packageLinkIntentsEqual(
  left: NonNullable<ProjectBlueprintV2["packageLinkIntents"]>[number],
  right: NonNullable<ProjectBlueprintV2["packageLinkIntents"]>[number],
): boolean {
  return (
    left.consumerPackagePath === right.consumerPackagePath &&
    left.providerPackagePath === right.providerPackagePath
  );
}

function turboBoundaryTagsForContributions(
  contributions: readonly PackageContribution[],
): readonly ("app" | "library")[] {
  const selectedTags = new Set<"app" | "library">();
  for (const contribution of contributions) {
    switch (contribution.definition.role) {
      case "cli-tool":
      case "runtime-service":
        selectedTags.add("app");
        break;
      case "shared-library":
        selectedTags.add("library");
        break;
      case "native-package":
        break;
    }
  }
  return [...selectedTags];
}

function devcontainerDockerfileOperations(options: {
  readonly context: BuiltInGenerationContext;
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
}): RenderOperation[] {
  const hasBrowserTests = options.environmentNeeds.some(
    (need) => need.kind === "playwright-browser-assets",
  );
  const hasShellChecks = options.environmentNeeds.some(
    (need) => need.kind === "shellcheck-command",
  );
  const browserLayer = hasBrowserTests ? browserTestToolLayer() : undefined;
  return [
    {
      kind: "writeTextTemplate",
      source: templateSources.foundation,
      from: "devcontainer.json",
      to: ".devcontainer/devcontainer.json",
      replacements: {
        PROJECT_NAME: options.context.projectName,
        NODE_LTS_MAJOR: options.context.toolchain.nodeLtsMajor,
        PACKAGE_MANAGER_PIN: options.context.toolchain.packageManagerPin,
        PLAYWRIGHT_CLI_PACKAGE: browserLayer?.playwrightCliPackage ?? "unused",
      },
    },
    {
      kind: "writeTextFromFragments",
      to: ".devcontainer/Dockerfile",
      fragments: [
        {
          source: templateSources.sharedDevcontainer,
          from: "node-pnpm.Dockerfile",
        },
        ...(browserLayer === undefined
          ? []
          : [
              {
                source: templateSources.sharedDevcontainer,
                from: "browser-test.Dockerfile",
              },
            ]),
        ...(hasShellChecks
          ? [
              {
                source: templateSources.sharedDevcontainer,
                from: "shellcheck.Dockerfile",
              },
            ]
          : []),
      ],
    },
  ];
}

function foundationPlan(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
  readonly contributions: readonly PackageContribution[];
  /** Contributions whose package-owned operations are rendered in this pass. */
  readonly renderContributions?: readonly PackageContribution[];
  /** Focused deployment preparation recovered from durable Environment Need facts. */
  readonly existingDeploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
  /** Current manifests used only to decide explicitly requested links. */
  readonly manifestTruthByPackagePath?: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly generationRecord?: GenerationRecord;
  readonly mode: "initialization" | "addition";
}): GeneratedRepositoryPlan {
  assertProjectBlueprintV2(options.blueprint);
  const generationRecord: GenerationRecord = options.generationRecord ?? {
    schemaVersion: 1,
    preset: options.definition.metadata.name,
    templateVersion: "0.0.0",
    toolchain: options.context.toolchain,
    packages: options.contributions.map((contribution) => ({
      path: contribution.definition.path,
      definitionName: options.definition.metadata.name,
      planningContribution:
        options.mode === "initialization"
          ? "planInitialization"
          : "planPackageAddition",
    })),
  };
  const environmentNeeds = uniqueEnvironmentNeeds(
    options.contributions.flatMap((item) => item.environmentNeeds),
  );
  const deploymentEnvironmentNeeds = uniqueEnvironmentNeeds([
    ...(options.existingDeploymentEnvironmentNeeds ?? []),
    ...options.contributions.flatMap(
      (item) => item.deploymentEnvironmentNeeds ?? [],
    ),
  ]);
  const persistedEnvironmentNeeds: PersistedEnvironmentNeeds = {
    schemaVersion: 1,
    check: environmentNeeds.map(checkEnvironmentNeedFact),
    deployment: deploymentEnvironmentNeeds.map(deploymentEnvironmentNeedFact),
  };
  const hasDeploymentTask = options.contributions.some((contribution) => {
    const scripts = contribution.manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).deployment === "string"
    );
  });
  const packagePaths = options.contributions.map(
    (contribution) => contribution.definition.path,
  );
  if (new Set(packagePaths).size !== packagePaths.length)
    throw new Error("Package Contributions must have unique Package Paths");
  const packageNames = options.contributions.map(
    (contribution) => contribution.definition.name,
  );
  if (new Set(packageNames).size !== packageNames.length)
    throw new Error("Package Contributions must have unique package names");
  const rustToolchain = options.contributions
    .map((contribution) => contribution.foundation.toolchains.rust)
    .find((toolchain) => toolchain !== undefined);
  if (
    options.contributions.some(
      (contribution) =>
        contribution.foundation.toolchains.rust !== undefined &&
        contribution.foundation.toolchains.rust !== rustToolchain,
    )
  ) {
    throw new Error("Foundation requires one coordinated Rust toolchain");
  }
  const workspacePackageGlobs = [
    "apps/*",
    "packages/*",
    ...new Set([
      ...options.blueprint.packages
        .map((definition) => `${definition.path.split("/")[0]}/*`)
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
      ...options.contributions
        .flatMap(
          (contribution) => contribution.foundation.workspacePackageGlobs ?? [],
        )
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
    ]),
  ];
  const editorCustomization = editorCustomizationForCapabilities(
    options.contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
    loadEditorCustomizationDeclarations(
      resolveTemplateSource(
        templateSources.editorCustomization,
        "capabilities.json",
      ),
    ),
  );
  const dependencyMaintenancePolicy: DependencyMaintenancePolicy = {
    ecosystems: [
      ...new Set(
        options.contributions.flatMap(
          (contribution) =>
            contribution.foundation.dependencyMaintenance.ecosystems,
        ),
      ),
    ],
    directories: Object.assign(
      {},
      ...options.contributions.map(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.directories ?? {},
      ),
    ),
    extraDirectories: Object.assign(
      {},
      ...options.contributions.map(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.extraDirectories ?? {},
      ),
    ),
    interval: "weekly",
  };
  const rootManifest = {
    name: options.context.projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      check: renderRootCheckCommand(),
      boundaries: "node --conditions=source scripts/check-boundaries.ts",
      ...(hasDeploymentTask
        ? { "check:deployment": renderDeploymentCheckCommand() }
        : {}),
      fix: renderFixCommand(),
      "format:check":
        "node --conditions=source scripts/run-root-owned-task.ts format:check",
      "format:write":
        "node --conditions=source scripts/run-root-owned-task.ts format:write",
      lint: "node --conditions=source scripts/run-root-owned-task.ts lint",
      "lint:fix":
        "node --conditions=source scripts/run-root-owned-task.ts lint:fix",
      typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
    },
    devDependencies: {
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      turbo: "catalog:",
      "typescript-7": "catalog:",
    },
    engines: { node: options.context.toolchain.nodeLtsMajor },
    packageManager: options.context.toolchain.packageManagerPin,
  };
  const dependencyCatalog = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences([
      ...options.contributions.map((contribution) => contribution.manifest),
      rootManifest,
    ]),
  );
  const dependencyOverrides = {
    ...(Object.hasOwn(dependencyCatalog, "vue") ||
    Object.hasOwn(dependencyCatalog, "pinia")
      ? vuePnpmDependencyOverrides
      : {}),
  };
  const workspaceOperation: RenderOperation = {
    kind: "writeTextTemplate",
    source: templateSources.foundation,
    from: "pnpm-workspace.dynamic.txt",
    to: "pnpm-workspace.yaml",
    replacements: {
      WORKSPACE_PACKAGE_GLOBS: workspacePackageGlobs
        .map((glob) => `  - ${glob}`)
        .join("\n"),
      DEPENDENCY_CATALOG: Object.entries(dependencyCatalog)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(
          ([name, version]) => `  ${JSON.stringify(name)}: ${String(version)}`,
        )
        .join("\n"),
      DEPENDENCY_OVERRIDES_SECTION:
        Object.keys(dependencyOverrides).length === 0
          ? ""
          : [
              "",
              "overrides:",
              ...Object.entries(dependencyOverrides)
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(
                  ([dependency, version]) =>
                    `  ${JSON.stringify(dependency)}: ${JSON.stringify(version)}`,
                ),
              "",
            ].join("\n"),
    },
  };
  const workflowOperation: RenderOperation = {
    kind: "writeTextTemplate",
    source: templateSources.foundation,
    from: ".github/workflows/check.dynamic.template",
    to: ".github/workflows/check.yml",
    replacements: projectCheckWorkflowTemplateReplacements({
      environment: { needs: environmentNeeds },
      deploymentEnvironmentNeeds,
      hasDeploymentTask,
    }),
  };
  const workflowOperations: RenderOperation[] = [
    workflowOperation,
    {
      kind: "writeTextTemplate" as const,
      source: templateSources.foundation,
      from: ".github/dependabot.dynamic.template",
      to: ".github/dependabot.yml",
      replacements: projectDependabotTemplateReplacements(
        dependencyMaintenancePolicy,
      ),
    },
  ];
  const projectLinkPlan = planExplicitProjectLinks({
    blueprint: options.blueprint,
    contributions: options.contributions,
    ...(options.manifestTruthByPackagePath === undefined
      ? {}
      : {
          manifestTruthByPackagePath: options.manifestTruthByPackagePath,
        }),
  });
  const turboBoundaryTags = turboBoundaryTagsForContributions(
    options.contributions,
  );
  const initializationFoundationOperations: RenderOperation[] = [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootManifest,
      keyOrder: packageManifestKeyOrder,
      nestedKeyOrder: packageConditionKeyOrder,
    },
    workspaceOperation,
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "gitignore",
      to: ".gitignore",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "turbo.json",
      to: "turbo.json",
    },
    ...turboBoundaryTags.map(
      (tag): RenderOperation => ({
        kind: "mergeJsonTemplate",
        source: templateSources.foundation,
        from: `turbo-boundary-tags/${tag}.json`,
        to: "turbo.json",
      }),
    ),
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "scripts/check-boundaries.ts",
      to: "scripts/check-boundaries.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "scripts/run-root-owned-task.ts",
      to: "scripts/run-root-owned-task.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "tsconfig.json",
      to: "tsconfig.json",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "tsconfig.config.json",
      to: "tsconfig.config.json",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "node/oxlint.config.ts",
      to: "oxlint.config.ts",
    },
    {
      kind: "copyFile",
      source: templateSources.sharedOxc,
      from: "oxfmt.config.ts",
      to: "oxfmt.config.ts",
    },
    {
      kind: "writeJson",
      to: ".vscode/extensions.json",
      value: { recommendations: editorCustomization.extensions },
      ...(editorCustomization.extensions.length > 2
        ? { multilineArrays: ["recommendations"] }
        : {}),
    },
    {
      kind: "writeJson",
      to: ".vscode/settings.json",
      value: editorCustomization.settings,
    },
    ...(rustToolchain === undefined
      ? [
          ...devcontainerDockerfileOperations({
            context: options.context,
            environmentNeeds,
          }),
        ]
      : [
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "rust/rust-toolchain.toml",
            to: "rust-toolchain.toml",
            replacements: { RUST_TOOLCHAIN: rustToolchain.toolchain },
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "rust/devcontainer/devcontainer.json",
            to: ".devcontainer/devcontainer.json",
            replacements: {
              PROJECT_NAME: options.context.projectName,
              NODE_LTS_MAJOR: options.context.toolchain.nodeLtsMajor,
              PACKAGE_MANAGER_PIN: options.context.toolchain.packageManagerPin,
              RUST_TOOLCHAIN: rustToolchain.toolchain,
            },
          },
          {
            kind: "writeTextFromFragments" as const,
            to: ".devcontainer/Dockerfile",
            fragments: [
              {
                source: templateSources.sharedDevcontainer,
                from: "node-pnpm.Dockerfile",
              },
              {
                source: templateSources.foundation,
                from: "rust/devcontainer/rust.Dockerfile",
              },
              ...(environmentNeeds.some(
                (need) => need.kind === "playwright-browser-assets",
              )
                ? [
                    {
                      source: templateSources.sharedDevcontainer,
                      from: "browser-test.Dockerfile",
                    },
                  ]
                : []),
              ...(environmentNeeds.some(
                (need) => need.kind === "shellcheck-command",
              )
                ? [
                    {
                      source: templateSources.sharedDevcontainer,
                      from: "shellcheck.Dockerfile",
                    },
                  ]
                : []),
            ],
          },
        ]),
    ...workflowOperations,
    {
      kind: "writeJson",
      to: ".template/blueprint.json",
      value: options.blueprint,
    },
    {
      kind: "writeJson",
      to: environmentNeedsPath,
      value: persistedEnvironmentNeeds,
    },
    {
      kind: "writeJson",
      to: ".template/generation.json",
      value: generationRecord,
    },
  ];
  const plannedFoundationOperations = initializationFoundationOperations;
  const linkOperations: RenderOperation[] = [
    ...projectLinkPlan.manifestPatchesByPackagePath,
  ].map(([packagePath, manifestPatch]) => ({
    kind: "mergeJson" as const,
    to: `${packagePath}/package.json`,
    value: manifestPatch,
    multilineArrays: ["files"],
    keyOrder: packageManifestKeyOrder,
    nestedKeyOrder: packageConditionKeyOrder,
  }));
  const contributionProvenance = {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: options.definition.plannerSourceFile,
    planningContribution:
      options.mode === "addition"
        ? "planPackageAddition"
        : "planInitialization",
    ownershipRule:
      "Package Contribution may write only its owned Package Boundary",
  } as const;
  const foundationProvenance = {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: fileURLToPath(import.meta.url),
    planningContribution: "foundationPlan",
    ownershipRule: "Foundation owns coordinated root outputs",
  } as const;
  const withProvenance = (
    operation: RenderOperation,
    provenance: typeof contributionProvenance | typeof foundationProvenance,
  ): RenderOperation => ({ ...operation, provenance });
  const operations: RenderOperation[] = [
    ...(options.renderContributions ?? options.contributions)
      .map((item) =>
        assertPackageContribution(item, {
          definitionName: options.definition.metadata.name,
          planner:
            options.mode === "addition"
              ? "planPackageAddition"
              : "planInitialization",
        }),
      )
      .flatMap((item) =>
        item.operations.map((operation) =>
          operation.kind === "writeJson" &&
          operation.to.endsWith("/package.json")
            ? {
                ...operation,
                value: item.manifest,
                keyOrder: packageManifestKeyOrder,
                nestedKeyOrder: packageConditionKeyOrder,
              }
            : operation,
        ),
      )
      .map((operation) => withProvenance(operation, contributionProvenance)),
    ...plannedFoundationOperations.map((operation) =>
      withProvenance(operation, foundationProvenance),
    ),
    ...linkOperations.map((operation) =>
      withProvenance(operation, foundationProvenance),
    ),
  ];
  const reconciliation: readonly ProjectProjectionReconciliation[] = [
    { path: "turbo.json", driver: "structured" },
    { path: ".devcontainer/devcontainer.json", driver: "structured" },
    {
      path: ".vscode/extensions.json",
      driver: "structured",
      identitySets: [
        {
          location: "/recommendations",
          identity: { kind: "self" },
        },
      ],
    },
    { path: ".template/blueprint.json", driver: "canonical" },
    { path: environmentNeedsPath, driver: "canonical" },
    { path: ".template/generation.json", driver: "canonical" },
  ];
  return {
    definitionName: options.definition.metadata.name,
    plannerSourceFile: options.definition.plannerSourceFile,
    planningContribution:
      options.mode === "addition"
        ? "planPackageAddition"
        : "planInitialization",
    blueprint: options.blueprint,
    generationRecord,
    operations,
    reconciliation,
    environmentNeeds,
    deploymentEnvironmentNeeds,
    manifests: [
      ...options.contributions.map((item) => item.manifest),
      rootManifest,
    ],
    dependencyCatalog,
    dependencyMaintenancePolicy,
    nextStepInstructions: [
      { display: "pnpm install" },
      ...environmentNeeds.map((need) => ({ display: need.nextStep.display })),
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ],
  };
}

export function planGeneratedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
}): GeneratedRepositoryPlan {
  const blueprint = options.definition.blueprint(options.context);
  const contributions = options.definition.planInitializationContributions?.(
    options.context,
  ) ?? [options.definition.planInitialization(options.context)];
  return foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    contributions,
    mode: "initialization",
  });
}

export function planGeneratedRepositoryPackageAddition(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprintV2;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  /** Existing consumers that explicitly import the newly added provider. */
  readonly linkFrom?: readonly string[];
}): GeneratedRepositoryPackageAdditionPlan {
  assertProjectBlueprintV2(options.blueprint);
  if (!options.definition.planPackageAddition)
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} does not support Package Addition`,
    );
  const packagePath =
    options.packagePath ??
    options.definition.defaultPackagePath?.({
      context: options.context,
      packageLeafName: options.packageLeafName,
    });
  if (packagePath === undefined) {
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} must own a default Package Path or receive an explicit Package Path`,
    );
  }
  const contribution = options.definition.planPackageAddition({
    context: options.context,
    packageLeafName: options.packageLeafName,
    packagePath,
  });
  const requestedPackageLinkIntents = [...new Set(options.linkFrom ?? [])].map(
    (consumerPackagePath) => ({
      consumerPackagePath,
      providerPackagePath: contribution.definition.path,
    }),
  );
  const conflictingPackage = options.blueprint.packages.find(
    (existing) =>
      existing.name === contribution.definition.name ||
      existing.path === contribution.definition.path,
  );
  if (conflictingPackage !== undefined) {
    const isExactPackageDefinition = packageDefinitionsEqual(
      conflictingPackage,
      contribution.definition,
    );
    const existingPackageLinkIntents =
      options.blueprint.packageLinkIntents ?? [];
    const missingPackageLinkIntent = requestedPackageLinkIntents.find(
      (requested) =>
        !existingPackageLinkIntents.some((existing) =>
          packageLinkIntentsEqual(existing, requested),
        ),
    );
    if (isExactPackageDefinition && missingPackageLinkIntent === undefined) {
      const existing = readExistingPackageAdditionState(options);
      const plan = foundationPlan({
        definition: options.definition,
        context: options.context,
        blueprint: options.blueprint,
        contributions: existing.contributions,
        renderContributions: [],
        existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
        generationRecord: existing.generationRecord,
        mode: "addition",
      });
      const currentProjection = foundationPlan({
        definition: options.definition,
        context: options.context,
        blueprint: options.blueprint,
        contributions: existing.contributions,
        existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
        generationRecord: existing.generationRecord,
        mode: "initialization",
      });
      return {
        ...plan,
        operations: [],
        projectProjections: {
          before: {
            operations: currentProjection.operations,
            reconciliation: currentProjection.reconciliation,
          },
          after: {
            operations: currentProjection.operations,
            reconciliation: currentProjection.reconciliation,
          },
          preconditions: [],
        },
      };
    }
    if (isExactPackageDefinition) {
      throw new Error(
        `Package Addition conflicts because requested Package Link Intent ${missingPackageLinkIntent!.consumerPackagePath} -> ${missingPackageLinkIntent!.providerPackagePath} does not already exist`,
      );
    }
    throw new Error(
      `Package Addition conflicts with existing Package Definition ${conflictingPackage.name} at ${conflictingPackage.path} (${conflictingPackage.role}); requested ${contribution.definition.name} at ${contribution.definition.path} (${contribution.definition.role})`,
    );
  }
  const blueprint: ProjectBlueprintV2 = {
    ...options.blueprint,
    packages: [...options.blueprint.packages, contribution.definition],
    ...(requestedPackageLinkIntents.length > 0
      ? {
          packageLinkIntents: [
            ...(options.blueprint.packageLinkIntents ?? []),
            ...requestedPackageLinkIntents,
          ],
        }
      : {}),
  };
  assertProjectBlueprintV2(blueprint);
  const existing = readExistingPackageAdditionState(options);
  const generationRecord: GenerationRecord = {
    ...existing.generationRecord,
    packages: [
      ...existing.generationRecord.packages,
      {
        path: contribution.definition.path,
        definitionName: options.definition.metadata.name,
        planningContribution: "planPackageAddition",
      },
    ],
  };
  const beforeProjection = foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint: options.blueprint,
    contributions: existing.contributions,
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    generationRecord: existing.generationRecord,
    mode: "initialization",
  });
  const afterProjection = foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    contributions: [...existing.contributions, contribution],
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    ...(requestedPackageLinkIntents.length === 0
      ? {}
      : {
          manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
        }),
    generationRecord,
    mode: "initialization",
  });
  const plan = foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    contributions: [...existing.contributions, contribution],
    renderContributions: [contribution],
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    ...(requestedPackageLinkIntents.length === 0
      ? {}
      : {
          manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
        }),
    generationRecord,
    mode: "addition",
  });
  return {
    ...plan,
    projectProjections: {
      before: {
        operations: beforeProjection.operations,
        reconciliation: beforeProjection.reconciliation,
      },
      after: {
        operations: afterProjection.operations,
        reconciliation: afterProjection.reconciliation,
      },
      preconditions: [
        {
          path: contribution.definition.path,
          kind: "must-not-exist",
          reason: `Package Path ${contribution.definition.path} already exists and cannot be used for a new Package Addition`,
        },
      ],
    },
  };
}
