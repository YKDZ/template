import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { composeCiDiagnosticArtifacts } from "@ykdz/template-core/ci-diagnostic-artifact";
import type { CiDiagnosticArtifactDeclaration } from "@ykdz/template-core/ci-diagnostic-artifact";
import {
  collectGeneratedManifestCatalogReferences,
  selectTemplateDependencyCatalogEntries,
} from "@ykdz/template-core/dependency-catalog";
import {
  planDevelopmentContainerToolLayersSync,
  type DevelopmentContainerToolLayer,
  type DevelopmentContainerToolLayerBuildArgument,
  type DevelopmentContainerToolLayerMount,
  type DevelopmentContainerToolLayerProbe,
  type PlannedDevelopmentContainerToolLayer,
} from "@ykdz/template-core/development-container-tool-layer";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
} from "@ykdz/template-core/editor-customization";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
  EnvironmentNeedsMetadata,
} from "@ykdz/template-core/module-graph";
import {
  normalizeEnvironmentNeeds,
  parseEnvironmentNeedsMetadata,
  playwrightBrowserAssetsEnvironmentNeed,
  renderDeploymentCheckCommand,
  renderFixCommand,
  renderRootCheckCommand,
  renderTurboRunCommand,
  shellCheckEnvironmentNeed,
} from "@ykdz/template-core/module-graph";
import {
  assertPackageContribution,
  assertPackageContributionCommandNames,
  type FoundationContribution,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  BuiltInPresetDefinition,
  GenerationContext,
  InitialPackageDefinitionLookup,
  PackageContributionReplayAdapter,
  PlannedPackageContribution,
  ResolvedPrimaryPackageIdentity,
} from "@ykdz/template-core/preset-definition";
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
} from "@ykdz/template-core/project-blueprint";
import type { DependencyMaintenancePolicy } from "@ykdz/template-core/project-github";
import {
  projectCheckWorkflowTemplateSource,
  projectCheckWorkflowTemplateReplacements,
  projectDependabotTemplateReplacements,
} from "@ykdz/template-core/project-github";
import {
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
  planExplicitProjectLinks,
} from "@ykdz/template-core/project-linking-v2";
import type {
  MaterializeProjectProjectionOptions,
  ProjectProjectionMirrorSlot,
  ProjectProjectionPathPrecondition,
  ProjectProjectionReconciliation,
  StructuredIdentitySetPolicy,
} from "@ykdz/template-core/project-projection";
import { validateProjectProjectionPlan } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";

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
} from "@ykdz/template-core/project-blueprint";
export type { PackageContribution } from "@ykdz/template-core/package-contribution";

export type BuiltInGenerationContext = GenerationContext;
export type { BuiltInPresetDefinition } from "@ykdz/template-core/preset-definition";

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
      /** 仅目标根 Node/pnpm 声明错误携带的字段级诊断；其他操作失败保持通用提示。 */
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

/**
 * Package Addition 的目标根 package.json 允许两种 Node 声明：旧仓库的纯大版本
 * （"24"）与精确版本（"24.16.0"），两者都能派生大版本；范围表达式与两段版本拒绝。
 */
const nodeMajorOrExactVersionPattern = /^(\d+)(?:\.(\d+)\.(\d+))?$/u;

/** 与 npm packageManager 字段一致的精确 pnpm pin（可带预发布或构建元数据）。 */
const exactPnpmPinPattern = /^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

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

/**
 * Package Addition 的版本上下文来自目标仓库根 package.json 的当前声明，因此升级过
 * Node 或 pnpm 的仓库会继续按自身版本加包；Generation Record 的 toolchain 只保留为
 * 初始化历史。
 */
function readPackageAdditionVersionFacts(repositoryRoot: string): {
  readonly toolchain: BuiltInGenerationContext["toolchain"];
  readonly rootNodeDeclaration: string;
} {
  const manifest = readRepositoryJsonRecord({
    repositoryRoot,
    relativePath: "package.json",
    label: "root Manifest",
  });
  const nodeDeclaration = isRecord(manifest.engines)
    ? manifest.engines.node
    : undefined;
  const nodeDeclarationMatch =
    typeof nodeDeclaration === "string"
      ? nodeMajorOrExactVersionPattern.exec(nodeDeclaration)
      : undefined;
  const nodeLtsMajor = nodeDeclarationMatch?.[1];
  if (nodeLtsMajor === undefined || typeof nodeDeclaration !== "string") {
    throw new PackageAdditionTargetDeclarationFailure(
      "package.json",
      "engines.node",
      '声明单个 Node 大版本（"24"）或精确 Node 版本（"24.16.0"）',
      JSON.stringify(nodeDeclaration ?? null),
      "请先修改根 package.json 的 engines.node 声明再加包。",
    );
  }
  const packageManagerDeclaration = manifest.packageManager;
  if (
    typeof packageManagerDeclaration !== "string" ||
    !exactPnpmPinPattern.test(packageManagerDeclaration)
  ) {
    throw new PackageAdditionTargetDeclarationFailure(
      "package.json",
      "packageManager",
      '声明精确 pnpm 版本（"pnpm@11.21.0"）',
      JSON.stringify(packageManagerDeclaration ?? null),
      "请先修改根 package.json 的 packageManager 声明再加包。",
    );
  }
  // 根只声明大版本时没有诚实的精确 patch 可传，保持缺省而不伪造。
  return {
    toolchain: {
      nodeLtsMajor,
      packageManagerPin: packageManagerDeclaration,
      ...(nodeDeclarationMatch?.[2] === undefined
        ? {}
        : { nodeVersion: nodeDeclaration }),
    },
    rootNodeDeclaration: nodeDeclaration,
  };
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
          // 根 Node 声明原文是 M1 槽位唯一来源；major 与快照字段不得另作真源。
          value: options.rootNodeDeclaration,
        },
      ],
      probes: [
        { identity: "procps", command: "ps", args: ["--version"] },
        { identity: "bubblewrap", command: "bwrap", args: ["--version"] },
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
          NODE_VERSION: options.rootNodeDeclaration,
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
    probes: [
      ...layerPlan.probes,
      {
        identity: "docker-daemon",
        command: "docker",
        args: ["version"],
        failureMessage:
          "无法连接宿主 Docker；请检查宿主 daemon 是否运行，以及开发容器 Feature 的连接配置与权限。",
      },
      {
        identity: "docker-buildx",
        command: "docker",
        args: ["buildx", "version"],
        failureMessage:
          "Buildx 不可用；请重建开发容器以完成官方 Feature 安装。",
      },
      {
        identity: "docker-compose",
        command: "docker",
        args: ["compose", "version"],
        failureMessage:
          "Compose 不可用；请重建开发容器以完成官方 Feature 安装。",
      },
    ],
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
}>;

type TurboTaskTruthByName = Readonly<Record<string, TurboTaskTruth>>;

function databasePreparationTurboTasks(
  preparation: NormalizedDatabasePreparation,
): TurboTaskTruthByName {
  return {
    "//#database:prepare:dev": { cache: false },
    "//#database:prepare:test": { cache: false },
    "//#database:prepare:e2e": { cache: false },
    [`${preparation.databasePackageName}#test`]: {
      dependsOn: ["//#database:prepare:test"],
    },
    [`${preparation.migrationPackageName}#typecheck`]: {
      dependsOn: [`${preparation.databasePackageName}#build`],
    },
    [`${preparation.consumers["application-dev"]}#typecheck`]: {
      dependsOn: [`${preparation.databasePackageName}#build`],
    },
    [`${preparation.consumers["application-dev"]}#dev`]: {
      dependsOn: [`${preparation.databasePackageName}#build`],
      cache: false,
      persistent: true,
    },
    [`${preparation.consumers["application-e2e"]}#test:e2e`]: {
      dependsOn: [
        "//#database:prepare:e2e",
        `${preparation.databasePackageName}#build`,
        "build",
      ],
      cache: false,
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
    },
  };
}

function vueHonoJointE2eTurboTasks(e2e: VueHonoJointE2e): TurboTaskTruthByName {
  return {
    "//#test:e2e": {
      dependsOn: [`${e2e.apiPackageName}#build`, `${e2e.webPackageName}#build`],
      cache: false,
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
          "check:deployment": renderDeploymentCheckCommand(),
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

function effectiveCapabilityTaskDependencies(options: {
  readonly localTask: unknown;
  readonly inheritedTask: unknown;
  readonly label: string;
  readonly taskName: string;
}): unknown {
  if (options.localTask === undefined) {
    if (!isRecord(options.inheritedTask)) {
      throw new Error(
        `${options.label} requires Turbo task ${options.taskName}`,
      );
    }
    return options.inheritedTask.dependsOn;
  }
  if (!isRecord(options.localTask)) {
    throw new Error(`${options.label} requires Turbo task ${options.taskName}`);
  }
  const extendsValue = options.localTask.extends;
  if (extendsValue !== undefined && typeof extendsValue !== "boolean") {
    throw new Error(
      `${options.label} requires Turbo task ${options.taskName} extends truth`,
    );
  }
  if (extendsValue === false || options.localTask.dependsOn !== undefined) {
    return options.localTask.dependsOn;
  }
  if (!isRecord(options.inheritedTask)) {
    throw new Error(`${options.label} requires Turbo task ${options.taskName}`);
  }
  return options.inheritedTask.dependsOn;
}

function assertCapabilityConsumerTurboTruth(options: {
  readonly repositoryRoot: string;
  readonly rootTurbo: Readonly<Record<string, unknown>>;
  readonly expectedTasks: TurboTaskTruthByName;
  readonly buildConsumerPackageNames: readonly string[];
  readonly databasePackageName: string;
  readonly packageByName: ReadonlyMap<string, PackageContribution>;
}): void {
  const turboByPackagePath = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const [qualifiedTaskName, expectedTask] of Object.entries(
    options.expectedTasks,
  )) {
    if (expectedTask.dependsOn === undefined) continue;
    const separator = qualifiedTaskName.lastIndexOf("#");
    if (separator <= 0) continue;
    const packageName = qualifiedTaskName.slice(0, separator);
    const taskName = qualifiedTaskName.slice(separator + 1);
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
    const localDependencies = effectiveCapabilityTaskDependencies({
      localTask,
      inheritedTask: expectedTask,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
      taskName,
    });
    if (
      !Array.isArray(localDependencies) ||
      expectedTask.dependsOn.some(
        (expectedDependency) => !localDependencies.includes(expectedDependency),
      )
    ) {
      throw new Error(
        `Package Addition ${contribution.definition.name} Turbo Truth requires Turbo task ${taskName} dependsOn`,
      );
    }
  }

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
    const qualifiedBuild = isRecord(options.rootTurbo.tasks)
      ? options.rootTurbo.tasks[`${packageName}#build`]
      : undefined;
    const genericBuild = isRecord(options.rootTurbo.tasks)
      ? options.rootTurbo.tasks.build
      : undefined;
    const dependencies = effectiveCapabilityTaskDependencies({
      localTask: localBuild,
      inheritedTask:
        qualifiedBuild === undefined ? genericBuild : qualifiedBuild,
      label: `Package Addition ${contribution.definition.name} Turbo Truth`,
      taskName: "build",
    });
    if (
      !Array.isArray(dependencies) ||
      !dependencies.some(
        (dependency) =>
          dependency === "^build" ||
          dependency === `${options.databasePackageName}#build`,
      )
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
        : databasePreparationTurboTasks(options.databasePreparation)),
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
    rootTurbo,
    expectedTasks: databasePreparationTurboTasks(options.databasePreparation),
    buildConsumerPackageNames: [
      options.databasePreparation.migrationPackageName,
      ...new Set(Object.values(options.databasePreparation.consumers)),
    ],
    databasePackageName: options.databasePreparation.databasePackageName,
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
  const externalPackageNames =
    external !== undefined && ts.isArrayLiteralExpression(external)
      ? external.elements.flatMap((element) =>
          ts.isStringLiteralLike(element) ? [element.text] : [],
        )
      : external !== undefined && ts.isStringLiteralLike(external)
        ? [external.text]
        : [];
  if (!externalPackageNames.includes(expectedPackageName)) {
    throw new Error(
      `Package Addition requires ${configPath} to externalize ${expectedPackageName} through Vite SSR`,
    );
  }
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
      portEnvironment: "PORT",
      portVariable: "apiPort",
      portInput: "PLAYWRIGHT_API_PORT",
      stdout:
        "/Hono API listening on (?<VITE_API_BASE_URL>http:\\/\\/localhost:\\d+)/",
    },
    {
      command: `pnpm --filter ${options.e2e.webPackageName} --fail-if-no-match run preview --host 127.0.0.1 --strictPort`,
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
    if (
      command === undefined ||
      !ts.isStringLiteralLike(command) ||
      command.text !== expected.command
    ) {
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
  return [
    {
      identity: "shellcheck",
      dockerfile: deploymentCheck.sources.shellCheckDockerfile,
      requires: ["node-pnpm"],
      probes: [
        {
          identity: "shellcheck",
          command: "shellcheck",
          args: ["--version"],
        },
      ],
    },
  ];
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
    "pnpm run boundaries",
    renderTurboRunCommand(["format:check", "lint", "typecheck", "test"], [], {
      continueAfterFailure: true,
      taskPrefix: true,
    }),
    renderTurboRunCommand(
      ["build", "test:e2e"],
      [`--filter=!./${candidatePackagePath}`],
      { continueAfterFailure: true, taskPrefix: true },
    ),
    "pnpm run publication:artifact",
  ].join(" && ");
}

/**
 * 票 26 清单单源：把 plan 声明的镜像槽位集合投影成生成检查器携带的清单文本。
 * 转义 `$` 是必要的：清单文本注入模板字面量，未转义的 `$` 会被当成 TypeScript 插值。
 */
function renderToolchainMirrorSlotManifest(
  reconciliation: readonly ProjectProjectionReconciliation[],
): string {
  const slots = reconciliation.flatMap((policy) =>
    policy.driver === "canonical"
      ? []
      : (policy.mirrorSlots ?? []).map((slot) => ({
          id: slot.id,
          path: policy.path,
          location: slot.location,
        })),
  );

  return JSON.stringify(slots, null, 2).replaceAll("$", String.raw`\$`);
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
  readonly generationRecord?: GenerationRecord;
  readonly mode: "initialization" | "addition";
  /**
   * 生成仓库私有根 package.json 的 engines.node 声明：初始化投影 CLI 发版快照的精确
   * Node 版本，加包按目标仓库现行声明原样回写。
   */
  readonly rootNodeDeclaration: string;
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
    // 显式只投影 v2 的两个历史字段，上下文里的精确 Node 事实不得进入持久记录。
    toolchain: {
      nodeLtsMajor: options.context.toolchain.nodeLtsMajor,
      packageManagerPin: options.context.toolchain.packageManagerPin,
    },
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
  const dependencyMaintenancePolicy = composeDependencyMaintenancePolicy(
    contributions,
    deploymentCheck,
  );
  const rootOwnedE2e = vueHonoJointE2e !== undefined;
  const rootAutomationPaths = rootOwnedE2e ? "scripts test" : "scripts";
  const rootManifest = {
    name: options.context.repositoryName,
    private: true,
    type: "module",
    ...(publicationCandidate === undefined
      ? {}
      : {
          imports: {
            "#npm-publication/*": "./scripts/npm-publication/*.ts",
          },
        }),
    scripts: {
      check:
        publicationCandidate === undefined
          ? renderRootCheckCommand()
          : renderPublicationRootCheckCommand(
              publicationCandidate.definition.path,
            ),
      // Cargo 会在首次代理调用时按根 rust-toolchain.toml 安装版本与组件；先经唯一根任务完成解析，再并行运行各 Rust 包的 Cargo 检查。
      ...(rustToolchain === undefined
        ? {}
        : { "toolchain:prepare": "cargo --version" }),
      boundaries:
        "turbo boundaries --no-color && node --conditions=source scripts/check-toolchain-versions.ts",
      ...(databasePreparation === undefined
        ? {}
        : databasePreparationCommands(databasePreparation)),
      ...(publicationCandidate === undefined
        ? {}
        : {
            "publication:readiness":
              "node --conditions=source scripts/npm-publication/check-readiness.ts",
            "publication:artifact":
              "node --conditions=source scripts/npm-publication/check-artifact.ts",
          }),
      ...(deploymentCheck === undefined
        ? {}
        : {
            deployment:
              "node --conditions=source scripts/check-standalone-deployment.ts",
            "check:deployment": renderDeploymentCheckCommand(),
          }),
      ...(rootOwnedE2e ? { "test:e2e": "playwright test" } : {}),
      fix: renderFixCommand(),
      "format:check": `oxfmt --list-different --no-error-on-unmatched-pattern package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json tsconfig.config.json *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer ${rootAutomationPaths}`,
      "format:write": `oxfmt --write --no-error-on-unmatched-pattern package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json tsconfig.config.json *.config.ts .pnpmfile.mjs .gitignore .dockerignore Dockerfile TODO.md rust-toolchain.toml .vscode .github .devcontainer ${rootAutomationPaths}`,
      lint:
        deploymentCheck === undefined
          ? `oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths}`
          : `shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths}`,
      "lint:fix": `oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths} --fix`,
      typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
    },
    devDependencies: {
      "@types/node": "catalog:",
      ...(rootOwnedE2e ? { "@playwright/test": "catalog:" } : {}),
      ...(publicationCandidate === undefined
        ? {}
        : {
            "@types/semver": "catalog:",
            "@types/spdx-expression-parse": "catalog:",
          }),
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      "smol-toml": "catalog:",
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
    engines: { node: options.rootNodeDeclaration },
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
    deploymentCheck,
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
    ...(publicationCandidate === undefined
      ? []
      : [
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication/release.yml",
            to: ".github/workflows/release.yml",
          },
        ]),
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
    ...(deploymentCheck === undefined || deploymentPackages === undefined
      ? []
      : [
          {
            path: "Dockerfile",
            driver: "text" as const,
            // M2：同一 rootNodeDeclaration 投影的锚定 ARG 默认值。
            mirrorSlots: [
              {
                id: "node-version-deployment-arg",
                location: { kind: "text-anchor", name: "NODE_VERSION" },
              } satisfies ProjectProjectionMirrorSlot,
            ],
          },
        ]),
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
  const toolchainMirrorSlotManifest =
    renderToolchainMirrorSlotManifest(reconciliation);
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
      from: "AGENTS.md.template",
      to: "AGENTS.md",
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "turbo.json",
      to: "turbo.json",
    },
    ...(vueHonoJointE2e === undefined
      ? []
      : [
          {
            kind: "mergeJson" as const,
            to: "turbo.json",
            value: { tasks: vueHonoJointE2eTurboTasks(vueHonoJointE2e) },
            multilineArrays: ["tasks.//#test:e2e.dependsOn"],
          },
        ]),
    ...(deploymentCheck === undefined
      ? []
      : [
          {
            kind: "mergeJson" as const,
            to: "turbo.json",
            value: {
              tasks: deploymentTurboTasks(deploymentCheck),
            },
            multilineArrays: ["tasks.//#deployment.dependsOn"],
          },
        ]),
    ...(databasePreparation === undefined
      ? []
      : [
          {
            kind: "mergeJson" as const,
            to: "turbo.json",
            value: {
              tasks: databasePreparationTurboTasks(databasePreparation),
            },
            multilineArrays: [
              `tasks.${databasePreparation.migrationPackageName}#typecheck.dependsOn`,
              `tasks.${databasePreparation.consumers["application-dev"]}#typecheck.dependsOn`,
              `tasks.${databasePreparation.consumers["application-dev"]}#dev.dependsOn`,
              `tasks.${databasePreparation.consumers["application-e2e"]}#test:e2e.dependsOn`,
            ],
          },
        ]),
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
    ...turboBoundaryTags.map((tag): RenderOperation => ({
      kind: "mergeJsonTemplate",
      source: templateSources.foundation,
      from: `turbo-boundary-tags/${tag}.json`,
      to: "turbo.json",
      multilineArrays:
        deploymentCheck === undefined ? [] : ["tasks.//#deployment.dependsOn"],
    })),
    {
      kind: "writeTextTemplate",
      source: templateSources.foundation,
      from: "scripts/check-toolchain-versions.ts",
      to: "scripts/check-toolchain-versions.ts",
      replacements: {
        TOOLCHAIN_MIRROR_SLOT_MANIFEST: toolchainMirrorSlotManifest,
      },
    },
    {
      kind: "copyFile",
      source: templateSources.foundation,
      from: "tsconfig.json",
      to: "tsconfig.json",
    },
    ...(vueHonoJointE2e === undefined
      ? []
      : [
          {
            kind: "mergeJsonTemplate" as const,
            source: templateSources.vueHonoApp,
            from: "root/tsconfig.json",
            to: "tsconfig.json",
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.vueHonoApp,
            from: "root/playwright.config.ts",
            to: "playwright.config.ts",
            replacements: {
              API_PACKAGE_NAME: vueHonoJointE2e.apiPackageName,
              WEB_PACKAGE_NAME: vueHonoJointE2e.webPackageName,
            },
          },
          {
            kind: "copyFile" as const,
            source: templateSources.vueHonoApp,
            from: "root/test/e2e/fixtures.ts",
            to: "test/e2e/fixtures.ts",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.vueHonoApp,
            from: "root/test/e2e/app.spec.ts",
            to: "test/e2e/app.spec.ts",
          },
        ]),
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
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication/handoff.ts",
            to: "scripts/npm-publication/handoff.ts",
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
            from: "publication/publish.ts",
            to: "scripts/npm-publication/publish.ts",
            replacements: {
              PUBLIC_CLI_PACKAGE_PATH: publicationCandidate.definition.path,
            },
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.tsCli,
            from: "publication/release.ts",
            to: "scripts/npm-publication/release.ts",
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
            from: "publication/RELEASING.md",
            to: "RELEASING.md",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "src/cli-command-identity.ts",
            to: "scripts/npm-publication/cli-command-identity.ts",
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.tsCli,
            from: "publication-setup/setup.sh",
            to: "scripts/npm-publication-setup/setup.sh",
            replacements: {
              PUBLIC_CLI_PACKAGE_PATH: publicationCandidate.definition.path,
            },
          },
          {
            kind: "setExecutable" as const,
            path: "scripts/npm-publication-setup/setup.sh",
            executable: true,
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication-setup/README.md",
            to: "scripts/npm-publication-setup/README.md",
          },
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.tsCli,
            from: "publication-setup/bridge.ts",
            to: "scripts/npm-publication-setup/bridge.ts",
            replacements: {
              PUBLIC_CLI_PACKAGE_PATH: publicationCandidate.definition.path,
            },
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication-setup/assets/LICENSE-MIT.txt",
            to: "scripts/npm-publication-setup/assets/LICENSE-MIT.txt",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication-setup/assets/LICENSE-APACHE-2.0.txt",
            to: "scripts/npm-publication-setup/assets/LICENSE-APACHE-2.0.txt",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication-setup/assets/README.md.template",
            to: "scripts/npm-publication-setup/assets/README.md.template",
          },
          {
            kind: "copyFile" as const,
            source: templateSources.tsCli,
            from: "publication-setup/assets/CHANGELOG.md.template",
            to: "scripts/npm-publication-setup/assets/CHANGELOG.md.template",
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
            kind: "writeTextTemplate" as const,
            source: rustToolchain.configurationSource.source,
            from: rustToolchain.configurationSource.from,
            to: "rust-toolchain.toml",
            replacements: { RUST_TOOLCHAIN: rustToolchain.toolchain },
          },
        ]),
    ...(deploymentCheck === undefined || deploymentPackages === undefined
      ? []
      : [
          {
            kind: "writeTextTemplate" as const,
            source: deploymentCheck.sources.dockerfile.source,
            from: deploymentCheck.sources.dockerfile.from,
            to: "Dockerfile",
            replacements: {
              NODE_VERSION: options.rootNodeDeclaration,
              APPLICATION_PACKAGE_NAME:
                deploymentPackages.application.definition.name,
              APPLICATION_PACKAGE_PATH:
                deploymentPackages.application.definition.path,
              DATABASE_PACKAGE_NAME:
                deploymentPackages.database.definition.name,
              DATABASE_PACKAGE_PATH:
                deploymentPackages.database.definition.path,
              MIGRATION_PACKAGE_NAME:
                deploymentPackages.migration.definition.name,
              MIGRATION_PACKAGE_PATH:
                deploymentPackages.migration.definition.path,
              TYPESCRIPT_CONFIG_PACKAGE_PATH: configDefinition.path,
            },
          },
          {
            kind: "writeTextTemplate" as const,
            source: deploymentCheck.sources.dockerIgnore.source,
            from: deploymentCheck.sources.dockerIgnore.from,
            to: ".dockerignore",
            replacements: {
              APPLICATION_PACKAGE_PATH:
                deploymentPackages.application.definition.path,
              DATABASE_PACKAGE_PATH:
                deploymentPackages.database.definition.path,
            },
          },
          {
            kind: "writeTextTemplate" as const,
            source: deploymentCheck.sources.checker.source,
            from: deploymentCheck.sources.checker.from,
            to: "scripts/check-standalone-deployment.ts",
            replacements: {
              APPLICATION_PACKAGE_NAME:
                deploymentPackages.application.definition.name,
            },
          },
          {
            kind: "copyFile" as const,
            source: deploymentCheck.sources.controlScript.source,
            from: deploymentCheck.sources.controlScript.from,
            to: "scripts/container-entrypoint.sh",
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
    isValidNewNpmPackageName(`@x/${nameOverride}`);
  if (nameOverride !== undefined && !validNameOverride) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }
  if (pathOverride !== undefined) {
    const pathValidation = validateNewPackagePath(pathOverride);
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
    isValidNewNpmPackageName(`@${normalizedScope}/typescript-config`);
  if (normalizedScope !== undefined && !validScopeOverride) {
    issues.push({ code: "INVALID_PACKAGE_SCOPE" });
  }
  let validRepositoryScope =
    isValidDefaultPackageScope(repositoryName) &&
    isValidNewNpmPackageName(`@${repositoryName}/typescript-config`);
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
    !isValidNewNpmPackageName(`@${resolvedScope}/${resolvedLeaf}`)
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
  readonly rootNodeDeclaration: string;
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
    const derivedPathValidation = validateNewPackagePath(derivedPackagePath);
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
  assertProjectBlueprint(persistedBlueprint);
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
    generationRecord: existing.generationRecord,
    mode: "initialization",
    rootNodeDeclaration,
  });
  const afterProjection = foundationPlan({
    definition: options.definition,
    context,
    blueprint,
    foundationContribution: existing.foundationContribution,
    contributions: [...existing.contributions, contribution],
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
    contributions: [...existing.contributions, contribution],
    renderContributions: [contribution],
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
      operation.kind === "writeTextTemplate" &&
      "to" in operation &&
      operation.to === rootRustDeclarationFileName
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
  if (!isValidNewNpmPackageName(`@x/${options.packageLeafName}`)) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }
  if (options.packagePath !== undefined) {
    const validation = validateNewPackagePath(options.packagePath);
    if (!validation.hasValidShape)
      issues.push({ code: "INVALID_PACKAGE_PATH" });
    if (validation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_PACKAGE_PATH" });
    }
  }
  const linkFrom = [...new Set(options.linkFrom ?? [])];
  for (const consumerPackagePath of linkFrom) {
    const validation = validateNewPackagePath(consumerPackagePath);
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
    if (error instanceof PackageAdditionTargetDeclarationFailure) {
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
        : validateNewPackagePath(packagePath);
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
      if (error instanceof PackageAdditionTargetDeclarationFailure) {
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
    return { status: "operation-failure", phase: "planning" };
  }
}
