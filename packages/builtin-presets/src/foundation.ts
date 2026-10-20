import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { composeCiDiagnosticArtifacts } from "@ykdz/template-core/ci-diagnostic-artifact";
import type { CiDiagnosticArtifactDeclaration } from "@ykdz/template-core/ci-diagnostic-artifact";
import {
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerBuildArgument,
  type DevelopmentContainerToolLayerMount,
  type DevelopmentContainerToolLayerProbe,
  type PlannedDevelopmentContainerToolLayer,
} from "@ykdz/template-core/development-container-tool-layer";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
  EnvironmentNeedsMetadata,
} from "@ykdz/template-core/module-graph";
import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  playwrightBrowserAssetsEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import {
  type PackageDefinition,
  type PackageDefinitionId,
  type PersistedPackageDefinition,
  type ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import type { DependencyMaintenancePolicy } from "@ykdz/template-core/project-github";
import type {
  MaterializeProjectProjectionOptions,
  ProjectProjectionMirrorSlot,
  ProjectProjectionPathPrecondition,
  ProjectProjectionReconciliation,
  StructuredIdentitySetPolicy,
} from "@ykdz/template-core/project-projection";
import { validateProjectProjectionPlan } from "@ykdz/template-core/project-projection";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import {
  assertPackageContribution,
  assertPackageContributionCommandNames,
  type FoundationContribution,
  type PackageContribution,
} from "@ykdz/template-workspace-authoring/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
  InitialPackageDefinitionLookup,
  PackageContributionReplayAdapter,
  PlannedPackageContribution,
  ResolvedPrimaryPackageIdentity,
} from "@ykdz/template-workspace-authoring/preset-definition";
import {
  assertDefaultProjectBlueprint,
  assertDefaultProjectBlueprintDraft,
  isValidDefaultNpmPackageName,
  validateDefaultPackagePath,
  validateDefaultProjectBlueprint,
} from "@ykdz/template-workspace/default-package-identity";
import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-workspace/dependency-catalog";
import {
  assertReusablePackageExposure,
  readPackageAdditionVersionFacts,
  WorkspacePackageAdditionFailure,
} from "@ykdz/template-workspace/package-addition-facts";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "@ykdz/template-workspace/project-github";
import {
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
  planExplicitProjectLinks,
} from "@ykdz/template-workspace/project-linking";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import {
  createWorkspaceRootManifest,
  packageConditionKeyOrder,
  packageManifestKeyOrder,
  projectPreparedWorkspaceRoot,
  projectToolchainMirrorManifest,
  type WorkspaceRootInsertion,
} from "@ykdz/template-workspace/root-projection";
import { vuePnpmDependencyOverrides } from "@ykdz/template-workspace/vue-policy";
import {
  copyWorkspaceResource,
  copyWorkspaceDirectory,
  readWorkspaceJson,
} from "@ykdz/template-workspace/workspace-resources";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";

import {
  isValidDefaultPackageScope,
  parseGenerationRecord,
  type GeneratedPackagePlanningRecord,
  type GenerationRecord,
} from "./generation-record.ts";
import {
  composeReferenceContributions,
  ReferenceCompositionFailure,
  referenceDependencyNames,
  requireReferencePackage,
} from "./reference-composition.ts";
import { rustBinDefinition } from "./rust-bin/definition.ts";
import {
  builtInEditorCustomization,
  browserTestDevelopmentContainerToolLayer,
  planBuiltInDevelopmentContainer,
  shellCheckDevelopmentContainerToolLayer,
} from "./shared/development-container.ts";
import {
  typescriptReferencePackage,
  typescriptConfigContribution,
  typescriptConfigPackageDefinition,
  typescriptConfigReplayAdapter,
} from "./shared/typescript.ts";
import { tsCliDefinition } from "./ts-cli/definition.ts";
import { tsLibDefinition } from "./ts-lib/definition.ts";
import { vikeAppDefinition } from "./vike-app/definition.ts";
import { vueAppDefinition } from "./vue-app/definition.ts";
import { vueHonoAppDefinition } from "./vue-hono-app/definition.ts";

export type {
  PackageDefinition,
  PackageDefinitionId,
  PackageLinkIntent,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
export type { DefaultPackageRole } from "@ykdz/template-workspace-authoring/default-package-role";
export type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";

export type BuiltInGenerationContext = GenerationContext;
export type { BuiltInPresetDefinition } from "@ykdz/template-workspace-authoring/preset-definition";

export type NextStepInstruction = {
  readonly display: string;
};

export type GeneratedDeploymentCheck = Omit<
  NonNullable<FoundationContribution["deploymentCheck"]>,
  "sources"
>;

export type GeneratedVueHonoJointE2e = Omit<
  NonNullable<FoundationContribution["vueHonoJointE2e"]>,
  "sources"
>;

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
  readonly deploymentCheck: GeneratedDeploymentCheck | undefined;
  readonly vueHonoJointE2e: GeneratedVueHonoJointE2e | undefined;
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
    /**
     * 目标仓库根 package.json 现行的 engines.node 声明原文；加包时按它回写私有根，
     * 使生成后目标仓库自身的版本声明不被 CLI 发版快照覆盖。
     */
    readonly rootNodeDeclaration: string;
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

/** 用户可修正的 Package Addition 输入事实，顺序由 Foundation 固定。 */
export type PackageAdditionInputIssue = {
  readonly code:
    | "PRESET_UNKNOWN"
    | "PRESET_NOT_ADDABLE"
    | "INVALID_PACKAGE_NAME"
    | "INVALID_PACKAGE_PATH"
    | "RESERVED_PACKAGE_PATH"
    | "INVALID_LINK_FROM"
    | "RESERVED_LINK_FROM"
    | "UNKNOWN_LINK_FROM"
    | "UNSUPPORTED_LINK";
};

export type PackageAdditionPreparation =
  | {
      readonly status: "input-invalid";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly status: "conflict";
      readonly conflict: PackageAdditionBusinessConflict;
    }
  | {
      readonly status: "operation-failure";
      readonly phase: "metadata" | "default" | "planning";
      /** 目标声明或共享配置接口不满足加包要求时，提供可操作的诊断。 */
      readonly diagnostic?: {
        readonly message: string;
        readonly suggestion: string;
      };
    }
  | {
      readonly status: "ready";
      readonly definition: BuiltInPresetDefinition;
      readonly plan: GeneratedRepositoryPackageAdditionPlan;
    };

export class PackageAdditionBusinessConflict extends Error {
  readonly kind: "identity" | "missing-link";
  readonly existing: PackageDefinition;
  readonly requested: PackageDefinition;
  readonly missingLink?: {
    readonly consumerPackagePath: string;
    readonly providerPackagePath: string;
  };

  constructor(
    kind: "identity" | "missing-link",
    existing: PackageDefinition,
    requested: PackageDefinition,
    missingLink?: {
      readonly consumerPackagePath: string;
      readonly providerPackagePath: string;
    },
  ) {
    super("Package Addition business conflict");
    this.kind = kind;
    this.existing = existing;
    this.requested = requested;
    if (missingLink !== undefined) this.missingLink = missingLink;
  }
}

export type PublicationSetupHandoff = null | {
  readonly command: "./scripts/npm-publication-setup/setup.sh";
};

const environmentNeedsPath = ".template/environment-needs.json";

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
  return validateDefaultProjectBlueprint(value);
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

/**
 * 目标根现行版本声明缺失或形状错误时的显式带形状内部失败：点名文件与字段、实际值与修正动作，
 * 由 Package Addition 准备边界传递给命令层；其他 metadata 错误保持通用。
 */
class PackageAdditionTargetDeclarationFailure extends Error {
  readonly field: "engines.node" | "packageManager" | "[toolchain].channel";
  readonly suggestion: string;

  constructor(
    file: "package.json" | "rust-toolchain.toml",
    field: "engines.node" | "packageManager" | "[toolchain].channel",
    requirement: string,
    actualDeclaration: string,
    suggestion: string,
  ) {
    super(
      `加包需要目标仓库根 ${file} 的 ${field} ${requirement}，实际收到 ${actualDeclaration}。${suggestion}`,
    );
    this.field = field;
    this.suggestion = suggestion;
  }
}

/** 生成仓库根 Rust 声明的唯一文件名；所有权判定与投影保留都只经这个接缝引用它。 */
const rootRustDeclarationFileName = "rust-toolchain.toml";

/**
 * 已选用 Rust 的目标仓库由根 rust-toolchain.toml 的 channel 拥有后续 Rust 版本选择，因此加包
 * 按该现行声明重放根投影与开发容器初值。声明缺失、非法 TOML 或 channel 形状错误时在此失败，
 * 不回退 CLI 发版快照、Generation Record 历史或 ambient 环境。
 */
function readPackageAdditionTargetRustChannel(repositoryRoot: string): string {
  const relativePath = rootRustDeclarationFileName;
  const filePath = path.join(repositoryRoot, relativePath);
  if (!existsSync(filePath)) {
    throw new PackageAdditionTargetDeclarationFailure(
      relativePath,
      "[toolchain].channel",
      "存在",
      "文件不存在",
      `请先创建根 ${relativePath}，在 [toolchain] 表内声明 channel 再加包。`,
    );
  }
  let declaration: unknown;
  try {
    declaration = parseToml(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new PackageAdditionTargetDeclarationFailure(
      relativePath,
      "[toolchain].channel",
      "是有效 TOML 声明",
      `无法解析：${error instanceof Error ? error.message : String(error)}`,
      `请先修正根 ${relativePath} 的 TOML 语法，使 [toolchain] 表内声明 channel 再加包。`,
    );
  }
  const toolchain = isRecord(declaration) ? declaration.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new PackageAdditionTargetDeclarationFailure(
      relativePath,
      "[toolchain].channel",
      "为非空字符串",
      JSON.stringify(channel ?? null),
      `请先在根 ${relativePath} 的 [toolchain] 表内写入 channel 再加包。`,
    );
  }
  return channel;
}

export type RustToolchainChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

/**
 * Root Rust 来源的最小接缝：从 rust-toolchain.toml 正文结构化读出 `[toolchain].channel`。
 * 复用加包路径同一 smol-toml 真源，供模板仓投影值门核对 M5；不引入第二套版本或文件名表。
 * 正文非法 TOML 或缺少非空 channel 时返回不可解释，由调用方按缺失/漂移分类，不静默跳过。
 */
export function readRustToolchainChannelFromToml(
  contents: string,
): RustToolchainChannelReading {
  let declaration: unknown;
  try {
    declaration = parseToml(contents);
  } catch (error) {
    return {
      reason: `不是有效 TOML 声明：${error instanceof Error ? error.message : String(error)}`,
      status: "unreadable",
    };
  }
  const toolchain = isRecord(declaration) ? declaration.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    return {
      reason: `[toolchain].channel 必须是非空字符串，实际为 ${JSON.stringify(channel ?? null)}`,
      status: "unreadable",
    };
  }

  return { channel, status: "explained" };
}

function readJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Package Addition requires valid ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
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
    (candidate) =>
      candidate.planningContribution === "planInitialization" &&
      candidate.definitionName !== "reference",
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

  const sharedSources = joinedPackages
    .filter(
      (candidate) =>
        candidate.record.referenceSource !== undefined &&
        requireReferencePackage(candidate.record.referenceSource).instance ===
          "shared",
    )
    .map((candidate) => candidate.record.referenceSource);
  if (new Set(sharedSources).size !== sharedSources.length) {
    throw new ReferenceCompositionFailure(
      "无法唯一选择共同包的持久实例：同一参考来源记录了多个共同实例。",
    );
  }
  const preparedWithoutInitialLookup = joinedPackages.map((candidate) => {
    if (candidate.record.referenceSource !== undefined) {
      const reference = requireReferencePackage(
        candidate.record.referenceSource,
      );
      let ownerAdapter: PackageContributionReplayAdapter | undefined;
      if (candidate.record === record) {
        if (
          candidate.record.referenceSource !==
          typescriptReferencePackage.manifest.name
        )
          throw new ReferenceCompositionFailure(
            "共同配置来源与已记录的根配置身份不匹配。",
          );
      } else if (candidate.record.definitionName === "reference") {
        if (
          reference.instance !== "shared" ||
          candidate.record.contributionIdentity !== reference.manifest.name
        )
          throw new ReferenceCompositionFailure(
            "共同包来源身份与生成记录不匹配。",
          );
      } else {
        const owner = builtInPresetRegistry.require(
          candidate.record.definitionName,
        );
        ownerAdapter = requireRecordReplayAdapter({
          owner: owner.metadata.name,
          adapters: owner.packageContributionReplayAdapters,
          record: candidate.record,
        });
        if (
          candidate.record.planningContribution === "planPackageAddition" &&
          owner.planPackageAddition === undefined
        )
          throw new ReferenceCompositionFailure(
            `预设 ${owner.metadata.name} 不支持已记录的新增操作。`,
          );
      }
      const bindings = new Map<string, PackageDefinition>();
      const dependencyNames = referenceDependencyNames(reference.manifest.name);
      if (
        !isDeepStrictEqual(
          Object.keys(candidate.record.dependencyBindings ?? {}).toSorted(),
          [...dependencyNames].toSorted(),
        )
      ) {
        throw new ReferenceCompositionFailure(
          `参考包 ${reference.identity} 的依赖记录与当前来源不兼容，请先显式迁移。`,
        );
      }
      for (const dependencyName of dependencyNames) {
        const id = candidate.record.dependencyBindings?.[dependencyName];
        const provider = joinedPackages.find(
          (item) => item.record.packageDefinitionId === id,
        );
        if (
          provider === undefined ||
          provider.record.referenceSource !== dependencyName
        ) {
          throw new ReferenceCompositionFailure(
            `参考包 ${reference.identity} 缺少已记录的依赖实例 ${dependencyName}。`,
          );
        }
        bindings.set(dependencyName, provider.definition);
      }
      const adapter: PackageContributionReplayAdapter = {
        identity: candidate.record.contributionIdentity,
        identify: (contribution) => ({
          ...contribution,
          planningIdentity: candidate.record.contributionIdentity,
        }),
        replay: (input) => {
          const replayed = ownerAdapter?.replay(input);
          if (
            replayed !== undefined &&
            replayed.referenceSource !== reference.manifest.name
          ) {
            throw new ReferenceCompositionFailure(
              `记录的来源 ${reference.manifest.name} 与所属预设 ${candidate.record.definitionName} 的 ${candidate.record.contributionIdentity} 贡献不一致。`,
            );
          }
          const contribution = reference.contribute({
            context: input.context,
            definition: input.packageDefinition,
            bindings,
            planningIdentity: candidate.record.contributionIdentity,
            creationOrigin: "replay",
          });
          return {
            ...contribution,
            foundation: { ...contribution.foundation, ...replayed?.foundation },
          };
        },
      };
      return {
        ...candidate,
        owner: candidate.record.definitionName,
        adapter,
        kind:
          candidate.record === record
            ? ("foundation" as const)
            : ("package" as const),
      };
    }
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
    blueprint = assertDefaultProjectBlueprint(
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
  const rootVersions = readPackageAdditionVersionFacts(resolvedRoot);
  const nodeFactsContext: BuiltInGenerationContext = {
    targetDir: resolvedRoot,
    repositoryName: generationRecord.repositoryName,
    defaultPackageScope: generationRecord.defaultPackageScope,
    foundationPackages: {
      typescriptConfiguration: {
        name: preflight.foundationPackage.definition.name,
      },
    },
    toolchain: rootVersions.toolchain,
  };
  let context = nodeFactsContext;
  let planningState = replayLocalTemplateMetadata({
    context: nodeFactsContext,
    preflight,
  });
  // 已有 Rust 能力事实的目标仓库由自己的根 rust-toolchain.toml 拥有后续版本选择：读出该现行
  // channel 后重放，使根声明与开发容器初值来自同一个目标根事实；首次引入 Rust 的仓库还没有
  // 该声明，保持缺省上下文交由建源路径处理。
  if (
    normalizeRustToolchain([
      planningState.foundationContribution,
      ...planningState.packageContributions,
    ]) !== undefined
  ) {
    context = {
      ...nodeFactsContext,
      toolchain: {
        ...nodeFactsContext.toolchain,
        rustVersion: readPackageAdditionTargetRustChannel(resolvedRoot),
      },
    };
    planningState = replayLocalTemplateMetadata({ context, preflight });
  }
  return {
    blueprint,
    context,
    [localTemplateMetadataStateKey]: {
      generationRecord,
      rootNodeDeclaration: rootVersions.rootNodeDeclaration,
      ...planningState,
    },
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
    if (error instanceof ReferenceCompositionFailure) throw error;
    throw new Error(
      `Package Planning Provenance ${options.owner}:${options.record.contributionIdentity} (${options.record.planningContribution}) at ${options.record.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    contribution.referenceSource !== undefined &&
    options.record.referenceSource === undefined
  ) {
    throw new ReferenceCompositionFailure(
      "现有生成记录缺少原生参考包的来源与依赖身份；请先显式迁移，新增操作不会推测或接管旧拓扑。",
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
      { cause: error },
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
  const allContributions = [foundationContribution, ...contributions];
  const deploymentCheck = normalizeDeploymentCheck(allContributions);
  const vueHonoJointE2e = normalizeVueHonoJointE2e(allContributions);
  const databasePreparation = normalizeDatabasePreparation(allContributions);
  const manifestTruthByPackagePath = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const requiredManifestTruthPackagePaths = new Set(
    options.requiredManifestTruthPackagePaths ?? [],
  );
  const packageByName = new Map(
    allContributions.map((contribution) => [
      contribution.definition.name,
      contribution,
    ]),
  );
  const capabilityPackageNames = [
    ...(databasePreparation === undefined
      ? []
      : [
          databasePreparation.databasePackageName,
          databasePreparation.migrationPackageName,
          ...Object.values(databasePreparation.consumers),
        ]),
    ...(deploymentCheck === undefined
      ? []
      : [
          deploymentCheck.applicationPackageName,
          deploymentCheck.databasePackageName,
          deploymentCheck.migrationPackageName,
        ]),
  ];
  for (const packageName of capabilityPackageNames) {
    const contribution = packageByName.get(packageName);
    if (contribution !== undefined) {
      requiredManifestTruthPackagePaths.add(contribution.definition.path);
    }
  }
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
        { cause: error },
      );
    }
    if (!isRecord(manifest) || manifest.name !== expectedDefinition.name) {
      throw new Error(
        `Package Addition requires manifest truth for ${expectedDefinition.path}: expected name ${expectedDefinition.name}`,
      );
    }
    manifestTruthByPackagePath.set(expectedDefinition.path, manifest);
  }
  assertCapabilityRepositoryTruth({
    repositoryRoot: context.targetDir,
    blueprint,
    contributions: allContributions,
    packageByName,
    manifestTruthByPackagePath,
    databasePreparation,
    deploymentCheck,
    vueHonoJointE2e,
  });
  const reconstructedEnvironmentNeeds = normalizeEnvironmentNeeds({
    check: foundationCheckEnvironmentNeeds(
      allContributions,
      deploymentCheck,
      vueHonoJointE2e,
    ),
    deployment: deploymentCheck?.environmentNeeds ?? [],
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
  readonly rootNodeDeclaration: string;
  readonly layers: readonly DevelopmentContainerToolLayer[];
}): {
  readonly operations: readonly RenderOperation[];
  readonly mountIdentitySet: StructuredIdentitySetPolicy;
  readonly toolLayers: readonly PlannedDevelopmentContainerToolLayer[];
  readonly buildArguments: readonly DevelopmentContainerToolLayerBuildArgument[];
  readonly mounts: readonly DevelopmentContainerToolLayerMount[];
  readonly probes: readonly DevelopmentContainerToolLayerProbe[];
} {
  const layerPlan = planBuiltInDevelopmentContainer({
    nodeVersion: options.rootNodeDeclaration,
    layers: options.layers,
  });

  return {
    operations: [
      {
        kind: "writeJson",
        to: ".devcontainer/devcontainer.json",
        value: {
          ...(JSON.parse(
            readFileSync(
              fileURLToPath(
                import.meta
                  .resolve("@ykdz/template-environment/assets/.devcontainer/devcontainer.json"),
              ),
              "utf8",
            ),
          ) as Record<string, unknown>),
          name: options.context.repositoryName,
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
      layerPlan.dockerfileOperation,
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

type NormalizedDatabasePreparation = {
  readonly databasePackageName: string;
  readonly migrationPackageName: string;
  readonly consumers: Readonly<
    Record<"application-dev" | "database-test" | "application-e2e", string>
  >;
  readonly fingerprint: string;
};

function normalizeDatabasePreparation(
  contributions: readonly PackageContribution[],
): NormalizedDatabasePreparation | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const capability = contribution.foundation.databasePreparation;
    if (capability === undefined) return [];
    if (capability.kind !== "sqlite-database-preparation") {
      throw new Error(
        "Database Preparation has an unsupported capability kind",
      );
    }
    const consumers = Object.fromEntries(
      capability.consumers.map((consumer) => [
        consumer.kind,
        consumer.packageName,
      ]),
    ) as Partial<NormalizedDatabasePreparation["consumers"]>;
    if (
      capability.consumers.length !== 3 ||
      new Set(capability.consumers.map((consumer) => consumer.kind)).size !==
        3 ||
      consumers["application-dev"] === undefined ||
      consumers["database-test"] === undefined ||
      consumers["application-e2e"] === undefined
    ) {
      throw new Error(
        "Database Preparation must declare application-dev, database-test, and application-e2e consumers exactly once",
      );
    }
    const normalizedConsumers: NormalizedDatabasePreparation["consumers"] = {
      "application-dev": consumers["application-dev"],
      "database-test": consumers["database-test"],
      "application-e2e": consumers["application-e2e"],
    };
    return [
      {
        databasePackageName: contribution.definition.name,
        migrationPackageName: capability.migrationPackageName,
        consumers: normalizedConsumers,
        fingerprint: JSON.stringify({
          databasePackageName: contribution.definition.name,
          migrationPackageName: capability.migrationPackageName,
          consumers: normalizedConsumers,
          profiles: ["dev", "test", "e2e"],
        }),
      },
    ];
  });
  const first = declarations.at(0);
  if (first === undefined) return undefined;
  if (declarations.some((item) => item.fingerprint !== first.fingerprint)) {
    throw new Error(
      "Database Preparation has conflicting capability declarations",
    );
  }
  return first;
}

function databasePreparationCommands(
  preparation: NormalizedDatabasePreparation,
): Readonly<
  Record<
    | "database:prepare:dev"
    | "database:prepare:test"
    | "database:prepare:e2e"
    | "dev",
    string
  >
> {
  const run = (
    profile: "dev" | "test" | "e2e",
    packageName: string,
    task: string,
  ) => `DATABASE_PROFILE=${profile} pnpm --filter ${packageName} run ${task}`;
  return {
    "database:prepare:dev": [
      run("dev", preparation.migrationPackageName, "db:push"),
      run("dev", preparation.databasePackageName, "db:seed:example"),
    ].join(" && "),
    "database:prepare:test": [
      run("test", preparation.databasePackageName, "db:reset"),
      run("test", preparation.migrationPackageName, "db:push"),
      run("test", preparation.databasePackageName, "db:seed:example"),
    ].join(" && "),
    "database:prepare:e2e": [
      run("e2e", preparation.databasePackageName, "db:reset"),
      run("e2e", preparation.migrationPackageName, "db:push"),
      run("e2e", preparation.databasePackageName, "db:seed:example"),
    ].join(" && "),
    dev: `pnpm run database:prepare:dev && turbo watch dev --filter=${preparation.consumers["application-dev"]}`,
  };
}

type TurboTaskTruth = Readonly<{
  dependsOn?: readonly string[];
  outputs?: readonly string[];
  cache?: boolean;
  persistent?: boolean;
  tags?: readonly string[];
}>;

type TurboTaskTruthByName = Readonly<Record<string, TurboTaskTruth>>;

function databasePreparationRootTurboTasks(): TurboTaskTruthByName {
  return {
    "//#database:prepare:dev": {
      cache: false,
      tags: ["work:preparation"],
    },
    "//#database:prepare:test": {
      cache: false,
      tags: ["work:preparation"],
    },
    "//#database:prepare:e2e": {
      cache: false,
      tags: ["work:preparation"],
    },
  };
}

function deploymentTurboTasks(
  deploymentCheck: DeploymentCheck,
): TurboTaskTruthByName {
  return {
    "//#deployment": {
      dependsOn: [
        `${deploymentCheck.applicationPackageName}#build`,
        `${deploymentCheck.databasePackageName}#build`,
        `${deploymentCheck.migrationPackageName}#build`,
      ],
      cache: false,
      tags: ["quality:heavy"],
    },
  };
}

function vueHonoJointE2eTurboTasks(e2e: VueHonoJointE2e): TurboTaskTruthByName {
  return {
    "//#test:e2e": {
      dependsOn: [
        `${e2e.apiPackageName}#build`,
        `${e2e.webPackageName}#build`,
        `${e2e.webPackageName}#browser:prepare`,
      ],
      cache: false,
      tags: ["quality:heavy"],
    },
  };
}

function assertDatabasePreparationManifestTruth(options: {
  readonly preparation: NormalizedDatabasePreparation | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath:
    | ReadonlyMap<string, Readonly<Record<string, unknown>>>
    | undefined;
}): void {
  const { preparation, packageByName, manifestTruthByPackagePath } = options;
  if (preparation === undefined || manifestTruthByPackagePath === undefined) {
    return;
  }
  const expectedTasks = [
    [preparation.databasePackageName, "build"],
    [preparation.databasePackageName, "db:reset"],
    [preparation.databasePackageName, "db:seed:example"],
    [preparation.databasePackageName, "test"],
    [preparation.migrationPackageName, "db:push"],
    [preparation.migrationPackageName, "typecheck"],
    [preparation.consumers["application-dev"], "dev"],
    [preparation.consumers["application-dev"], "typecheck"],
    [preparation.consumers["application-e2e"], "build"],
    [preparation.consumers["application-e2e"], "test:e2e"],
  ] as const;
  for (const [packageName, taskName] of expectedTasks) {
    const contribution = requireContributionByName(
      packageByName,
      packageName,
      "Database Preparation",
    );
    const manifest = requireManifestTruth(
      manifestTruthByPackagePath,
      contribution,
      "Database Preparation",
    );
    const actualScripts = manifest.scripts;
    const expectedScripts = contribution.manifest.scripts;
    const actual = isRecord(actualScripts)
      ? actualScripts[taskName]
      : undefined;
    const expected = isRecord(expectedScripts)
      ? expectedScripts[taskName]
      : undefined;
    if (actual !== expected) {
      throw new Error(
        `Database Preparation requires exact ${packageName} script ${taskName}`,
      );
    }
  }
}

type DeploymentCheck = NonNullable<
  PackageContribution["foundation"]["deploymentCheck"]
> & {
  readonly declaringPackagePath: string;
};

type VueHonoJointE2e = NonNullable<
  PackageContribution["foundation"]["vueHonoJointE2e"]
> & {
  readonly webPackageName: string;
  readonly declaringPackagePath: string;
};

function normalizeDeploymentCheck(
  contributions: readonly PackageContribution[],
): DeploymentCheck | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const check = contribution.foundation.deploymentCheck;
    if (check === undefined) return [];
    if (check.kind !== "application-container-with-database-migrations") {
      throw new Error("Deployment Check has an unsupported capability kind");
    }
    return [{ ...check, declaringPackagePath: contribution.definition.path }];
  });
  if (declarations.length > 1) {
    throw new Error("Deployment Check has multiple capability declarations");
  }
  return declarations.at(0);
}

function normalizeVueHonoJointE2e(
  contributions: readonly PackageContribution[],
): VueHonoJointE2e | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const e2e = contribution.foundation.vueHonoJointE2e;
    if (e2e === undefined) return [];
    if (e2e.kind !== "vue-hono-joint-e2e") {
      throw new Error("Vue-Hono joint E2E has an unsupported capability kind");
    }
    return [
      {
        ...e2e,
        webPackageName: contribution.definition.name,
        declaringPackagePath: contribution.definition.path,
      },
    ];
  });
  if (declarations.length > 1) {
    throw new Error("Vue-Hono joint E2E has multiple capability declarations");
  }
  return declarations.at(0);
}

function requireContributionByName(
  packageByName: ReadonlyMap<string, PackageContribution>,
  packageName: string,
  capability: string,
): PackageContribution {
  const contribution = packageByName.get(packageName);
  if (contribution === undefined) {
    throw new Error(`${capability} references unknown Package ${packageName}`);
  }
  return contribution;
}

function requireManifestTruth(
  manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >,
  contribution: PackageContribution,
  capability: string,
): Readonly<Record<string, unknown>> {
  const manifest = manifestTruthByPackagePath.get(contribution.definition.path);
  if (manifest === undefined) {
    throw new Error(
      `${capability} requires manifest truth for ${contribution.definition.path}`,
    );
  }
  return manifest;
}

function assertExpectedRecordMembers(options: {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly label: string;
}): void {
  if (!isRecord(options.expected)) {
    throw new Error(`${options.label} replay did not provide object truth`);
  }
  if (!isRecord(options.actual)) {
    throw new Error(`${options.label} must be an object`);
  }
  for (const [key, expectedValue] of Object.entries(options.expected)) {
    if (!isDeepStrictEqual(options.actual[key], expectedValue)) {
      throw new Error(`${options.label} must preserve replayed member ${key}`);
    }
  }
}

function assertArtifactConditionOrder(options: {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly label: string;
}): void {
  if (!isRecord(options.expected) || !isRecord(options.actual)) return;
  const conditionNames = ["source", "types", "default"] as const;
  const expectedConditions = Object.keys(options.expected).filter((name) =>
    conditionNames.includes(name as (typeof conditionNames)[number]),
  );
  if (
    !expectedConditions.includes("source") ||
    !expectedConditions.some((name) => name === "types" || name === "default")
  ) {
    return;
  }
  const actualConditions = Object.keys(options.actual).filter((name) =>
    expectedConditions.includes(name),
  );
  if (!isDeepStrictEqual(actualConditions, expectedConditions)) {
    throw new Error(`${options.label} must preserve replayed condition order`);
  }
}

function assertDatabaseArtifactConditionTruth(options: {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly label: string;
}): void {
  if (!isRecord(options.actual) || !isRecord(options.expected)) return;
  for (const [memberName, expectedMember] of Object.entries(options.expected)) {
    assertArtifactConditionOrder({
      actual: options.actual[memberName],
      expected: expectedMember,
      label: `${options.label} ${memberName}`,
    });
  }
}

function assertDatabaseArtifactManifestTruth(options: {
  readonly preparation: NormalizedDatabasePreparation | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
}): void {
  if (options.preparation === undefined) return;
  const database = requireContributionByName(
    options.packageByName,
    options.preparation.databasePackageName,
    "Database Preparation",
  );
  const actual = requireManifestTruth(
    options.manifestTruthByPackagePath,
    database,
    "Database Preparation",
  );
  const expected = database.manifest;
  if (actual.type !== expected.type || expected.type !== "module") {
    throw new Error(
      `Database Preparation requires ${database.definition.name} manifest type module`,
    );
  }
  if (!Array.isArray(expected.files)) {
    throw new Error(
      `Database Preparation replay for ${database.definition.name} did not provide files truth`,
    );
  }
  const actualFiles = actual.files;
  if (
    !Array.isArray(actualFiles) ||
    expected.files.some(
      (expectedFile) =>
        !actualFiles.some((actualFile) =>
          isDeepStrictEqual(actualFile, expectedFile),
        ),
    )
  ) {
    throw new Error(
      `Database Preparation requires ${database.definition.name} public build files`,
    );
  }
  assertExpectedRecordMembers({
    actual: actual.exports,
    expected: expected.exports,
    label: `Database Preparation ${database.definition.name} exports`,
  });
  assertDatabaseArtifactConditionTruth({
    actual: actual.exports,
    expected: expected.exports,
    label: `Database Preparation ${database.definition.name} exports`,
  });
  assertExpectedRecordMembers({
    actual: actual.imports,
    expected: expected.imports,
    label: `Database Preparation ${database.definition.name} imports`,
  });
  assertDatabaseArtifactConditionTruth({
    actual: actual.imports,
    expected: expected.imports,
    label: `Database Preparation ${database.definition.name} imports`,
  });
}

function assertDatabaseProjectLinkManifestTruth(options: {
  readonly blueprint: ProjectBlueprint;
  readonly contributions: readonly PackageContribution[];
  readonly preparation: NormalizedDatabasePreparation | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
}): void {
  if (options.preparation === undefined) return;
  const database = requireContributionByName(
    options.packageByName,
    options.preparation.databasePackageName,
    "Database Preparation",
  );
  const expectedLinks = planExplicitProjectLinks({
    blueprint: options.blueprint,
    contributions: options.contributions,
  });
  for (const intent of options.blueprint.packageLinkIntents ?? []) {
    if (intent.providerPackagePath !== database.definition.path) continue;
    const consumer = options.contributions.find(
      (candidate) => candidate.definition.path === intent.consumerPackagePath,
    );
    if (consumer === undefined) {
      throw new Error(
        `Database Preparation Project Link references unknown consumer ${intent.consumerPackagePath}`,
      );
    }
    const actual = requireManifestTruth(
      options.manifestTruthByPackagePath,
      consumer,
      "Database Preparation Project Link",
    );
    if (
      !isRecord(actual.dependencies) ||
      actual.dependencies[database.definition.name] !== "workspace:*"
    ) {
      throw new Error(
        `Database Preparation requires ${consumer.definition.name} to depend on ${database.definition.name} through workspace:*`,
      );
    }
    const expectedMetadata = expectedLinks.manifestPatchesByPackagePath.get(
      consumer.definition.path,
    )?.dependenciesMeta?.[database.definition.name];
    if (
      actual.dependenciesMeta !== undefined &&
      !isRecord(actual.dependenciesMeta)
    ) {
      throw new Error(
        `Database Preparation requires valid dependency metadata in ${consumer.definition.name}`,
      );
    }
    const actualMetadata = isRecord(actual.dependenciesMeta)
      ? actual.dependenciesMeta[database.definition.name]
      : undefined;
    if (!isDeepStrictEqual(actualMetadata, expectedMetadata)) {
      throw new Error(
        `Database Preparation requires replayed Project Link metadata for ${consumer.definition.name} -> ${database.definition.name}`,
      );
    }
  }
}

function assertDeploymentBuildManifestTruth(options: {
  readonly deploymentCheck: DeploymentCheck | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
}): void {
  if (options.deploymentCheck === undefined) return;
  for (const packageName of [
    options.deploymentCheck.applicationPackageName,
    options.deploymentCheck.databasePackageName,
    options.deploymentCheck.migrationPackageName,
  ]) {
    const contribution = requireContributionByName(
      options.packageByName,
      packageName,
      "Deployment Check",
    );
    const actual = requireManifestTruth(
      options.manifestTruthByPackagePath,
      contribution,
      "Deployment Check",
    );
    const actualBuild = isRecord(actual.scripts)
      ? actual.scripts.build
      : undefined;
    const expectedBuild = isRecord(contribution.manifest.scripts)
      ? contribution.manifest.scripts.build
      : undefined;
    if (typeof expectedBuild !== "string" || actualBuild !== expectedBuild) {
      throw new Error(
        `Deployment Check requires exact ${packageName} manifest script build`,
      );
    }
  }
}

function assertVueHonoJointE2eManifestTruth(options: {
  readonly e2e: VueHonoJointE2e | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
}): void {
  if (options.e2e === undefined) return;
  if (options.e2e.apiPackageName === options.e2e.webPackageName) {
    throw new Error(
      "Vue-Hono joint E2E requires distinct API and web Packages",
    );
  }
  const expectedTasks = [
    [options.e2e.apiPackageName, "build"],
    [options.e2e.apiPackageName, "start"],
    [options.e2e.webPackageName, "build"],
    [options.e2e.webPackageName, "preview"],
  ] as const;
  for (const [packageName, taskName] of expectedTasks) {
    const contribution = requireContributionByName(
      options.packageByName,
      packageName,
      "Vue-Hono joint E2E",
    );
    const actual = requireManifestTruth(
      options.manifestTruthByPackagePath,
      contribution,
      "Vue-Hono joint E2E",
    );
    const expected = isRecord(contribution.manifest.scripts)
      ? contribution.manifest.scripts[taskName]
      : undefined;
    const actualScript = isRecord(actual.scripts)
      ? actual.scripts[taskName]
      : undefined;
    if (typeof expected !== "string" || actualScript !== expected) {
      throw new Error(
        `Vue-Hono joint E2E requires exact ${packageName} manifest script ${taskName}`,
      );
    }
  }
}

function readRepositoryJsonRecord(options: {
  readonly repositoryRoot: string;
  readonly relativePath: string;
  readonly label: string;
}): Readonly<Record<string, unknown>> {
  const value = readJsonFile(
    path.join(options.repositoryRoot, options.relativePath),
    `${options.label} in ${options.relativePath}`,
  );
  if (!isRecord(value)) {
    throw new Error(
      `Package Addition requires ${options.label} in ${options.relativePath} to be an object`,
    );
  }
  return value;
}

function assertRootCapabilityManifestTruth(options: {
  readonly repositoryRoot: string;
  readonly databasePreparation: NormalizedDatabasePreparation | undefined;
  readonly deploymentCheck: DeploymentCheck | undefined;
  readonly vueHonoJointE2e: VueHonoJointE2e | undefined;
}): void {
  if (
    options.databasePreparation === undefined &&
    options.deploymentCheck === undefined &&
    options.vueHonoJointE2e === undefined
  ) {
    return;
  }
  const manifest = readRepositoryJsonRecord({
    repositoryRoot: options.repositoryRoot,
    relativePath: "package.json",
    label: "root Manifest Truth",
  });
  if (!isRecord(manifest.scripts)) {
    throw new Error("Package Addition requires root manifest scripts truth");
  }
  const expectedScripts = {
    ...(options.databasePreparation === undefined
      ? {}
      : databasePreparationCommands(options.databasePreparation)),
    ...(options.deploymentCheck === undefined
      ? {}
      : {
          deployment:
            "node --conditions=source scripts/check-standalone-deployment.ts",
        }),
    ...(options.vueHonoJointE2e === undefined
      ? {}
      : { "test:e2e": "playwright test" }),
  };
  for (const [scriptName, expectedCommand] of Object.entries(expectedScripts)) {
    if (manifest.scripts[scriptName] !== expectedCommand) {
      throw new Error(
        `Package Addition requires exact root manifest script ${scriptName}`,
      );
    }
  }
}

function assertTurboTaskTruth(options: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly expectedTasks: TurboTaskTruthByName;
  readonly label: string;
}): void {
  if (!isRecord(options.config.tasks)) {
    throw new Error(`${options.label} requires Turbo tasks truth`);
  }
  for (const [taskName, expectedTask] of Object.entries(
    options.expectedTasks,
  )) {
    const actualTask = options.config.tasks[taskName];
    if (!isRecord(actualTask)) {
      throw new Error(`${options.label} requires Turbo task ${taskName}`);
    }
    for (const [field, expectedValue] of Object.entries(expectedTask)) {
      const actualValue = actualTask[field];
      if (Array.isArray(expectedValue)) {
        if (
          !Array.isArray(actualValue) ||
          expectedValue.some(
            (expectedMember) => !actualValue.includes(expectedMember),
          )
        ) {
          throw new Error(
            `${options.label} requires Turbo task ${taskName} ${field}`,
          );
        }
      } else if (!isDeepStrictEqual(actualValue, expectedValue)) {
        throw new Error(
          `${options.label} requires Turbo task ${taskName} ${field}`,
        );
      }
    }
  }
}

function assertCapabilityPackageTurboInheritanceTruth(options: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly label: string;
}): void {
  if (
    !Array.isArray(options.config.extends) ||
    options.config.extends.length !== 1 ||
    options.config.extends[0] !== "//"
  ) {
    throw new Error(`${options.label} requires exact Turbo extends truth`);
  }
}

function localCapabilityTaskDependencies(options: {
  readonly localTask: unknown;
  readonly label: string;
  readonly taskName: string;
}): unknown {
  if (!isRecord(options.localTask)) {
    throw new Error(`${options.label} requires Turbo task ${options.taskName}`);
  }
  const extendsValue = options.localTask.extends;
  if (extendsValue !== undefined && typeof extendsValue !== "boolean") {
    throw new Error(
      `${options.label} requires Turbo task ${options.taskName} extends truth`,
    );
  }
  return options.localTask.dependsOn;
}

function assertCapabilityConsumerTurboTruth(options: {
  readonly repositoryRoot: string;
  readonly preparation: NormalizedDatabasePreparation;
  readonly buildConsumerPackageNames: readonly string[];
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
}): void {
  const turboByPackagePath = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const assertPackageTaskTruth = (
    packageName: string,
    taskName: string,
    expectedTask: TurboTaskTruth,
  ): void => {
    const contribution = requireContributionByName(
      options.packageByName,
      packageName,
      "Database Preparation",
    );
    const packageTurbo =
      turboByPackagePath.get(contribution.definition.path) ??
      readRepositoryJsonRecord({
        repositoryRoot: options.repositoryRoot,
        relativePath: `${contribution.definition.path}/turbo.json`,
        label: `${contribution.definition.name} Turbo Truth`,
      });
    turboByPackagePath.set(contribution.definition.path, packageTurbo);
    if (!isRecord(packageTurbo.tasks)) {
      throw new Error(
        `Package Addition ${contribution.definition.name} Turbo Truth requires Turbo tasks truth`,
      );
    }
    assertCapabilityPackageTurboInheritanceTruth({
      config: packageTurbo,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
    });
    const localTask = packageTurbo.tasks[taskName];
    localCapabilityTaskDependencies({
      localTask,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
      taskName,
    });
    assertTurboTaskTruth({
      config: packageTurbo,
      expectedTasks: { [taskName]: expectedTask },
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
    });
  };

  const preparation = options.preparation;
  assertPackageTaskTruth(preparation.databasePackageName, "test", {
    dependsOn: ["//#database:prepare:test"],
    tags: ["quality:light"],
  });
  assertPackageTaskTruth(preparation.migrationPackageName, "typecheck", {
    dependsOn: [`${preparation.databasePackageName}#build`],
    tags: ["quality:light"],
  });
  assertPackageTaskTruth(
    preparation.consumers["application-dev"],
    "typecheck",
    {
      dependsOn: [`${preparation.databasePackageName}#build`],
      tags: ["quality:light"],
    },
  );
  assertPackageTaskTruth(preparation.consumers["application-dev"], "dev", {
    dependsOn: [`${preparation.databasePackageName}#build`],
    cache: false,
    persistent: true,
    tags: ["work:development"],
  });
  assertPackageTaskTruth(preparation.consumers["application-e2e"], "test:e2e", {
    dependsOn: [
      "//#database:prepare:e2e",
      `${preparation.databasePackageName}#build`,
      "build",
      "browser:prepare",
    ],
    cache: false,
    tags: ["quality:heavy"],
  });

  for (const packageName of options.buildConsumerPackageNames) {
    const contribution = requireContributionByName(
      options.packageByName,
      packageName,
      "Database Preparation",
    );
    const packageTurbo =
      turboByPackagePath.get(contribution.definition.path) ??
      readRepositoryJsonRecord({
        repositoryRoot: options.repositoryRoot,
        relativePath: `${contribution.definition.path}/turbo.json`,
        label: `${contribution.definition.name} Turbo Truth`,
      });
    turboByPackagePath.set(contribution.definition.path, packageTurbo);
    if (!isRecord(packageTurbo.tasks)) {
      throw new Error(
        `Package Addition ${contribution.definition.name} Turbo Truth requires Turbo tasks truth`,
      );
    }
    assertCapabilityPackageTurboInheritanceTruth({
      config: packageTurbo,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
    });
    const localBuild = packageTurbo.tasks.build;
    const dependencies = localCapabilityTaskDependencies({
      localTask: localBuild,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
      taskName: "build",
    });
    if (
      !Array.isArray(dependencies) ||
      (packageName !== options.preparation.databasePackageName &&
        !dependencies.some(
          (dependency) =>
            dependency === "^build" ||
            dependency === `${options.preparation.databasePackageName}#build`,
        ))
    ) {
      throw new Error(
        `Package Addition ${contribution.definition.name} Turbo Truth requires Turbo task build dependsOn`,
      );
    }
  }
}

function assertCapabilityTurboTruth(options: {
  readonly repositoryRoot: string;
  readonly databasePreparation: NormalizedDatabasePreparation | undefined;
  readonly deploymentCheck: DeploymentCheck | undefined;
  readonly vueHonoJointE2e: VueHonoJointE2e | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
}): void {
  if (
    options.databasePreparation === undefined &&
    options.deploymentCheck === undefined &&
    options.vueHonoJointE2e === undefined
  ) {
    return;
  }
  const rootTurbo = readRepositoryJsonRecord({
    repositoryRoot: options.repositoryRoot,
    relativePath: "turbo.json",
    label: "root Turbo Truth",
  });
  assertTurboTaskTruth({
    config: rootTurbo,
    expectedTasks: {
      ...(options.databasePreparation === undefined
        ? {}
        : databasePreparationRootTurboTasks()),
      ...(options.deploymentCheck === undefined
        ? {}
        : deploymentTurboTasks(options.deploymentCheck)),
      ...(options.vueHonoJointE2e === undefined
        ? {}
        : vueHonoJointE2eTurboTasks(options.vueHonoJointE2e)),
    },
    label: "Package Addition root Turbo Truth",
  });
  if (options.databasePreparation === undefined) return;
  const database = requireContributionByName(
    options.packageByName,
    options.databasePreparation.databasePackageName,
    "Database Preparation",
  );
  const databaseTurbo = readRepositoryJsonRecord({
    repositoryRoot: options.repositoryRoot,
    relativePath: `${database.definition.path}/turbo.json`,
    label: `${database.definition.name} Turbo Truth`,
  });
  assertTurboTaskTruth({
    config: databaseTurbo,
    expectedTasks: { build: { outputs: ["dist/**"] } },
    label: `Package Addition ${database.definition.name} Turbo Truth`,
  });
  assertCapabilityConsumerTurboTruth({
    repositoryRoot: options.repositoryRoot,
    preparation: options.databasePreparation,
    buildConsumerPackageNames: [
      options.databasePreparation.migrationPackageName,
      ...new Set(Object.values(options.databasePreparation.consumers)),
    ],
    packageByName: options.packageByName,
  });
}

type ParsedTypeScriptSourceFile = ts.SourceFile & {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

function unwrapTypeScriptExpression(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
    ? unwrapTypeScriptExpression(expression.expression)
    : expression;
}

function typeScriptPropertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : undefined;
}

function finalObjectLiteralPropertyValue(
  expression: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  let hasUnverifiableOverride = false;
  for (const property of [...expression.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      hasUnverifiableOverride = true;
      continue;
    }
    const name = typeScriptPropertyName(property.name);
    if (name === propertyName) {
      if (!ts.isPropertyAssignment(property) || hasUnverifiableOverride) {
        return undefined;
      }
      return property.initializer;
    }
    if (name === undefined) {
      hasUnverifiableOverride = true;
    }
  }
  return undefined;
}

function assertDatabaseViteRuntimeTruth(options: {
  readonly repositoryRoot: string;
  readonly deploymentCheck: DeploymentCheck | undefined;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
}): void {
  if (options.deploymentCheck === undefined) return;
  const application = requireContributionByName(
    options.packageByName,
    options.deploymentCheck.applicationPackageName,
    "Deployment Check",
  );
  const configPath = `${application.definition.path}/vite.config.ts`;
  let sourceText: string;
  try {
    sourceText = readFileSync(
      path.join(options.repositoryRoot, configPath),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Package Addition requires Vite runtime truth in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const sourceFile = ts.createSourceFile(
    configPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  ) as ParsedTypeScriptSourceFile;
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    throw new Error(
      `Package Addition requires valid Vite runtime truth in ${configPath}`,
    );
  }
  const exportAssignment = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const exported =
    exportAssignment === undefined
      ? undefined
      : unwrapTypeScriptExpression(exportAssignment.expression);
  const configCall =
    exported !== undefined &&
    ts.isCallExpression(exported) &&
    ts.isIdentifier(exported.expression) &&
    exported.expression.text === "defineConfig"
      ? exported
      : undefined;
  const configArgument = configCall?.arguments[0];
  const config =
    configArgument === undefined
      ? undefined
      : unwrapTypeScriptExpression(configArgument);
  const ssrValue =
    config !== undefined && ts.isObjectLiteralExpression(config)
      ? finalObjectLiteralPropertyValue(config, "ssr")
      : undefined;
  const ssr =
    ssrValue === undefined ? undefined : unwrapTypeScriptExpression(ssrValue);
  const externalValue =
    ssr !== undefined && ts.isObjectLiteralExpression(ssr)
      ? finalObjectLiteralPropertyValue(ssr, "external")
      : undefined;
  const external =
    externalValue === undefined
      ? undefined
      : unwrapTypeScriptExpression(externalValue);
  const expectedPackageName = options.deploymentCheck.databasePackageName;
  const externalPackageName = (element: ts.Expression): string | undefined => {
    const expression = unwrapTypeScriptExpression(element);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (
      !ts.isPropertyAccessExpression(expression) ||
      expression.name.text !== "name" ||
      !ts.isIdentifier(expression.expression)
    )
      return undefined;
    const manifestVariable = expression.expression.text;
    const declaration = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .find(
        (entry) =>
          !entry.importClause?.isTypeOnly &&
          entry.importClause?.name?.text === manifestVariable &&
          ts.isStringLiteralLike(entry.moduleSpecifier) &&
          entry.moduleSpecifier.text ===
            `${expectedPackageName}/package.json` &&
          entry.attributes?.elements.some(
            (attribute) =>
              attribute.name.text === "type" &&
              ts.isStringLiteralLike(attribute.value) &&
              attribute.value.text === "json",
          ),
      );
    if (declaration === undefined) return undefined;
    const database = requireContributionByName(
      options.packageByName,
      expectedPackageName,
      "Deployment Check",
    );
    // 只检查公开 JSON 导入及包身份，不执行用户的 Vite 配置。
    const manifest = readRepositoryJsonRecord({
      repositoryRoot: options.repositoryRoot,
      relativePath: `${database.definition.path}/package.json`,
      label: `${expectedPackageName} Vite runtime identity`,
    });
    return isRecord(manifest.exports) &&
      manifest.exports["./package.json"] === "./package.json" &&
      typeof manifest.name === "string"
      ? manifest.name
      : undefined;
  };
  const externalPackageNames =
    external !== undefined && ts.isArrayLiteralExpression(external)
      ? external.elements.map(externalPackageName)
      : external !== undefined
        ? [externalPackageName(external)]
        : [];
  if (!externalPackageNames.includes(expectedPackageName)) {
    throw new Error(
      `Package Addition requires ${configPath} to externalize ${expectedPackageName} through Vite SSR`,
    );
  }
}

function isWorkspaceJsonRead(
  expression: ts.Expression | undefined,
  file: string,
): boolean {
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "JSON" ||
    expression.expression.name.text !== "parse"
  )
    return false;
  const read = expression.arguments[0]!;
  if (
    !ts.isCallExpression(read) ||
    !ts.isIdentifier(read.expression) ||
    read.expression.text !== "readFileSync" ||
    read.arguments.length !== 2
  )
    return false;
  const [url, encoding] = read.arguments;
  if (
    url === undefined ||
    !ts.isNewExpression(url) ||
    !ts.isIdentifier(url.expression) ||
    url.expression.text !== "URL" ||
    url.arguments?.length !== 2 ||
    encoding === undefined ||
    !ts.isStringLiteralLike(encoding) ||
    encoding.text !== "utf8"
  )
    return false;
  const [relative, base] = url.arguments;
  return (
    relative !== undefined &&
    ts.isStringLiteralLike(relative) &&
    relative.text === file &&
    base !== undefined &&
    ts.isPropertyAccessExpression(base) &&
    base.name.text === "url" &&
    ts.isMetaProperty(base.expression) &&
    base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    base.expression.name.text === "meta"
  );
}

function assertVueHonoJointE2ePlaywrightTruth(options: {
  readonly repositoryRoot: string;
  readonly e2e: VueHonoJointE2e | undefined;
}): void {
  if (options.e2e === undefined) return;
  const configPath = "playwright.config.ts";
  let sourceText: string;
  try {
    sourceText = readFileSync(
      path.join(options.repositoryRoot, configPath),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Package Addition requires Vue-Hono joint E2E root Playwright truth in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const sourceFile = ts.createSourceFile(
    configPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  ) as ParsedTypeScriptSourceFile;
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    throw new Error(
      `Package Addition requires valid Vue-Hono joint E2E root Playwright truth in ${configPath}`,
    );
  }
  const exportAssignment = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const exported =
    exportAssignment === undefined
      ? undefined
      : unwrapTypeScriptExpression(exportAssignment.expression);
  const configCall =
    exported !== undefined &&
    ts.isCallExpression(exported) &&
    ts.isIdentifier(exported.expression) &&
    exported.expression.text === "defineConfig"
      ? exported
      : undefined;
  const configArgument = configCall?.arguments[0];
  const config =
    configArgument === undefined
      ? undefined
      : unwrapTypeScriptExpression(configArgument);
  const webServerValue =
    config !== undefined && ts.isObjectLiteralExpression(config)
      ? finalObjectLiteralPropertyValue(config, "webServer")
      : undefined;
  const webServers =
    webServerValue === undefined
      ? undefined
      : unwrapTypeScriptExpression(webServerValue);
  if (
    webServers === undefined ||
    !ts.isArrayLiteralExpression(webServers) ||
    webServers.elements.length !== 2
  ) {
    throw new Error(
      `Package Addition requires two static Vue-Hono joint E2E web servers in ${configPath}`,
    );
  }
  const expectedServers = [
    {
      command: `pnpm --filter ${options.e2e.apiPackageName} --fail-if-no-match run start`,
      packageVariable: "apiPackageName",
      portEnvironment: "PORT",
      portVariable: "apiPort",
      portInput: "PLAYWRIGHT_API_PORT",
      stdout:
        "/Hono API listening on (?<VITE_API_BASE_URL>http:\\/\\/localhost:\\d+)/",
    },
    {
      command: `pnpm --filter ${options.e2e.webPackageName} --fail-if-no-match run preview --host 127.0.0.1 --strictPort`,
      packageVariable: "webPackageName",
      portEnvironment: "PLAYWRIGHT_WEB_PORT",
      portVariable: "webPort",
      portInput: "PLAYWRIGHT_WEB_PORT",
      stdout:
        "/Local:\\s+(?<PLAYWRIGHT_WEB_URL>http:\\/\\/127\\.0\\.0\\.1:\\d+)/",
    },
  ] as const;
  for (const [index, expected] of expectedServers.entries()) {
    const server = unwrapTypeScriptExpression(webServers.elements[index]!);
    if (!ts.isObjectLiteralExpression(server)) {
      throw new Error(
        `Package Addition requires static Vue-Hono joint E2E web server ${index + 1} in ${configPath}`,
      );
    }
    const command = finalObjectLiteralPropertyValue(server, "command");
    let commandText =
      command !== undefined && ts.isStringLiteralLike(command)
        ? command.text
        : undefined;
    if (
      command !== undefined &&
      ts.isTemplateExpression(command) &&
      command.templateSpans.length === 1
    ) {
      const span = command.templateSpans[0]!;
      if (
        ts.isIdentifier(span.expression) &&
        span.expression.text === expected.packageVariable
      ) {
        const declaration = sourceFile.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) =>
            (statement.declarationList.flags & ts.NodeFlags.Const) === 0
              ? []
              : [...statement.declarationList.declarations],
          )
          .find(
            (entry) =>
              ts.isObjectBindingPattern(entry.name) &&
              entry.name.elements.some(
                (element) =>
                  ts.isIdentifier(element.name) &&
                  element.name.text === expected.packageVariable,
              ),
          );
        const expression =
          declaration?.initializer === undefined
            ? undefined
            : unwrapTypeScriptExpression(declaration.initializer);
        // 固定原生读取表达式使包身份来自受检查的 JSON，而不是执行用户配置。
        if (isWorkspaceJsonRead(expression, "./joint-e2e.json")) {
          const identities = readRepositoryJsonRecord({
            repositoryRoot: options.repositoryRoot,
            relativePath: "joint-e2e.json",
            label: "Vue-Hono joint E2E package identities",
          });
          const name = identities[expected.packageVariable];
          if (name === options.e2e[expected.packageVariable])
            commandText = command.head.text + name + span.literal.text;
        }
      }
    }
    if (commandText !== expected.command) {
      throw new Error(
        `Package Addition requires exact Vue-Hono joint E2E web server ${index + 1} command in ${configPath}`,
      );
    }
    const environmentValue = finalObjectLiteralPropertyValue(server, "env");
    const environment =
      environmentValue === undefined
        ? undefined
        : unwrapTypeScriptExpression(environmentValue);
    const environmentProperty =
      environment !== undefined && ts.isObjectLiteralExpression(environment)
        ? environment.properties[0]
        : undefined;
    const portValue =
      environmentProperty !== undefined &&
      ts.isPropertyAssignment(environmentProperty) &&
      !ts.isComputedPropertyName(environmentProperty.name) &&
      (ts.isIdentifier(environmentProperty.name) ||
        ts.isStringLiteral(environmentProperty.name)) &&
      environmentProperty.name.text === expected.portEnvironment
        ? unwrapTypeScriptExpression(environmentProperty.initializer)
        : undefined;
    if (
      environment === undefined ||
      !ts.isObjectLiteralExpression(environment) ||
      environment.properties.length !== 1 ||
      portValue === undefined ||
      !ts.isIdentifier(portValue) ||
      portValue.text !== expected.portVariable
    ) {
      throw new Error(
        `Package Addition requires Vue-Hono joint E2E web server ${index + 1} ${expected.portEnvironment} environment in ${configPath}`,
      );
    }
    const waitValue = finalObjectLiteralPropertyValue(server, "wait");
    const wait =
      waitValue === undefined
        ? undefined
        : unwrapTypeScriptExpression(waitValue);
    const stdout =
      wait !== undefined && ts.isObjectLiteralExpression(wait)
        ? finalObjectLiteralPropertyValue(wait, "stdout")
        : undefined;
    if (
      stdout === undefined ||
      !ts.isRegularExpressionLiteral(stdout) ||
      stdout.text !== expected.stdout
    ) {
      throw new Error(
        `Package Addition requires static Vue-Hono joint E2E web server ${index + 1} stdout capture in ${configPath}`,
      );
    }
    const reuseExistingServer = finalObjectLiteralPropertyValue(
      server,
      "reuseExistingServer",
    );
    if (reuseExistingServer?.kind !== ts.SyntaxKind.FalseKeyword) {
      throw new Error(
        `Package Addition requires Vue-Hono joint E2E web server ${index + 1} native cleanup in ${configPath}`,
      );
    }
  }
  const expectedPortInputs = expectedServers.map(
    ({ portVariable, portInput }) => ({ portVariable, portInput }),
  );
  for (const expected of expectedPortInputs) {
    const declarations = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) =>
        statement.declarationList.declarations.map((declaration) => ({
          declaration,
          declarationList: statement.declarationList,
        })),
      )
      .filter(
        ({ declaration }) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === expected.portVariable,
      );
    const declaration = declarations[0];
    if (
      declarations.length !== 1 ||
      declaration === undefined ||
      (declaration.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      throw new Error(
        `Package Addition requires one top-level const Vue-Hono joint E2E ${expected.portVariable} in ${configPath}`,
      );
    }
    const initializer = declaration.declaration.initializer;
    const left =
      initializer !== undefined &&
      ts.isBinaryExpression(initializer) &&
      initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? initializer.left
        : undefined;
    const right =
      initializer !== undefined &&
      ts.isBinaryExpression(initializer) &&
      initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? initializer.right
        : undefined;
    const environmentInput =
      left !== undefined &&
      ts.isPropertyAccessExpression(left) &&
      ts.isPropertyAccessExpression(left.expression) &&
      ts.isIdentifier(left.expression.expression) &&
      left.expression.expression.text === "process" &&
      left.expression.name.text === "env"
        ? left.name.text
        : undefined;
    if (
      environmentInput !== expected.portInput ||
      right === undefined ||
      !ts.isStringLiteralLike(right) ||
      right.text !== "0"
    ) {
      throw new Error(
        `Package Addition requires Vue-Hono joint E2E ${expected.portVariable} to read ${expected.portInput} or static port 0 in ${configPath}`,
      );
    }
  }
}

function assertCapabilityRepositoryTruth(options: {
  readonly repositoryRoot: string;
  readonly blueprint: ProjectBlueprint;
  readonly contributions: readonly PackageContribution[];
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
  readonly manifestTruthByPackagePath: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly databasePreparation: NormalizedDatabasePreparation | undefined;
  readonly deploymentCheck: DeploymentCheck | undefined;
  readonly vueHonoJointE2e: VueHonoJointE2e | undefined;
}): void {
  assertDatabasePreparationManifestTruth({
    preparation: options.databasePreparation,
    packageByName: options.packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  assertDatabaseArtifactManifestTruth({
    preparation: options.databasePreparation,
    packageByName: options.packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  assertDatabaseProjectLinkManifestTruth({
    blueprint: options.blueprint,
    contributions: options.contributions,
    preparation: options.databasePreparation,
    packageByName: options.packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  assertDeploymentBuildManifestTruth({
    deploymentCheck: options.deploymentCheck,
    packageByName: options.packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  assertVueHonoJointE2eManifestTruth({
    e2e: options.vueHonoJointE2e,
    packageByName: options.packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  assertVueHonoJointE2ePlaywrightTruth({
    repositoryRoot: options.repositoryRoot,
    e2e: options.vueHonoJointE2e,
  });
  assertRootCapabilityManifestTruth(options);
  assertCapabilityTurboTruth(options);
  assertDatabaseViteRuntimeTruth(options);
}

function foundationCheckEnvironmentNeeds(
  contributions: readonly PackageContribution[],
  deploymentCheck: DeploymentCheck | undefined,
  vueHonoJointE2e: VueHonoJointE2e | undefined,
): readonly CheckEnvironmentNeed[] {
  return [
    ...contributions.flatMap((contribution) => contribution.environmentNeeds),
    ...(vueHonoJointE2e === undefined
      ? []
      : [
          playwrightBrowserAssetsEnvironmentNeed({
            browser: "chromium",
            owner: { kind: "workspace-orchestration", path: "." },
          }),
        ]),
    ...(deploymentCheck === undefined
      ? []
      : [
          shellCheckEnvironmentNeed({
            kind: "workspace-orchestration",
            path: ".",
          }),
        ]),
  ];
}

function deploymentCheckDevelopmentContainerToolLayers(
  deploymentCheck: DeploymentCheck | undefined,
): readonly DevelopmentContainerToolLayer[] {
  if (deploymentCheck === undefined) return [];
  return [shellCheckDevelopmentContainerToolLayer()];
}

type RustToolchain = NonNullable<
  PackageContribution["foundation"]["toolchains"]["rust"]
>;

function normalizeRustToolchain(
  contributions: readonly PackageContribution[],
): RustToolchain | undefined {
  const declarations = contributions.flatMap((contribution) => {
    const rust = contribution.foundation.toolchains.rust;
    return rust === undefined
      ? []
      : [
          {
            ...rust,
            components: [...new Set(rust.components)].toSorted(),
          },
        ];
  });
  const fingerprints = declarations.map((rust) =>
    JSON.stringify({
      toolchain: rust.toolchain,
      components: rust.components,
      configurationSource: resolveTemplateSource(
        rust.configurationSource.source,
        rust.configurationSource.from,
      ),
    }),
  );
  if (new Set(fingerprints).size > 1) {
    throw new Error("Foundation requires compatible Rust toolchain facts");
  }
  return declarations.at(0);
}

function composeDependencyMaintenancePolicy(
  contributions: readonly PackageContribution[],
  deploymentCheck: DeploymentCheck | undefined,
): DependencyMaintenancePolicy {
  const ecosystems = [
    ...new Set([
      "devcontainers" as const,
      ...contributions.flatMap(
        (contribution) =>
          contribution.foundation.dependencyMaintenance.ecosystems,
      ),
      ...(deploymentCheck === undefined ? [] : (["docker"] as const)),
    ]),
  ];
  const directories: NonNullable<DependencyMaintenancePolicy["directories"]> =
    {};
  const extraDirectories: NonNullable<
    DependencyMaintenancePolicy["extraDirectories"]
  > = {};

  for (const ecosystem of ecosystems) {
    const candidates = [
      ...new Set([
        ...(ecosystem === "docker" ? (["/.devcontainer"] as const) : []),
        ...contributions.flatMap((contribution) => {
          const policy = contribution.foundation.dependencyMaintenance;
          const primary = policy.directories?.[ecosystem];
          return [
            ...(primary === undefined ? [] : [primary]),
            ...(policy.extraDirectories?.[ecosystem] ?? []),
          ];
        }),
        ...(ecosystem === "docker" && deploymentCheck !== undefined
          ? (["/"] as const)
          : []),
      ]),
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

function publicationIdentitySource(): TemplateSourceHandle {
  const source = requireReferencePackage(
    "@ykdz/reference-ts-cli",
  ).publicationIdentitySource;
  if (source === undefined) {
    throw new Error("公开 CLI 候选缺少原生 CLI 身份资源");
  }
  return source;
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
  /** Current manifests supply mutable package-owned facts such as commands and explicit links. */
  readonly manifestTruthByPackagePath?: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly generationRecord: GenerationRecord;
  readonly mode: "initialization" | "addition";
  /**
   * 生成仓库私有根 package.json 的 engines.node 声明：初始化投影 CLI 发版快照的精确
   * Node 版本，加包按目标仓库现行声明原样回写。
   */
  readonly rootNodeDeclaration: string;
}): GeneratedRepositoryPlan {
  assertDefaultProjectBlueprint(options.blueprint);
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
        Object.entries(patch.dependenciesMeta ?? {})
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
    if (contribution.referenceSource !== undefined) {
      if (!injectedProviderNames.has(contribution.definition.name))
        return contribution;
      const devDependencies = {
        ...(isRecord(contribution.manifest.devDependencies)
          ? contribution.manifest.devDependencies
          : {}),
      };
      const dependencies = {
        ...(isRecord(contribution.manifest.dependencies)
          ? contribution.manifest.dependencies
          : {}),
      };
      for (const definition of Object.values(
        contribution.referenceBindings ?? {},
      )) {
        if (devDependencies[definition.name] === undefined) continue;
        dependencies[definition.name] = "workspace:*";
        delete devDependencies[definition.name];
      }
      return {
        ...contribution,
        manifest: { ...contribution.manifest, dependencies, devDependencies },
      };
    }
    return contribution;
  });
  const requiresPackingHook = packageContributions.some((contribution) => {
    const developmentDependencies = contribution.manifest.devDependencies;
    return (
      isRecord(developmentDependencies) &&
      Object.values(developmentDependencies).some(
        (specifier) =>
          typeof specifier === "string" &&
          (specifier.startsWith("link:") ||
            (contribution.manifest.private !== true &&
              specifier.startsWith("workspace:"))),
      )
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
  const generationRecord = parseGenerationRecord(options.generationRecord);
  const deploymentCheck = normalizeDeploymentCheck(contributions);
  const vueHonoJointE2e = normalizeVueHonoJointE2e(contributions);
  const databasePreparation = normalizeDatabasePreparation(contributions);
  const rustToolchain = normalizeRustToolchain(contributions);
  const packageByName = new Map(
    contributions.map((contribution) => [
      contribution.definition.name,
      contribution,
    ]),
  );
  const deploymentPackages =
    deploymentCheck === undefined
      ? undefined
      : {
          application: requireContributionByName(
            packageByName,
            deploymentCheck.applicationPackageName,
            "Deployment Check",
          ),
          database: requireContributionByName(
            packageByName,
            deploymentCheck.databasePackageName,
            "Deployment Check",
          ),
          migration: requireContributionByName(
            packageByName,
            deploymentCheck.migrationPackageName,
            "Deployment Check",
          ),
        };
  if (databasePreparation !== undefined) {
    const migration = packageByName.get(
      databasePreparation.migrationPackageName,
    );
    if (migration === undefined) {
      throw new Error(
        "Database Preparation references an unknown migration Package",
      );
    }
    for (const packageName of Object.values(databasePreparation.consumers)) {
      if (!packageByName.has(packageName)) {
        throw new Error(
          "Database Preparation references an unknown consumer Package",
        );
      }
    }
    if (
      databasePreparation.consumers["database-test"] !==
      databasePreparation.databasePackageName
    ) {
      throw new Error(
        "Database Preparation database-test consumer must be its owner",
      );
    }
  }
  assertDatabasePreparationManifestTruth({
    preparation: databasePreparation,
    packageByName,
    manifestTruthByPackagePath: options.manifestTruthByPackagePath,
  });
  if (deploymentCheck !== undefined) {
    const deploymentPackageNames = [
      deploymentCheck.applicationPackageName,
      deploymentCheck.databasePackageName,
      deploymentCheck.migrationPackageName,
    ];
    if (new Set(deploymentPackageNames).size !== 3) {
      throw new Error("Deployment Check requires three distinct Packages");
    }
    if (
      deploymentPackages?.application.definition.path !==
      deploymentCheck.declaringPackagePath
    ) {
      throw new Error(
        "Deployment Check must be declared by its application Package",
      );
    }
    if (
      databasePreparation !== undefined &&
      (databasePreparation.databasePackageName !==
        deploymentCheck.databasePackageName ||
        databasePreparation.migrationPackageName !==
          deploymentCheck.migrationPackageName)
    ) {
      throw new Error(
        "Deployment Check must use the Database Preparation Packages",
      );
    }
    for (const packageName of deploymentPackageNames) {
      const contribution = requireContributionByName(
        packageByName,
        packageName,
        "Deployment Check",
      );
      const manifest =
        options.manifestTruthByPackagePath?.get(contribution.definition.path) ??
        contribution.manifest;
      const expectedBuild = isRecord(contribution.manifest.scripts)
        ? contribution.manifest.scripts.build
        : undefined;
      const actualBuild = isRecord(manifest.scripts)
        ? manifest.scripts.build
        : undefined;
      if (typeof expectedBuild !== "string" || actualBuild !== expectedBuild) {
        throw new Error(
          `Deployment Check requires exact ${packageName} manifest script build`,
        );
      }
    }
  }
  const persistedEnvironmentNeeds = normalizeEnvironmentNeeds({
    check: foundationCheckEnvironmentNeeds(
      contributions,
      deploymentCheck,
      vueHonoJointE2e,
    ),
    deployment: deploymentCheck?.environmentNeeds ?? [],
  });
  const environmentNeeds = persistedEnvironmentNeeds.check;
  const deploymentEnvironmentNeeds = persistedEnvironmentNeeds.deployment;
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
    declarations: [
      ...ciDiagnosticArtifactDeclarations,
      ...(vueHonoJointE2e === undefined
        ? []
        : [
            {
              kind: "playwright" as const,
              owner: { kind: "workspace-orchestration" as const, path: "." },
            },
          ]),
    ],
  });
  const contributedToolLayers = contributions.flatMap(
    (contribution) =>
      contribution.foundation.developmentContainerToolLayers ?? [],
  );
  const developmentContainer = contributedDevcontainerComposition({
    context: options.context,
    rootNodeDeclaration: options.rootNodeDeclaration,
    layers: [
      ...contributedToolLayers,
      ...(contributions.some((contribution) =>
        contribution.environmentNeeds.some(
          (need) => need.kind === "playwright-browser-assets",
        ),
      ) &&
      !contributedToolLayers.some((layer) => layer.identity === "browser-test")
        ? [browserTestDevelopmentContainerToolLayer()]
        : []),
      ...deploymentCheckDevelopmentContainerToolLayers(deploymentCheck),
    ],
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
  const editorCustomization = builtInEditorCustomization(
    contributions.flatMap(
      (contribution) => contribution.foundation.editorCapabilities,
    ),
  );
  const dependencyMaintenancePolicy = composeDependencyMaintenancePolicy(
    contributions,
    deploymentCheck,
  );
  const rootOwnedE2e = vueHonoJointE2e !== undefined;
  const rootAutomationPaths = rootOwnedE2e ? "scripts test" : "scripts";
  const scriptInsertions: WorkspaceRootInsertion[] = [
    ...(rustToolchain === undefined
      ? []
      : [
          {
            before: "boundaries",
            values: { "toolchain:prepare": "cargo --version" },
          },
        ]),
    ...(databasePreparation === undefined
      ? []
      : [
          {
            before: "fix",
            values: databasePreparationCommands(databasePreparation),
          },
        ]),
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            before: "fix",
            values: {
              "publication:readiness":
                "node --conditions=source scripts/npm-publication/check-readiness.ts",
              "publication:artifact":
                "node --conditions=source scripts/npm-publication/check-artifact.ts",
            },
          },
        ]),
    ...(deploymentCheck === undefined
      ? []
      : [
          {
            before: "fix",
            values: {
              deployment:
                "node --conditions=source scripts/check-standalone-deployment.ts",
            },
          },
        ]),
    ...(rootOwnedE2e
      ? [{ before: "fix", values: { "test:e2e": "playwright test" } }]
      : []),
  ];
  const dependencyInsertions: WorkspaceRootInsertion[] = [
    ...(rootOwnedE2e
      ? [
          {
            before:
              publicationCandidate === undefined ? "oxfmt" : "@types/semver",
            values: { "@playwright/test": "catalog:" },
          },
        ]
      : []),
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            before: "oxfmt",
            values: {
              "@types/semver": "catalog:",
              "@types/spdx-expression-parse": "catalog:",
            },
          },
          {
            before: "turbo",
            values: {
              semver: "catalog:",
              "spdx-expression-parse": "catalog:",
              npm: "catalog:",
              tar: "catalog:",
            },
          },
        ]),
  ];
  const rootManifest = createWorkspaceRootManifest({
    name: options.context.repositoryName,
    typescriptConfigurationPackageName: configDefinition.name,
    nodeDeclaration: options.rootNodeDeclaration,
    packageManagerPin: options.context.toolchain.packageManagerPin,
    ...(publicationCandidate === undefined
      ? {}
      : {
          imports: {
            "#npm-publication/*": "./scripts/npm-publication/*.ts",
          },
        }),
    scriptOverrides: {
      "format:check": `oxfmt --list-different --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer ${rootAutomationPaths}`,
      "format:write": `oxfmt --write --no-error-on-unmatched-pattern *.json pnpm-workspace.yaml pnpm-lock.yaml *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer ${rootAutomationPaths}`,
      lint:
        deploymentCheck === undefined
          ? `oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths}`
          : `shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths}`,
      "lint:fix": `oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths} --fix`,
    },
    scriptInsertions,
    dependencyInsertions,
  });
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
  const workflowOperations: RenderOperation[] = [
    {
      kind: "writeText",
      to: ".github/workflows/check.yml",
      text: projectCheckWorkflow({
        packagePaths: blueprintPackagePaths,
        deploymentCheck,
        diagnosticArtifacts: ciDiagnosticArtifacts,
      }),
    },
    {
      kind: "writeText",
      to: ".github/dependabot.yml",
      text: projectDependabotConfig(dependencyMaintenancePolicy),
    },
    ...(publicationCandidate === undefined
      ? []
      : [
          copyWorkspaceResource(
            "publication/release.yml",
            ".github/workflows/release.yml",
          ),
        ]),
  ];
  const projectLinkPlan = initialProjectLinkPlan;
  const turboBoundaryTags = turboBoundaryTagsForContributions(contributions);
  const reconciliation: readonly ProjectProjectionReconciliation[] = [
    { path: "tsconfig.json", driver: "structured" },
    { path: "turbo.json", driver: "structured" },
    {
      path: ".devcontainer/devcontainer.json",
      driver: "structured",
      identitySets: [developmentContainer.mountIdentitySet],
      // M1：根 engines.node 原文拥有的静态镜像槽位；Core 只见位置，不见文件语义。
      // 设计写作 /build.args/NODE_VERSION；RFC 6901 下点号不是分隔符，取同位置的标准形。
      mirrorSlots: [
        {
          id: "node-version-build-arg",
          location: {
            kind: "json-pointer",
            pointer: "/build/args/NODE_VERSION",
          },
        } satisfies ProjectProjectionMirrorSlot,
        // M5：仅当本 plan 选用 Rust 时接入同一机制，值由根 rust-toolchain.toml channel 拥有。
        // 声明只给位置、不含版本值，故已含 Rust 的目标在加包时 Before/After 清单逐字节相同，
        // reconciliationPoliciesCompatible 不因 M5 扩展把合法加包变成策略不兼容。
        ...(rustToolchain === undefined
          ? []
          : [
              {
                id: "rust-toolchain-build-arg",
                location: {
                  kind: "json-pointer",
                  pointer: "/build/args/RUST_TOOLCHAIN",
                },
              } satisfies ProjectProjectionMirrorSlot,
            ]),
      ],
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
  // 票 26 清单单源：生成检查器携带的槽位清单是上面声明的投影，不是第二份真源。
  const toolchainMirrorOperation =
    projectToolchainMirrorManifest(reconciliation);
  const referenceNames = new Map(
    contributions.flatMap((contribution) =>
      contribution.referenceSource === undefined
        ? []
        : [
            [
              contribution.referenceSource,
              contribution.definition.name,
            ] as const,
          ],
    ),
  );
  const rootProjection = projectPreparedWorkspaceRoot({
    rootManifest,
    packageGlobs: workspacePackageGlobs,
    dependencyCatalog,
    dependencyOverrides,
    turboTemplate: readWorkspaceJson("assets/turbo.json"),
    referenceNames,
    turboBoundaryTags,
    rootTsconfigTemplate: readWorkspaceJson("assets/tsconfig.json"),
    rootTsconfigCompilerOptions: {
      ...(requiresPackingHook ? { allowJs: true, checkJs: true } : {}),
      rewriteRelativeImportExtensions: false,
      allowImportingTsExtensions: true,
    },
    rootTsconfigInclude: [
      "*.config.ts",
      "scripts/**/*.ts",
      ...(vueHonoJointE2e === undefined ? [] : ["test/**/*.ts"]),
      ...(requiresPackingHook ? [".pnpmfile.mjs"] : []),
    ],
    tsconfigConfigTemplate: readWorkspaceJson("assets/tsconfig.config.json"),
  });
  const initializationFoundationOperations: RenderOperation[] = [
    rootProjection.manifest,
    rootProjection.workspace,
    ...(requiresPackingHook
      ? [copyWorkspaceResource("assets/.pnpmfile.mjs", ".pnpmfile.mjs")]
      : []),
    copyWorkspaceResource("assets/gitignore", ".gitignore"),
    copyWorkspaceResource("assets/agent-instructions.md", "AGENTS.md"),
    rootProjection.turbo,
    copyWorkspaceResource(
      "scripts/check-toolchain-versions.ts",
      "scripts/check-toolchain-versions.ts",
    ),
    toolchainMirrorOperation,
    copyWorkspaceResource("scripts/task-gates.ts", "scripts/task-gates.ts"),
    copyWorkspaceResource(
      "scripts/run-turbo-boundaries.ts",
      "scripts/run-turbo-boundaries.ts",
    ),
    rootProjection.tsconfig,
    rootProjection.tsconfigConfig,
    {
      kind: "writeText",
      to: "oxlint.config.ts",
      text: `export { default } from ${JSON.stringify(configDefinition.name + "/oxlint")};\n`,
    },
    {
      kind: "writeText",
      to: "oxfmt.config.ts",
      text: `export { default } from ${JSON.stringify(configDefinition.name + "/oxfmt")};\n`,
    },
    ...(vueHonoJointE2e === undefined
      ? []
      : [
          copyWorkspaceResource(
            "joint-e2e/playwright.config.ts",
            "playwright.config.ts",
          ),
          {
            kind: "writeJson" as const,
            to: "joint-e2e.json",
            value: {
              apiPackageName: vueHonoJointE2e.apiPackageName,
              webPackageName: vueHonoJointE2e.webPackageName,
            },
          },
          ...copyWorkspaceDirectory("joint-e2e/test", "test"),
        ]),
    ...(publicationCandidate === undefined
      ? []
      : [
          ...copyWorkspaceDirectory(
            "publication",
            "scripts/npm-publication",
          ).filter(
            (operation) =>
              ![
                "release.yml",
                "RELEASING.md",
                "publication.config.json",
                "cli-command-identity.ts",
              ].includes(path.posix.basename(operation.to)),
          ),
          ...copyWorkspaceDirectory(
            "publication-setup",
            "scripts/npm-publication-setup",
          ),
          copyWorkspaceResource("publication/RELEASING.md", "RELEASING.md"),
          {
            kind: "writeJson" as const,
            to: "scripts/npm-publication/publication.config.json",
            value: { packagePath: publicationCandidate.definition.path },
          },
          {
            kind: "copyFile" as const,
            source: publicationIdentitySource(),
            from: ".",
            to: "scripts/npm-publication/cli-command-identity.ts",
          },
          {
            kind: "setExecutable" as const,
            path: "scripts/npm-publication-setup/setup.sh",
            executable: true,
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
    ...(rustToolchain === undefined
      ? []
      : [
          {
            kind: "writeText" as const,
            to: "rust-toolchain.toml",
            text: projectTomlStringValues(
              readFileSync(
                resolveTemplateSource(
                  rustToolchain.configurationSource.source,
                  rustToolchain.configurationSource.from,
                ),
                "utf8",
              ),
              [
                {
                  path: ["toolchain", "channel"],
                  value: rustToolchain.toolchain,
                },
              ],
            ),
          },
        ]),
    ...(deploymentCheck === undefined || deploymentPackages === undefined
      ? []
      : [
          ...(
            [
              [deploymentCheck.sources.dockerfile, "Dockerfile"],
              [deploymentCheck.sources.dockerIgnore, ".dockerignore"],
              [
                deploymentCheck.sources.checker,
                "scripts/check-standalone-deployment.ts",
              ],
              [
                deploymentCheck.sources.controlScript,
                "scripts/container-entrypoint.sh",
              ],
            ] as const
          ).map(([asset, to]) => ({ kind: "copyFile" as const, ...asset, to })),
          {
            kind: "writeJson" as const,
            to: "deployment.json",
            value: {
              application: {
                name: deploymentPackages.application.definition.name,
                path: deploymentPackages.application.definition.path,
              },
              database: {
                name: deploymentPackages.database.definition.name,
                path: deploymentPackages.database.definition.path,
              },
              migrations: {
                name: deploymentPackages.migration.definition.name,
                path: deploymentPackages.migration.definition.path,
              },
            },
          },
          {
            kind: "setExecutable" as const,
            path: "scripts/container-entrypoint.sh",
            executable: true,
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
                multilineArrays: ["files"],
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
    deploymentCheck:
      deploymentCheck === undefined
        ? undefined
        : {
            kind: deploymentCheck.kind,
            applicationPackageName: deploymentCheck.applicationPackageName,
            databasePackageName: deploymentCheck.databasePackageName,
            migrationPackageName: deploymentCheck.migrationPackageName,
            environmentNeeds: deploymentCheck.environmentNeeds,
          },
    vueHonoJointE2e:
      vueHonoJointE2e === undefined
        ? undefined
        : {
            kind: vueHonoJointE2e.kind,
            apiPackageName: vueHonoJointE2e.apiPackageName,
          },
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
  readonly presetBlueprint: ReturnType<
    typeof assertDefaultProjectBlueprintDraft
  >;
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

/** A user-correctable initialization fact, ordered by the owning Foundation. */
export type InitializationInputIssue = {
  readonly code:
    | "PRESET_UNKNOWN"
    | "FIXED_TOPOLOGY_OVERRIDE"
    | "INVALID_PACKAGE_NAME"
    | "INVALID_PACKAGE_PATH"
    | "RESERVED_PACKAGE_PATH"
    | "INVALID_PACKAGE_SCOPE"
    | "INVALID_REPOSITORY_SCOPE"
    | "CONFLICTING_PACKAGE_IDENTITY";
};

export type InitializationPreparation =
  | {
      readonly status: "input-invalid";
      readonly issues: readonly InitializationInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly phase: "preset" | "planning" | "preflight";
    }
  | {
      readonly status: "ready";
      readonly context: BuiltInGenerationContext;
      readonly resolvedPackageIdentity?: ResolvedPrimaryPackageIdentity;
      readonly resolved: ResolvedInitialization;
      readonly plan: GeneratedRepositoryPlan;
      readonly publicationSetup: PublicationSetupHandoff;
    };

export type InitializationInputValidation =
  | {
      readonly status: "input-invalid";
      readonly issues: readonly InitializationInputIssue[];
    }
  | { readonly status: "valid" };

type CollectedInitializationInput =
  | {
      readonly status: "input-invalid";
      readonly issues: readonly InitializationInputIssue[];
    }
  | {
      readonly status: "valid";
      readonly definition: BuiltInPresetDefinition;
      readonly normalizedScope: string | undefined;
      readonly nameOverride: string | undefined;
      readonly pathOverride: string | undefined;
      readonly repositoryName: string;
      readonly configurablePrimaryPackage: boolean;
      readonly validScopeOverride: boolean;
      readonly validRepositoryScope: boolean;
      readonly resolvedScope: string;
      readonly initialPrimaryPackage:
        | BuiltInPresetDefinition["initialPrimaryPackage"]
        | undefined;
      readonly foundationDefinition: PackageDefinition;
    };

type InitializationInputOptions = {
  readonly definition?: BuiltInPresetDefinition;
  readonly preset?: string;
  readonly targetDir: string;
  readonly overrides?: InitializationIdentityOverrides;
};

function deduplicateInitializationInputIssues(
  issues: readonly InitializationInputIssue[],
): readonly InitializationInputIssue[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex((candidate) => candidate.code === issue.code) === index,
  );
}

function collectInitializationInput(
  options: InitializationInputOptions,
): CollectedInitializationInput {
  const issues: InitializationInputIssue[] = [];
  const definition =
    options.definition ??
    (options.preset === undefined
      ? undefined
      : builtInPresetRegistry
          .all()
          .find((candidate) => candidate.metadata.name === options.preset));
  if (definition === undefined) {
    return {
      status: "input-invalid",
      issues: [{ code: "PRESET_UNKNOWN" }],
    };
  }
  const scopeOverride = options.overrides?.scope;
  const normalizedScope =
    scopeOverride?.startsWith("@") === true
      ? scopeOverride.slice(1)
      : scopeOverride;
  const nameOverride = options.overrides?.name;
  const pathOverride = options.overrides?.path;
  const repositoryName = path.basename(path.resolve(options.targetDir));
  const configurablePrimaryPackage =
    definition.initialPrimaryPackage !== undefined;
  if (
    !configurablePrimaryPackage &&
    (nameOverride !== undefined || pathOverride !== undefined)
  ) {
    issues.push({ code: "FIXED_TOPOLOGY_OVERRIDE" });
  }
  let validNameOverride =
    nameOverride !== undefined &&
    isValidDefaultNpmPackageName(`@x/${nameOverride}`);
  if (nameOverride !== undefined && !validNameOverride) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }
  if (pathOverride !== undefined) {
    const pathValidation = validateDefaultPackagePath(pathOverride);
    if (!pathValidation.hasValidShape) {
      issues.push({ code: "INVALID_PACKAGE_PATH" });
    }
    if (pathValidation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_PACKAGE_PATH" });
    }
  }
  let validScopeOverride =
    normalizedScope !== undefined &&
    scopeOverride === scopeOverride?.trim() &&
    isValidDefaultPackageScope(normalizedScope) &&
    isValidDefaultNpmPackageName(`@${normalizedScope}/typescript-config`);
  if (normalizedScope !== undefined && !validScopeOverride) {
    issues.push({ code: "INVALID_PACKAGE_SCOPE" });
  }
  let validRepositoryScope =
    isValidDefaultPackageScope(repositoryName) &&
    isValidDefaultNpmPackageName(`@${repositoryName}/typescript-config`);
  if (normalizedScope === undefined && !validRepositoryScope) {
    issues.push({ code: "INVALID_REPOSITORY_SCOPE" });
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
        ? definition.initialPrimaryPackage?.defaultLeafName
        : undefined;
  if (
    resolvedLeaf !== undefined &&
    !isValidDefaultNpmPackageName(`@${resolvedScope}/${resolvedLeaf}`)
  ) {
    if (nameOverride !== undefined) {
      validNameOverride = false;
      issues.push({ code: "INVALID_PACKAGE_NAME" });
    } else if (scopeOverride !== undefined) {
      validScopeOverride = false;
      issues.push({ code: "INVALID_PACKAGE_SCOPE" });
    } else {
      validRepositoryScope = false;
      issues.push({ code: "INVALID_REPOSITORY_SCOPE" });
    }
  }

  const initialPrimaryPackage = definition.initialPrimaryPackage;
  const foundationDefinition = typescriptConfigPackageDefinition({
    foundationPackages: {
      typescriptConfiguration: {
        name: `@${resolvedScope}/typescript-config`,
      },
    },
  });
  if (
    (nameOverride !== undefined &&
      `@${resolvedScope}/${nameOverride}` === foundationDefinition.name) ||
    pathOverride === foundationDefinition.path
  ) {
    issues.push({ code: "CONFLICTING_PACKAGE_IDENTITY" });
  }

  if (issues.length > 0) {
    return {
      status: "input-invalid",
      issues: deduplicateInitializationInputIssues(issues),
    };
  }
  return {
    status: "valid",
    definition,
    normalizedScope,
    nameOverride,
    pathOverride,
    repositoryName,
    configurablePrimaryPackage,
    validScopeOverride,
    validRepositoryScope,
    resolvedScope,
    initialPrimaryPackage,
    foundationDefinition,
  };
}

export function validateGeneratedRepositoryInitializationInput(
  options: InitializationInputOptions,
): InitializationInputValidation {
  const input = collectInitializationInput(options);
  return input.status === "input-invalid" ? input : { status: "valid" };
}

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
      presetBlueprint = assertDefaultProjectBlueprintDraft(
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
    presetBlueprint = assertDefaultProjectBlueprintDraft({
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

function referencePlanningFacts(
  contribution: PlannedPackageContribution,
  blueprint: ProjectBlueprint,
): Pick<
  GeneratedPackagePlanningRecord,
  "referenceSource" | "dependencyBindings"
> {
  if (contribution.referenceSource === undefined) return {};
  return {
    referenceSource: contribution.referenceSource,
    dependencyBindings: Object.fromEntries(
      Object.entries(contribution.referenceBindings ?? {}).map(
        ([source, definition]) => [
          source,
          requirePersistedPackageDefinition(blueprint, definition)
            .packageDefinitionId,
        ],
      ),
    ),
  };
}

function planPreparedRepositoryInitialization(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly context: BuiltInGenerationContext;
  readonly presetBlueprint: ReturnType<
    typeof assertDefaultProjectBlueprintDraft
  >;
  readonly contributions: readonly PlannedPackageContribution[];
  readonly rootNodeDeclaration: string;
}): GeneratedRepositoryPlan {
  const configDefinition = typescriptConfigPackageDefinition(options.context);
  const configSeed = typescriptConfigReplayAdapter.identify(
    typescriptConfigContribution(options.context, configDefinition),
  );
  const allContributions = composeReferenceContributions({
    context: options.context,
    requested: [...options.contributions, configSeed],
  });
  const foundationContribution = allContributions.find(
    (item) => item.definition.path === configDefinition.path,
  )!;
  const contributions = allContributions.filter(
    (item) => item !== foundationContribution,
  );
  const occupiedIds = new Set<PackageDefinitionId>();
  const provenance = (contribution: PlannedPackageContribution) => {
    const isFoundation = contribution === foundationContribution;
    const isRequested = options.contributions.some(
      (item) => item.definition.path === contribution.definition.path,
    );
    return {
      definitionName: isFoundation
        ? "foundation"
        : isRequested
          ? options.definition.metadata.name
          : "reference",
      planningContribution: isFoundation
        ? ("foundationPlan" as const)
        : ("planInitialization" as const),
      contributionIdentity: contribution.planningIdentity,
    };
  };
  const blueprint: ProjectBlueprint = {
    ...options.presetBlueprint,
    packages: allContributions.map((contribution) =>
      persistPackageDefinition({
        definition: contribution.definition,
        provenance: provenance(contribution),
        occupiedIds,
      }),
    ),
  };
  const generationRecord: GenerationRecord = {
    schemaVersion: 2,
    repositoryName: options.context.repositoryName,
    defaultPackageScope: options.context.defaultPackageScope,
    preset: options.definition.metadata.name,
    templateVersion: "0.0.0",
    toolchain: {
      nodeLtsMajor: options.context.toolchain.nodeLtsMajor,
      packageManagerPin: options.context.toolchain.packageManagerPin,
    },
    packages: allContributions.map((contribution) => ({
      ...provenance(contribution),
      packageDefinitionId: requirePersistedPackageDefinition(
        blueprint,
        contribution.definition,
      ).packageDefinitionId,
      path: contribution.definition.path,
      ...referencePlanningFacts(contribution, blueprint),
    })),
  };
  return foundationPlan({
    definition: options.definition,
    context: options.context,
    blueprint,
    foundationContribution,
    contributions,
    generationRecord,
    mode: "initialization",
    rootNodeDeclaration: options.rootNodeDeclaration,
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

/** 精确 Node 事实必须是有三段补丁号的版本，不接受纯大版本或两段形式。 */
const exactNodeVersionPattern = /^\d+\.\d+\.\d+$/u;

/**
 * 私有根的 Node 声明：上下文带已知精确值时沿用该精确值，并校验其大版本与 nodeLtsMajor 一致；
 * 缺省时沿用原有大版本声明。这条缺省路径不作为新生成公开包范围的推导来源。
 */
function resolvePrivateRootNodeDeclaration(
  toolchain: BuiltInGenerationContext["toolchain"],
): string {
  const { nodeLtsMajor, nodeVersion } = toolchain;
  if (nodeVersion === undefined) return nodeLtsMajor;
  if (!exactNodeVersionPattern.test(nodeVersion)) {
    throw new Error(
      `Generation Context 的 toolchain.nodeVersion 必须是精确三段 Node 版本（"24.16.0"），实际收到 ${JSON.stringify(nodeVersion)}。`,
    );
  }
  if (nodeVersion.slice(0, nodeVersion.indexOf(".")) !== nodeLtsMajor) {
    throw new Error(
      `Generation Context 的 toolchain.nodeVersion ${nodeVersion} 与 nodeLtsMajor ${nodeLtsMajor} 大版本不一致。`,
    );
  }
  return nodeVersion;
}

/**
 * 直接规划接缝：调用方自带 Generation Context，私有根沿用其 Node 声明；上下文带精确事实时
 * 私有根得到精确版本。生产初始化由 prepareGeneratedRepositoryInitialization 投影 CLI 发版快照。
 */
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
      rootNodeDeclaration: resolvePrivateRootNodeDeclaration(
        options.context.toolchain,
      ),
    }),
  );
}

/**
 * 初始化只消费随 CLI 发版的不可变工具链快照：私有根得到精确 Node 与 pnpm pin，
 * 选用 Rust 的仓库根 toolchain 声明得到快照的精确 Rust 版本，Generation Record 与容器等
 * 消费者继续得到派生的大版本。不读在线版本源，也不接受调用方版本。
 */
const initializationSnapshotToolchain: BuiltInGenerationContext["toolchain"] = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
  rustVersion: releaseToolchainSnapshot.rustVersion,
};

export function prepareGeneratedRepositoryInitialization(options: {
  /** Direct Definitions are retained for Preset-local behavior tests. */
  readonly definition?: BuiltInPresetDefinition;
  /** CLI callers select a Preset through the owning Built-in Presets Module. */
  readonly preset?: string;
  readonly targetDir: string;
  readonly overrides?: InitializationIdentityOverrides;
}): InitializationPreparation {
  const input = collectInitializationInput(options);
  if (input.status === "input-invalid") return input;
  const {
    definition,
    normalizedScope,
    nameOverride,
    pathOverride,
    repositoryName,
    configurablePrimaryPackage,
    validScopeOverride,
    validRepositoryScope,
    resolvedScope,
    initialPrimaryPackage,
    foundationDefinition,
  } = input;

  let derivedPackagePath: string | undefined;
  if (initialPrimaryPackage !== undefined) {
    try {
      derivedPackagePath = initialPrimaryPackage.defaultPackagePath({
        packageLeafName: nameOverride ?? initialPrimaryPackage.defaultLeafName,
      });
    } catch {
      return { status: "operation-failure", phase: "preset" };
    }
    const derivedPathValidation =
      validateDefaultPackagePath(derivedPackagePath);
    if (
      !derivedPathValidation.hasValidShape ||
      derivedPathValidation.reservedWorkspaceCollection !== undefined
    ) {
      return { status: "operation-failure", phase: "preset" };
    }
    if (
      (nameOverride === undefined &&
        `@${resolvedScope}/${initialPrimaryPackage.defaultLeafName}` ===
          foundationDefinition.name) ||
      (pathOverride === undefined &&
        derivedPackagePath === foundationDefinition.path)
    ) {
      return { status: "operation-failure", phase: "preset" };
    }
  }

  const context = createGenerationContext({
    targetDir: options.targetDir,
    defaultPackageScope: validScopeOverride
      ? (normalizedScope ?? "repository")
      : validRepositoryScope
        ? repositoryName
        : "repository",
    toolchain: initializationSnapshotToolchain,
  });
  const safeIdentityOverrides: Pick<
    InitializationIdentityOverrides,
    "name" | "path"
  > = {
    ...(configurablePrimaryPackage && nameOverride !== undefined
      ? { name: nameOverride }
      : {}),
    ...(configurablePrimaryPackage && pathOverride !== undefined
      ? { path: pathOverride }
      : derivedPackagePath === undefined
        ? {}
        : { path: derivedPackagePath }),
  };
  let prepared: PreparedPresetInitialization;
  try {
    prepared = preparePresetInitialization({
      definition,
      context,
      ...(Object.keys(safeIdentityOverrides).length === 0
        ? {}
        : { overrides: safeIdentityOverrides }),
    });
  } catch {
    return { status: "operation-failure", phase: "preset" };
  }
  let plan: GeneratedRepositoryPlan;
  try {
    plan = planPreparedRepositoryInitialization({
      definition,
      context,
      presetBlueprint: prepared.presetBlueprint,
      contributions: prepared.contributions,
      // 私有根与上下文共用同一精确 Node 事实的推导点，避免根声明与上下文出现两个来源。
      rootNodeDeclaration: resolvePrivateRootNodeDeclaration(context.toolchain),
    });
    if (
      validateProjectProjectionPlan({
        operations: plan.operations,
        reconciliation: plan.reconciliation,
      }).length > 0
    ) {
      return { status: "operation-failure", phase: "preflight" };
    }
  } catch {
    return { status: "operation-failure", phase: "planning" };
  }
  return {
    status: "ready",
    context,
    resolved: {
      preset: definition.metadata.name,
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
    publicationSetup:
      publicCliCandidate(prepared.contributions) === undefined
        ? null
        : { command: "./scripts/npm-publication-setup/setup.sh" },
  };
}

function planGeneratedRepositoryPackageAdditionFromPreparedContribution(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly localTemplateMetadata: LocalTemplateMetadata;
  readonly packageLeafName: string;
  readonly packagePath: string;
  readonly contribution: PlannedPackageContribution;
  /** Existing consumers that explicitly import the newly added provider. */
  readonly linkFrom?: readonly string[];
  /**
   * 首次引入 Rust 时目标已有的合法根声明正文。存在时 Before/After 都以该原字节表达根所有权：
   * 正文保留即两侧条目相同，根文件不进入 delta 集合，任何路径都不会改写它；M5 仍由根 channel 派生。
   */
  readonly existingRootRustDeclaration?: string;
}): GeneratedRepositoryPackageAdditionPlan {
  const { blueprint: persistedBlueprint, context } =
    options.localTemplateMetadata;
  const { rootNodeDeclaration } =
    options.localTemplateMetadata[localTemplateMetadataStateKey];
  assertDefaultProjectBlueprint(persistedBlueprint);
  const contribution = options.contribution;
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
    const recorded = options.localTemplateMetadata[
      localTemplateMetadataStateKey
    ].generationRecord.packages.find(
      (item) =>
        item.packageDefinitionId === conflictingPackage.packageDefinitionId,
    );
    const isExactPackageDefinition =
      packageDefinitionsEqual(conflictingPackage, contribution.definition) &&
      recorded?.definitionName === options.definition.metadata.name &&
      recorded.contributionIdentity === contribution.planningIdentity &&
      recorded.referenceSource === contribution.referenceSource;
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
        manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
        generationRecord: existing.generationRecord,
        mode: "addition",
        rootNodeDeclaration,
      });
      const currentProjection = foundationPlan({
        definition: options.definition,
        context,
        blueprint: persistedBlueprint,
        foundationContribution: existing.foundationContribution,
        contributions: existing.contributions,
        generationRecord: existing.generationRecord,
        mode: "initialization",
        rootNodeDeclaration,
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
      throw new PackageAdditionBusinessConflict(
        "missing-link",
        conflictingPackage,
        contribution.definition,
        missingPackageLinkIntent,
      );
    }
    throw new PackageAdditionBusinessConflict(
      "identity",
      conflictingPackage,
      contribution.definition,
    );
  }
  const contributionIdentity = requireReplayAdapter({
    owner: options.definition.metadata.name,
    adapters: options.definition.packageContributionReplayAdapters,
    identity: contribution.planningIdentity,
  }).identity;
  const existing = readExistingPackageAdditionState({
    localTemplateMetadata: options.localTemplateMetadata,
    requiredManifestTruthPackagePaths: requestedPackageLinkIntents.flatMap(
      (intent) => [intent.consumerPackagePath],
    ),
  });
  const additions = composeReferenceContributions({
    context,
    requested: [contribution],
    existing: [existing.foundationContribution, ...existing.contributions],
  });
  const occupiedIds = new Set(
    persistedBlueprint.packages.map(
      (definition) => definition.packageDefinitionId,
    ),
  );
  const provenance = (item: PlannedPackageContribution) => ({
    definitionName:
      item.definition.path === contribution.definition.path
        ? options.definition.metadata.name
        : "reference",
    planningContribution: "planPackageAddition" as const,
    contributionIdentity:
      item.definition.path === contribution.definition.path
        ? contributionIdentity
        : item.planningIdentity,
  });
  const addedDefinitions = additions.map((item) =>
    persistPackageDefinition({
      definition: item.definition,
      provenance: provenance(item),
      occupiedIds,
    }),
  );
  const blueprint: ProjectBlueprint = {
    ...persistedBlueprint,
    packages: [...persistedBlueprint.packages, ...addedDefinitions],
    ...(requestedPackageLinkIntents.length > 0
      ? {
          packageLinkIntents: [
            ...(persistedBlueprint.packageLinkIntents ?? []),
            ...requestedPackageLinkIntents,
          ],
        }
      : {}),
  };
  assertDefaultProjectBlueprint(blueprint);
  for (const item of additions) {
    for (const provider of Object.values(item.referenceBindings ?? {})) {
      if (
        !persistedBlueprint.packages.some(
          (definition) => definition.path === provider.path,
        )
      )
        continue;
      const baseline = [
        existing.foundationContribution,
        ...existing.contributions,
      ].find((candidate) => candidate.definition.path === provider.path)!;
      const actual = existing.manifestTruthByPackagePath.get(provider.path);
      if (actual === undefined)
        throw new ReferenceCompositionFailure(
          `共同包 ${provider.path} 缺少有效 manifest，不能复用。`,
        );
      assertReusablePackageExposure({
        repositoryRoot: context.targetDir,
        packagePath: provider.path,
        expectedExports: baseline.exposure.exports,
        actualManifest: actual,
      });
    }
  }
  const generationRecord: GenerationRecord = {
    ...existing.generationRecord,
    packages: [
      ...existing.generationRecord.packages,
      ...additions.map((item) => ({
        ...provenance(item),
        packageDefinitionId: requirePersistedPackageDefinition(
          blueprint,
          item.definition,
        ).packageDefinitionId,
        path: item.definition.path,
        ...referencePlanningFacts(item, blueprint),
      })),
    ],
  };
  const beforeProjection = foundationPlan({
    definition: options.definition,
    context,
    blueprint: persistedBlueprint,
    foundationContribution: existing.foundationContribution,
    contributions: existing.contributions,
    generationRecord: existing.generationRecord,
    mode: "initialization",
    rootNodeDeclaration,
  });
  const afterProjection = foundationPlan({
    definition: options.definition,
    context,
    blueprint,
    foundationContribution: existing.foundationContribution,
    contributions: [...existing.contributions, ...additions],
    manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
    generationRecord,
    mode: "initialization",
    rootNodeDeclaration,
  });
  const plan = foundationPlan({
    definition: options.definition,
    context,
    blueprint,
    foundationContribution: existing.foundationContribution,
    contributions: [...existing.contributions, ...additions],
    renderContributions: additions,
    manifestTruthByPackagePath: existing.manifestTruthByPackagePath,
    generationRecord,
    mode: "addition",
    rootNodeDeclaration,
  });
  let beforeOperations = beforeProjection.operations;
  let afterOperations = afterProjection.operations;
  if (options.existingRootRustDeclaration !== undefined) {
    const preserveOperation: RenderOperation = {
      kind: "writeText",
      to: rootRustDeclarationFileName,
      text: options.existingRootRustDeclaration,
    };
    beforeOperations = [...beforeProjection.operations, preserveOperation];
    afterOperations = afterProjection.operations.map((operation) =>
      "to" in operation && operation.to === rootRustDeclarationFileName
        ? preserveOperation
        : operation,
    );
  }
  return {
    ...plan,
    projectProjections: {
      before: {
        operations: beforeOperations,
        reconciliation: beforeProjection.reconciliation,
      },
      after: {
        operations: afterOperations,
        reconciliation: afterProjection.reconciliation,
      },
      preconditions: additions.map((item) => ({
        path: item.definition.path,
        kind: "must-not-exist" as const,
        reason: `Package Path ${item.definition.path} already exists and cannot be used for a new Package Addition`,
      })),
    },
  };
}

export function planGeneratedRepositoryPackageAddition(options: {
  readonly definition: BuiltInPresetDefinition;
  readonly localTemplateMetadata: LocalTemplateMetadata;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
}): GeneratedRepositoryPackageAdditionPlan {
  const { context } = options.localTemplateMetadata;
  if (options.definition.planPackageAddition === undefined) {
    throw new Error(
      `Built-in Preset ${options.definition.metadata.name} does not support Package Addition`,
    );
  }
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
  return planGeneratedRepositoryPackageAdditionFromPreparedContribution({
    ...options,
    packagePath,
    contribution,
  });
}

function collectPackageAdditionInput(options: {
  readonly preset: string;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
}):
  | {
      readonly status: "input-invalid";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly status: "valid";
      readonly definition: BuiltInPresetDefinition;
      readonly linkFrom: readonly string[];
    } {
  const issues: PackageAdditionInputIssue[] = [];
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.metadata.name === options.preset);
  if (definition === undefined) issues.push({ code: "PRESET_UNKNOWN" });
  else if (definition.planPackageAddition === undefined)
    issues.push({ code: "PRESET_NOT_ADDABLE" });
  if (!isValidDefaultNpmPackageName(`@x/${options.packageLeafName}`)) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }
  if (options.packagePath !== undefined) {
    const validation = validateDefaultPackagePath(options.packagePath);
    if (!validation.hasValidShape)
      issues.push({ code: "INVALID_PACKAGE_PATH" });
    if (validation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_PACKAGE_PATH" });
    }
  }
  const linkFrom = [...new Set(options.linkFrom ?? [])];
  for (const consumerPackagePath of linkFrom) {
    const validation = validateDefaultPackagePath(consumerPackagePath);
    if (!validation.hasValidShape) {
      issues.push({ code: "INVALID_LINK_FROM" });
    }
    if (validation.reservedWorkspaceCollection !== undefined)
      issues.push({ code: "RESERVED_LINK_FROM" });
  }
  if (issues.length > 0 || definition === undefined) {
    return { status: "input-invalid", issues };
  }
  return { status: "valid", definition, linkFrom };
}

/** 在读取仓库元数据前校验新增包调用参数，供 CLI 输入契约复用。 */
export function validateGeneratedRepositoryPackageAdditionInput(
  options: Parameters<typeof collectPackageAdditionInput>[0],
):
  | { readonly status: "valid" }
  | {
      readonly status: "input-invalid";
      readonly issues: readonly PackageAdditionInputIssue[];
    } {
  const result = collectPackageAdditionInput(options);
  return result.status === "input-invalid" ? result : { status: "valid" };
}

/**
 * Command-owned preparation: user input is checked before local metadata or any
 * Preset default/planner work; all remaining failures are deliberately bounded.
 */
export function prepareGeneratedRepositoryPackageAddition(options: {
  readonly repositoryRoot: string;
  readonly preset: string;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
}): PackageAdditionPreparation {
  const input = collectPackageAdditionInput(options);
  if (input.status === "input-invalid") return input;
  let localTemplateMetadata: LocalTemplateMetadata;
  try {
    localTemplateMetadata = loadLocalTemplateMetadata(options.repositoryRoot);
  } catch (error) {
    if (
      error instanceof PackageAdditionTargetDeclarationFailure ||
      error instanceof WorkspacePackageAdditionFailure ||
      error instanceof ReferenceCompositionFailure
    ) {
      return {
        status: "operation-failure",
        phase: "metadata",
        diagnostic: { message: error.message, suggestion: error.suggestion },
      };
    }
    return { status: "operation-failure", phase: "metadata" };
  }
  if (
    input.linkFrom.some(
      (consumerPackagePath) =>
        !localTemplateMetadata.blueprint.packages.some(
          (candidate) => candidate.path === consumerPackagePath,
        ),
    )
  ) {
    return {
      status: "input-invalid",
      issues: [{ code: "UNKNOWN_LINK_FROM" }],
    };
  }
  let packagePath = options.packagePath;
  if (packagePath === undefined) {
    try {
      packagePath = input.definition.defaultPackagePath?.({
        context: localTemplateMetadata.context,
        packageLeafName: options.packageLeafName,
      });
    } catch {
      return { status: "operation-failure", phase: "default" };
    }
    const defaultPathValidation =
      packagePath === undefined
        ? undefined
        : validateDefaultPackagePath(packagePath);
    if (
      defaultPathValidation === undefined ||
      !defaultPathValidation.hasValidShape ||
      defaultPathValidation.reservedWorkspaceCollection !== undefined
    ) {
      return { status: "operation-failure", phase: "default" };
    }
  }
  if (packagePath === undefined) {
    return { status: "operation-failure", phase: "default" };
  }
  let provider: PlannedPackageContribution;
  try {
    provider = input.definition.planPackageAddition!({
      context: localTemplateMetadata.context,
      packageLeafName: options.packageLeafName,
      packagePath,
    });
  } catch {
    return { status: "operation-failure", phase: "planning" };
  }
  // 首次引入 Rust 的加包按目标事实二选一：已有合法根声明由该声明拥有版本并原正文保留；
  // 没有根声明才以当前 CLI 已验证快照建源。已有 Rust 能力的仓库在 loadLocalTemplateMetadata
  // 已由根 channel 重放（缺真源在那里失败），不进入这条路径；不可解释的声明在此可行动失败，
  // 不用快照掩盖。非 Rust 加包不读无关根文件。
  let additionMetadata = localTemplateMetadata;
  let preservedRootRustDeclaration: string | undefined;
  if (
    provider.foundation.toolchains.rust !== undefined &&
    localTemplateMetadata.context.toolchain.rustVersion === undefined
  ) {
    const repositoryRoot = localTemplateMetadata.context.targetDir;
    const rootDeclarationPath = path.join(
      repositoryRoot,
      rootRustDeclarationFileName,
    );
    const existingDeclaration = existsSync(rootDeclarationPath)
      ? readFileSync(rootDeclarationPath, "utf8")
      : undefined;
    let rustVersion: string;
    try {
      if (existingDeclaration === undefined) {
        rustVersion = releaseToolchainSnapshot.rustVersion;
      } else {
        rustVersion = readPackageAdditionTargetRustChannel(repositoryRoot);
        preservedRootRustDeclaration = existingDeclaration;
      }
    } catch (error) {
      if (
        error instanceof PackageAdditionTargetDeclarationFailure ||
        error instanceof WorkspacePackageAdditionFailure ||
        error instanceof ReferenceCompositionFailure
      ) {
        return {
          status: "operation-failure",
          phase: "metadata",
          diagnostic: { message: error.message, suggestion: error.suggestion },
        };
      }
      return { status: "operation-failure", phase: "metadata" };
    }
    additionMetadata = {
      ...localTemplateMetadata,
      context: {
        ...localTemplateMetadata.context,
        toolchain: {
          ...localTemplateMetadata.context.toolchain,
          rustVersion,
        },
      },
    };
    try {
      provider = input.definition.planPackageAddition!({
        context: additionMetadata.context,
        packageLeafName: options.packageLeafName,
        packagePath,
      });
    } catch {
      return { status: "operation-failure", phase: "planning" };
    }
  }
  const contributionsByPath = new Map(
    localTemplateMetadata[
      localTemplateMetadataStateKey
    ].packageContributions.map((contribution) => [
      contribution.definition.path,
      contribution,
    ]),
  );
  if (
    input.linkFrom.length > 0 &&
    (!canProvideSourceConditionPackageNameImport(provider) ||
      input.linkFrom.some((consumerPackagePath) => {
        const consumer = contributionsByPath.get(consumerPackagePath);
        return (
          consumer === undefined ||
          !canConsumeNodePackageNameImport(consumer) ||
          !canLinkNodePackageRoles(
            consumer.definition.role,
            provider.definition.role,
          )
        );
      }))
  ) {
    return { status: "input-invalid", issues: [{ code: "UNSUPPORTED_LINK" }] };
  }
  try {
    return {
      status: "ready",
      definition: input.definition,
      plan: planGeneratedRepositoryPackageAdditionFromPreparedContribution({
        definition: input.definition,
        localTemplateMetadata: additionMetadata,
        packageLeafName: options.packageLeafName,
        packagePath,
        contribution: provider,
        ...(input.linkFrom.length === 0 ? {} : { linkFrom: input.linkFrom }),
        ...(preservedRootRustDeclaration === undefined
          ? {}
          : { existingRootRustDeclaration: preservedRootRustDeclaration }),
      }),
    };
  } catch (error) {
    if (error instanceof PackageAdditionBusinessConflict) {
      return { status: "conflict", conflict: error };
    }
    if (
      error instanceof ReferenceCompositionFailure ||
      error instanceof WorkspacePackageAdditionFailure
    ) {
      return {
        status: "operation-failure",
        phase: "planning",
        diagnostic: { message: error.message, suggestion: error.suggestion },
      };
    }
    return { status: "operation-failure", phase: "planning" };
  }
}
