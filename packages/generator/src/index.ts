import { createHash } from "node:crypto";
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
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import { assertProjectBlueprint } from "@ykdz/template-core/project-blueprint";
import {
  commitProjectProjectionPlan,
  planProjectProjections,
  readProjectProjectionCurrent,
  type ProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionChangePlan,
  type ProjectProjectionConflict,
  type ProjectProjectionEntry,
  type ProjectProjectionPathPrecondition,
  type ProjectProjectionReconciliation,
  type ProjectProjectionSource,
} from "@ykdz/template-core/project-projection";
import type {
  PreparedReference,
  PackageBinding,
  ReferencePackageDefinition,
  ReferenceSelectionRoot,
  PresetSelectionDefinition,
  PresetSelectionRequest,
} from "@ykdz/template-core/reference-package";

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
export type {
  ReferencePackage,
  ReferencePackageDefinition,
} from "@ykdz/template-core/reference-package";
export type { Composition } from "@ykdz/template-core/composition";

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
  readonly dependencies: readonly {
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
  readonly dependencies: readonly {
    readonly key: string;
    readonly package: PreparedNode<CreationInput>;
  }[];
};

type PreparedSelection<CreationInput extends JsonValue = JsonValue> = {
  readonly presetIdentity: ContentIdentity | null;
  readonly roots: readonly PreparedNode<CreationInput>[];
};

type PackageSelectionDraft<CreationInput extends JsonValue = JsonValue> = {
  readonly presetIdentity: ContentIdentity | null;
  readonly roots: readonly PackageNodeDraft<CreationInput>[];
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
      readonly phase: "preparation" | "calculation" | "planning" | "commit";
      readonly error: { readonly message: string };
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
      readonly phase: "preparation" | "calculation" | "planning" | "commit";
      readonly error: { readonly message: string };
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
  readonly createdBy: "initialization" | "shared-dependency";
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

function conflictReason(
  conflicts: readonly ProjectProjectionConflict[],
): string {
  return conflicts.map((conflict) => conflict.reason).join("\n");
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
  return selectedPaths.filter((candidate) =>
    isNestedDirectory(definition.path, candidate),
  );
}

function packageNodePaths(roots: readonly PackageNodeDraft[]): string[] {
  return roots.flatMap((root) => [
    root.definition.path,
    ...packageNodePaths(root.dependencies.map((item) => item.package)),
  ]);
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
  const pendingInitializationPlans = new WeakMap<
    ProjectProjectionChangePlan,
    { readonly targetRoot: string; readonly computed: InitializedProject }
  >();

  const resolveReference = (selector: ContentSelector): RuntimeReference =>
    contentIndex.resolve(selector, "reference") as RuntimeReference;

  const makePackageNodeDraft = (request: {
    readonly content: RuntimeReference;
    readonly nodeIdentity: string;
    readonly creationInput: ContentCreationInput<Members> | undefined;
    readonly definition: PackageDefinition;
    readonly layout?: unknown;
    readonly conventions: CompositionConventions<CompositionDefinition>;
    readonly ancestry: readonly string[];
  }): PackageNodeDraft<ContentCreationInput<Members>> => {
    const identityKey = contentIdentityKey(request.content.identity);
    if (request.ancestry.includes(identityKey)) {
      throw new Error(
        `参考包依赖形成循环：${[...request.ancestry, identityKey].join(" → ")}`,
      );
    }
    const dependencies = request.content.definition.dependencies ?? [];
    const dependencyKeys = new Set<string>();
    const dependencyDrafts: {
      key: string;
      package: PackageNodeDraft<ContentCreationInput<Members>>;
    }[] = [];
    for (const dependency of dependencies) {
      assertContentIdentity(dependency.contentIdentity);
      if (
        dependency.key.trim().length === 0 ||
        dependencyKeys.has(dependency.key)
      ) {
        throw new Error(`参考包依赖键不能为空且不能重复：${dependency.key}`);
      }
      dependencyKeys.add(dependency.key);
      const provider = resolveReference(dependency.contentIdentity);
      const providerCreationInput = requireParsedCreationInput(
        provider,
        dependency.creationInput,
      ) as ContentCreationInput<Members> | undefined;
      const providerDefinition = packageDefinition(
        provider.definition.createDefinition({
          conventions: request.conventions,
          creationInput: providerCreationInput,
        }),
      );
      const providerNode = makePackageNodeDraft({
        content: provider,
        nodeIdentity: `${request.nodeIdentity}-${dependency.key}`,
        creationInput: providerCreationInput,
        definition: providerDefinition,
        layout: undefined,
        conventions: request.conventions,
        ancestry: [...request.ancestry, identityKey],
      });
      dependencyDrafts.push({ key: dependency.key, package: providerNode });
    }
    return {
      content: request.content,
      definition: request.definition,
      creationInput: request.creationInput,
      layout: request.layout,
      nodeIdentity: request.nodeIdentity,
      dependencies: dependencyDrafts,
    };
  };

  const preparePackageNode = async (
    draft: PackageNodeDraft<ContentCreationInput<Members>>,
    selectedPaths: readonly string[],
  ): Promise<PreparedNode<ContentCreationInput<Members>>> => {
    const preparedDependencies: {
      key: string;
      package: PreparedNode<ContentCreationInput<Members>>;
    }[] = [];
    for (const dependency of draft.dependencies) {
      preparedDependencies.push({
        key: dependency.key,
        package: await preparePackageNode(dependency.package, selectedPaths),
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
      dependencies: preparedDependencies,
    };
  };

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
    const conventions = composition.parseConventions(
      prepareOptions.conventions,
    ) as CompositionConventions<CompositionDefinition>;
    assertJsonValue(conventions, "组合约定");
    const selectionDrafts: PackageSelectionDraft<
      ContentCreationInput<Members>
    >[] = [];
    const directRoots = prepareOptions.selection.roots ?? [];
    if (directRoots.length > 0) {
      const selectedRoots = directRoots.map((root) => ({
        content: resolveReference(root.contentIdentity),
        nodeIdentity: root.nodeIdentity,
        rawCreationInput: root.creationInput,
        layout: root.layout,
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
      const group = {
        presetIdentity: null,
        roots: [] as PackageNodeDraft<ContentCreationInput<Members>>[],
      };
      selectionDrafts.push(group);
      for (const root of preparedRoots) {
        group.roots.push(
          makePackageNodeDraft({
            ...root,
            conventions,
            ancestry: [],
          }),
        );
      }
      requireUniqueNodes(group.roots);
    }

    for (const presetRequest of prepareOptions.selection.presets ?? []) {
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
      if (!definition.operations.includes("init")) {
        throw new Error(
          `预设不支持初始化：${contentIdentityLabel(presetMember.identity)}`,
        );
      }
      const entries = Object.entries(definition.nodes);
      if (entries.length === 0)
        throw new Error("预设必须至少选择一个软件包节点");
      if (presetRequest.creationInput !== undefined && entries.length !== 1) {
        throw new Error("多节点预设不能接收单个软件包创建输入");
      }
      const group = {
        presetIdentity: presetMember.identity,
        roots: [] as PackageNodeDraft<ContentCreationInput<Members>>[],
      };
      selectionDrafts.push(group);
      const presetRoots: {
        readonly content: RuntimeReference;
        readonly nodeIdentity: string;
        readonly rawCreationInput: unknown;
        readonly layout?: unknown;
      }[] = [];
      for (const [nodeIdentity, node] of entries) {
        const selectedInput = mergeCreationInput(
          node.creationInput?.init,
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
      for (const root of preparedRoots) {
        group.roots.push(
          makePackageNodeDraft({
            ...root,
            conventions,
            ancestry: [],
          }),
        );
      }
      requireUniqueNodes(group.roots);
    }

    if (selectionDrafts.length === 0) {
      throw new Error("初始化至少需要选择一个参考包或预设");
    }
    const selectedPaths = [
      ...new Set(
        selectionDrafts.flatMap((selection) =>
          packageNodePaths(selection.roots),
        ),
      ),
    ];
    const selections: PreparedSelection<ContentCreationInput<Members>>[] = [];
    for (const selection of selectionDrafts) {
      const roots: PreparedNode<ContentCreationInput<Members>>[] = [];
      for (const root of selection.roots) {
        roots.push(await preparePackageNode(root, selectedPaths));
      }
      selections.push({
        presetIdentity: selection.presetIdentity,
        roots,
      });
    }
    return {
      conventions,
      composition: options.composition,
      selections,
      operationFacts:
        prepareOptions.operationFacts as CompositionOperationFacts<CompositionDefinition>,
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
    const selectionRecords: GenerationRecordSelection[] = [];
    const explicitlySelectedSharedReferences = new Set(
      preparedProject.selections.flatMap((selection) =>
        selection.roots.flatMap((root) =>
          root.content.definition.instance === "shared"
            ? [contentIdentityKey(root.content.identity)]
            : [],
        ),
      ),
    );

    const makeNode = (
      prepared: PreparedNode,
      createdBy: PackageNode["createdBy"],
      discriminator: string,
    ): PackageNode => {
      const identityKey = contentIdentityKey(prepared.content.identity);
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
          return existing;
        }
      }
      const effectiveCreatedBy =
        sharedKey !== undefined &&
        explicitlySelectedSharedReferences.has(sharedKey)
          ? "initialization"
          : createdBy;
      const definition = {
        ...prepared.definition,
        packageDefinitionId: packageId({
          contentIdentity: prepared.content.identity,
          definition: prepared.definition,
          creationInput: prepared.creationInput ?? null,
          createdBy: effectiveCreatedBy,
          discriminator:
            sharedKey === undefined ? discriminator : "shared-reference",
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
      if (sharedKey !== undefined) sharedNodes.set(sharedKey, node);
      for (const dependency of prepared.dependencies) {
        const provider = makeNode(
          dependency.package,
          "shared-dependency",
          `${definition.packageDefinitionId}:${dependency.key}`,
        );
        node.dependencies.set(dependency.key, provider);
      }
      return node;
    };

    for (const selection of preparedProject.selections) {
      const id = selectionId({
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
          "initialization",
          `${id}:${root.nodeIdentity}`,
        );
        nodeIds[root.nodeIdentity] = node.id;
      }
      selectionRecords.push({
        selectionId: id,
        presetIdentity: selection.presetIdentity,
        nodes: nodeIds,
      });
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
      for (const [key, provider] of node.dependencies) {
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
        path: ".template/blueprint.json",
        kind: "file",
        content: printCanonicalJson(blueprint),
        mode: 0,
        sources: metadataSources,
      },
      {
        path: ".template/generation.json",
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
      return {
        status: "operation-failure",
        phase: "calculation",
        error: { message: errorMessage(error) },
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
      pendingInitializationPlans.set(planning.plan, {
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

  async function commitPlan(
    plan: ProjectProjectionChangePlan,
  ): Promise<
    GeneratorResult<
      CompositionOwnerFacts<CompositionDefinition>,
      CompositionConventions<CompositionDefinition>,
      ContentCreationInput<Members>
    >
  > {
    const pending = pendingInitializationPlans.get(plan);
    if (pending === undefined) {
      return {
        status: "operation-failure",
        phase: "commit",
        error: { message: "提交计划必须由当前生成器的 planInit 创建" },
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

  return {
    init,
    planInit,
    commitPlan,
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
