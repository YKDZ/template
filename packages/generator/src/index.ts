import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Composition } from "@ykdz/template-core/composition";
import type {
  CompositionPackage,
  CompositionPackageEvaluation,
} from "@ykdz/template-core/composition";
import {
  assertContentIdentity,
  contentIdentityKey,
  contentIdentityLabel,
  createContentIndex,
  type ContentIdentity,
  type ContentSelector,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import {
  assertGenerationRecordMatchesBlueprint,
  parseGenerationRecordStructure,
  type GenerationRecord,
  type GenerationRecordPackage,
  type GenerationRecordSelection,
} from "@ykdz/template-core/generation-record";
import {
  assertJsonValue,
  printCanonicalJson,
  type JsonValue,
} from "@ykdz/template-core/json";
import {
  projectPackageContributions,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  BlueprintPackageIdentityIssue,
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import {
  assertProjectBlueprint,
  ProjectBlueprintValidationError,
} from "@ykdz/template-core/project-blueprint";
import {
  commitProjectProjectionPlan,
  planProjectProjections,
  readProjectProjectionCurrent,
  type ProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionChangePlan,
  type ProjectProjectionConflict,
  type CurrentProjectProjectionEntry,
  type ProjectProjectionEntry,
  type ProjectProjectionPathPrecondition,
  type ProjectProjectionReconciliation,
  type ProjectProjectionSource,
} from "@ykdz/template-core/project-projection";
import type {
  PreparedReference,
  PackageBinding,
  ReferenceDependency,
  ReferencePackageDefinition,
  ReferenceSelectionRoot,
  SelectionDependencyBindingTarget,
  PresetSelectionDefinition,
  PresetSelectionRequest,
} from "@ykdz/template-core/reference-package";

import { resolveReferenceDependencyIdentity } from "./owner-local-reference.ts";

type CompositionDefinitionLike = Composition<
  JsonValue,
  unknown,
  unknown,
  unknown,
  unknown,
  JsonValue,
  unknown
>;

export type { GenerationRecord } from "@ykdz/template-core/generation-record";
export {
  generationRecordSchema,
  parseGenerationRecordStructure,
} from "@ykdz/template-core/generation-record";
export const generatorMetadataPaths = Object.freeze({
  blueprint: ".template/blueprint.json",
  generationRecord: ".template/generation.json",
} as const);
export type {
  ReferencePackage,
  ReferencePackageDefinition,
} from "@ykdz/template-core/reference-package";
export type { Composition } from "@ykdz/template-core/composition";
export { resolveReferenceDependencyIdentity } from "./owner-local-reference.ts";

type RuntimeReferenceDefinition = ReferencePackageDefinition<
  JsonValue,
  JsonValue,
  unknown,
  unknown,
  unknown,
  unknown
>;

type RuntimeReference = LoadedContentMember<
  RuntimeReferenceDefinition,
  "reference"
>;
type RuntimePreset = LoadedContentMember<PresetSelectionDefinition, "preset">;

type PackageNodeDraft<CreationInput extends JsonValue = JsonValue> = {
  readonly content: RuntimeReference;
  readonly definition: PackageDefinition;
  readonly creationInput: CreationInput | undefined;
  readonly layout: unknown;
  readonly nodeIdentity: string;
  readonly restored?: {
    readonly packageDefinitionId: PackageDefinitionId;
    readonly createdBy: "initialization" | "addition" | "shared-dependency";
  };
  readonly explicitRoot?: {
    readonly selectionId: string;
    readonly nodeIdentity: string;
    readonly createdBy: "initialization" | "addition";
  };
  dependencies: {
    readonly key: string;
    readonly package: PackageNodeDraft<CreationInput>;
  }[];
};

type PreparedNode<CreationInput extends JsonValue = JsonValue> = {
  readonly content: RuntimeReference;
  readonly preparation: PreparedReference<unknown>;
  readonly definition: PackageDefinition;
  readonly creationInput: CreationInput | undefined;
  readonly layout: unknown;
  readonly nodeIdentity: string;
  readonly restored?: {
    readonly packageDefinitionId: PackageDefinitionId;
    readonly createdBy: "initialization" | "addition" | "shared-dependency";
  };
  readonly explicitRoot?: {
    readonly selectionId: string;
    readonly nodeIdentity: string;
    readonly createdBy: "initialization" | "addition";
  };
  readonly dependencies: readonly {
    readonly key: string;
    readonly package: PreparedNode<CreationInput>;
  }[];
};

type PreparedSelection<CreationInput extends JsonValue = JsonValue> = {
  readonly presetIdentity: ContentIdentity | null;
  readonly selectionId?: string;
  readonly recordedNodeIds?: Readonly<Record<string, PackageDefinitionId>>;
  readonly createdBy?: "initialization" | "addition";
  readonly roots: readonly PreparedNode<CreationInput>[];
};

type PackageSelectionDraft<CreationInput extends JsonValue = JsonValue> = {
  readonly presetIdentity: ContentIdentity | null;
  readonly selectionId?: string;
  readonly recordedNodeIds?: Readonly<Record<string, PackageDefinitionId>>;
  readonly createdBy?: "initialization" | "addition";
  readonly roots: readonly PackageNodeDraft<CreationInput>[];
};

type RestoredProject = {
  readonly blueprint: ProjectBlueprint;
  readonly generationRecord: GenerationRecord;
  readonly normalizedDependencies?: readonly GeneratorDependencyIdentity[];
};

export type GeneratorDependencyIdentity = {
  readonly consumerContentIdentity: ContentIdentity;
  readonly key: string;
  readonly contentIdentity: ContentIdentity;
};

type DependencyIdentityCache = Map<string, GeneratorDependencyIdentity>;

export type GeneratorRestoredProject<
  CreationInput extends JsonValue = JsonValue,
> = RestoredProject & {
  readonly targetRoot: string;
  readonly packages: readonly CompositionPackage<CreationInput>[];
  readonly selections: readonly GenerationRecordSelection[];
  readonly readFacts: readonly CurrentProjectProjectionEntry[];
  readonly normalizedDependencies: readonly GeneratorDependencyIdentity[];
};

export type PreparedProject<
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  CompositionDefinition extends CompositionDefinitionLike =
    CompositionDefinitionLike,
  OperationFacts = null,
> = {
  readonly conventions: Conventions;
  readonly composition: CompositionDefinition;
  readonly selections: readonly PreparedSelection<CreationInput>[];
  readonly operationFacts: OperationFacts;
  readonly restored?: RestoredProject;
};

export type ComputedPackage<ContributionFacts = unknown> = {
  readonly package: CompositionPackage;
  readonly bindings: ReadonlyMap<string, unknown>;
  readonly contribution: PackageContribution<ContributionFacts>;
};

export type ComputedProject<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  ContributionFacts = unknown,
> = {
  readonly blueprint: ProjectBlueprint;
  readonly generationRecord: GenerationRecord<Conventions, CreationInput>;
  readonly projection: ProjectProjection;
  readonly packages: readonly ComputedPackage<ContributionFacts>[];
  readonly ownerFacts: OwnerFacts;
};

export type GeneratorSelection<CreationInput extends JsonValue = JsonValue> = {
  readonly roots?: readonly ReferenceSelectionRoot<CreationInput>[];
  readonly presets?: readonly PresetSelectionRequest<CreationInput>[];
};

type CompositionOperationFacts<Definition> =
  Definition extends Composition<
    JsonValue,
    unknown,
    unknown,
    unknown,
    unknown,
    JsonValue,
    infer OperationFacts
  >
    ? OperationFacts
    : undefined;

type OperationFactsInput<OperationFacts> = {
  readonly operationFacts: OperationFacts;
};

export type GeneratorInitializationOptions<
  CreationInput extends JsonValue = JsonValue,
  OperationFacts = null,
> = {
  readonly targetRoot: string;
  readonly selection: GeneratorSelection<CreationInput>;
  readonly conventions: unknown;
} & OperationFactsInput<OperationFacts>;

export type GeneratorResult<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
> =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GenerationRecord<Conventions, CreationInput>;
      readonly projection: ProjectProjection;
      readonly ownerFacts: OwnerFacts;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly reason: string;
      readonly conflicts: readonly ProjectProjectionConflict[];
      readonly actions: readonly [];
    }
  | {
      readonly status: "operation-failure";
      readonly phase:
        | "metadata"
        | "preparation"
        | "calculation"
        | "planning"
        | "commit";
      readonly error: {
        readonly message: string;
        readonly packageIdentityIssues?: readonly BlueprintPackageIdentityIssue[];
      };
    };

export type GeneratorPlanningResult<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
> =
  | {
      readonly status: "planned";
      readonly plan: ProjectProjectionChangePlan;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GenerationRecord<Conventions, CreationInput>;
      readonly projection: ProjectProjection;
      readonly ownerFacts: OwnerFacts;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly status: "conflict";
      readonly reason: string;
      readonly conflicts: readonly ProjectProjectionConflict[];
      readonly actions: readonly [];
    }
  | {
      readonly status: "operation-failure";
      readonly phase:
        | "metadata"
        | "preparation"
        | "calculation"
        | "planning"
        | "commit";
      readonly error: {
        readonly message: string;
        readonly packageIdentityIssues?: readonly BlueprintPackageIdentityIssue[];
      };
    };

export type GeneratorAdditionOptions<
  CreationInput extends JsonValue = JsonValue,
  OperationFacts = null,
> = GeneratorAdditionSelection<CreationInput> & {
  readonly repositoryRoot: string;
  readonly operationFacts: OperationFacts;
  /** 外围在准备时实际读取的只读目标事实。 */
  readonly readFacts?: readonly CurrentProjectProjectionEntry[];
};

export type GeneratorAdditionSelection<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly creationInput?: CreationInput;
} & (
  | {
      readonly contentIdentity: ContentSelector;
      readonly nodeIdentity?: string;
      readonly layout?: unknown;
      readonly dependencyBindings?: Readonly<
        Record<string, SelectionDependencyBindingTarget>
      >;
    }
  | { readonly preset: ContentSelector }
);

export type GeneratorAdditionPreparation<
  Conventions extends JsonValue,
  CreationInput extends JsonValue,
  CompositionDefinition extends CompositionDefinitionLike,
  OperationFacts,
> = {
  readonly restored: GeneratorRestoredProject<CreationInput>;
  readonly before: PreparedProject<
    Conventions,
    CreationInput,
    CompositionDefinition,
    OperationFacts
  >;
  readonly after: PreparedProject<
    Conventions,
    CreationInput,
    CompositionDefinition,
    OperationFacts
  >;
  readonly readFacts: readonly CurrentProjectProjectionEntry[];
};

export type Generator<
  OwnerFacts = unknown,
  Conventions extends JsonValue = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  ContributionFacts = unknown,
  CompositionDefinition extends CompositionDefinitionLike =
    CompositionDefinitionLike,
> = {
  init(
    options: GeneratorInitializationOptions<
      CreationInput,
      CompositionOperationFacts<CompositionDefinition>
    > & {
      readonly dryRun?: boolean;
    },
  ): Promise<GeneratorResult<OwnerFacts, Conventions, CreationInput>>;
  planInit(
    options: GeneratorInitializationOptions<
      CreationInput,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): Promise<GeneratorPlanningResult<OwnerFacts, Conventions, CreationInput>>;
  add(
    options: GeneratorAdditionOptions<
      CreationInput,
      CompositionOperationFacts<CompositionDefinition>
    > & { readonly dryRun?: boolean },
  ): Promise<GeneratorResult<OwnerFacts, Conventions, CreationInput>>;
  planAdd(
    options: GeneratorAdditionOptions<
      CreationInput,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): Promise<GeneratorPlanningResult<OwnerFacts, Conventions, CreationInput>>;
  planComputedAdd(options: {
    readonly preparation: GeneratorAdditionPreparation<
      Conventions,
      CreationInput,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >;
    readonly before: ComputedProject<
      OwnerFacts,
      Conventions,
      CreationInput,
      ContributionFacts
    >;
    readonly after: ComputedProject<
      OwnerFacts,
      Conventions,
      CreationInput,
      ContributionFacts
    >;
    /** 外围在准备项目时实际读取的额外只读事实。 */
    readonly readFacts?: readonly CurrentProjectProjectionEntry[];
  }): Promise<GeneratorPlanningResult<OwnerFacts, Conventions, CreationInput>>;
  restoreProject(options: {
    readonly repositoryRoot: string;
  }): Promise<GeneratorRestoredProject<CreationInput>>;
  prepareAddProject(options: {
    readonly restored: GeneratorRestoredProject<CreationInput>;
    readonly selection: GeneratorAdditionSelection<CreationInput>;
    readonly operationFacts: CompositionOperationFacts<CompositionDefinition>;
  }): Promise<
    GeneratorAdditionPreparation<
      Conventions,
      CreationInput,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >
  >;
  commitPlan(
    plan: ProjectProjectionChangePlan,
  ): Promise<GeneratorResult<OwnerFacts, Conventions, CreationInput>>;
  prepareProject(
    options: {
      readonly selection: GeneratorSelection<CreationInput>;
      readonly conventions: unknown;
    } & OperationFactsInput<CompositionOperationFacts<CompositionDefinition>>,
  ): Promise<
    PreparedProject<
      Conventions,
      CreationInput,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >
  >;
  computeProject(
    prepared: PreparedProject<
      Conventions,
      CreationInput,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): ComputedProject<OwnerFacts, Conventions, CreationInput, ContributionFacts>;
};

type PackageNode = {
  readonly id: PackageDefinitionId;
  readonly content: RuntimeReference;
  readonly definition: PersistedPackageDefinition;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly creationInput: JsonValue | null;
  readonly preparation: PreparedReference<unknown>;
  readonly dependencies: Map<string, PackageNode>;
  contribution?: PackageContribution;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageId(value: unknown): PackageDefinitionId {
  const digest = createHash("sha256")
    .update(printCanonicalJson(value as JsonValue))
    .digest("hex");
  return `package-${digest}` as PackageDefinitionId;
}

function selectionId(value: unknown): string {
  const digest = createHash("sha256")
    .update(printCanonicalJson(value as JsonValue))
    .digest("hex");
  return `selection-${digest}`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeProjectionSources(
  ...groups: readonly (readonly ProjectProjectionSource[] | undefined)[]
): readonly ProjectProjectionSource[] {
  const sources = new Map<string, ProjectProjectionSource>();
  for (const group of groups) {
    for (const source of group ?? []) {
      if (!sources.has(source.identity)) {
        sources.set(source.identity, { ...source });
      }
    }
  }
  return [...sources.values()];
}

function projectionPath(packagePath: string, relativePath: string): string {
  return packagePath === "." ? relativePath : `${packagePath}/${relativePath}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dependencyIdentityCacheKey(
  consumer: ContentIdentity,
  dependencyKey: string,
): string {
  return JSON.stringify([contentIdentityKey(consumer), dependencyKey]);
}

function conflictReason(
  conflicts: readonly ProjectProjectionConflict[],
): string {
  return conflicts.map((conflict) => conflict.reason).join("\n");
}

function preserveProjectionPaths(
  before: ProjectProjection,
  after: ProjectProjection,
): ProjectProjection {
  const entries = new Map(after.entries.map((entry) => [entry.path, entry]));
  for (const entry of before.entries) {
    if (!entries.has(entry.path)) entries.set(entry.path, entry);
  }
  const reconciliation = new Map(
    after.reconciliation.map((policy) => [policy.path, policy]),
  );
  for (const policy of before.reconciliation) {
    if (!reconciliation.has(policy.path)) {
      reconciliation.set(policy.path, policy);
    }
  }
  return {
    entries: [...entries.values()].toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
    reconciliation: [...reconciliation.values()].toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
  };
}

function isCanonicalRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value !== "." &&
    value
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isNestedDirectory(parent: string, child: string): boolean {
  return parent === "." ? child !== "." : child.startsWith(`${parent}/`);
}

function packageDefinition(value: PackageDefinition): PackageDefinition {
  assertProjectBlueprint({
    schemaVersion: 4,
    packages: [{ packageDefinitionId: `package-${"0".repeat(64)}`, ...value }],
    packageLinkIntents: [],
  });
  return { ...value };
}

function preparationSnapshot(
  value: PreparedReference<unknown>,
): PreparedReference<unknown> {
  if (!isRecord(value) || !Array.isArray(value.resources)) {
    throw new Error("参考包准备结果必须是资源快照");
  }
  const paths = new Set<string>();
  const resources = value.resources.map((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.path !== "string" ||
      !isCanonicalRelativeFilePath(resource.path) ||
      !(resource.content instanceof Uint8Array) ||
      !Number.isInteger(resource.mode) ||
      (resource.mode as number) < 0 ||
      ((resource.mode as number) & ~0o111) !== 0
    ) {
      throw new Error("参考包准备结果包含无效资源文件");
    }
    if (paths.has(resource.path)) {
      throw new Error(`参考包准备结果包含重复资源：${resource.path}`);
    }
    paths.add(resource.path);
    return {
      path: resource.path,
      content: resource.content.slice(),
      mode: resource.mode as number,
    };
  });
  return {
    resources,
    facts: structuredClone(value.facts),
  };
}

function clonePreparation(
  value: PreparedReference<unknown>,
): PreparedReference<unknown> {
  return {
    resources: value.resources.map((resource) => ({
      path: resource.path,
      content: resource.content.slice(),
      mode: resource.mode,
    })),
    facts: structuredClone(value.facts),
  };
}

function requireParsedCreationInput(
  content: RuntimeReference,
  value: unknown,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const parsed = content.definition.parseCreationInput(value);
  assertJsonValue(parsed, "包创建输入");
  return parsed;
}

function mergeCreationInput(defaults: unknown, supplied: unknown): unknown {
  if (defaults === undefined) return supplied;
  if (supplied === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(supplied)) {
    throw new Error("预设创建输入只能通过对象进行补充");
  }
  return { ...defaults, ...supplied };
}

function excludedPackagePaths(
  definition: PackageDefinition,
  selectedPaths: readonly string[],
): string[] {
  return selectedPaths
    .filter((candidate) => isNestedDirectory(definition.path, candidate))
    .map((candidate) =>
      definition.path === "."
        ? candidate
        : candidate.slice(definition.path.length + 1),
    );
}

function packageNodePaths(roots: readonly PackageNodeDraft[]): string[] {
  const paths: string[] = [];
  const visited = new Set<PackageNodeDraft>();
  const visit = (root: PackageNodeDraft): void => {
    if (visited.has(root)) return;
    visited.add(root);
    paths.push(root.definition.path);
    for (const dependency of root.dependencies) {
      visit(dependency.package);
    }
  };
  for (const root of roots) visit(root);
  return paths;
}

function assertAcyclicPackageDrafts(
  roots: readonly PackageNodeDraft[],
  explicitlySelectedSharedReferences: ReadonlyMap<
    string,
    "initialization" | "addition"
  >,
): void {
  const visiting = new Set<PackageDefinitionId>();
  const completed = new Map<
    PackageDefinitionId,
    readonly { readonly key: string; readonly packageId: PackageDefinitionId }[]
  >();
  const packageIdFor = (
    node: PackageNodeDraft,
    parentId?: PackageDefinitionId,
    dependencyKey?: string,
  ): PackageDefinitionId => {
    if (node.restored !== undefined) {
      return node.restored.packageDefinitionId;
    }
    const identityKey = contentIdentityKey(node.content.identity);
    const shared = node.content.definition.instance === "shared";
    const explicitRoot = shared ? undefined : node.explicitRoot;
    const createdBy =
      explicitRoot?.createdBy ??
      (shared
        ? explicitlySelectedSharedReferences.get(identityKey)
        : undefined) ??
      (parentId === undefined ? "initialization" : "shared-dependency");
    const discriminator = shared
      ? "shared-reference"
      : explicitRoot === undefined
        ? parentId === undefined || dependencyKey === undefined
          ? undefined
          : `${parentId}:${dependencyKey}`
        : `${explicitRoot.selectionId}:${explicitRoot.nodeIdentity}`;
    if (discriminator === undefined) {
      throw new Error("参考包实例缺少明确的创建地址");
    }
    return packageId({
      contentIdentity: node.content.identity,
      definition: node.definition,
      creationInput: node.creationInput ?? null,
      createdBy,
      discriminator,
    });
  };
  const visit = (
    node: PackageNodeDraft,
    parentId?: PackageDefinitionId,
    dependencyKey?: string,
  ): void => {
    const id = packageIdFor(node, parentId, dependencyKey);
    if (visiting.has(id)) {
      throw new Error("预设节点依赖形成循环");
    }
    const edges = node.dependencies.map((dependency) => ({
      key: dependency.key,
      packageId: packageIdFor(dependency.package, id, dependency.key),
    }));
    const previousEdges = completed.get(id);
    if (previousEdges !== undefined) {
      if (!isDeepStrictEqual(previousEdges, edges)) {
        throw new Error("共享参考包的依赖绑定不一致");
      }
      return;
    }
    visiting.add(id);
    for (const dependency of node.dependencies) {
      visit(dependency.package, id, dependency.key);
    }
    visiting.delete(id);
    completed.set(id, edges);
  };
  for (const root of roots) visit(root);
}

function requireUniqueNodes(
  roots: readonly { readonly nodeIdentity: string }[],
): void {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!/^[a-z][a-z0-9-]*$/u.test(root.nodeIdentity)) {
      throw new Error(`选择节点标识无效：${root.nodeIdentity}`);
    }
    if (seen.has(root.nodeIdentity)) {
      throw new Error(`选择节点标识必须唯一：${root.nodeIdentity}`);
    }
    seen.add(root.nodeIdentity);
  }
}

/** 为显式内容集合创建通用纯计算引擎。 */
type CompositionConventions<Definition> = Definition extends {
  parseConventions(value: unknown): infer Conventions;
}
  ? Extract<Conventions, JsonValue>
  : JsonValue;
type CompositionOwnerFacts<Definition> =
  Definition extends Composition<
    JsonValue,
    unknown,
    unknown,
    unknown,
    infer OwnerFacts,
    JsonValue,
    unknown
  >
    ? OwnerFacts
    : unknown;
type CompositionContributionFacts<Definition> =
  Definition extends Composition<
    JsonValue,
    unknown,
    unknown,
    infer ContributionFacts,
    unknown,
    JsonValue,
    unknown
  >
    ? ContributionFacts
    : unknown;
type ReferenceCreationInput<Member> = Member extends {
  readonly kind: "reference";
  readonly definition: {
    parseCreationInput(value: unknown): infer CreationInput;
  };
}
  ? Extract<CreationInput, JsonValue>
  : never;
type ContentCreationInput<Members extends readonly LoadedContentMember[]> =
  Extract<Members[number], { readonly kind: "reference" }> extends infer Member
    ? [ReferenceCreationInput<Member>] extends [never]
      ? JsonValue
      : ReferenceCreationInput<Member>
    : JsonValue;

export function createGenerator<
  const Members extends readonly LoadedContentMember[],
  const CompositionDefinition extends CompositionDefinitionLike,
>(options: {
  readonly content: Members;
  readonly composition: CompositionDefinition;
}): Generator<
  CompositionOwnerFacts<CompositionDefinition>,
  CompositionConventions<CompositionDefinition>,
  ContentCreationInput<Members>,
  CompositionContributionFacts<CompositionDefinition>,
  CompositionDefinition
> {
  type InitializedProject = ComputedProject<
    CompositionOwnerFacts<CompositionDefinition>,
    CompositionConventions<CompositionDefinition>,
    ContentCreationInput<Members>,
    CompositionContributionFacts<CompositionDefinition>
  >;
  assertContentIdentity(options.composition.identity);
  const contentIndex = createContentIndex(options.content);
  const composition =
    options.composition as unknown as CompositionDefinitionLike;
  const emptyProjectProjection: ProjectProjection = {
    entries: [],
    reconciliation: [],
  };
  const pendingPlans = new WeakMap<
    ProjectProjectionChangePlan,
    { readonly targetRoot: string; readonly computed: InitializedProject }
  >();

  const readMetadataFact = async (
    targetRoot: string,
    metadataPath: string,
  ): Promise<CurrentProjectProjectionEntry> => {
    const filePath = path.join(targetRoot, metadataPath);
    try {
      const stat = await lstat(filePath);
      if (!stat.isFile()) {
        return {
          path: metadataPath,
          kind: stat.isDirectory()
            ? "directory"
            : stat.isSymbolicLink()
              ? "symbolic-link"
              : "other",
        };
      }
      return {
        path: metadataPath,
        kind: "file",
        content: new Uint8Array(await readFile(filePath)),
        mode: stat.mode & 0o111,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return { path: metadataPath, kind: "missing" };
      }
      throw error;
    }
  };

  const readRestoredProject = async (
    targetRoot: string,
  ): Promise<{
    readonly restored: RestoredProject;
    readonly readFacts: readonly CurrentProjectProjectionEntry[];
  }> => {
    const paths = [
      generatorMetadataPaths.blueprint,
      generatorMetadataPaths.generationRecord,
    ] as const;
    const readFacts = await Promise.all(
      paths.map((metadataPath) => readMetadataFact(targetRoot, metadataPath)),
    );
    const [blueprintFact, generationRecordFact] = readFacts;
    if (
      blueprintFact?.kind !== "file" ||
      generationRecordFact?.kind !== "file"
    ) {
      throw new Error("目标项目缺少可读取的 schema4 蓝图或 schema6 生成记录");
    }
    let blueprintValue: unknown;
    let generationRecordValue: unknown;
    try {
      blueprintValue = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(blueprintFact.content),
      ) as unknown;
      generationRecordValue = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          generationRecordFact.content,
        ),
      ) as unknown;
    } catch (error) {
      throw new Error(`生成元数据不是有效 JSON：${errorMessage(error)}`, {
        cause: error,
      });
    }
    const blueprint = assertProjectBlueprint(blueprintValue);
    const generationRecord = parseGenerationRecordStructure(
      generationRecordValue,
    );
    assertGenerationRecordMatchesBlueprint(generationRecord, blueprint);
    return { restored: { blueprint, generationRecord }, readFacts };
  };

  const resolveReference = (selector: ContentSelector): RuntimeReference =>
    contentIndex.resolve(selector, "reference") as RuntimeReference;

  const normalizeDependencyIdentity = (
    consumer: RuntimeReference,
    dependency: ReferenceDependency,
    cache: DependencyIdentityCache,
  ): ContentIdentity => {
    const cacheKey = dependencyIdentityCacheKey(
      consumer.identity,
      dependency.key,
    );
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached.contentIdentity;

    const identity = resolveReferenceDependencyIdentity({
      consumerIdentity: consumer.identity,
      dependency,
      members: contentIndex.members,
    });

    cache.set(cacheKey, {
      consumerContentIdentity: consumer.identity,
      key: dependency.key,
      contentIdentity: identity,
    });
    return identity;
  };

  const createPackageNodeDraft = (request: {
    readonly content: RuntimeReference;
    readonly nodeIdentity: string;
    readonly creationInput: ContentCreationInput<Members> | undefined;
    readonly definition: PackageDefinition;
    readonly layout?: unknown;
    readonly restored?: PackageNodeDraft<
      ContentCreationInput<Members>
    >["restored"];
    readonly explicitRoot?: PackageNodeDraft<
      ContentCreationInput<Members>
    >["explicitRoot"];
    readonly sharedDrafts?: Map<
      string,
      PackageNodeDraft<ContentCreationInput<Members>>
    >;
  }): PackageNodeDraft<ContentCreationInput<Members>> => {
    const identityKey = contentIdentityKey(request.content.identity);
    const sharedKey =
      request.content.definition.instance === "shared"
        ? identityKey
        : undefined;
    const cached =
      sharedKey === undefined
        ? undefined
        : request.sharedDrafts?.get(sharedKey);
    if (cached !== undefined) {
      if (
        !isDeepStrictEqual(cached.definition, request.definition) ||
        !isDeepStrictEqual(
          cached.creationInput ?? null,
          request.creationInput ?? null,
        )
      ) {
        throw new Error(
          `共享参考包的创建事实不一致：${contentIdentityLabel(request.content.identity)}`,
        );
      }
      return {
        ...cached,
        nodeIdentity: request.nodeIdentity,
        layout: request.layout,
        ...(request.explicitRoot === undefined
          ? {}
          : { explicitRoot: request.explicitRoot }),
        dependencies: [...cached.dependencies],
      };
    }
    const draft: PackageNodeDraft<ContentCreationInput<Members>> = {
      content: request.content,
      definition: request.definition,
      creationInput: request.creationInput,
      layout: request.layout,
      nodeIdentity: request.nodeIdentity,
      ...(request.explicitRoot === undefined
        ? {}
        : { explicitRoot: request.explicitRoot }),
      ...(request.restored === undefined ? {} : { restored: request.restored }),
      dependencies: [],
    };
    if (sharedKey !== undefined) request.sharedDrafts?.set(sharedKey, draft);
    return draft;
  };

  const populatePackageNodeDraft = (options: {
    readonly draft: PackageNodeDraft<ContentCreationInput<Members>>;
    readonly conventions: CompositionConventions<CompositionDefinition>;
    readonly ancestry: readonly string[];
    readonly sharedDrafts: Map<
      string,
      PackageNodeDraft<ContentCreationInput<Members>>
    >;
    readonly dependencyIdentities: DependencyIdentityCache;
    readonly explicitTargets?: ReadonlyMap<
      string,
      PackageNodeDraft<ContentCreationInput<Members>>
    >;
    readonly restoredTargets?: ReadonlyMap<
      PackageDefinitionId,
      PackageNodeDraft<ContentCreationInput<Members>>
    >;
    readonly existingSelection?: {
      readonly selectionId: string;
      readonly recordedNodeIds?: Readonly<Record<string, PackageDefinitionId>>;
    };
    readonly dependencyBindings?: Readonly<
      Record<string, SelectionDependencyBindingTarget>
    >;
  }): void => {
    const { draft } = options;
    const identityKey = contentIdentityKey(draft.content.identity);
    if (options.ancestry.includes(identityKey)) {
      throw new Error(
        `参考包依赖形成循环：${[...options.ancestry, identityKey].join(" → ")}`,
      );
    }
    const dependencies = draft.content.definition.dependencies ?? [];
    const dependencyKeys = new Set<string>();
    const bindings = options.dependencyBindings ?? {};
    const bindingEntries = Object.entries(bindings);
    for (const [key, target] of bindingEntries) {
      if (key.trim().length === 0) {
        throw new Error(`选择节点依赖绑定无效：${draft.nodeIdentity}/${key}`);
      }
      if (typeof target === "string") {
        if (
          target.trim().length === 0 ||
          !options.explicitTargets?.has(target)
        ) {
          throw new Error(
            `选择节点依赖绑定目标不存在：${draft.nodeIdentity}/${key}`,
          );
        }
      } else if (
        !isRecord(target) ||
        typeof target.packageDefinitionId !== "string" ||
        target.packageDefinitionId.trim().length === 0 ||
        !options.restoredTargets?.has(
          target.packageDefinitionId as PackageDefinitionId,
        )
      ) {
        throw new Error(
          `选择节点依赖绑定目标不存在：${draft.nodeIdentity}/${key}`,
        );
      }
    }
    const populated: PackageNodeDraft<
      ContentCreationInput<Members>
    >["dependencies"] = [];
    const restoredDependencies =
      draft.restored === undefined
        ? new Map<string, PackageNodeDraft<ContentCreationInput<Members>>>()
        : new Map(
            draft.dependencies.map((dependency) => [
              dependency.key,
              dependency.package,
            ]),
          );
    for (const dependency of dependencies) {
      if (
        dependency.key.trim().length === 0 ||
        dependencyKeys.has(dependency.key)
      ) {
        throw new Error(`参考包依赖键不能为空且不能重复：${dependency.key}`);
      }
      dependencyKeys.add(dependency.key);
      const providerIdentity = normalizeDependencyIdentity(
        draft.content,
        dependency,
        options.dependencyIdentities,
      );
      const restoredDependency = restoredDependencies.get(dependency.key);
      const bindingTarget = bindings[dependency.key];
      if (bindingTarget !== undefined) {
        const selectedTarget =
          typeof bindingTarget === "string"
            ? options.explicitTargets?.get(bindingTarget)
            : options.restoredTargets?.get(bindingTarget.packageDefinitionId);
        if (selectedTarget === undefined) {
          throw new Error(
            `选择节点依赖绑定目标不存在：${draft.nodeIdentity}/${dependency.key}`,
          );
        }
        if (
          contentIdentityKey(selectedTarget.content.identity) !==
          contentIdentityKey(providerIdentity)
        ) {
          throw new Error(
            `选择节点依赖绑定身份不一致：${draft.nodeIdentity}/${dependency.key}`,
          );
        }
        if (dependency.creationInput !== undefined) {
          const expectedInput = requireParsedCreationInput(
            selectedTarget.content,
            dependency.creationInput,
          ) as ContentCreationInput<Members> | undefined;
          if (
            !isDeepStrictEqual(
              selectedTarget.creationInput ?? null,
              expectedInput ?? null,
            )
          ) {
            throw new Error(
              `选择节点依赖创建输入不一致：${draft.nodeIdentity}/${dependency.key}`,
            );
          }
        }
        const selectedTargetNode = selectedTarget.explicitRoot;
        const existingSelection = options.existingSelection;
        const selectedTargetId =
          selectedTarget.restored?.packageDefinitionId ??
          (selectedTargetNode !== undefined &&
          existingSelection !== undefined &&
          selectedTargetNode.selectionId === existingSelection.selectionId
            ? existingSelection.recordedNodeIds?.[
                selectedTargetNode.nodeIdentity
              ]
            : undefined);
        if (
          restoredDependency !== undefined &&
          selectedTargetId !== restoredDependency.restored?.packageDefinitionId
        ) {
          throw new Error(
            `生成记录中的依赖绑定不一致：${draft.nodeIdentity} → ${dependency.key}`,
          );
        }
        populated.push({
          key: dependency.key,
          package: restoredDependency ?? selectedTarget,
        });
        continue;
      }

      if (restoredDependency !== undefined) {
        if (
          contentIdentityKey(restoredDependency.content.identity) !==
          contentIdentityKey(providerIdentity)
        ) {
          throw new Error(
            `生成记录包含无效依赖绑定：${draft.nodeIdentity} → ${dependency.key}`,
          );
        }
        if (dependency.creationInput !== undefined) {
          const expectedInput = requireParsedCreationInput(
            restoredDependency.content,
            dependency.creationInput,
          ) as ContentCreationInput<Members> | undefined;
          if (
            !isDeepStrictEqual(
              restoredDependency.creationInput ?? null,
              expectedInput ?? null,
            )
          ) {
            throw new Error(
              `生成记录中的依赖创建事实不一致：${draft.nodeIdentity} → ${dependency.key}`,
            );
          }
        }
        populated.push({ key: dependency.key, package: restoredDependency });
        continue;
      }

      const provider = resolveReference(providerIdentity);
      const providerCreationInput = requireParsedCreationInput(
        provider,
        dependency.creationInput,
      ) as ContentCreationInput<Members> | undefined;
      const providerDefinition = packageDefinition(
        provider.definition.createDefinition({
          conventions: options.conventions,
          creationInput: providerCreationInput,
        }),
      );
      const providerNode = createPackageNodeDraft({
        content: provider,
        nodeIdentity: `${draft.nodeIdentity}-${dependency.key}`,
        creationInput: providerCreationInput,
        definition: providerDefinition,
        layout: undefined,
        sharedDrafts: options.sharedDrafts,
      });
      populatePackageNodeDraft({
        draft: providerNode,
        conventions: options.conventions,
        ancestry: [...options.ancestry, identityKey],
        sharedDrafts: options.sharedDrafts,
        dependencyIdentities: options.dependencyIdentities,
        ...(options.existingSelection === undefined
          ? {}
          : { existingSelection: options.existingSelection }),
      });
      populated.push({ key: dependency.key, package: providerNode });
    }
    if (draft.restored !== undefined) {
      for (const dependency of draft.dependencies) {
        if (!dependencyKeys.has(dependency.key)) populated.push(dependency);
      }
    }
    for (const [key] of bindingEntries) {
      if (!dependencyKeys.has(key)) {
        throw new Error(
          `选择节点依赖绑定键不存在：${draft.nodeIdentity}/${key}`,
        );
      }
    }
    draft.dependencies = populated;
  };

  const preparePackageNode = async (
    draft: PackageNodeDraft<ContentCreationInput<Members>>,
    selectedPaths: readonly string[],
    preparedDrafts: WeakMap<
      PackageNodeDraft<ContentCreationInput<Members>>,
      Promise<PreparedNode<ContentCreationInput<Members>>>
    >,
  ): Promise<PreparedNode<ContentCreationInput<Members>>> => {
    const existing = preparedDrafts.get(draft);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const preparedDependencies: {
        key: string;
        package: PreparedNode<ContentCreationInput<Members>>;
      }[] = [];
      for (const dependency of draft.dependencies) {
        preparedDependencies.push({
          key: dependency.key,
          package: await preparePackageNode(
            dependency.package,
            selectedPaths,
            preparedDrafts,
          ),
        });
      }
      const prepared = preparationSnapshot(
        await draft.content.definition.prepare({
          excludedPackagePaths: excludedPackagePaths(
            draft.definition,
            selectedPaths,
          ),
        }),
      );
      return {
        content: draft.content,
        preparation: prepared,
        definition: draft.definition,
        creationInput: draft.creationInput,
        layout: draft.layout,
        nodeIdentity: draft.nodeIdentity,
        ...(draft.explicitRoot === undefined
          ? {}
          : { explicitRoot: draft.explicitRoot }),
        ...(draft.restored === undefined ? {} : { restored: draft.restored }),
        dependencies: preparedDependencies,
      };
    })();
    preparedDrafts.set(draft, pending);
    return pending;
  };

  const restoredSelectionDrafts = (
    restored: RestoredProject,
    dependencyIdentities: DependencyIdentityCache = new Map(),
  ): PackageSelectionDraft<ContentCreationInput<Members>>[] => {
    const { generationRecord, blueprint } = restored;
    for (const requirement of restored.normalizedDependencies ?? []) {
      const key = dependencyIdentityCacheKey(
        requirement.consumerContentIdentity,
        requirement.key,
      );
      const existing = dependencyIdentities.get(key);
      if (
        existing !== undefined &&
        contentIdentityKey(existing.contentIdentity) !==
          contentIdentityKey(requirement.contentIdentity)
      ) {
        throw new Error("缓存的内容依赖身份不一致");
      }
      dependencyIdentities.set(key, requirement);
    }
    if (
      contentIdentityKey(generationRecord.composition.identity) !==
      contentIdentityKey(composition.identity)
    ) {
      throw new Error("目标项目使用了不兼容的组合定义");
    }
    assertGenerationRecordMatchesBlueprint(generationRecord, blueprint);
    const conventions = composition.parseConventions(
      generationRecord.composition.conventions,
    ) as CompositionConventions<CompositionDefinition>;
    assertJsonValue(conventions, "组合约定");
    if (
      !isDeepStrictEqual(conventions, generationRecord.composition.conventions)
    ) {
      throw new Error("生成记录中的组合约定不符合当前组合定义");
    }

    const recordsById = new Map(
      generationRecord.packages.map((item) => [item.packageDefinitionId, item]),
    );
    const definitionsById = new Map(
      blueprint.packages.map((definition) => [
        definition.packageDefinitionId,
        definition,
      ]),
    );
    const contentsById = new Map<PackageDefinitionId, RuntimeReference>();
    const inputsById = new Map<
      PackageDefinitionId,
      ContentCreationInput<Members> | undefined
    >();
    const draftsById = new Map<
      PackageDefinitionId,
      PackageNodeDraft<ContentCreationInput<Members>>
    >();
    const sharedIdentities = new Set<string>();

    for (const item of generationRecord.packages) {
      const content = resolveReference(item.contentIdentity);
      const definition = definitionsById.get(item.packageDefinitionId);
      if (definition === undefined) {
        throw new Error(`项目蓝图缺少包实例：${item.packageDefinitionId}`);
      }
      const creationInput =
        item.creationInput === null
          ? undefined
          : (requireParsedCreationInput(
              content,
              item.creationInput,
            ) as ContentCreationInput<Members>);
      if (!isDeepStrictEqual(creationInput ?? null, item.creationInput)) {
        throw new Error(
          `生成记录中的创建事实不规范：${item.packageDefinitionId}`,
        );
      }
      contentsById.set(item.packageDefinitionId, content);
      inputsById.set(item.packageDefinitionId, creationInput);
      if (content.definition.instance === "shared") {
        const identity = contentIdentityKey(content.identity);
        if (sharedIdentities.has(identity)) {
          throw new Error(
            `共享参考包必须只有一个实例：${contentIdentityLabel(content.identity)}`,
          );
        }
        sharedIdentities.add(identity);
      }
    }

    const explicitBindingsByConsumer = new Map<
      PackageDefinitionId,
      Map<string, PackageDefinitionId>
    >();
    for (const selection of generationRecord.selections) {
      if (selection.presetIdentity === null) continue;
      const preset = contentIndex.resolve(
        selection.presetIdentity,
        "preset",
      ) as RuntimePreset;
      const definition = preset.definition;
      if (
        !isRecord(definition) ||
        definition.kind !== "preset" ||
        !isRecord(definition.nodes)
      ) {
        throw new Error(
          `预设定义无效：${contentIdentityLabel(preset.identity)}`,
        );
      }
      const presetNodes = Object.entries(definition.nodes);
      if (
        presetNodes.length !== Object.keys(selection.nodes).length ||
        presetNodes.some(
          ([nodeIdentity]) => !Object.hasOwn(selection.nodes, nodeIdentity),
        )
      ) {
        throw new Error(
          `生成记录中的预设选择与当前定义不一致：${contentIdentityLabel(preset.identity)}`,
        );
      }
      for (const [nodeIdentity, rawNode] of presetNodes) {
        if (!isRecord(rawNode) || !isRecord(rawNode.reference)) {
          throw new Error(`预设节点定义无效：${nodeIdentity}`);
        }
        const consumerId = selection.nodes[nodeIdentity];
        const consumerRecord =
          consumerId === undefined ? undefined : recordsById.get(consumerId);
        const consumer =
          consumerId === undefined ? undefined : contentsById.get(consumerId);
        const expected = resolveReference({
          alias: String(rawNode.reference.alias),
          namespace: preset.identity.namespace,
        });
        if (
          consumerId === undefined ||
          consumerRecord === undefined ||
          consumer === undefined ||
          contentIdentityKey(consumer.identity) !==
            contentIdentityKey(expected.identity)
        ) {
          throw new Error(`生成记录中的预设节点引用不一致：${nodeIdentity}`);
        }
        const rawBindings = rawNode.dependencyBindings;
        if (rawBindings === undefined) continue;
        if (!isRecord(rawBindings)) {
          throw new Error(`预设节点依赖绑定无效：${nodeIdentity}`);
        }
        const declarations = consumer.definition.dependencies ?? [];
        const declaredKeys = new Set(declarations.map(({ key }) => key));
        for (const [key, targetNodeIdentity] of Object.entries(rawBindings)) {
          if (
            key.trim().length === 0 ||
            typeof targetNodeIdentity !== "string" ||
            targetNodeIdentity.trim().length === 0
          ) {
            throw new Error(`预设节点依赖绑定无效：${nodeIdentity}/${key}`);
          }
          if (!declaredKeys.has(key)) {
            throw new Error(`预设节点依赖绑定键不存在：${nodeIdentity}/${key}`);
          }
          const providerId = selection.nodes[targetNodeIdentity];
          const providerRecord =
            providerId === undefined ? undefined : recordsById.get(providerId);
          const provider =
            providerId === undefined ? undefined : contentsById.get(providerId);
          const dependency = declarations.find((item) => item.key === key);
          if (
            providerId === undefined ||
            providerRecord === undefined ||
            provider === undefined ||
            dependency === undefined
          ) {
            throw new Error(
              `预设节点依赖绑定目标不存在：${nodeIdentity}/${key}`,
            );
          }
          const expectedIdentity = normalizeDependencyIdentity(
            consumer,
            dependency,
            dependencyIdentities,
          );
          if (
            contentIdentityKey(provider.identity) !==
              contentIdentityKey(expectedIdentity) ||
            consumerRecord.dependencyBindings[key] !== providerId
          ) {
            throw new Error(
              `生成记录中的预设节点依赖绑定不一致：${consumerId} → ${key}`,
            );
          }
          const bindings =
            explicitBindingsByConsumer.get(consumerId) ?? new Map();
          const existingProviderId = bindings.get(key);
          if (
            existingProviderId !== undefined &&
            existingProviderId !== providerId
          ) {
            throw new Error(
              `生成记录中的预设节点依赖绑定不一致：${consumerId} → ${key}`,
            );
          }
          bindings.set(key, providerId);
          explicitBindingsByConsumer.set(consumerId, bindings);
        }
      }
    }

    const visiting = new Set<PackageDefinitionId>();
    const buildDraft = (
      id: PackageDefinitionId,
    ): PackageNodeDraft<ContentCreationInput<Members>> => {
      const existing = draftsById.get(id);
      if (existing !== undefined) return existing;
      if (visiting.has(id)) throw new Error("生成记录依赖包含循环");
      const item = recordsById.get(id);
      const persistedDefinition = definitionsById.get(id);
      const content = contentsById.get(id);
      if (
        item === undefined ||
        persistedDefinition === undefined ||
        content === undefined
      ) {
        throw new Error(`生成记录引用了未知包实例：${id}`);
      }

      visiting.add(id);
      const declarations = content.definition.dependencies ?? [];
      const declaredKeys = new Set<string>();
      for (const dependency of declarations) {
        if (
          dependency.key.trim().length === 0 ||
          declaredKeys.has(dependency.key)
        ) {
          throw new Error(`参考包依赖键不能为空且不能重复：${dependency.key}`);
        }
        declaredKeys.add(dependency.key);
      }
      const recordedBindings = Object.entries(item.dependencyBindings);
      if (recordedBindings.some(([key]) => key.trim().length === 0)) {
        throw new Error(`生成记录中的依赖绑定与当前参考包不一致：${id}`);
      }
      const recordedKeys = new Set(recordedBindings.map(([key]) => key));
      if (declarations.some(({ key }) => !recordedKeys.has(key))) {
        throw new Error(`生成记录中的依赖绑定与当前参考包不一致：${id}`);
      }
      const dependencies = recordedBindings.map(([key, providerId]) => {
        const providerRecord =
          providerId === undefined ? undefined : recordsById.get(providerId);
        const providerContent =
          providerId === undefined ? undefined : contentsById.get(providerId);
        if (
          providerId === undefined ||
          providerRecord === undefined ||
          providerContent === undefined
        ) {
          throw new Error(`生成记录包含无效依赖绑定：${id} → ${key}`);
        }
        const dependency = declarations.find((item) => item.key === key);
        if (dependency !== undefined) {
          const consumer = contentsById.get(id);
          if (consumer === undefined) {
            throw new Error(`生成记录引用了未知内容实例：${id}`);
          }
          const declaredIdentity = normalizeDependencyIdentity(
            consumer,
            dependency,
            dependencyIdentities,
          );
          if (
            contentIdentityKey(providerContent.identity) !==
            contentIdentityKey(declaredIdentity)
          ) {
            throw new Error(`生成记录包含无效依赖绑定：${id} → ${key}`);
          }
          const explicitProviderId = explicitBindingsByConsumer
            .get(id)
            ?.get(key);
          if (
            explicitProviderId !== undefined &&
            providerId !== explicitProviderId
          ) {
            throw new Error(
              `生成记录中的预设节点依赖绑定不一致：${id} → ${key}`,
            );
          }
          const expectedInput = requireParsedCreationInput(
            providerContent,
            dependency.creationInput,
          );
          if (
            dependency.creationInput !== undefined &&
            !isDeepStrictEqual(
              inputsById.get(providerId) ?? null,
              expectedInput ?? null,
            )
          ) {
            throw new Error(`生成记录中的依赖创建事实不一致：${id} → ${key}`);
          }
        }
        return { key, package: buildDraft(providerId) };
      });
      visiting.delete(id);

      const { packageDefinitionId: _id, ...definition } = persistedDefinition;
      const draft: PackageNodeDraft<ContentCreationInput<Members>> = {
        content,
        definition,
        creationInput: inputsById.get(id),
        layout: undefined,
        nodeIdentity: `restored-${id}`,
        restored: {
          packageDefinitionId: id,
          createdBy: item.createdBy,
        },
        dependencies,
      };
      draftsById.set(id, draft);
      return draft;
    };

    const reachable = new Set<PackageDefinitionId>();
    const collectReachable = (id: PackageDefinitionId): void => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const item = recordsById.get(id);
      if (item === undefined) throw new Error(`未知包实例：${id}`);
      for (const providerId of Object.values(item.dependencyBindings)) {
        collectReachable(providerId);
      }
    };

    const result = generationRecord.selections.map((selection) => {
      const nodeEntries = Object.entries(selection.nodes);
      requireUniqueNodes(
        nodeEntries.map(([nodeIdentity]) => ({ nodeIdentity })),
      );
      if (selection.presetIdentity !== null) {
        const preset = contentIndex.resolve(
          selection.presetIdentity,
          "preset",
        ) as RuntimePreset;
        const definition = preset.definition;
        if (
          !isRecord(definition) ||
          definition.kind !== "preset" ||
          !isRecord(definition.nodes)
        ) {
          throw new Error(
            `预设定义无效：${contentIdentityLabel(preset.identity)}`,
          );
        }
        const presetNodes = Object.entries(definition.nodes);
        if (
          presetNodes.length !== nodeEntries.length ||
          presetNodes.some(
            ([nodeIdentity]) => !Object.hasOwn(selection.nodes, nodeIdentity),
          )
        ) {
          throw new Error(
            `生成记录中的预设选择与当前定义不一致：${contentIdentityLabel(preset.identity)}`,
          );
        }
        for (const [nodeIdentity, node] of presetNodes) {
          if (!isRecord(node) || !isRecord(node.reference)) {
            throw new Error(`预设节点定义无效：${nodeIdentity}`);
          }
          const rootRecord = recordsById.get(selection.nodes[nodeIdentity]!);
          const rootContent =
            rootRecord === undefined
              ? undefined
              : contentsById.get(rootRecord.packageDefinitionId);
          const expected = resolveReference({
            alias: String(node.reference.alias),
            namespace: preset.identity.namespace,
          });
          if (
            rootContent === undefined ||
            contentIdentityKey(rootContent.identity) !==
              contentIdentityKey(expected.identity)
          ) {
            throw new Error(`生成记录中的预设节点引用不一致：${nodeIdentity}`);
          }
        }
      }
      const roots = nodeEntries.map(([nodeIdentity, id]) => {
        collectReachable(id);
        return { ...buildDraft(id), nodeIdentity };
      });
      // 规范化 JSON 会按键名排序 nodes，无法从记录恢复原始根数组顺序。
      return {
        presetIdentity: selection.presetIdentity,
        selectionId: selection.selectionId,
        recordedNodeIds: selection.nodes,
        roots,
      };
    });
    if (reachable.size !== recordsById.size) {
      throw new Error("生成记录包含未被选择引用的包实例");
    }
    return result;
  };

  async function prepareProjectInternal(
    prepareOptions: {
      readonly selection?: GeneratorSelection<ContentCreationInput<Members>>;
      readonly conventions?: unknown;
      readonly restored?: RestoredProject;
      readonly operation: "init" | "add";
      readonly dependencyIdentities?: DependencyIdentityCache;
    } & OperationFactsInput<CompositionOperationFacts<CompositionDefinition>>,
  ): Promise<
    PreparedProject<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >
  > {
    const parsedConventions = prepareOptions.restored
      ? composition.parseConventions(
          prepareOptions.restored.generationRecord.composition.conventions,
        )
      : composition.parseConventions(prepareOptions.conventions);
    const conventions =
      parsedConventions as CompositionConventions<CompositionDefinition>;
    assertJsonValue(conventions, "组合约定");
    if (
      prepareOptions.restored &&
      !isDeepStrictEqual(
        conventions,
        prepareOptions.restored.generationRecord.composition.conventions,
      )
    ) {
      throw new Error("生成记录中的组合约定不符合当前组合定义");
    }
    const dependencyIdentities =
      prepareOptions.dependencyIdentities ??
      new Map<string, GeneratorDependencyIdentity>();
    const selectionDrafts = prepareOptions.restored
      ? restoredSelectionDrafts(prepareOptions.restored, dependencyIdentities)
      : [];
    const restoredTargetsById = new Map<
      PackageDefinitionId,
      PackageNodeDraft<ContentCreationInput<Members>>
    >();
    const indexRestoredTargets = (
      roots: readonly PackageNodeDraft<ContentCreationInput<Members>>[],
    ): void => {
      for (const root of roots) {
        if (root.restored !== undefined) {
          restoredTargetsById.set(root.restored.packageDefinitionId, root);
        }
        indexRestoredTargets(
          root.dependencies.map(({ package: item }) => item),
        );
      }
    };
    for (const selectionDraft of selectionDrafts) {
      indexRestoredTargets(selectionDraft.roots);
    }
    const sharedDrafts = new Map<
      string,
      PackageNodeDraft<ContentCreationInput<Members>>
    >();
    const indexSharedDrafts = (
      roots: readonly PackageNodeDraft<ContentCreationInput<Members>>[],
    ): void => {
      for (const root of roots) {
        if (root.content.definition.instance === "shared") {
          sharedDrafts.set(contentIdentityKey(root.content.identity), root);
        }
        indexSharedDrafts(root.dependencies.map((item) => item.package));
      }
    };
    for (const selectionDraft of selectionDrafts) {
      indexSharedDrafts(selectionDraft.roots);
    }
    const operation = prepareOptions.operation;
    const createdBy: "initialization" | "addition" =
      operation === "init" ? "initialization" : "addition";

    const identifyDraftSelection = (
      presetIdentity: ContentIdentity | null,
      roots: readonly {
        readonly content: RuntimeReference;
        readonly nodeIdentity: string;
        readonly creationInput: ContentCreationInput<Members> | undefined;
        readonly definition: PackageDefinition;
      }[],
    ): string =>
      selectionId({
        compositionIdentity: composition.identity,
        presetIdentity,
        roots: roots.map((root) => ({
          nodeIdentity: root.nodeIdentity,
          contentIdentity: root.content.identity,
          creationInput: root.creationInput ?? null,
          definition: root.definition,
        })),
      });

    const selectionRootFacts = (
      root: PackageNodeDraft<ContentCreationInput<Members>>,
      existingSelection: PackageSelectionDraft<ContentCreationInput<Members>>,
    ) => {
      const declaredKeys = new Set(
        (root.content.definition.dependencies ?? []).map(({ key }) => key),
      );
      return {
        nodeIdentity: root.nodeIdentity,
        identity: contentIdentityKey(root.content.identity),
        creationInput: root.creationInput ?? null,
        definition: root.definition,
        dependencies: root.dependencies
          .filter(({ key }) => declaredKeys.has(key))
          .map(({ key, package: dependency }) => {
            if (dependency.restored !== undefined) {
              return {
                key,
                target: {
                  packageDefinitionId: dependency.restored.packageDefinitionId,
                },
              };
            }
            if (dependency.explicitRoot !== undefined) {
              const packageDefinitionId =
                dependency.explicitRoot.selectionId ===
                existingSelection.selectionId
                  ? existingSelection.recordedNodeIds?.[
                      dependency.explicitRoot.nodeIdentity
                    ]
                  : undefined;
              return {
                key,
                target:
                  packageDefinitionId === undefined
                    ? {
                        selectionId: dependency.explicitRoot.selectionId,
                        nodeIdentity: dependency.explicitRoot.nodeIdentity,
                      }
                    : { packageDefinitionId },
              };
            }
            const existingRoot = existingSelection.roots.find(
              (candidate) => candidate.nodeIdentity === root.nodeIdentity,
            );
            const existingDependency = existingRoot?.dependencies.find(
              (candidate) => candidate.key === key,
            )?.package;
            const recordedPackageDefinitionId =
              existingDependency?.restored?.packageDefinitionId;
            if (
              existingDependency !== undefined &&
              recordedPackageDefinitionId !== undefined &&
              contentIdentityKey(existingDependency.content.identity) ===
                contentIdentityKey(dependency.content.identity) &&
              isDeepStrictEqual(
                existingDependency.creationInput ?? null,
                dependency.creationInput ?? null,
              ) &&
              isDeepStrictEqual(
                existingDependency.definition,
                dependency.definition,
              )
            ) {
              return {
                key,
                target: { packageDefinitionId: recordedPackageDefinitionId },
              };
            }
            return {
              key,
              target: {
                identity: contentIdentityKey(dependency.content.identity),
                creationInput: dependency.creationInput ?? null,
                definition: dependency.definition,
              },
            };
          })
          .toSorted((left, right) =>
            left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
          ),
      };
    };

    const appendSelection = (
      group: PackageSelectionDraft<ContentCreationInput<Members>>,
    ): void => {
      const existing = selectionDrafts.find(
        (candidate) => candidate.selectionId === group.selectionId,
      );
      if (existing !== undefined) {
        const existingRoots = existing.roots
          .map((root) => selectionRootFacts(root, existing))
          .toSorted((left, right) =>
            left.nodeIdentity < right.nodeIdentity
              ? -1
              : left.nodeIdentity > right.nodeIdentity
                ? 1
                : 0,
          );
        const requestedRoots = group.roots
          .map((root) => selectionRootFacts(root, existing))
          .toSorted((left, right) =>
            left.nodeIdentity < right.nodeIdentity
              ? -1
              : left.nodeIdentity > right.nodeIdentity
                ? 1
                : 0,
          );
        const existingPresetIdentity =
          existing.presetIdentity === null
            ? null
            : contentIdentityKey(existing.presetIdentity);
        const requestedPresetIdentity =
          group.presetIdentity === null
            ? null
            : contentIdentityKey(group.presetIdentity);
        if (existingPresetIdentity === requestedPresetIdentity) {
          if (!isDeepStrictEqual(existingRoots, requestedRoots)) {
            throw new Error("相同选择标识对应不同的包创建事实");
          }
          return;
        }
        throw new Error("生成记录包含重复选择标识");
      }
      selectionDrafts.push(group);
    };

    const selection = prepareOptions.selection;
    const directRoots = selection?.roots ?? [];
    if (directRoots.length > 0) {
      const selectedRoots = directRoots.map((root) => ({
        content: resolveReference(root.contentIdentity),
        nodeIdentity: root.nodeIdentity,
        rawCreationInput: root.creationInput,
        layout: root.layout,
        dependencyBindings: root.dependencyBindings,
      }));
      const preparedRoots = selectedRoots.map((root) => {
        const creationInput = requireParsedCreationInput(
          root.content,
          root.rawCreationInput,
        ) as ContentCreationInput<Members> | undefined;
        return {
          ...root,
          creationInput,
          definition: packageDefinition(
            root.content.definition.createDefinition({
              conventions,
              creationInput,
              ...(root.layout === undefined ? {} : { layout: root.layout }),
            }),
          ),
        };
      });
      const id = identifyDraftSelection(null, preparedRoots);
      const matchedSelection = selectionDrafts.find(
        (candidate) => candidate.selectionId === id,
      );
      const existingSelection =
        matchedSelection?.selectionId === undefined
          ? undefined
          : {
              selectionId: matchedSelection.selectionId,
              ...(matchedSelection.recordedNodeIds === undefined
                ? {}
                : { recordedNodeIds: matchedSelection.recordedNodeIds }),
            };
      const roots = preparedRoots.map((root) => {
        const explicitRoot =
          root.content.definition.instance === "independent"
            ? {
                selectionId: id,
                nodeIdentity: root.nodeIdentity,
                createdBy,
              }
            : undefined;
        return createPackageNodeDraft({
          ...root,
          sharedDrafts,
          ...(explicitRoot === undefined ? {} : { explicitRoot }),
        });
      });
      requireUniqueNodes(roots);
      const rootsByIdentity = new Map(
        roots.map((root) => [root.nodeIdentity, root]),
      );
      for (const root of roots) {
        const dependencyBindings = directRoots.find(
          ({ nodeIdentity }) => nodeIdentity === root.nodeIdentity,
        )?.dependencyBindings;
        if (dependencyBindings !== undefined && !isRecord(dependencyBindings)) {
          throw new Error(`选择节点依赖绑定无效：${root.nodeIdentity}`);
        }
        populatePackageNodeDraft({
          draft: root,
          conventions,
          ancestry: [],
          sharedDrafts,
          dependencyIdentities,
          explicitTargets: rootsByIdentity,
          restoredTargets: restoredTargetsById,
          ...(existingSelection === undefined ? {} : { existingSelection }),
          ...(dependencyBindings === undefined ? {} : { dependencyBindings }),
        });
      }
      appendSelection({
        presetIdentity: null,
        selectionId: id,
        createdBy: operation === "init" ? "initialization" : "addition",
        roots,
      });
    }

    for (const presetRequest of selection?.presets ?? []) {
      const presetMember = contentIndex.resolve(
        presetRequest.contentIdentity,
        "preset",
      ) as RuntimePreset;
      const preset = presetMember.definition;
      if (
        !isRecord(preset) ||
        preset.kind !== "preset" ||
        !isRecord(preset.nodes)
      ) {
        throw new Error(
          `预设定义无效：${contentIdentityLabel(presetMember.identity)}`,
        );
      }
      const definition = preset as unknown as PresetSelectionDefinition;
      if (!definition.operations.includes(operation)) {
        throw new Error(
          `预设不支持${operation === "init" ? "初始化" : "加包"}：${contentIdentityLabel(presetMember.identity)}`,
        );
      }
      const entries = Object.entries(definition.nodes);
      if (entries.length === 0)
        throw new Error("预设必须至少选择一个软件包节点");
      if (presetRequest.creationInput !== undefined && entries.length !== 1) {
        throw new Error("多节点预设不能接收单个软件包创建输入");
      }
      const presetRoots: {
        readonly content: RuntimeReference;
        readonly nodeIdentity: string;
        readonly rawCreationInput: unknown;
        readonly layout?: unknown;
      }[] = [];
      for (const [nodeIdentity, node] of entries) {
        const selectedInput = mergeCreationInput(
          node.creationInput?.[operation],
          presetRequest.creationInput,
        );
        const content = resolveReference({
          alias: node.reference.alias,
          namespace: presetMember.identity.namespace,
        });
        presetRoots.push({
          content,
          nodeIdentity,
          rawCreationInput: selectedInput,
          ...(node.layout === undefined ? {} : { layout: node.layout }),
        });
      }
      const preparedRoots = presetRoots.map((root) => {
        const creationInput = requireParsedCreationInput(
          root.content,
          root.rawCreationInput,
        ) as ContentCreationInput<Members> | undefined;
        return {
          ...root,
          creationInput,
          definition: packageDefinition(
            root.content.definition.createDefinition({
              conventions,
              creationInput,
              ...(root.layout === undefined ? {} : { layout: root.layout }),
            }),
          ),
        };
      });
      const id = identifyDraftSelection(presetMember.identity, preparedRoots);
      const matchedSelection = selectionDrafts.find(
        (candidate) => candidate.selectionId === id,
      );
      const existingSelection =
        matchedSelection?.selectionId === undefined
          ? undefined
          : {
              selectionId: matchedSelection.selectionId,
              ...(matchedSelection.recordedNodeIds === undefined
                ? {}
                : { recordedNodeIds: matchedSelection.recordedNodeIds }),
            };
      const rootsByIdentity = new Map<
        string,
        PackageNodeDraft<ContentCreationInput<Members>>
      >();
      const roots = preparedRoots.map((root) => {
        const declaration = preset.nodes[root.nodeIdentity];
        const dependencyBindings =
          declaration !== undefined && isRecord(declaration)
            ? declaration.dependencyBindings
            : undefined;
        if (dependencyBindings !== undefined && !isRecord(dependencyBindings)) {
          throw new Error(`预设节点依赖绑定无效：${root.nodeIdentity}`);
        }
        const explicitRoot =
          root.content.definition.instance === "independent"
            ? {
                selectionId: id,
                nodeIdentity: root.nodeIdentity,
                createdBy,
              }
            : undefined;
        const draft = createPackageNodeDraft({
          ...root,
          sharedDrafts,
          ...(explicitRoot === undefined ? {} : { explicitRoot }),
        });
        rootsByIdentity.set(root.nodeIdentity, draft);
        return draft;
      });
      requireUniqueNodes(roots);
      for (const root of roots) {
        const declaration = preset.nodes[root.nodeIdentity];
        const dependencyBindings =
          declaration !== undefined && isRecord(declaration)
            ? declaration.dependencyBindings
            : undefined;
        populatePackageNodeDraft({
          draft: root,
          conventions,
          ancestry: [],
          sharedDrafts,
          dependencyIdentities,
          explicitTargets: rootsByIdentity,
          ...(existingSelection === undefined ? {} : { existingSelection }),
          ...(dependencyBindings === undefined ? {} : { dependencyBindings }),
        });
      }
      appendSelection({
        presetIdentity: presetMember.identity,
        selectionId: id,
        createdBy: operation === "init" ? "initialization" : "addition",
        roots,
      });
    }

    if (selectionDrafts.length === 0) {
      throw new Error(
        prepareOptions.restored
          ? "生成记录至少需要一个选择"
          : operation === "init"
            ? "初始化至少需要选择一个参考包或预设"
            : "加包至少需要选择一个参考包或预设",
      );
    }
    const explicitlySelectedSharedReferences = new Map<
      string,
      "initialization" | "addition"
    >();
    for (const selectionDraft of selectionDrafts) {
      if (selectionDraft.createdBy === undefined) continue;
      for (const root of selectionDraft.roots) {
        if (root.content.definition.instance === "shared") {
          explicitlySelectedSharedReferences.set(
            contentIdentityKey(root.content.identity),
            selectionDraft.createdBy,
          );
        }
      }
    }
    assertAcyclicPackageDrafts(
      selectionDrafts.flatMap((item) => item.roots),
      explicitlySelectedSharedReferences,
    );
    const selectedPaths = [
      ...new Set(
        selectionDrafts.flatMap((selection) =>
          packageNodePaths(selection.roots),
        ),
      ),
    ];
    const selections: PreparedSelection<ContentCreationInput<Members>>[] = [];
    const preparedDrafts = new WeakMap<
      PackageNodeDraft<ContentCreationInput<Members>>,
      Promise<PreparedNode<ContentCreationInput<Members>>>
    >();
    for (const selection of selectionDrafts) {
      const roots: PreparedNode<ContentCreationInput<Members>>[] = [];
      for (const root of selection.roots) {
        roots.push(
          await preparePackageNode(root, selectedPaths, preparedDrafts),
        );
      }
      selections.push({
        presetIdentity: selection.presetIdentity,
        ...(selection.selectionId === undefined
          ? {}
          : { selectionId: selection.selectionId }),
        ...(selection.recordedNodeIds === undefined
          ? {}
          : { recordedNodeIds: selection.recordedNodeIds }),
        ...(selection.createdBy === undefined
          ? {}
          : { createdBy: selection.createdBy }),
        roots,
      });
    }
    return {
      conventions,
      composition: options.composition,
      selections,
      operationFacts:
        prepareOptions.operationFacts as CompositionOperationFacts<CompositionDefinition>,
      ...(prepareOptions.restored === undefined
        ? {}
        : { restored: prepareOptions.restored }),
    };
  }

  async function prepareProject(
    prepareOptions: {
      readonly selection: GeneratorSelection<ContentCreationInput<Members>>;
      readonly conventions: unknown;
    } & OperationFactsInput<CompositionOperationFacts<CompositionDefinition>>,
  ): Promise<
    PreparedProject<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >
  > {
    return prepareProjectInternal({ ...prepareOptions, operation: "init" });
  }

  async function restoreProject(restoreOptions: {
    readonly repositoryRoot: string;
  }): Promise<GeneratorRestoredProject<ContentCreationInput<Members>>> {
    const targetRoot = path.resolve(restoreOptions.repositoryRoot);
    const { restored, readFacts } = await readRestoredProject(targetRoot);
    const dependencyIdentities: DependencyIdentityCache = new Map();
    restoredSelectionDrafts(restored, dependencyIdentities);
    const normalizedDependencies = [...dependencyIdentities.values()];
    const definitionsById = new Map(
      restored.blueprint.packages.map((definition) => [
        definition.packageDefinitionId,
        definition,
      ]),
    );
    const packages = restored.generationRecord.packages.map((item) => {
      const definition = definitionsById.get(item.packageDefinitionId);
      if (definition === undefined) {
        throw new Error(`项目蓝图缺少包实例：${item.packageDefinitionId}`);
      }
      return {
        ...item,
        definition,
      } as CompositionPackage<ContentCreationInput<Members>>;
    });
    return {
      ...restored,
      targetRoot,
      packages,
      selections: restored.generationRecord.selections,
      readFacts,
      normalizedDependencies,
    };
  }

  const additionSelection = (
    selection: GeneratorAdditionSelection<ContentCreationInput<Members>>,
  ): GeneratorSelection<ContentCreationInput<Members>> =>
    "preset" in selection
      ? {
          presets: [
            {
              contentIdentity: selection.preset,
              ...(selection.creationInput === undefined
                ? {}
                : { creationInput: selection.creationInput }),
            },
          ],
        }
      : {
          roots: [
            {
              nodeIdentity: selection.nodeIdentity ?? "addition",
              contentIdentity: selection.contentIdentity,
              ...(selection.creationInput === undefined
                ? {}
                : { creationInput: selection.creationInput }),
              ...(selection.layout === undefined
                ? {}
                : { layout: selection.layout }),
              ...(selection.dependencyBindings === undefined
                ? {}
                : { dependencyBindings: selection.dependencyBindings }),
            },
          ],
        };

  async function prepareAddProject(prepareOptions: {
    readonly restored: GeneratorRestoredProject<ContentCreationInput<Members>>;
    readonly selection: GeneratorAdditionSelection<
      ContentCreationInput<Members>
    >;
    readonly operationFacts: CompositionOperationFacts<CompositionDefinition>;
  }): Promise<
    GeneratorAdditionPreparation<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >
  > {
    const restored: RestoredProject = {
      blueprint: prepareOptions.restored.blueprint,
      generationRecord: prepareOptions.restored.generationRecord,
      normalizedDependencies: prepareOptions.restored.normalizedDependencies,
    };
    const dependencyIdentities: DependencyIdentityCache = new Map(
      restored.normalizedDependencies?.map((requirement) => [
        dependencyIdentityCacheKey(
          requirement.consumerContentIdentity,
          requirement.key,
        ),
        requirement,
      ]),
    );
    const common = {
      restored,
      operation: "add" as const,
      operationFacts: prepareOptions.operationFacts,
      dependencyIdentities,
    };
    const before = await prepareProjectInternal(common);
    const after = await prepareProjectInternal({
      ...common,
      selection: additionSelection(prepareOptions.selection),
    });
    return {
      restored: prepareOptions.restored,
      before,
      after,
      readFacts: prepareOptions.restored.readFacts,
    };
  }

  function computeProject(
    preparedProject: PreparedProject<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): InitializedProject {
    if (preparedProject.composition !== composition) {
      throw new Error("准备结果属于另一个组合定义");
    }
    const nodes: PackageNode[] = [];
    const sharedNodes = new Map<string, PackageNode>();
    const nodesById = new Map<PackageDefinitionId, PackageNode>();
    const nodesByPrepared = new WeakMap<PreparedNode, PackageNode>();
    const wiringNodes = new Set<PackageNode>();
    const selectionRecords: GenerationRecordSelection[] = [];
    const explicitlySelectedSharedReferences = new Map<
      string,
      "initialization" | "addition"
    >();
    for (const selection of preparedProject.selections) {
      if (selection.createdBy === undefined) continue;
      for (const root of selection.roots) {
        if (root.content.definition.instance === "shared") {
          explicitlySelectedSharedReferences.set(
            contentIdentityKey(root.content.identity),
            selection.createdBy,
          );
        }
      }
    }

    const makeNode = (
      prepared: PreparedNode,
      createdBy: PackageNode["createdBy"],
      discriminator: string,
    ): PackageNode => {
      const preparedNode = nodesByPrepared.get(prepared);
      if (preparedNode !== undefined) return preparedNode;
      const identityKey = contentIdentityKey(prepared.content.identity);
      const restoredId = prepared.restored?.packageDefinitionId;
      if (restoredId !== undefined) {
        const restored = nodesById.get(restoredId);
        if (restored !== undefined) {
          if (
            contentIdentityKey(restored.content.identity) !== identityKey ||
            !isDeepStrictEqual(restored.definition, {
              ...prepared.definition,
              packageDefinitionId: restoredId,
            }) ||
            !isDeepStrictEqual(
              restored.creationInput,
              prepared.creationInput ?? null,
            ) ||
            !isDeepStrictEqual(restored.preparation, prepared.preparation)
          ) {
            throw new Error(`生成记录中的包实例事实不一致：${restoredId}`);
          }
          nodesByPrepared.set(prepared, restored);
          return restored;
        }
      }
      const sharedKey =
        prepared.content.definition.instance === "shared"
          ? identityKey
          : undefined;
      if (sharedKey !== undefined) {
        const existing = sharedNodes.get(sharedKey);
        if (existing !== undefined) {
          if (
            !isDeepStrictEqual(
              {
                name: existing.definition.name,
                path: existing.definition.path,
                role: existing.definition.role,
              },
              prepared.definition,
            ) ||
            !isDeepStrictEqual(
              existing.creationInput,
              prepared.creationInput ?? null,
            ) ||
            !isDeepStrictEqual(existing.preparation, prepared.preparation)
          ) {
            throw new Error(
              `共享参考包的创建事实不一致：${contentIdentityLabel(prepared.content.identity)}`,
            );
          }
          if (restoredId !== undefined && existing.id !== restoredId) {
            throw new Error(`共享实例标识与生成记录不一致：${restoredId}`);
          }
          if (wiringNodes.has(existing)) {
            throw new Error("预设节点依赖形成循环");
          }
          wiringNodes.add(existing);
          const proposedDependencies = prepared.dependencies.map(
            (dependency) => ({
              key: dependency.key,
              package: makeNode(
                dependency.package,
                "shared-dependency",
                `${existing.id}:${dependency.key}`,
              ),
            }),
          );
          wiringNodes.delete(existing);
          if (
            proposedDependencies.length !== existing.dependencies.size ||
            proposedDependencies.some(
              ({ key, package: provider }) =>
                existing.dependencies.get(key)?.id !== provider.id,
            )
          ) {
            throw new Error("共享参考包的依赖绑定不一致");
          }
          nodesByPrepared.set(prepared, existing);
          return existing;
        }
      }
      const explicitRoot =
        sharedKey === undefined ? prepared.explicitRoot : undefined;
      const effectiveCreatedBy =
        prepared.restored?.createdBy ??
        (sharedKey === undefined
          ? undefined
          : explicitlySelectedSharedReferences.get(sharedKey)) ??
        explicitRoot?.createdBy ??
        createdBy;
      const definition = {
        ...prepared.definition,
        packageDefinitionId:
          restoredId ??
          packageId({
            contentIdentity: prepared.content.identity,
            definition: prepared.definition,
            creationInput: prepared.creationInput ?? null,
            createdBy: effectiveCreatedBy,
            discriminator:
              sharedKey !== undefined
                ? "shared-reference"
                : explicitRoot === undefined
                  ? discriminator
                  : `${explicitRoot.selectionId}:${explicitRoot.nodeIdentity}`,
          }),
      } as PersistedPackageDefinition;
      const node: PackageNode = {
        id: definition.packageDefinitionId,
        content: prepared.content,
        definition,
        createdBy: effectiveCreatedBy,
        creationInput: prepared.creationInput ?? null,
        preparation: prepared.preparation,
        dependencies: new Map(),
      };
      nodes.push(node);
      nodesById.set(node.id, node);
      nodesByPrepared.set(prepared, node);
      if (sharedKey !== undefined) sharedNodes.set(sharedKey, node);
      wiringNodes.add(node);
      for (const dependency of prepared.dependencies) {
        const provider = makeNode(
          dependency.package,
          "shared-dependency",
          `${definition.packageDefinitionId}:${dependency.key}`,
        );
        node.dependencies.set(dependency.key, provider);
      }
      wiringNodes.delete(node);
      return node;
    };

    for (const selection of preparedProject.selections) {
      const id =
        selection.selectionId ??
        selectionId({
          compositionIdentity: composition.identity,
          presetIdentity: selection.presetIdentity,
          roots: selection.roots.map((root) => ({
            nodeIdentity: root.nodeIdentity,
            contentIdentity: root.content.identity,
            creationInput: root.creationInput ?? null,
            definition: root.definition,
          })),
        });
      const nodeIds: Record<string, PackageDefinitionId> = {};
      for (const root of selection.roots) {
        const node = makeNode(
          root,
          selection.createdBy ?? "initialization",
          `${id}:${root.nodeIdentity}`,
        );
        const expected = selection.recordedNodeIds?.[root.nodeIdentity];
        if (expected !== undefined && expected !== node.id) {
          throw new Error(
            `生成记录中的选择节点实例不一致：${root.nodeIdentity}`,
          );
        }
        nodeIds[root.nodeIdentity] = node.id;
      }
      if (
        selection.recordedNodeIds !== undefined &&
        Object.keys(selection.recordedNodeIds).length !==
          Object.keys(nodeIds).length
      ) {
        throw new Error(`生成记录中的选择节点数量不一致：${id}`);
      }
      selectionRecords.push({
        selectionId: id,
        presetIdentity: selection.presetIdentity,
        nodes: nodeIds,
      });
    }

    if (preparedProject.restored !== undefined) {
      const recordedOrder = new Map(
        preparedProject.restored.generationRecord.packages.map(
          (item, index) => [item.packageDefinitionId, index],
        ),
      );
      nodes.sort(
        (left, right) =>
          (recordedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (recordedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }

    const packageRecords: GenerationRecordPackage<JsonValue>[] = nodes.map(
      (node) => ({
        packageDefinitionId: node.id,
        contentIdentity: node.content.identity,
        createdBy: node.createdBy,
        creationInput: node.creationInput,
        dependencyBindings: Object.fromEntries(
          [...node.dependencies.entries()].map(([key, provider]) => [
            key,
            provider.id,
          ]),
        ),
      }),
    );
    const packages = nodes.map((node) => ({
      packageDefinitionId: node.id,
      contentIdentity: node.content.identity,
      definition: node.definition,
      createdBy: node.createdBy,
      creationInput: node.creationInput,
      dependencyBindings: Object.fromEntries(
        [...node.dependencies.entries()].map(([key, provider]) => [
          key,
          provider.id,
        ]),
      ),
    })) satisfies CompositionPackage[];

    const bindingsFor = (
      node: PackageNode,
    ): ReadonlyMap<string, PackageBinding> => {
      const bindings = new Map<string, PackageBinding>();
      for (const { key } of node.content.definition.dependencies ?? []) {
        const provider = node.dependencies.get(key);
        if (provider === undefined) {
          throw new Error(`参考包依赖尚未绑定：${node.id} → ${key}`);
        }
        if (provider.contribution === undefined) {
          throw new Error(`依赖包尚未求值：${provider.id}`);
        }
        bindings.set(key, {
          packageDefinitionId: provider.id,
          contentIdentity: provider.content.identity,
          definition: provider.definition,
          facts: structuredClone(provider.contribution.facts),
        });
      }
      return bindings;
    };

    const provisionalBlueprint = assertProjectBlueprint({
      schemaVersion: 4,
      packages: nodes.map((node) => node.definition),
      packageLinkIntents: [],
    });
    const resolution = composition.resolve({
      conventions: preparedProject.conventions,
      blueprint: provisionalBlueprint,
      selections: selectionRecords,
      packages,
      operationFacts: preparedProject.operationFacts,
    });
    for (const id of resolution.packageInputs.keys()) {
      if (!nodes.some((node) => node.id === id)) {
        throw new Error(`组合输入引用了未知软件包实例：${id}`);
      }
    }
    const blueprint = assertProjectBlueprint({
      ...provisionalBlueprint,
      packageLinkIntents: resolution.packageLinkIntents ?? [],
    });

    if (preparedProject.restored !== undefined) {
      const existingIds = new Set(
        preparedProject.restored.generationRecord.packages.map(
          (item) => item.packageDefinitionId,
        ),
      );
      const existingBlueprintPackages = blueprint.packages.filter((item) =>
        existingIds.has(item.packageDefinitionId),
      );
      const recordedBlueprintPackages =
        preparedProject.restored.blueprint.packages.filter((item) =>
          existingIds.has(item.packageDefinitionId),
        );
      if (
        !isDeepStrictEqual(existingBlueprintPackages, recordedBlueprintPackages)
      ) {
        throw new Error("回放后的包定义与持久蓝图不一致");
      }
      const existingLinks = blueprint.packageLinkIntents.filter(
        ({ consumerId, providerId }) =>
          existingIds.has(consumerId) && existingIds.has(providerId),
      );
      if (
        !isDeepStrictEqual(
          existingLinks,
          preparedProject.restored.blueprint.packageLinkIntents,
        )
      ) {
        throw new Error("回放后的显式包连接与持久蓝图不一致");
      }
    }

    const visiting = new Set<PackageDefinitionId>();
    const complete = new Set<PackageDefinitionId>();
    const evaluate = (node: PackageNode): PackageContribution => {
      if (node.contribution !== undefined) return node.contribution;
      if (visiting.has(node.id)) throw new Error("软件包依赖图包含循环");
      visiting.add(node.id);
      for (const provider of node.dependencies.values()) {
        evaluate(provider);
      }
      const contentPreparation = clonePreparation(node.preparation);
      const contribution = node.content.definition.evaluate({
        packageDefinitionId: node.id,
        definition: node.definition,
        createdBy: node.createdBy,
        creationInput: node.creationInput,
        prepared: contentPreparation,
        bindings: bindingsFor(node),
        conventions: structuredClone(preparedProject.conventions),
        stableCommon: structuredClone(resolution.stableCommon),
        packageInput: structuredClone(resolution.packageInputs.get(node.id)),
      });
      if (contribution.packageDefinitionId !== node.id) {
        throw new Error(`包贡献返回了错误的软件包实例标识：${node.id}`);
      }
      node.contribution = contribution;
      visiting.delete(node.id);
      complete.add(node.id);
      return contribution;
    };

    for (const node of nodes) evaluate(node);
    if (complete.size !== nodes.length)
      throw new Error("部分软件包贡献尚未求值");

    const compositionPackages: CompositionPackageEvaluation[] = nodes.map(
      (node) => ({
        package: packages.find((item) => item.packageDefinitionId === node.id)!,
        bindings: bindingsFor(node),
        contribution: node.contribution!,
      }),
    );
    const combined = composition.combine({
      conventions: preparedProject.conventions,
      stableCommon: structuredClone(resolution.stableCommon),
      blueprint,
      selections: selectionRecords,
      packages: compositionPackages,
    });

    const projection = projectPackageContributions({
      blueprint,
      contributions: nodes.map((node) => node.contribution!),
      ...(combined.files === undefined
        ? {}
        : { compositionFiles: combined.files }),
      ...(combined.reconciliation === undefined
        ? {}
        : { compositionReconciliation: combined.reconciliation }),
    });
    const sourcesByPackage = new Map(
      nodes.map((node) => [
        node.id,
        {
          identity: `content:${contentIdentityKey(node.content.identity)}:${node.id}`,
          label: `${contentIdentityLabel(node.content.identity)}（${node.definition.path}）`,
        } satisfies ProjectProjectionSource,
      ]),
    );
    const packageSources = [...sourcesByPackage.values()];
    const compositionSource: ProjectProjectionSource = {
      identity: `composition:${contentIdentityKey(composition.identity)}`,
      label: `组合${contentIdentityLabel(composition.identity)}`,
    };
    const sourcesByPath = new Map<string, readonly ProjectProjectionSource[]>();
    const addPathSources = (
      targetPath: string,
      sources: readonly (ProjectProjectionSource | undefined)[],
    ): void => {
      const existing = sourcesByPath.get(targetPath) ?? [];
      const definedSources = sources.filter(
        (source): source is ProjectProjectionSource => source !== undefined,
      );
      sourcesByPath.set(
        targetPath,
        mergeProjectionSources(existing, definedSources),
      );
    };
    for (const node of nodes) {
      const source = sourcesByPackage.get(node.id)!;
      for (const file of node.contribution!.files) {
        addPathSources(projectionPath(node.definition.path, file.path), [
          source,
        ]);
      }
      for (const policy of node.contribution!.reconciliation ?? []) {
        addPathSources(projectionPath(node.definition.path, policy.path), [
          source,
        ]);
      }
    }
    const combinedSources = [compositionSource, ...packageSources];
    for (const item of combined.files ?? []) {
      const definition = blueprint.packages.find(
        (candidate) =>
          candidate.packageDefinitionId === item.packageDefinitionId,
      )!;
      addPathSources(
        projectionPath(definition.path, item.file.path),
        combinedSources,
      );
    }
    for (const item of combined.reconciliation ?? []) {
      const definition = blueprint.packages.find(
        (candidate) =>
          candidate.packageDefinitionId === item.packageDefinitionId,
      )!;
      addPathSources(
        projectionPath(definition.path, item.reconciliation.path),
        combinedSources,
      );
    }
    const annotatedProjection: ProjectProjection = {
      entries: projection.entries.map((entry) => {
        const sources = mergeProjectionSources(
          entry.sources,
          sourcesByPath.get(entry.path),
        );
        return sources.length === 0 ? entry : { ...entry, sources };
      }),
      reconciliation: projection.reconciliation.map((policy) => {
        const sources = mergeProjectionSources(
          policy.sources,
          sourcesByPath.get(policy.path),
        );
        return sources.length === 0 ? policy : { ...policy, sources };
      }),
    };
    const metadataSources = mergeProjectionSources(packageSources, [
      compositionSource,
    ]);
    const generationRecord: GenerationRecord<JsonValue, JsonValue> = {
      schemaVersion: 6,
      composition: {
        identity: composition.identity,
        conventions: preparedProject.conventions,
      },
      packages: packageRecords,
      selections: selectionRecords,
    };
    assertGenerationRecordMatchesBlueprint(generationRecord, blueprint);

    const metadataEntries: ProjectProjectionEntry[] = [
      {
        path: generatorMetadataPaths.blueprint,
        kind: "file",
        content: printCanonicalJson(blueprint),
        mode: 0,
        sources: metadataSources,
      },
      {
        path: generatorMetadataPaths.generationRecord,
        kind: "file",
        content: printCanonicalJson(generationRecord),
        mode: 0,
        sources: metadataSources,
      },
    ];
    const metadataReconciliation: ProjectProjectionReconciliation[] =
      metadataEntries.map((entry) => ({
        path: entry.path,
        driver: "canonical",
        ...(entry.sources === undefined ? {} : { sources: entry.sources }),
      }));
    const finalProjection: ProjectProjection = {
      entries: [...annotatedProjection.entries, ...metadataEntries].toSorted(
        (left, right) => comparePaths(left.path, right.path),
      ),
      reconciliation: [
        ...annotatedProjection.reconciliation,
        ...metadataReconciliation,
      ].toSorted((left, right) => comparePaths(left.path, right.path)),
    };
    return {
      blueprint,
      generationRecord,
      projection: finalProjection,
      packages: nodes.map((node) => ({
        package: packages.find((item) => item.packageDefinitionId === node.id)!,
        bindings: bindingsFor(node),
        contribution: node.contribution!,
      })),
      ownerFacts: combined.facts,
    } as unknown as InitializedProject;
  }

  async function planInit(
    initOptions: GeneratorInitializationOptions<
      ContentCreationInput<Members>,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): Promise<
    GeneratorPlanningResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    let prepared: PreparedProject<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >;
    try {
      prepared = await prepareProject({
        selection: initOptions.selection,
        conventions: initOptions.conventions,
        operationFacts: initOptions.operationFacts,
      });
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "preparation",
        error: { message: errorMessage(error) },
      };
    }

    let computed: ComputedProject<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionContributionFacts<CompositionDefinition>
    >;
    try {
      computed = computeProject(prepared);
    } catch (error) {
      const packageIdentityIssues =
        error instanceof ProjectBlueprintValidationError
          ? error.packageIdentityIssues
          : [];
      return {
        status: "operation-failure",
        phase: "calculation",
        error: {
          message: errorMessage(error),
          ...(packageIdentityIssues.length === 0
            ? {}
            : { packageIdentityIssues }),
        },
      };
    }

    try {
      const sources = mergeProjectionSources(
        ...computed.projection.entries.map((entry) => entry.sources),
        ...computed.projection.reconciliation.map((policy) => policy.sources),
      );
      const preconditions: readonly ProjectProjectionPathPrecondition[] = [
        {
          path: ".",
          kind: "directory-empty-or-missing",
          reason: "初始化要求目标目录为空或不存在",
          ...(sources.length === 0 ? {} : { sources }),
        },
      ];
      const current = await readProjectProjectionCurrent({
        targetRoot: initOptions.targetRoot,
        before: emptyProjectProjection,
        after: computed.projection,
        preconditions,
      });
      const planning = planProjectProjections({
        before: emptyProjectProjection,
        current,
        after: computed.projection,
        preconditions,
      });
      if (!planning.ok) {
        return {
          status: "conflict",
          reason: conflictReason(planning.conflicts),
          conflicts: planning.conflicts,
          actions: [],
        };
      }
      pendingPlans.set(planning.plan, {
        targetRoot: current.targetRoot,
        computed,
      });
      return {
        status: "planned",
        plan: planning.plan,
        blueprint: computed.blueprint,
        generationRecord: computed.generationRecord,
        projection: computed.projection,
        ownerFacts: computed.ownerFacts,
        actions: planning.plan.actions,
      };
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "planning",
        error: { message: errorMessage(error) },
      };
    }
  }

  async function planComputedAdd(options: {
    readonly preparation: GeneratorAdditionPreparation<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >;
    readonly before: InitializedProject;
    readonly after: InitializedProject;
    readonly readFacts?: readonly CurrentProjectProjectionEntry[];
  }): Promise<
    GeneratorPlanningResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const { preparation, before } = options;
    let after: InitializedProject;
    try {
      if (
        !isDeepStrictEqual(
          before.generationRecord,
          preparation.restored.generationRecord,
        ) ||
        !isDeepStrictEqual(before.blueprint, preparation.restored.blueprint)
      ) {
        throw new Error("Before 计算结果与恢复的项目记录不一致");
      }
      const afterPackages = new Map(
        options.after.generationRecord.packages.map((item) => [
          item.packageDefinitionId,
          item,
        ]),
      );
      const afterDefinitions = new Map(
        options.after.blueprint.packages.map((item) => [
          item.packageDefinitionId,
          item,
        ]),
      );
      for (const item of before.generationRecord.packages) {
        if (
          !isDeepStrictEqual(afterPackages.get(item.packageDefinitionId), item)
        ) {
          throw new Error(
            `After 未保留既有包实例事实：${item.packageDefinitionId}`,
          );
        }
      }
      for (const item of before.blueprint.packages) {
        if (
          !isDeepStrictEqual(
            afterDefinitions.get(item.packageDefinitionId),
            item,
          )
        ) {
          throw new Error(
            `After 未保留既有包定义：${item.packageDefinitionId}`,
          );
        }
      }
      for (const selection of before.generationRecord.selections) {
        if (
          !isDeepStrictEqual(
            options.after.generationRecord.selections.find(
              (item) => item.selectionId === selection.selectionId,
            ),
            selection,
          )
        ) {
          throw new Error(`After 未保留既有内容选择：${selection.selectionId}`);
        }
      }
      if (
        !isDeepStrictEqual(
          options.after.generationRecord.composition,
          before.generationRecord.composition,
        )
      ) {
        throw new Error("After 未保留既有组合事实");
      }
      after = {
        ...options.after,
        projection: preserveProjectionPaths(
          before.projection,
          options.after.projection,
        ),
      };
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "calculation",
        error: { message: errorMessage(error) },
      };
    }

    try {
      const existingIds = new Set(
        before.blueprint.packages.map((item) => item.packageDefinitionId),
      );
      const newPackages = after.blueprint.packages.filter(
        (item) => !existingIds.has(item.packageDefinitionId),
      );
      const sourcesById = new Map(
        after.packages.map(({ package: item }) => [
          item.packageDefinitionId,
          {
            identity: `content:${contentIdentityKey(item.contentIdentity)}:${item.packageDefinitionId}`,
            label: `${contentIdentityLabel(item.contentIdentity)}（${item.definition.path}）`,
          } satisfies ProjectProjectionSource,
        ]),
      );
      const preconditions: readonly ProjectProjectionPathPrecondition[] =
        newPackages
          .filter((item) => item.path !== ".")
          .map((item) => ({
            path: item.path,
            kind: "must-not-exist" as const,
            reason: `新包路径必须不存在：${item.path}`,
            ...(sourcesById.get(item.packageDefinitionId) === undefined
              ? {}
              : { sources: [sourcesById.get(item.packageDefinitionId)!] }),
          }));
      const current = await readProjectProjectionCurrent({
        targetRoot: preparation.restored.targetRoot,
        before: before.projection,
        after: after.projection,
        preconditions,
      });
      const planning = planProjectProjections({
        before: before.projection,
        current,
        after: after.projection,
        preconditions,
        readFacts: [...preparation.readFacts, ...(options.readFacts ?? [])],
      });
      if (!planning.ok) {
        return {
          status: "conflict",
          reason: conflictReason(planning.conflicts),
          conflicts: planning.conflicts,
          actions: [],
        };
      }
      pendingPlans.set(planning.plan, {
        targetRoot: current.targetRoot,
        computed: after,
      });
      return {
        status: "planned",
        plan: planning.plan,
        blueprint: after.blueprint,
        generationRecord: after.generationRecord,
        projection: after.projection,
        ownerFacts: after.ownerFacts,
        actions: planning.plan.actions,
      };
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "planning",
        error: { message: errorMessage(error) },
      };
    }
  }

  async function planAdd(
    addOptions: GeneratorAdditionOptions<
      ContentCreationInput<Members>,
      CompositionOperationFacts<CompositionDefinition>
    >,
  ): Promise<
    GeneratorPlanningResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const targetRoot = path.resolve(addOptions.repositoryRoot);
    let restored: GeneratorRestoredProject<ContentCreationInput<Members>>;
    try {
      restored = await restoreProject({ repositoryRoot: targetRoot });
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "metadata",
        error: { message: errorMessage(error) },
      };
    }

    let preparation: GeneratorAdditionPreparation<
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>,
      CompositionDefinition,
      CompositionOperationFacts<CompositionDefinition>
    >;
    try {
      preparation = await prepareAddProject({
        restored,
        selection: addOptions,
        operationFacts: addOptions.operationFacts,
      });
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "preparation",
        error: { message: errorMessage(error) },
      };
    }

    let before: InitializedProject;
    let after: InitializedProject;
    try {
      before = computeProject(preparation.before);
      after = computeProject(preparation.after);
    } catch (error) {
      const packageIdentityIssues =
        error instanceof ProjectBlueprintValidationError
          ? error.packageIdentityIssues
          : [];
      return {
        status: "operation-failure",
        phase: "calculation",
        error: {
          message: errorMessage(error),
          ...(packageIdentityIssues.length === 0
            ? {}
            : { packageIdentityIssues }),
        },
      };
    }
    return planComputedAdd({
      preparation,
      before,
      after,
      ...(addOptions.readFacts === undefined
        ? {}
        : { readFacts: addOptions.readFacts }),
    });
  }

  async function commitPlan(
    plan: ProjectProjectionChangePlan,
  ): Promise<
    GeneratorResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const pending = pendingPlans.get(plan);
    if (pending === undefined) {
      return {
        status: "operation-failure",
        phase: "commit",
        error: {
          message:
            "提交计划必须由当前生成器的 planInit、planAdd 或 planComputedAdd 创建",
        },
      };
    }
    try {
      const committed = await commitProjectProjectionPlan({
        targetRoot: pending.targetRoot,
        plan,
      });
      if (!committed.ok) {
        return {
          status: "conflict",
          dryRun: false,
          reason: conflictReason(committed.conflicts),
          conflicts: committed.conflicts,
          actions: [],
        };
      }
      return {
        status: "success",
        dryRun: false,
        blueprint: pending.computed.blueprint,
        generationRecord: pending.computed.generationRecord,
        projection: pending.computed.projection,
        ownerFacts: pending.computed.ownerFacts,
        actions: committed.actions,
      };
    } catch (error) {
      return {
        status: "operation-failure",
        phase: "commit",
        error: { message: errorMessage(error) },
      };
    }
  }

  async function init(
    initOptions: GeneratorInitializationOptions<
      ContentCreationInput<Members>,
      CompositionOperationFacts<CompositionDefinition>
    > & {
      readonly dryRun?: boolean;
    },
  ): Promise<
    GeneratorResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const dryRun = initOptions.dryRun ?? false;
    const planned = await planInit({
      targetRoot: initOptions.targetRoot,
      selection: initOptions.selection,
      conventions: initOptions.conventions,
      operationFacts: initOptions.operationFacts,
    });
    if (planned.status === "operation-failure") return planned;
    if (planned.status === "conflict") {
      return { ...planned, dryRun, actions: [] };
    }
    if (!dryRun) return commitPlan(planned.plan);
    return {
      status: "success",
      dryRun: true,
      blueprint: planned.blueprint,
      generationRecord: planned.generationRecord,
      projection: planned.projection,
      ownerFacts: planned.ownerFacts,
      actions: planned.actions,
    };
  }

  async function add(
    addOptions: GeneratorAdditionOptions<
      ContentCreationInput<Members>,
      CompositionOperationFacts<CompositionDefinition>
    > & { readonly dryRun?: boolean },
  ): Promise<
    GeneratorResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const { dryRun = false, ...planningOptions } = addOptions;
    const planned = await planAdd(planningOptions);
    if (planned.status === "operation-failure") return planned;
    if (planned.status === "conflict") {
      return { ...planned, dryRun, actions: [] };
    }
    if (!dryRun) return commitPlan(planned.plan);
    return {
      status: "success",
      dryRun: true,
      blueprint: planned.blueprint,
      generationRecord: planned.generationRecord,
      projection: planned.projection,
      ownerFacts: planned.ownerFacts,
      actions: planned.actions,
    };
  }

  return {
    init,
    add,
    planInit,
    planAdd,
    planComputedAdd,
    commitPlan,
    restoreProject,
    prepareAddProject,
    prepareProject,
    computeProject,
  } as unknown as Generator<
    CompositionOwnerFacts<CompositionDefinition>,
    CompositionConventions<CompositionDefinition>,
    ContentCreationInput<Members>,
    CompositionContributionFacts<CompositionDefinition>,
    CompositionDefinition
  >;
}
