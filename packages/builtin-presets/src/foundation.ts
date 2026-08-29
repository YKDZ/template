import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { composeCiDiagnosticArtifacts } from "#template-core/ci-diagnostic-artifact";
import type { CiDiagnosticArtifactDeclaration } from "#template-core/ci-diagnostic-artifact";
import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "#template-core/dependency-catalog";
import {
  planDevelopmentContainerToolLayersSync,
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerBuildArgument,
  type DevelopmentContainerToolLayerMount,
  type DevelopmentContainerToolLayerProbe,
  type PlannedDevelopmentContainerToolLayer,
} from "#template-core/development-container-tool-layer";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
} from "#template-core/editor-customization";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
  EnvironmentNeedsMetadata,
} from "#template-core/module-graph";
import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  renderDeploymentCheckCommand,
  renderFixCommand,
  renderRootCheckCommand,
  renderTurboRunCommand,
} from "#template-core/module-graph";
import {
  assertPackageContribution,
  assertPackageContributionCommandNames,
  type PackageContribution,
} from "#template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
  InitialPackageDefinitionLookup,
  PackageContributionReplayAdapter,
  PlannedPackageContribution,
  ResolvedPrimaryPackageIdentity,
} from "#template-core/preset-definition";
import {
  assertProjectBlueprint,
  assertProjectBlueprintDraft,
  isValidNewNpmPackageName,
  validateNewPackagePath,
  validateProjectBlueprint as validateCoreProjectBlueprint,
  type PackageDefinition,
  type PackageDefinitionId,
  type PersistedPackageDefinition,
  type ProjectBlueprint,
} from "#template-core/project-blueprint";
import type { DependencyMaintenancePolicy } from "#template-core/project-github";
import {
  projectCheckWorkflowTemplateSource,
  projectCheckWorkflowTemplateReplacements,
  projectDependabotTemplateReplacements,
} from "#template-core/project-github";
import { planExplicitProjectLinks } from "#template-core/project-linking-v2";
import type {
  MaterializeProjectProjectionOptions,
  ProjectProjectionPathPrecondition,
  ProjectProjectionReconciliation,
  StructuredIdentitySetPolicy,
} from "#template-core/project-projection";
import { validateProjectProjectionPlan } from "#template-core/project-projection";
import type { RenderOperation } from "#template-core/renderer";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "#template-core/renderer";

import {
  isValidDefaultPackageScope,
  parseGenerationRecord,
  type GeneratedPackagePlanningRecord,
  type GenerationRecord,
} from "./generation-record.ts";
import { rustBinDefinition } from "./rust-bin/definition.ts";
import { githubCliDevelopmentContainerToolLayer } from "./shared/development-container.ts";
import {
  typescriptConfigContribution,
  typescriptConfigPackageDefinition,
  typescriptConfigReplayAdapter,
} from "./shared/typescript.ts";
import { vuePnpmDependencyOverrides } from "./shared/vue.ts";
import { templateSources } from "./template-sources.ts";
import { tsCliDefinition } from "./ts-cli/definition.ts";
import { tsLibDefinition } from "./ts-lib/definition.ts";
import { vikeAppDefinition } from "./vike-app/definition.ts";
import { vueAppDefinition } from "./vue-app/definition.ts";
import { vueHonoAppDefinition } from "./vue-hono-app/definition.ts";

export type {
  PackageDefinition,
  PackageDefinitionId,
  PackageLinkIntent,
  PackageRole,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "#template-core/project-blueprint";
export type { PackageContribution } from "#template-core/package-contribution";

export type BuiltInGenerationContext = GenerationContext;
export type { BuiltInPresetDefinition } from "#template-core/preset-definition";

export type NextStepInstruction = {
  readonly display: string;
};

export type GeneratedRepositoryPlan = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly planningContribution: "planInitialization" | "planPackageAddition";
  readonly blueprint: ProjectBlueprint;
  readonly generationRecord: GenerationRecord;
  /** Resolved Preset contributions consumed by Blueprint and projections. */
  readonly packageContributions: readonly PlannedPackageContribution[];
  readonly operations: readonly RenderOperation[];
  readonly reconciliation: readonly ProjectProjectionReconciliation[];
  readonly developmentContainer: {
    readonly toolLayers: readonly PlannedDevelopmentContainerToolLayer[];
    readonly buildArguments: readonly DevelopmentContainerToolLayerBuildArgument[];
    readonly mounts: readonly DevelopmentContainerToolLayerMount[];
    readonly probes: readonly DevelopmentContainerToolLayerProbe[];
  };
  readonly environmentNeeds: readonly CheckEnvironmentNeed[];
  readonly deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[];
  readonly ciDiagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
  /** Structured manifests used to derive the generated Dependency Catalog. */
  readonly manifests: readonly Readonly<Record<string, unknown>>[];
  readonly dependencyCatalog: Readonly<Record<string, string>>;
  readonly dependencyMaintenancePolicy: DependencyMaintenancePolicy;
  readonly nextStepInstructions: readonly NextStepInstruction[];
};

const localTemplateMetadataStateKey: unique symbol = Symbol(
  "localTemplateMetadataState",
);

export type LocalTemplateMetadata = {
  readonly blueprint: ProjectBlueprint;
  readonly context: BuiltInGenerationContext;
  /** Opaque Foundation-owned facts; callers pass the whole metadata value. */
  readonly [localTemplateMetadataStateKey]: {
    readonly generationRecord: GenerationRecord;
    readonly foundationContribution: PlannedPackageContribution;
    readonly packageContributions: readonly PlannedPackageContribution[];
  };
};

export type GeneratedRepositoryPackageAdditionPlan = GeneratedRepositoryPlan & {
  readonly projectProjections: {
    readonly before: MaterializeProjectProjectionOptions;
    readonly after: MaterializeProjectProjectionOptions;
    readonly preconditions: readonly ProjectProjectionPathPrecondition[];
  };
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

export function validateProjectBlueprint(value: unknown) {
  return validateCoreProjectBlueprint(value);
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
    for (const definition of definitions) {
      const adapterIdentities =
        definition.packageContributionReplayAdapters.map(
          (adapter) => adapter.identity,
        );
      if (
        adapterIdentities.length === 0 ||
        adapterIdentities.some((identity) => identity.length === 0) ||
        new Set(adapterIdentities).size !== adapterIdentities.length
      ) {
        throw new Error(
          `Built-in Preset ${definition.metadata.name} requires unique non-empty Package Contribution replay adapters`,
        );
      }
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

export function createGenerationContext(options: {
  readonly targetDir: string;
  readonly defaultPackageScope?: string;
  readonly toolchain: BuiltInGenerationContext["toolchain"];
}): BuiltInGenerationContext {
  const repositoryName = path.basename(path.resolve(options.targetDir));
  const defaultPackageScope = options.defaultPackageScope ?? repositoryName;
  return {
    targetDir: options.targetDir,
    repositoryName,
    defaultPackageScope,
    foundationPackages: {
      typescriptConfiguration: {
        name: `@${defaultPackageScope}/typescript-config`,
      },
    },
    toolchain: options.toolchain,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PackageCreationProvenance = Pick<
  GeneratedPackagePlanningRecord,
  "definitionName" | "planningContribution" | "contributionIdentity"
>;

const packageDefinitionIdDomain = "ykdz.template.package-definition-id.v1";

function packageDefinitionIdDigest(value: unknown): PackageDefinitionId {
  return `package-${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function allocatePackageDefinitionId(options: {
  readonly definition: PackageDefinition;
  readonly provenance: PackageCreationProvenance;
  readonly occupiedIds: ReadonlySet<PackageDefinitionId>;
}): PackageDefinitionId {
  const creationFacts = {
    domain: packageDefinitionIdDomain,
    definition: {
      name: options.definition.name,
      path: options.definition.path,
      role: options.definition.role,
    },
    provenance: {
      definitionName: options.provenance.definitionName,
      planningContribution: options.provenance.planningContribution,
      contributionIdentity: options.provenance.contributionIdentity,
    },
  };
  let nonce = 0;
  while (true) {
    const candidate = packageDefinitionIdDigest(
      nonce === 0
        ? creationFacts
        : {
            creationFacts,
            occupiedIds: [...options.occupiedIds].toSorted(),
            nonce,
          },
    );
    if (!options.occupiedIds.has(candidate)) return candidate;
    nonce += 1;
  }
}

function persistPackageDefinition(options: {
  readonly definition: PackageDefinition;
  readonly provenance: PackageCreationProvenance;
  readonly occupiedIds: Set<PackageDefinitionId>;
}): PersistedPackageDefinition {
  const packageDefinitionId = allocatePackageDefinitionId(options);
  options.occupiedIds.add(packageDefinitionId);
  return { ...options.definition, packageDefinitionId };
}

function readGenerationRecord(options: {
  readonly repositoryRoot: string;
}): GenerationRecord {
  const generationPath = path.join(
    options.repositoryRoot,
    ".template/generation.json",
  );
  return parseGenerationRecord(
    readJsonFile(generationPath, "Generation Record facts"),
  );
}

function readJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Package Addition requires valid ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type FoundationTypeScriptConfigurationPackageFact = {
  readonly record: GeneratedPackagePlanningRecord;
  readonly definition: PackageDefinition;
};

type PreparedPackageReplay = {
  readonly record: GeneratedPackagePlanningRecord;
  readonly definition: PackageDefinition;
  readonly owner: string;
  readonly adapter: PackageContributionReplayAdapter;
  readonly initialPackages: InitialPackageDefinitionLookup;
  readonly kind: "foundation" | "package";
};

type LocalTemplateMetadataPreflight = {
  readonly foundationPackage: FoundationTypeScriptConfigurationPackageFact;
  readonly replays: readonly PreparedPackageReplay[];
};

function barePackageDefinition(
  definition: PersistedPackageDefinition,
): PackageDefinition {
  return {
    name: definition.name,
    path: definition.path,
    role: definition.role,
  };
}

function preflightLocalTemplateMetadata(options: {
  readonly blueprint: ProjectBlueprint;
  readonly generationRecord: GenerationRecord;
}): LocalTemplateMetadataPreflight {
  const definitionsById = new Map(
    options.blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition,
    ]),
  );
  const joinedPackages = options.generationRecord.packages.map((record) => {
    const definition = definitionsById.get(record.packageDefinitionId);
    if (definition === undefined) {
      throw new Error(
        `Generation Record Package Definition ID ${record.packageDefinitionId} has no matching Project Blueprint Package Definition`,
      );
    }
    if (record.path !== definition.path) {
      throw new Error(
        `Generation Record path witness ${record.path} for Package Definition ID ${record.packageDefinitionId} conflicts with Project Blueprint path ${definition.path}`,
      );
    }
    return { record, definition: barePackageDefinition(definition) };
  });
  const recordedIds = new Set(
    options.generationRecord.packages.map(
      (record) => record.packageDefinitionId,
    ),
  );
  const unrecordedDefinition = options.blueprint.packages.find(
    (definition) => !recordedIds.has(definition.packageDefinitionId),
  );
  if (unrecordedDefinition !== undefined) {
    throw new Error(
      `Project Blueprint Package Definition ID ${unrecordedDefinition.packageDefinitionId} has no matching Generation Record provenance`,
    );
  }

  const records = options.generationRecord.packages.filter(
    (record) => record.planningContribution === "foundationPlan",
  );
  if (records.length !== 1) {
    throw new Error(
      `Package Addition requires exactly one Foundation Package Planning Provenance record; found ${records.length}`,
    );
  }
  const record = records[0]!;
  if (record.definitionName !== "foundation") {
    throw new Error(
      `Foundation Package Planning Provenance at ${record.path} must use definitionName foundation; received ${record.definitionName}`,
    );
  }
  if (record.contributionIdentity !== typescriptConfigReplayAdapter.identity) {
    throw new Error(
      `Foundation TypeScript Configuration Package provenance must use contribution identity ${typescriptConfigReplayAdapter.identity}`,
    );
  }
  const foundationPackage = joinedPackages.find(
    (candidate) => candidate.record === record,
  )!;

  let initialDefinition: BuiltInPresetDefinition;
  try {
    initialDefinition = builtInPresetRegistry.require(
      options.generationRecord.preset,
    );
  } catch {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} is not a registered Built-in Preset`,
    );
  }
  const initialRecords = options.generationRecord.packages.filter(
    (candidate) => candidate.planningContribution === "planInitialization",
  );
  if (initialRecords.length === 0) {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} has no initial Package provenance`,
    );
  }
  const conflictingRecord = initialRecords.find(
    (candidate) => candidate.definitionName !== options.generationRecord.preset,
  );
  if (conflictingRecord !== undefined) {
    throw new Error(
      `Package Addition Generation Record preset ${options.generationRecord.preset} conflicts with initial Package provenance ${conflictingRecord.definitionName} for Blueprint package ${conflictingRecord.path}`,
    );
  }

  const preparedWithoutInitialLookup = joinedPackages.map((candidate) => {
    if (candidate.record === record) {
      return {
        ...candidate,
        owner: "foundation",
        adapter: typescriptConfigReplayAdapter,
        kind: "foundation" as const,
      };
    }
    let definition: BuiltInPresetDefinition;
    try {
      definition = builtInPresetRegistry.require(
        candidate.record.definitionName,
      );
    } catch {
      throw new Error(
        `Package Addition Generation Record Package Planning Provenance references unknown Built-in Preset ${candidate.record.definitionName} for Blueprint package ${candidate.record.path}`,
      );
    }
    if (
      candidate.record.planningContribution === "planPackageAddition" &&
      definition.planPackageAddition === undefined
    ) {
      throw new Error(
        `Package Addition Generation Record Package Planning Provenance references unsupported Package Addition for Built-in Preset ${candidate.record.definitionName} at ${candidate.record.path}`,
      );
    }
    return {
      ...candidate,
      owner: definition.metadata.name,
      adapter: requireRecordReplayAdapter({
        owner: definition.metadata.name,
        adapters: definition.packageContributionReplayAdapters,
        record: candidate.record,
      }),
      kind: "package" as const,
    };
  });

  const initialPlanningKeys = initialRecords.map(
    (candidate) =>
      `${candidate.definitionName}:${candidate.contributionIdentity}`,
  );
  if (new Set(initialPlanningKeys).size !== initialPlanningKeys.length) {
    throw new Error(
      "Package Addition Generation Record contains duplicate initialization contribution identity",
    );
  }
  if (initialDefinition.initialPrimaryPackage !== undefined) {
    if (initialRecords.length !== 1) {
      throw new Error(
        `${initialDefinition.metadata.name} requires exactly one initial Primary Package Contribution provenance record`,
      );
    }
  } else {
    for (const adapter of initialDefinition.packageContributionReplayAdapters) {
      const matchingRecords = initialRecords.filter(
        (candidate) => candidate.contributionIdentity === adapter.identity,
      );
      if (matchingRecords.length !== 1) {
        throw new Error(
          `${initialDefinition.metadata.name} requires exactly one initial ${adapter.identity} Package Contribution provenance record`,
        );
      }
    }
  }
  const initialDefinitions = new Map(
    preparedWithoutInitialLookup.flatMap((candidate) =>
      candidate.record.planningContribution === "planInitialization"
        ? [[candidate.record.contributionIdentity, candidate.definition]]
        : [],
    ),
  );
  const initialPackages: InitialPackageDefinitionLookup = {
    require(identity) {
      const definition = initialDefinitions.get(identity);
      if (definition === undefined) {
        throw new Error(
          `${initialDefinition.metadata.name} has no preflighted initial ${identity} Package Definition`,
        );
      }
      return definition;
    },
  };
  const noInitialPackages: InitialPackageDefinitionLookup = {
    require(identity) {
      throw new Error(
        `Foundation replay adapter does not declare initial Package ${identity}`,
      );
    },
  };
  return {
    foundationPackage,
    replays: preparedWithoutInitialLookup.map((candidate) => ({
      ...candidate,
      initialPackages:
        candidate.kind === "foundation" ? noInitialPackages : initialPackages,
    })),
  };
}

export function loadLocalTemplateMetadata(
  repositoryRoot: string,
): LocalTemplateMetadata {
  const resolvedRoot = path.resolve(repositoryRoot);
  const blueprintPath = path.join(resolvedRoot, ".template/blueprint.json");
  let blueprint: ProjectBlueprint;
  try {
    blueprint = assertProjectBlueprint(
      readJsonFile(blueprintPath, "Project Blueprint facts"),
    );
  } catch (error) {
    throw new Error(
      `Package Addition requires a supported Project Blueprint in .template/blueprint.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const generationRecord = readGenerationRecord({
    repositoryRoot: resolvedRoot,
  });
  const preflight = preflightLocalTemplateMetadata({
    blueprint,
    generationRecord,
  });
  const context = {
    targetDir: resolvedRoot,
    repositoryName: generationRecord.repositoryName,
    defaultPackageScope: generationRecord.defaultPackageScope,
    foundationPackages: {
      typescriptConfiguration: {
        name: preflight.foundationPackage.definition.name,
      },
    },
    toolchain: generationRecord.toolchain,
  };
  const planningState = replayLocalTemplateMetadata({
    context,
    preflight,
  });
  return {
    blueprint,
    context,
    [localTemplateMetadataStateKey]: { generationRecord, ...planningState },
  };
}

function requireReplayAdapter(options: {
  readonly owner: string;
  readonly adapters: readonly PackageContributionReplayAdapter[];
  readonly identity: string;
}): PackageContributionReplayAdapter {
  const adapter = options.adapters.find(
    (candidate) => candidate.identity === options.identity,
  );
  if (adapter === undefined) {
    throw new Error(
      `unknown Package Contribution replay adapter ${options.identity}; expected ${options.adapters.map((candidate) => candidate.identity).join(", ")} for ${options.owner}`,
    );
  }
  return adapter;
}

function requireRecordReplayAdapter(options: {
  readonly owner: string;
  readonly adapters: readonly PackageContributionReplayAdapter[];
  readonly record: GeneratedPackagePlanningRecord;
}): PackageContributionReplayAdapter {
  try {
    return requireReplayAdapter({
      owner: options.owner,
      adapters: options.adapters,
      identity: options.record.contributionIdentity,
    });
  } catch (error) {
    throw new Error(
      `Package Planning Provenance ${options.owner}:${options.record.contributionIdentity} (${options.record.planningContribution}) at ${options.record.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function packageLeafName(packageDefinition: PackageDefinition): string {
  return packageDefinition.name.slice(
    packageDefinition.name.lastIndexOf("/") + 1,
  );
}

function replayPersistedPackageContribution(options: {
  readonly context: BuiltInGenerationContext;
  readonly owner: string;
  readonly adapter: PackageContributionReplayAdapter;
  readonly record: GeneratedPackagePlanningRecord;
  readonly packageDefinition: PackageDefinition;
  readonly initialPackages: InitialPackageDefinitionLookup;
}): PlannedPackageContribution {
  let contribution: PackageContribution;
  try {
    contribution = options.adapter.replay({
      context: options.context,
      planningContribution: options.record.planningContribution,
      packageDefinition: options.packageDefinition,
      packageLeafName: packageLeafName(options.packageDefinition),
      initialPackages: options.initialPackages,
    });
  } catch (error) {
    throw new Error(
      `Package Planning Provenance ${options.owner}:${options.record.contributionIdentity} (${options.record.planningContribution}) at ${options.record.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    !packageDefinitionsEqual(contribution.definition, options.packageDefinition)
  ) {
    throw new Error(
      `Package Planning Provenance ${options.owner}:${options.record.contributionIdentity} at ${options.record.path} expected ${options.packageDefinition.name} / ${options.packageDefinition.path} / ${options.packageDefinition.role}, received ${contribution.definition.name} / ${contribution.definition.path} / ${contribution.definition.role}`,
    );
  }
  return options.adapter.identify(contribution);
}

function replayLocalTemplateMetadata(options: {
  readonly context: BuiltInGenerationContext;
  readonly preflight: LocalTemplateMetadataPreflight;
}): {
  readonly foundationContribution: PlannedPackageContribution;
  readonly packageContributions: readonly PlannedPackageContribution[];
} {
  let foundationContribution: PlannedPackageContribution | undefined;
  const packageContributions: PlannedPackageContribution[] = [];
  for (const replay of options.preflight.replays) {
    const contribution = replayPersistedPackageContribution({
      context: options.context,
      owner: replay.owner,
      adapter: replay.adapter,
      record: replay.record,
      packageDefinition: replay.definition,
      initialPackages: replay.initialPackages,
    });
    if (replay.kind === "foundation") {
      foundationContribution = contribution;
    } else {
      packageContributions.push(contribution);
    }
  }
  if (foundationContribution === undefined) {
    throw new Error(
      "Package Addition Generation Record is missing its validated Foundation contribution",
    );
  }
  return { foundationContribution, packageContributions };
}

function readPersistedEnvironmentNeeds(
  targetDir: string,
): EnvironmentNeedsMetadata {
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
  try {
    return parseEnvironmentNeedsMetadata(value);
  } catch (error) {
    throw new Error(
      `Package Addition requires valid Environment Need metadata in ${environmentNeedsPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readExistingPackageAdditionState(options: {
  readonly localTemplateMetadata: LocalTemplateMetadata;
  readonly requiredManifestTruthPackagePaths?: readonly string[];
}): {
  readonly foundationContribution: PlannedPackageContribution;
  readonly contributions: readonly PlannedPackageContribution[];
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly deploymentEnvironmentNeeds: readonly DeploymentEnvironmentNeed[];
  readonly generationRecord: GenerationRecord;
} {
  const { blueprint, context } = options.localTemplateMetadata;
  const state = options.localTemplateMetadata[localTemplateMetadataStateKey];
  const {
    foundationContribution,
    generationRecord,
    packageContributions: contributions,
  } = state;
  const persistedEnvironmentNeeds = readPersistedEnvironmentNeeds(
    context.targetDir,
  );
  const manifestTruthByPackagePath = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const requiredManifestTruthPackagePaths = new Set(
    options.requiredManifestTruthPackagePaths ?? [],
  );
  for (const packagePath of requiredManifestTruthPackagePaths) {
    if (
      !blueprint.packages.some((definition) => definition.path === packagePath)
    ) {
      throw new Error(
        `Package Addition requires manifest truth for unknown Package Path ${packagePath}`,
      );
    }
  }
  for (const expectedDefinition of blueprint.packages) {
    const manifestPath = path.join(
      context.targetDir,
      expectedDefinition.path,
      "package.json",
    );
    if (
      !existsSync(manifestPath) &&
      !requiredManifestTruthPackagePaths.has(expectedDefinition.path)
    ) {
      continue;
    }
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
  }
  const reconstructedEnvironmentNeeds = normalizeEnvironmentNeeds({
    check: [foundationContribution, ...contributions].flatMap(
      (contribution) => contribution.environmentNeeds,
    ),
    deployment: [foundationContribution, ...contributions].flatMap(
      (contribution) => contribution.deploymentEnvironmentNeeds ?? [],
    ),
  });
  if (
    JSON.stringify(reconstructedEnvironmentNeeds) !==
    JSON.stringify(persistedEnvironmentNeeds)
  ) {
    throw new Error(
      "Package Addition requires persisted Environment Needs to match the reproducible Project Projection",
    );
  }
  return {
    foundationContribution,
    contributions,
    manifestTruthByPackagePath,
    deploymentEnvironmentNeeds: persistedEnvironmentNeeds.deployment,
    generationRecord,
  };
}

function packageDefinitionsEqual(
  left: PackageDefinition,
  right: PackageDefinition,
): boolean {
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.role === right.role
  );
}

function requirePersistedPackageDefinition(
  blueprint: ProjectBlueprint,
  definition: PackageDefinition,
): PersistedPackageDefinition {
  const persisted = blueprint.packages.find((candidate) =>
    packageDefinitionsEqual(candidate, definition),
  );
  if (persisted === undefined) {
    throw new Error(
      `Project Blueprint has no persisted Package Definition for ${definition.name} at ${definition.path} (${definition.role})`,
    );
  }
  return persisted;
}

function packageLinkIntentsEqual(
  left: NonNullable<ProjectBlueprint["packageLinkIntents"]>[number],
  right: NonNullable<ProjectBlueprint["packageLinkIntents"]>[number],
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

function contributedDevcontainerComposition(options: {
  readonly context: BuiltInGenerationContext;
  readonly layers: readonly DevelopmentContainerToolLayer[];
}): {
  readonly operations: readonly RenderOperation[];
  readonly mountIdentitySet: StructuredIdentitySetPolicy;
  readonly toolLayers: readonly PlannedDevelopmentContainerToolLayer[];
  readonly buildArguments: readonly DevelopmentContainerToolLayerBuildArgument[];
  readonly mounts: readonly DevelopmentContainerToolLayerMount[];
  readonly probes: readonly DevelopmentContainerToolLayerProbe[];
} {
  const layerPlan = planDevelopmentContainerToolLayersSync({
    baseLayer: {
      identity: "node-pnpm",
      dockerfile: {
        source: templateSources.sharedDevcontainer,
        from: "node-pnpm.Dockerfile",
      },
      buildArguments: [
        {
          name: "NODE_VERSION",
          value: options.context.toolchain.nodeLtsMajor,
        },
        {
          name: "PACKAGE_MANAGER_PIN",
          value: options.context.toolchain.packageManagerPin,
        },
      ],
      mounts: [
        {
          identity: "pnpm-store",
          type: "volume",
          source: "${devcontainerId}-pnpm-store",
          target: "/pnpm/store",
        },
      ],
    },
    layers: [githubCliDevelopmentContainerToolLayer(), ...options.layers],
  });

  return {
    operations: [
      {
        kind: "writeTextTemplate",
        source: templateSources.foundation,
        from: "devcontainer.json",
        to: ".devcontainer/devcontainer.json",
        replacements: {
          PROJECT_NAME: options.context.repositoryName,
          NODE_LTS_MAJOR: options.context.toolchain.nodeLtsMajor,
          PACKAGE_MANAGER_PIN: options.context.toolchain.packageManagerPin,
        },
      },
      {
        kind: "mergeJson",
        to: ".devcontainer/devcontainer.json",
        value: {
          build: {
            args: Object.fromEntries(
              layerPlan.buildArguments.map((argument) => [
                argument.name,
                argument.value,
              ]),
            ),
          },
          ...(layerPlan.mounts.length === 0
            ? {}
            : {
                mounts: layerPlan.mounts.map(
                  ({ identity: _identity, ...mount }) => mount,
                ),
              }),
        },
      },
      {
        kind: "writeTextFromFragments",
        to: ".devcontainer/Dockerfile",
        validation: "development-container-dockerfile",
        fragments: layerPlan.layers.map((layer) => layer.dockerfile),
      },
    ],
    mountIdentitySet: {
      location: "/mounts",
      identity: {
        kind: "projection",
        members: layerPlan.mounts.map(
          ({
            identity,
            target,
          }): {
            readonly identity: string;
            readonly match: {
              readonly target: string;
            };
          } => ({
            identity,
            match: { target },
          }),
        ),
        fallback: { fields: ["target"] },
      },
    },
    toolLayers: layerPlan.layers,
    buildArguments: layerPlan.buildArguments,
    mounts: layerPlan.mounts,
    probes: layerPlan.probes,
  };
}

function contributedFoundationTemplateFileOperations(
  contributions: readonly PackageContribution[],
): readonly RenderOperation[] {
  const byIdentity = new Map<
    string,
    NonNullable<PackageContribution["foundation"]["templateFiles"]>[number]
  >();
  const outputOwners = new Map<string, string>();

  for (const file of contributions.flatMap(
    (contribution) => contribution.foundation.templateFiles ?? [],
  )) {
    const previous = byIdentity.get(file.identity);
    if (previous !== undefined) {
      const previousFingerprint = JSON.stringify({
        source: resolveTemplateSource(previous.source, previous.from),
        from: previous.from,
        to: previous.to,
        replacements: previous.replacements ?? {},
      });
      const fingerprint = JSON.stringify({
        source: resolveTemplateSource(file.source, file.from),
        from: file.from,
        to: file.to,
        replacements: file.replacements ?? {},
      });
      if (fingerprint !== previousFingerprint) {
        throw new Error(
          `Foundation Template File identity ${file.identity} has conflicting descriptors`,
        );
      }
      continue;
    }
    const outputOwner = outputOwners.get(file.to);
    if (outputOwner !== undefined) {
      throw new Error(
        `Foundation Template File output ${file.to} is declared by both ${outputOwner} and ${file.identity}`,
      );
    }
    byIdentity.set(file.identity, file);
    outputOwners.set(file.to, file.identity);
  }

  return [...byIdentity.values()]
    .toSorted((left, right) => left.identity.localeCompare(right.identity))
    .map(
      (file): RenderOperation => ({
        kind: "writeTextTemplate",
        source: file.source,
        from: file.from,
        to: file.to,
        replacements: { ...file.replacements },
      }),
    );
}

function assertCompatibleRustToolchainFacts(
  contributions: readonly PackageContribution[],
): void {
  const facts = contributions.flatMap((contribution) => {
    const rust = contribution.foundation.toolchains.rust;
    return rust === undefined
      ? []
      : [
          JSON.stringify({
            toolchain: rust.toolchain,
            components: [...new Set(rust.components)].toSorted(),
          }),
        ];
  });
  if (new Set(facts).size > 1) {
    throw new Error("Foundation requires compatible Rust toolchain facts");
  }
}

function composeDependencyMaintenancePolicy(
  contributions: readonly PackageContribution[],
): DependencyMaintenancePolicy {
  const ecosystems = [
    ...new Set(
      contributions.flatMap(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.ecosystems,
      ),
    ),
  ];
  const directories: NonNullable<DependencyMaintenancePolicy["directories"]> =
    {};
  const extraDirectories: NonNullable<
    DependencyMaintenancePolicy["extraDirectories"]
  > = {};

  for (const ecosystem of ecosystems) {
    const candidates = [
      ...new Set(
        contributions.flatMap((contribution) => {
          const policy = contribution.foundation.dependencyMaintenance;
          const primary = policy.directories?.[ecosystem];
          return [
            ...(primary === undefined ? [] : [primary]),
            ...(policy.extraDirectories?.[ecosystem] ?? []),
          ];
        }),
      ),
    ];
    const [primary, ...extra] = candidates;
    if (primary !== undefined) directories[ecosystem] = primary;
    if (extra.length > 0) extraDirectories[ecosystem] = extra;
  }

  return {
    ecosystems,
    ...(Object.keys(directories).length === 0 ? {} : { directories }),
    ...(Object.keys(extraDirectories).length === 0 ? {} : { extraDirectories }),
    interval: "weekly",
  };
}

function localTypescriptConfigurationSpecifier(options: {
  readonly consumerPackagePath: string;
  readonly configurationPackagePath: string;
}): string {
  const relativePackagePath = path.posix.relative(
    options.consumerPackagePath,
    options.configurationPackagePath,
  );
  if (relativePackagePath.length === 0) {
    throw new Error(
      "TypeScript Configuration Package must have a distinct Package Path",
    );
  }
  return `link:${relativePackagePath}`;
}

function publicCliCandidate(
  contributions: readonly PackageContribution[],
): PackageContribution | undefined {
  const candidates = contributions.filter(
    (contribution) =>
      contribution.foundation.npmPublication?.kind === "public-cli-candidate",
  );
  if (candidates.length > 1) {
    throw new Error(
      `Generated Repository Plan supports at most one public CLI candidate; found ${candidates.map((candidate) => `${candidate.definition.name} at ${candidate.definition.path}`).join(", ")}`,
    );
  }
  const candidate = candidates[0];
  if (candidate !== undefined && candidate.definition.role !== "cli-tool") {
    throw new Error(
      `Public CLI candidate ${candidate.definition.name} must use the cli-tool Package role`,
    );
  }
  return candidate;
}

function renderPublicationRootCheckCommand(
  candidatePackagePath: string,
): string {
  return [
    renderTurboRunCommand(
      ["boundaries", "format:check", "lint", "typecheck", "test"],
      [],
      { continueAfterFailure: true, taskPrefix: true },
    ),
    renderTurboRunCommand(
      ["build", "test:e2e"],
      [`--filter=!./${candidatePackagePath}`],
      { continueAfterFailure: true, taskPrefix: true },
    ),
    "pnpm run publication:artifact",
  ].join(" && ");
}

function foundationPlan(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly blueprint: ProjectBlueprint;
  /** Constructed once by init or validated once by the local metadata loader. */
  readonly foundationContribution: PlannedPackageContribution;
  readonly contributions: readonly PlannedPackageContribution[];
  /** Contributions whose package-owned operations are rendered in this pass. */
  readonly renderContributions?: readonly PackageContribution[];
  /** Focused deployment preparation recovered from durable Environment Need facts. */
  readonly existingDeploymentEnvironmentNeeds?: readonly DeploymentEnvironmentNeed[];
  /** Current manifests supply mutable package-owned facts such as commands and explicit links. */
  readonly manifestTruthByPackagePath?: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly generationRecord?: GenerationRecord;
  readonly mode: "initialization" | "addition";
}): GeneratedRepositoryPlan {
  assertProjectBlueprint(options.blueprint);
  const configContribution = options.foundationContribution;
  const configDefinition = configContribution.definition;
  if (
    !options.blueprint.packages.some((definition) =>
      packageDefinitionsEqual(definition, configDefinition),
    )
  ) {
    throw new Error(
      "Project Blueprint must contain the Foundation TypeScript configuration Package Definition",
    );
  }
  const initialProjectLinkPlan = planExplicitProjectLinks({
    blueprint: options.blueprint,
    contributions: options.contributions,
    ...(options.manifestTruthByPackagePath === undefined
      ? {}
      : {
          manifestTruthByPackagePath: options.manifestTruthByPackagePath,
        }),
  });
  const injectedProviderNames = new Set(
    [...initialProjectLinkPlan.manifestPatchesByPackagePath.values()].flatMap(
      (patch) =>
        Object.entries(patch.dependenciesMeta)
          .filter(([, metadata]) => metadata.injected)
          .map(([name]) => name),
    ),
  );
  const configPackageName =
    options.context.foundationPackages.typescriptConfiguration.name;
  if (configDefinition.name !== configPackageName) {
    throw new Error(
      `Generation Context TypeScript Configuration Package ${configPackageName} conflicts with Blueprint Package Definition ${configDefinition.name}`,
    );
  }
  const publicationCandidate = publicCliCandidate(options.contributions);
  const packageContributions = options.contributions.map((contribution) => {
    if (contribution.foundation.typescriptConfigurationPackage === undefined) {
      return contribution;
    }
    const dependencyField = injectedProviderNames.has(
      contribution.definition.name,
    )
      ? "dependencies"
      : "devDependencies";
    const dependencySpecifier =
      dependencyField === "devDependencies" &&
      (contribution.manifest.private !== true ||
        publicationCandidate?.definition.path === contribution.definition.path)
        ? localTypescriptConfigurationSpecifier({
            consumerPackagePath: contribution.definition.path,
            configurationPackagePath: configDefinition.path,
          })
        : "workspace:*";
    const existingDependencies = contribution.manifest[dependencyField];
    return {
      ...contribution,
      manifest: {
        ...contribution.manifest,
        [dependencyField]: {
          ...(isRecord(existingDependencies) ? existingDependencies : {}),
          [configPackageName]: dependencySpecifier,
        },
      },
    };
  });
  const requiresPackingHook = packageContributions.some((contribution) => {
    const developmentDependencies = contribution.manifest.devDependencies;
    return (
      isRecord(developmentDependencies) &&
      typeof developmentDependencies[configPackageName] === "string" &&
      developmentDependencies[configPackageName].startsWith("link:")
    );
  });
  const contributions = [configContribution, ...packageContributions];
  assertPackageContributionCommandNames(
    contributions.map((contribution) => {
      const manifest = options.manifestTruthByPackagePath?.get(
        contribution.definition.path,
      );
      return manifest === undefined
        ? contribution
        : { ...contribution, manifest };
    }),
  );
  const candidateRecord: GenerationRecord = options.generationRecord ?? {
    schemaVersion: 2,
    repositoryName: options.context.repositoryName,
    defaultPackageScope: options.context.defaultPackageScope,
    preset: options.definition.metadata.name,
    templateVersion: "0.0.0",
    toolchain: options.context.toolchain,
    packages: [
      ...options.contributions.map(
        (contribution): GeneratedPackagePlanningRecord => {
          const planningContribution =
            options.mode === "initialization"
              ? "planInitialization"
              : "planPackageAddition";
          return {
            packageDefinitionId: requirePersistedPackageDefinition(
              options.blueprint,
              contribution.definition,
            ).packageDefinitionId,
            path: contribution.definition.path,
            definitionName: options.definition.metadata.name,
            planningContribution,
            contributionIdentity: requireReplayAdapter({
              owner: options.definition.metadata.name,
              adapters: options.definition.packageContributionReplayAdapters,
              identity: contribution.planningIdentity,
            }).identity,
          };
        },
      ),
      {
        packageDefinitionId: requirePersistedPackageDefinition(
          options.blueprint,
          configDefinition,
        ).packageDefinitionId,
        path: configDefinition.path,
        definitionName: "foundation",
        planningContribution: "foundationPlan",
        contributionIdentity: typescriptConfigReplayAdapter.identity,
      },
    ],
  };
  const generationRecord = parseGenerationRecord(candidateRecord);
  const persistedEnvironmentNeeds = normalizeEnvironmentNeeds({
    check: contributions.flatMap((item) => item.environmentNeeds),
    deployment: [
      ...(options.existingDeploymentEnvironmentNeeds ?? []),
      ...contributions.flatMap((item) => item.deploymentEnvironmentNeeds ?? []),
    ],
  });
  const environmentNeeds = persistedEnvironmentNeeds.check;
  const deploymentEnvironmentNeeds = persistedEnvironmentNeeds.deployment;
  const hasDeploymentTask = contributions.some((contribution) => {
    const scripts = contribution.manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).deployment === "string"
    );
  });
  const contributionPackagePaths = contributions.map(
    (contribution) => contribution.definition.path,
  );
  if (
    new Set(contributionPackagePaths).size !== contributionPackagePaths.length
  )
    throw new Error("Package Contributions must have unique Package Paths");
  const blueprintPackagePaths = options.blueprint.packages.map(
    (definition) => definition.path,
  );
  if (
    contributionPackagePaths.length !== blueprintPackagePaths.length ||
    contributionPackagePaths.some(
      (packagePath) => !blueprintPackagePaths.includes(packagePath),
    )
  ) {
    throw new Error(
      "Package Contributions must exactly match Project Blueprint Package Paths",
    );
  }
  const packageNames = contributions.map(
    (contribution) => contribution.definition.name,
  );
  if (new Set(packageNames).size !== packageNames.length)
    throw new Error("Package Contributions must have unique package names");
  const ciDiagnosticArtifactDeclarations = contributions.flatMap(
    (contribution) => contribution.ciDiagnosticArtifacts ?? [],
  );
  const ciDiagnosticArtifacts = composeCiDiagnosticArtifacts({
    packagePaths: blueprintPackagePaths,
    declarations: ciDiagnosticArtifactDeclarations,
  });
  assertCompatibleRustToolchainFacts(contributions);
  const contributedToolLayers = contributions.flatMap(
    (contribution) =>
      contribution.foundation.developmentContainerToolLayers ?? [],
  );
  const developmentContainer = contributedDevcontainerComposition({
    context: options.context,
    layers: contributedToolLayers,
  });
  const workspacePackageGlobs = [
    "apps/*",
    "packages/*",
    ...new Set([
      ...options.blueprint.packages
        .map((definition) => `${definition.path.split("/")[0]}/*`)
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
      ...contributions
        .flatMap(
          (contribution) => contribution.foundation.workspacePackageGlobs ?? [],
        )
        .filter((glob) => glob !== "apps/*" && glob !== "packages/*"),
    ]),
  ];
  const editorCustomization = editorCustomizationForCapabilities(
    contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
    loadEditorCustomizationDeclarations(
      resolveTemplateSource(
        templateSources.editorCustomization,
        "capabilities.json",
      ),
    ),
  );
  const dependencyMaintenancePolicy =
    composeDependencyMaintenancePolicy(contributions);
  const rootManifest = {
    name: options.context.repositoryName,
    private: true,
    type: "module",
    scripts: {
      check:
        publicationCandidate === undefined
          ? renderRootCheckCommand()
          : renderPublicationRootCheckCommand(
              publicationCandidate.definition.path,
            ),
      boundaries: "node --conditions=source scripts/check-boundaries.ts",
      ...(publicationCandidate === undefined
        ? {}
        : {
            "publication:readiness":
              "node --conditions=source scripts/npm-publication/check-readiness.ts",
            "publication:artifact":
              "node --conditions=source scripts/npm-publication/check-artifact.ts",
          }),
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
      ...(publicationCandidate === undefined
        ? {}
        : {
            "@types/semver": "catalog:",
            "@types/spdx-expression-parse": "catalog:",
          }),
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      ...(publicationCandidate === undefined
        ? {}
        : {
            semver: "catalog:",
            "spdx-expression-parse": "catalog:",
            npm: "catalog:",
            tar: "catalog:",
          }),
      turbo: "catalog:",
      "typescript-7": "catalog:",
    },
    engines: { node: options.context.toolchain.nodeLtsMajor },
    packageManager: options.context.toolchain.packageManagerPin,
  };
  const dependencyCatalog = selectTemplateDependencyCatalogEntries(
    collectGeneratedManifestCatalogReferences([
      ...contributions.map((contribution) => contribution.manifest),
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
  const workflowTemplateSource = projectCheckWorkflowTemplateSource({
    packagePaths: blueprintPackagePaths,
    deploymentEnvironmentNeeds,
    hasDeploymentTask,
    diagnosticArtifacts: ciDiagnosticArtifacts,
  });
  const workflowOperation: RenderOperation =
    ciDiagnosticArtifacts.length === 0
      ? {
          kind: "copyFile",
          source: templateSources.foundation,
          from: workflowTemplateSource,
          to: ".github/workflows/check.yml",
        }
      : {
          kind: "writeTextTemplate",
          source: templateSources.foundation,
          from: workflowTemplateSource,
          to: ".github/workflows/check.yml",
          replacements: projectCheckWorkflowTemplateReplacements({
            packagePaths: blueprintPackagePaths,
            diagnosticArtifacts: ciDiagnosticArtifacts,
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
  const projectLinkPlan = initialProjectLinkPlan;
  const turboBoundaryTags = turboBoundaryTagsForContributions(contributions);
  const initializationFoundationOperations: RenderOperation[] = [
    {
      kind: "writeJson",
      to: "package.json",
      value: rootManifest,
      keyOrder: packageManifestKeyOrder,
      nestedKeyOrder: packageConditionKeyOrder,
    },
    workspaceOperation,
    ...(requiresPackingHook
      ? [
          {
            kind: "copyFile" as const,
            source: templateSources.foundation,
            from: ".pnpmfile.mjs",
            to: ".pnpmfile.mjs",
          },
        ]
      : []),
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
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            kind: "mergeJsonTemplate" as const,
            source: templateSources.tsCli,
            from: "publication/turbo.json",
            to: "turbo.json",
          },
        ]),
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
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            kind: "mergeJsonTemplate" as const,
            source: templateSources.tsCli,
            from: "publication/root-tsconfig.json",
            to: "tsconfig.json",
          },
        ]),
    ...(requiresPackingHook && publicationCandidate === undefined
      ? [
          {
            kind: "mergeJsonTemplate" as const,
            source: templateSources.foundation,
            from: "tsconfig.packing-hook.json",
            to: "tsconfig.json",
          },
        ]
      : []),
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
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication/readiness.ts",
            to: "scripts/npm-publication/readiness.ts",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication/artifact.ts",
            to: "scripts/npm-publication/artifact.ts",
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.tsCli,
            from: "publication/check-artifact.ts",
            to: "scripts/npm-publication/check-artifact.ts",
            replacements: {
              PUBLIC_CLI_PACKAGE_PATH: publicationCandidate.definition.path,
            },
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.tsCli,
            from: "publication/check-readiness.ts",
            to: "scripts/npm-publication/check-readiness.ts",
            replacements: {
              PUBLIC_CLI_PACKAGE_PATH: publicationCandidate.definition.path,
            },
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication/changelog.ts",
            to: "scripts/npm-publication/changelog.ts",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "src/cli-command-identity.ts",
            to: "scripts/npm-publication/cli-command-identity.ts",
          },
        ]),
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
    ...developmentContainer.operations,
    ...contributedFoundationTemplateFileOperations(contributions),
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
    ...(options.renderContributions === undefined
      ? contributions
      : options.renderContributions.map((renderContribution) => {
          const enriched = packageContributions.find(
            (candidate) =>
              candidate.definition.path === renderContribution.definition.path,
          );
          if (enriched === undefined) {
            throw new Error(
              `Foundation cannot render unknown Package Contribution ${renderContribution.definition.path}`,
            );
          }
          return enriched;
        })
    )
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
    { path: "tsconfig.json", driver: "structured" },
    { path: "turbo.json", driver: "structured" },
    {
      path: ".devcontainer/devcontainer.json",
      driver: "structured",
      identitySets: [developmentContainer.mountIdentitySet],
    },
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
    packageContributions,
    operations,
    reconciliation,
    developmentContainer: {
      toolLayers: developmentContainer.toolLayers,
      buildArguments: developmentContainer.buildArguments,
      mounts: developmentContainer.mounts,
      probes: developmentContainer.probes,
    },
    environmentNeeds,
    deploymentEnvironmentNeeds,
    ciDiagnosticArtifacts,
    manifests: [...contributions.map((item) => item.manifest), rootManifest],
    dependencyCatalog,
    dependencyMaintenancePolicy,
    nextStepInstructions: [
      { display: "pnpm install" },
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ],
  };
}

type PreparedPresetInitialization = {
  readonly presetBlueprint: ReturnType<typeof assertProjectBlueprintDraft>;
  readonly contributions: readonly PlannedPackageContribution[];
  readonly resolvedPackageIdentity?: ResolvedPrimaryPackageIdentity;
};

type ConfigurablePrimaryPackageDefinition = Extract<
  BuiltInPresetDefinition,
  { readonly initialPrimaryPackage: object }
>;

function hasConfigurablePrimaryPackage(
  definition: BuiltInPresetDefinition,
): definition is ConfigurablePrimaryPackageDefinition {
  return definition.initialPrimaryPackage !== undefined;
}

export type InitializationIdentityOverrides = {
  readonly name?: string;
  readonly path?: string;
  readonly scope?: string;
};

export type ResolvedInitialization = {
  readonly preset: string;
  readonly topology: "configurable-primary-package" | "fixed";
  readonly packages: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly scope: string;
};

function errorDiagnostics(error: unknown): readonly string[] {
  return (error instanceof Error ? error.message : String(error))
    .split("\n")
    .filter((diagnostic) => diagnostic.length > 0);
}

function preparePresetInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly overrides?: Pick<InitializationIdentityOverrides, "name" | "path">;
}): PreparedPresetInitialization {
  if (!hasConfigurablePrimaryPackage(options.definition)) {
    const diagnostics: string[] = [];
    let presetBlueprint: PreparedPresetInitialization["presetBlueprint"];
    let contributions: readonly PlannedPackageContribution[] | undefined;
    try {
      presetBlueprint = assertProjectBlueprintDraft(
        options.definition.blueprint(options.context),
      );
    } catch (error) {
      diagnostics.push(...errorDiagnostics(error));
    }
    try {
      contributions = options.definition.planInitializationContributions?.(
        options.context,
      ) ?? [options.definition.planInitialization(options.context)];
    } catch (error) {
      diagnostics.push(...errorDiagnostics(error));
    }
    if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
    return {
      presetBlueprint: presetBlueprint!,
      contributions: contributions!,
    };
  }
  const capability = options.definition.initialPrimaryPackage;
  const leafName = options.overrides?.name ?? capability.defaultLeafName;
  const resolvedPackageIdentity: ResolvedPrimaryPackageIdentity = {
    leafName,
    definition: {
      name: `@${options.context.defaultPackageScope}/${leafName}`,
      path:
        options.overrides?.path ??
        capability.defaultPackagePath({ packageLeafName: leafName }),
      role: capability.role,
    },
  };
  const diagnostics: string[] = [];
  let presetBlueprint: PreparedPresetInitialization["presetBlueprint"];
  let contribution: PlannedPackageContribution | undefined;
  try {
    presetBlueprint = assertProjectBlueprintDraft({
      schemaVersion: 3,
      packages: [resolvedPackageIdentity.definition],
    });
  } catch (error) {
    diagnostics.push(...errorDiagnostics(error));
  }
  try {
    contribution = capability.planInitialContribution({
      context: options.context,
      resolvedPackageIdentity,
    });
  } catch (error) {
    diagnostics.push(...errorDiagnostics(error));
  }
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
  return {
    presetBlueprint: presetBlueprint!,
    contributions: [contribution!],
    resolvedPackageIdentity,
  };
}

function planPreparedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly presetBlueprint: ReturnType<typeof assertProjectBlueprintDraft>;
  readonly contributions: readonly PlannedPackageContribution[];
}): GeneratedRepositoryPlan {
  const { presetBlueprint, contributions } = options;
  const configDefinition = typescriptConfigPackageDefinition(options.context);
  const foundationIdentityDiagnostics = presetBlueprint.packages.flatMap(
    (definition) => [
      ...(definition.name === configDefinition.name
        ? [
            `Initial package name ${definition.name} conflicts with Foundation package ${configDefinition.name}`,
          ]
        : []),
      ...(definition.path === configDefinition.path
        ? [
            `Initial Package Path ${definition.path} conflicts with Foundation Package Path ${configDefinition.path}`,
          ]
        : []),
    ],
  );
  if (foundationIdentityDiagnostics.length > 0) {
    throw new Error(foundationIdentityDiagnostics.join("\n"));
  }
  const occupiedIds = new Set<PackageDefinitionId>();
  const blueprint: ProjectBlueprint = {
    ...presetBlueprint,
    packages: [
      ...presetBlueprint.packages.map((definition) => {
        const contribution = contributions.find((candidate) =>
          packageDefinitionsEqual(candidate.definition, definition),
        );
        if (contribution === undefined) {
          throw new Error(
            `Preset Blueprint Package Definition ${definition.path} has no initialization Package Contribution`,
          );
        }
        return persistPackageDefinition({
          definition,
          provenance: {
            definitionName: options.definition.metadata.name,
            planningContribution: "planInitialization",
            contributionIdentity: requireReplayAdapter({
              owner: options.definition.metadata.name,
              adapters: options.definition.packageContributionReplayAdapters,
              identity: contribution.planningIdentity,
            }).identity,
          },
          occupiedIds,
        });
      }),
      persistPackageDefinition({
        definition: configDefinition,
        provenance: {
          definitionName: "foundation",
          planningContribution: "foundationPlan",
          contributionIdentity: typescriptConfigReplayAdapter.identity,
        },
        occupiedIds,
      }),
    ],
  };
  return foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    foundationContribution: typescriptConfigReplayAdapter.identify(
      typescriptConfigContribution(options.context, configDefinition),
    ),
    contributions,
    mode: "initialization",
  });
}

function assertPreflightedInitializationPlan(
  plan: GeneratedRepositoryPlan,
): GeneratedRepositoryPlan {
  const projectionDiagnostics = validateProjectProjectionPlan({
    operations: plan.operations,
    reconciliation: plan.reconciliation,
  });
  if (projectionDiagnostics.length > 0) {
    throw new Error(projectionDiagnostics.join("\n"));
  }
  return plan;
}

export function planGeneratedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
}): GeneratedRepositoryPlan {
  const prepared = preparePresetInitialization(options);
  return assertPreflightedInitializationPlan(
    planPreparedRepositoryInitialization({
      definition: options.definition,
      context: options.context,
      presetBlueprint: prepared.presetBlueprint,
      contributions: prepared.contributions,
    }),
  );
}

export function prepareGeneratedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly targetDir: string;
  readonly toolchain: BuiltInGenerationContext["toolchain"];
  readonly overrides?: InitializationIdentityOverrides;
}): {
  readonly context: BuiltInGenerationContext;
  readonly resolvedPackageIdentity?: ResolvedPrimaryPackageIdentity;
  readonly resolved: ResolvedInitialization;
  readonly plan: GeneratedRepositoryPlan;
} {
  const diagnostics: string[] = [];
  const appendDiagnostics = (error: unknown): void => {
    diagnostics.push(...errorDiagnostics(error));
  };
  const scopeOverride = options.overrides?.scope;
  const normalizedScope =
    scopeOverride?.startsWith("@") === true
      ? scopeOverride.slice(1)
      : scopeOverride;
  const nameOverride = options.overrides?.name;
  const pathOverride = options.overrides?.path;
  const repositoryName = path.basename(path.resolve(options.targetDir));
  const configurablePrimaryPackage =
    options.definition.initialPrimaryPackage !== undefined;
  if (
    !configurablePrimaryPackage &&
    (nameOverride !== undefined || pathOverride !== undefined)
  ) {
    diagnostics.push(
      `Built-in Preset ${options.definition.metadata.name} has fixed initial package topology and does not accept --name or --path`,
    );
  }
  let validNameOverride =
    nameOverride !== undefined &&
    isValidNewNpmPackageName(`@x/${nameOverride}`);
  if (nameOverride !== undefined && !validNameOverride) {
    diagnostics.push("--name must be an unscoped package leaf name");
  }
  let validPathOverride = pathOverride !== undefined;
  if (pathOverride !== undefined) {
    const pathValidation = validateNewPackagePath(pathOverride);
    if (!pathValidation.hasValidShape) {
      diagnostics.push("--path must be exactly two safe path segments");
      validPathOverride = false;
    }
    if (pathValidation.reservedWorkspaceCollection !== undefined) {
      diagnostics.push(
        `--path ${pathOverride} uses reserved workspace collection ${pathValidation.reservedWorkspaceCollection}`,
      );
      validPathOverride = false;
    }
  }
  let validScopeOverride =
    normalizedScope !== undefined &&
    scopeOverride === scopeOverride?.trim() &&
    isValidDefaultPackageScope(normalizedScope) &&
    isValidNewNpmPackageName(`@${normalizedScope}/typescript-config`);
  if (normalizedScope !== undefined && !validScopeOverride) {
    diagnostics.push("--scope must be a valid npm scope without whitespace");
  }
  let validRepositoryScope =
    isValidDefaultPackageScope(repositoryName) &&
    isValidNewNpmPackageName(`@${repositoryName}/typescript-config`);
  if (normalizedScope === undefined && !validRepositoryScope) {
    diagnostics.push(
      `Repository Identity ${repositoryName} is not a valid default package scope; pass --scope with a valid npm scope`,
    );
  }

  const resolvedScope = validScopeOverride
    ? (normalizedScope ?? "repository")
    : validRepositoryScope
      ? repositoryName
      : "repository";
  const resolvedLeaf =
    configurablePrimaryPackage &&
    nameOverride !== undefined &&
    validNameOverride
      ? nameOverride
      : configurablePrimaryPackage
        ? options.definition.initialPrimaryPackage?.defaultLeafName
        : undefined;
  if (
    resolvedLeaf !== undefined &&
    !isValidNewNpmPackageName(`@${resolvedScope}/${resolvedLeaf}`)
  ) {
    if (nameOverride !== undefined) {
      validNameOverride = false;
      diagnostics.push("--name must be an unscoped package leaf name");
    } else if (scopeOverride !== undefined) {
      validScopeOverride = false;
      diagnostics.push("--scope must be a valid npm scope without whitespace");
    } else {
      validRepositoryScope = false;
      diagnostics.push(
        `Repository Identity ${repositoryName} is not a valid default package scope; pass --scope with a valid npm scope`,
      );
    }
  }

  const context = createGenerationContext({
    targetDir: options.targetDir,
    defaultPackageScope: validScopeOverride
      ? (normalizedScope ?? "repository")
      : validRepositoryScope
        ? repositoryName
        : "repository",
    toolchain: options.toolchain,
  });
  const safeNameOverride =
    configurablePrimaryPackage && nameOverride !== undefined
      ? validNameOverride
        ? nameOverride
        : "x"
      : undefined;
  let safeDerivedPathOverride: string | undefined;
  const initialPrimaryPackage = options.definition.initialPrimaryPackage;
  if (initialPrimaryPackage !== undefined && pathOverride === undefined) {
    const safeLeafName =
      safeNameOverride ?? initialPrimaryPackage.defaultLeafName;
    const derivedPackagePath = initialPrimaryPackage.defaultPackagePath({
      packageLeafName: safeLeafName,
    });
    const derivedPathValidation = validateNewPackagePath(derivedPackagePath);
    if (
      !derivedPathValidation.hasValidShape ||
      derivedPathValidation.reservedWorkspaceCollection !== undefined
    ) {
      diagnostics.push(
        `Preset-derived Package Path ${derivedPackagePath} is unsafe; pass --path with exactly two safe path segments`,
      );
      safeDerivedPathOverride = "packages/invalid";
    }
  }
  const safeIdentityOverrides: Pick<
    InitializationIdentityOverrides,
    "name" | "path"
  > = {
    ...(safeNameOverride === undefined ? {} : { name: safeNameOverride }),
    ...(configurablePrimaryPackage && pathOverride !== undefined
      ? { path: validPathOverride ? pathOverride : "packages/invalid" }
      : safeDerivedPathOverride === undefined
        ? {}
        : { path: safeDerivedPathOverride }),
  };
  let prepared: PreparedPresetInitialization | undefined;
  try {
    prepared = preparePresetInitialization({
      definition: options.definition,
      context,
      ...(Object.keys(safeIdentityOverrides).length === 0
        ? {}
        : { overrides: safeIdentityOverrides }),
    });
  } catch (error) {
    appendDiagnostics(error);
  }
  let plan: GeneratedRepositoryPlan | undefined;
  if (prepared !== undefined) {
    try {
      plan = planPreparedRepositoryInitialization({
        definition: options.definition,
        context,
        presetBlueprint: prepared.presetBlueprint,
        contributions: prepared.contributions,
      });
    } catch (error) {
      appendDiagnostics(error);
    }
  }
  if (plan !== undefined) {
    diagnostics.push(
      ...validateProjectProjectionPlan({
        operations: plan.operations,
        reconciliation: plan.reconciliation,
      }),
    );
  }
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
  if (prepared === undefined || plan === undefined) {
    throw new Error("Initialization preparation did not produce a plan");
  }
  return {
    context,
    resolved: {
      preset: options.definition.metadata.name,
      topology:
        prepared.resolvedPackageIdentity === undefined
          ? "fixed"
          : "configurable-primary-package",
      packages: prepared.presetBlueprint.packages.map(({ name, path }) => ({
        name,
        path,
      })),
      scope: context.defaultPackageScope,
    },
    ...(prepared.resolvedPackageIdentity === undefined
      ? {}
      : { resolvedPackageIdentity: prepared.resolvedPackageIdentity }),
    plan,
  };
}

export function planGeneratedRepositoryPackageAddition(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly localTemplateMetadata: LocalTemplateMetadata;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  /** Existing consumers that explicitly import the newly added provider. */
  readonly linkFrom?: readonly string[];
}): GeneratedRepositoryPackageAdditionPlan {
  const { blueprint: persistedBlueprint, context } =
    options.localTemplateMetadata;
  assertProjectBlueprint(persistedBlueprint);
  if (!options.definition.planPackageAddition)
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} does not support Package Addition`,
    );
  const packagePath =
    options.packagePath ??
    options.definition.defaultPackagePath?.({
      context,
      packageLeafName: options.packageLeafName,
    });
  if (packagePath === undefined) {
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} must own a default Package Path or receive an explicit Package Path`,
    );
  }
  const contribution = options.definition.planPackageAddition({
    context,
    packageLeafName: options.packageLeafName,
    packagePath,
  });
  const requestedPackageLinkIntents = [...new Set(options.linkFrom ?? [])].map(
    (consumerPackagePath) => ({
      consumerPackagePath,
      providerPackagePath: contribution.definition.path,
    }),
  );
  const conflictingPackage = persistedBlueprint.packages.find(
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
      persistedBlueprint.packageLinkIntents ?? [];
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
        context,
        blueprint: persistedBlueprint,
        foundationContribution: existing.foundationContribution,
        contributions: existing.contributions,
        renderContributions: [],
        existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
        manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
        generationRecord: existing.generationRecord,
        mode: "addition",
      });
      const currentProjection = foundationPlan({
        definition: options.definition,
        context,
        blueprint: persistedBlueprint,
        foundationContribution: existing.foundationContribution,
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
  const contributionIdentity = requireReplayAdapter({
    owner: options.definition.metadata.name,
    adapters: options.definition.packageContributionReplayAdapters,
    identity: contribution.planningIdentity,
  }).identity;
  const persistedContributionDefinition = persistPackageDefinition({
    definition: contribution.definition,
    provenance: {
      definitionName: options.definition.metadata.name,
      planningContribution: "planPackageAddition",
      contributionIdentity,
    },
    occupiedIds: new Set(
      persistedBlueprint.packages.map(
        (definition) => definition.packageDefinitionId,
      ),
    ),
  });
  const blueprint: ProjectBlueprint = {
    ...persistedBlueprint,
    packages: [...persistedBlueprint.packages, persistedContributionDefinition],
    ...(requestedPackageLinkIntents.length > 0
      ? {
          packageLinkIntents: [
            ...(persistedBlueprint.packageLinkIntents ?? []),
            ...requestedPackageLinkIntents,
          ],
        }
      : {}),
  };
  assertProjectBlueprint(blueprint);
  const requiredManifestTruthPackagePaths =
    requestedPackageLinkIntents.length === 0
      ? []
      : [
          ...(persistedBlueprint.packageLinkIntents ?? []).flatMap((intent) => [
            intent.consumerPackagePath,
            intent.providerPackagePath,
          ]),
          ...requestedPackageLinkIntents.map(
            (intent) => intent.consumerPackagePath,
          ),
        ];
  const existing = readExistingPackageAdditionState({
    localTemplateMetadata: options.localTemplateMetadata,
    requiredManifestTruthPackagePaths,
  });
  const generationRecord: GenerationRecord = {
    ...existing.generationRecord,
    packages: [
      ...existing.generationRecord.packages,
      {
        packageDefinitionId:
          persistedContributionDefinition.packageDefinitionId,
        path: contribution.definition.path,
        definitionName: options.definition.metadata.name,
        planningContribution: "planPackageAddition",
        contributionIdentity,
      },
    ],
  };
  const beforeProjection = foundationPlan({
    definition: options.definition,
    context,
    blueprint: persistedBlueprint,
    foundationContribution: existing.foundationContribution,
    contributions: existing.contributions,
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    generationRecord: existing.generationRecord,
    mode: "initialization",
  });
  const afterProjection = foundationPlan({
    definition: options.definition,
    context,
    blueprint,
    foundationContribution: existing.foundationContribution,
    contributions: [...existing.contributions, contribution],
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
    generationRecord,
    mode: "initialization",
  });
  const plan = foundationPlan({
    definition: options.definition,
    context,
    blueprint,
    foundationContribution: existing.foundationContribution,
    contributions: [...existing.contributions, contribution],
    renderContributions: [contribution],
    existingDeploymentEnvironmentNeeds: existing.deploymentEnvironmentNeeds,
    manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
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
