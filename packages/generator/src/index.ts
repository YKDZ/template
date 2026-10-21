import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  assertPackageContribution,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  PresetDefinition,
  PresetProjectOptions,
  PresetReference,
} from "@ykdz/template-core/preset-definition";
import {
  assertProjectBlueprint,
  type PackageDefinition,
  type PackageDefinitionId,
  type PersistedPackageDefinition,
  type ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import {
  reconcileAndApplyProjectProjections,
  materializeProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
  type ProjectProjectionPathPrecondition,
} from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parseGenerationRecordStructure } from "@ykdz/template-core/workspace-strategy";
import type {
  GenerationRecord,
  GeneratorContent,
  GeneratorNodeInstanceIds,
  GeneratorNodeInstances,
  GeneratorPackageRecord,
  GeneratorPackageState,
  GeneratorSelectionRoot,
  PackageCreationInput,
  WorkspaceStrategyFailureDiagnostic,
  WorkspaceProjection,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";

export type { GenerationRecord } from "@ykdz/template-core/workspace-strategy";
export { generationRecordSchema } from "@ykdz/template-core/workspace-strategy";

type GeneratorRecord<CreationInput extends PackageCreationInput> =
  GenerationRecord<CreationInput>;

type PackageNode<
  Context,
  Contribution extends PackageContribution,
  CreationInput extends PackageCreationInput,
  Content extends GeneratorContent<Context, Contribution, CreationInput>,
> = {
  readonly content: Content;
  definition: PackageDefinition;
  readonly nodeIdentity?: string;
  readonly createdBy: GeneratorPackageRecord["createdBy"];
  readonly creationInput?: CreationInput;
  readonly configuration: unknown;
  readonly providers: Map<
    string,
    PackageNode<Context, Contribution, CreationInput, Content>
  >;
  record?: GeneratorPackageRecord<CreationInput>;
  contribution?: Contribution;
  preparation?: unknown;
  preparationComplete?: boolean;
};

export type GeneratorResult<
  CreationInput extends PackageCreationInput = PackageCreationInput,
  OwnerFacts = unknown,
> =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GenerationRecord<CreationInput>;
      /** 无动作幂等结果没有新的投影。 */
      readonly projection: WorkspaceProjection<OwnerFacts> | null;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly status: "input-invalid";
      readonly issues: readonly { readonly code: string }[];
    }
  | {
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly reason: string;
      readonly conflicts: readonly ProjectProjectionConflict[];
      /** 同次目标身份比较得到的既有与请求包身份。 */
      readonly identityConflict?: {
        readonly existing: GeneratorPackageIdentity;
        readonly requested: GeneratorPackageIdentity;
      };
      /** 所属 workspace 产生的用户冲突事实，由其公开 owner 解释。 */
      readonly ownerConflict?: {
        readonly code: string;
        readonly facts: unknown;
      };
      readonly actions: readonly [];
    }
  | {
      readonly status: "operation-failure";
      readonly phase: "metadata" | "planning" | "render" | "reconciliation";
      readonly error: {
        readonly message: string;
        readonly diagnostic?: WorkspaceStrategyFailureDiagnostic;
      };
    };

export type GeneratorPackageIdentity = Pick<
  PackageDefinition,
  "name" | "path" | "role"
>;

function packageIdentity(
  definition: PackageDefinition,
): GeneratorPackageIdentity {
  return {
    name: definition.name,
    path: definition.path,
    role: definition.role,
  };
}

export type Generator<
  Input,
  CreationInput extends PackageCreationInput = PackageCreationInput,
  Reference extends PresetReference = PresetReference,
  NodeLayout = unknown,
  Context = unknown,
  Contribution extends PackageContribution = PackageContribution,
  PresetProjectContribution = unknown,
  OwnerFacts = unknown,
> = {
  init(options: {
    readonly targetRoot: string;
    readonly selection: {
      readonly roots: readonly GeneratorSelectionInput<
        Reference,
        CreationInput,
        NodeLayout,
        Context,
        Contribution,
        PresetProjectContribution
      >[];
    };
    readonly strategyInput: Input;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult<CreationInput, OwnerFacts>>;
  add(
    options: {
      readonly repositoryRoot: string;
      readonly creationInput?: CreationInput;
      readonly configuration?: unknown;
      readonly dryRun?: boolean;
    } & (
      | { readonly contentIdentity: ContentSelector }
      | {
          readonly preset:
            | ContentSelector
            | PresetDefinition<
                Reference,
                NodeLayout,
                CreationInput,
                PresetProjectOptions<Context, Contribution>,
                PresetProjectContribution
              >;
        }
    ),
  ): Promise<GeneratorResult<CreationInput, OwnerFacts>>;
};

type GeneratorSelectionInput<
  Reference extends PresetReference,
  CreationInput extends PackageCreationInput,
  NodeLayout,
  Context,
  Contribution,
  PresetProjectContribution,
> =
  | GeneratorSelectionRoot<CreationInput, NodeLayout>
  | {
      readonly preset:
        | ContentSelector
        | PresetDefinition<
            Reference,
            NodeLayout,
            CreationInput,
            PresetProjectOptions<Context, Contribution>,
            PresetProjectContribution
          >;
      readonly creationInput?: CreationInput;
      readonly configuration?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresetDefinition<
  Reference extends PresetReference,
  NodeLayout,
  CreationInput,
  ProjectOptions,
  ProjectContribution,
>(
  value: unknown,
): value is PresetDefinition<
  Reference,
  NodeLayout,
  CreationInput,
  ProjectOptions,
  ProjectContribution
> {
  return isRecord(value) && value.kind === "preset" && isRecord(value.nodes);
}

function isLoadedPreset(
  value: unknown,
): value is LoadedContentMember<unknown, "preset"> {
  return (
    isRecord(value) &&
    value.kind === "preset" &&
    isRecord(value.definition) &&
    isPresetDefinition(value.definition)
  );
}

function mergeCreationInput<CreationInput extends PackageCreationInput>(
  defaults: CreationInput | undefined,
  supplied: CreationInput | undefined,
): CreationInput | undefined {
  if (defaults === undefined) return supplied;
  if (supplied === undefined) return defaults;
  return { ...defaults, ...supplied };
}

function fail(
  phase: "metadata" | "planning" | "render" | "reconciliation",
  error: unknown,
  diagnostic?: WorkspaceStrategyFailureDiagnostic,
): {
  readonly status: "operation-failure";
  readonly phase: "metadata" | "planning" | "render" | "reconciliation";
  readonly error: {
    readonly message: string;
    readonly diagnostic?: WorkspaceStrategyFailureDiagnostic;
  };
} {
  return {
    status: "operation-failure",
    phase,
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

class AdditionPlanningFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

function readJson(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + " must be an object");
  return value;
}

function presetSelectionKey(identity: ContentIdentity): string {
  return contentIdentityKey(identity);
}

function parsePresetSelections(value: unknown): ContentIdentity[] {
  if (!Array.isArray(value)) throw new Error("生成记录的预设选择无效");
  const seen = new Set<string>();
  return value.map((item) => {
    const selection = readJson(
      item,
      "生成记录预设选择",
    ) as unknown as ContentIdentity;
    assertContentIdentity(selection);
    const key = presetSelectionKey(selection);
    if (seen.has(key)) throw new Error("生成记录的预设选择重复");
    seen.add(key);
    return { ...selection };
  });
}

export function parseGenerationRecord<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(value: unknown): GenerationRecord<CreationInput> {
  const record = parseGenerationRecordStructure<CreationInput>(value);
  const nodeInstances = record.nodeInstances;
  const packageIds = new Set<string>();
  for (const packageRecord of record.packages) {
    assertContentIdentity(packageRecord.contentIdentity);
    if (packageIds.has(packageRecord.packageDefinitionId)) {
      throw new Error(
        "生成记录包含重复包实例：" + packageRecord.packageDefinitionId,
      );
    }
    packageIds.add(packageRecord.packageDefinitionId);
  }
  for (const packageRecord of record.packages) {
    for (const [identity, packageDefinitionId] of Object.entries(
      packageRecord.bindings,
    )) {
      if (identity.length === 0 || !packageIds.has(packageDefinitionId)) {
        throw new Error(
          `生成记录中的内容 ${contentIdentityLabel(packageRecord.contentIdentity)} 包含无效实例绑定：${identity}`,
        );
      }
    }
  }
  for (const [nodeIdentity, packageDefinitionId] of Object.entries(
    nodeInstances,
  )) {
    if (
      nodeIdentity.length === 0 ||
      typeof packageDefinitionId !== "string" ||
      !packageIds.has(packageDefinitionId)
    ) {
      throw new Error("生成记录的节点实例映射无效");
    }
  }
  const presetSelections = parsePresetSelections(record.presetSelections);
  return {
    schemaVersion: 4,
    strategyIdentity: record.strategyIdentity,
    strategyState: record.strategyState,
    packages: record.packages,
    nodeInstances: nodeInstances,
    presetSelections,
  };
}

function packageId(options: {
  readonly contentIdentity: ContentIdentity;
  readonly createdBy: GeneratorPackageRecord["createdBy"];
  readonly definition: PackageDefinition;
  readonly occupied: ReadonlySet<PackageDefinitionId>;
}): PackageDefinitionId {
  const facts = {
    domain: "ykdz.template.generator.package-instance.v1",
    contentIdentity: options.contentIdentity,
    createdBy: options.createdBy,
    definition: options.definition,
  };
  let nonce = 0;
  for (;;) {
    const value =
      nonce === 0
        ? facts
        : { facts, occupied: [...options.occupied].toSorted(), nonce };
    const candidate =
      "package-" +
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (!options.occupied.has(candidate as PackageDefinitionId)) {
      return candidate as PackageDefinitionId;
    }
    nonce += 1;
  }
}

export function createGenerator<
  Context,
  Input,
  State,
  Contribution extends PackageContribution,
  CreationInput extends PackageCreationInput,
  Content extends GeneratorContent<Context, Contribution, CreationInput>,
  NodeLayout,
  PresetProjectContribution = unknown,
  OwnerFacts = unknown,
>(options: {
  readonly content: readonly LoadedContentMember[];
  readonly strategy: WorkspaceStrategy<
    Context,
    Input,
    State,
    Contribution,
    CreationInput,
    Content,
    NodeLayout,
    PresetProjectContribution,
    OwnerFacts
  >;
}): Generator<
  Input,
  CreationInput,
  Content["definition"] & PresetReference,
  NodeLayout,
  Context,
  Contribution,
  PresetProjectContribution,
  OwnerFacts
> {
  const contentIndex = createContentIndex(options.content);
  const contentMembers = contentIndex.members.filter(
    (member) => member.kind === "reference",
  ) as Content[];
  const presetMembers = contentIndex.members.filter(isLoadedPreset);
  const contentByIdentity = new Map(
    contentMembers.map((content) => [
      contentIdentityKey(content.identity),
      content,
    ]),
  );
  const preparations = new WeakMap<object, unknown>();
  const preparedDefinitions = new WeakSet<object>();
  const prepareContent = (content: Content): unknown => {
    const definition = content.definition;
    if (preparedDefinitions.has(definition))
      return preparations.get(definition);
    const preparation = definition.prepare?.();
    preparations.set(definition, preparation);
    preparedDefinitions.add(definition);
    return preparation;
  };
  type LoadedPreset = LoadedContentMember<
    PresetDefinition<
      Content["definition"],
      NodeLayout,
      CreationInput,
      PresetProjectOptions<Context, Contribution>,
      PresetProjectContribution
    >,
    "preset"
  >;
  const presetsByIdentity = new Map<string, LoadedPreset>();
  for (const presetMember of presetMembers) {
    const preset = presetMember.definition as LoadedPreset["definition"];
    const identityKey = contentIdentityKey(presetMember.identity);
    if (presetsByIdentity.has(identityKey)) {
      throw new Error(
        `预设规范身份重复：${contentIdentityLabel(presetMember.identity)}`,
      );
    }
    presetsByIdentity.set(identityKey, presetMember as LoadedPreset);
    for (const node of Object.values(preset.nodes)) {
      try {
        contentIndex.fromDefinition(node.reference, "reference", {
          namespace: presetMember.identity.namespace,
        });
      } catch (error) {
        throw new Error(
          `预设${contentIdentityLabel(presetMember.identity)}引用未装载的来源定义：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }

  function requireContent(selector: ContentSelector): Content {
    return contentIndex.resolve(selector, "reference") as Content;
  }

  function resolvePreset(selector: unknown): LoadedPreset {
    const member = isPresetDefinition(selector)
      ? contentIndex.fromDefinition(selector, "preset")
      : contentIndex.resolve(selector as ContentSelector, "preset");
    return member as LoadedPreset;
  }

  function expandPreset(options_: {
    readonly preset: LoadedPreset;
    readonly operation: "init" | "add";
    readonly creationInput?: CreationInput;
    readonly configuration?: unknown;
  }): GeneratorSelectionRoot<CreationInput, NodeLayout>[] {
    const preset = options_.preset.definition;
    if (!preset.operations.includes(options_.operation)) {
      throw new Error(`预设不支持${options_.operation}操作`);
    }
    const nodes = Object.entries(preset.nodes);
    if (
      (options_.creationInput !== undefined ||
        options_.configuration !== undefined) &&
      nodes.length !== 1
    ) {
      throw new Error("多节点预设不能接收单一包创建输入");
    }
    return nodes.map(([nodeIdentity, node]) => {
      const creationInput = mergeCreationInput(
        node.creationInput?.[options_.operation],
        options_.creationInput,
      );
      const reference = contentIndex.fromDefinition(
        node.reference,
        "reference",
        { namespace: options_.preset.identity.namespace },
      ) as Content;
      return {
        nodeIdentity,
        contentIdentity: reference.identity,
        ...(node.layout === undefined ? {} : { layout: node.layout }),
        ...(creationInput === undefined ? {} : { creationInput }),
        configuration:
          options_.configuration === undefined
            ? node.configuration?.[options_.operation]
            : options_.configuration,
      };
    });
  }

  function findByPackageId(
    records: readonly GeneratorPackageState<CreationInput>[],
    id: string,
  ): GeneratorPackageState<CreationInput> {
    const record = records.find(
      (candidate) => candidate.packageDefinitionId === id,
    );
    if (record === undefined) {
      throw new Error("生成记录引用了不存在的包实例：" + id);
    }
    return record;
  }

  function normalizeConfiguration(content: Content, input: unknown): unknown {
    if (content.definition.normalizeConfiguration !== undefined)
      return content.definition.normalizeConfiguration(input) ?? null;
    if (input !== undefined && input !== null)
      throw new Error(
        `内容 ${contentIdentityLabel(content.identity)} 不支持实例配置`,
      );
    return null;
  }

  function resolvePackageStates(
    records: readonly GeneratorPackageRecord<CreationInput>[],
    blueprint: ProjectBlueprint,
  ): GeneratorPackageState<CreationInput>[] {
    const definitionsById = new Map(
      blueprint.packages.map((definition) => [
        definition.packageDefinitionId,
        definition,
      ]),
    );
    if (definitionsById.size !== records.length) {
      throw new Error("生成记录与蓝图的包实例数量不一致");
    }
    for (const definition of blueprint.packages) {
      if (
        !records.some(
          (record) =>
            record.packageDefinitionId === definition.packageDefinitionId,
        )
      ) {
        throw new Error(
          `蓝图包实例缺少生成记录事实：${definition.packageDefinitionId}`,
        );
      }
    }
    return records.map((record) => {
      const definition = definitionsById.get(record.packageDefinitionId);
      if (definition === undefined) {
        throw new Error(
          `蓝图缺少内容 ${contentIdentityLabel(record.contentIdentity)} 对应的包实例：${record.packageDefinitionId}`,
        );
      }
      const configuration = normalizeConfiguration(
        requireContent(record.contentIdentity),
        record.configuration,
      );
      if (!isDeepStrictEqual(configuration, record.configuration))
        throw new Error(`生成记录包含未规范化的实例配置：${definition.path}`);
      return { ...record, definition };
    });
  }

  function requiredDependencyIdentities(
    records: readonly GeneratorPackageState<CreationInput>[],
  ): ReadonlyMap<string, readonly ContentIdentity[]> {
    const dependenciesByPackageId = new Map<
      string,
      readonly ContentIdentity[]
    >();
    for (const record of records) {
      const content = requireContent(record.contentIdentity);
      dependenciesByPackageId.set(
        record.definition.packageDefinitionId,
        options.strategy.dependencies({
          content,
          contentByIdentity,
          configuration: record.configuration,
          ...(record.creationInput === null
            ? {}
            : { creationInput: record.creationInput }),
        }),
      );
    }
    return dependenciesByPackageId;
  }

  function validateRequiredBindings(
    records: readonly GeneratorPackageState<CreationInput>[],
    dependenciesByPackageId: ReadonlyMap<
      string,
      readonly ContentIdentity[]
    > = requiredDependencyIdentities(records),
    providers: readonly GeneratorPackageState<CreationInput>[] = records,
  ): void {
    for (const record of records) {
      const dependencies = dependenciesByPackageId.get(
        record.definition.packageDefinitionId,
      );
      if (dependencies === undefined) {
        throw new Error(
          "生成记录缺少已准备的内容依赖：" +
            contentIdentityLabel(record.contentIdentity),
        );
      }
      for (const dependency of dependencies) {
        const dependencyKey = contentIdentityKey(dependency);
        const packageDefinitionId = record.bindings[dependencyKey];
        if (packageDefinitionId === undefined) {
          throw new Error(
            `生成记录中的内容 ${contentIdentityLabel(record.contentIdentity)} 缺少必要实例绑定：${contentIdentityLabel(dependency)}`,
          );
        }
        const provider = findByPackageId(providers, packageDefinitionId);
        if (contentIdentityKey(provider.contentIdentity) !== dependencyKey) {
          throw new Error(
            `生成记录中的内容 ${contentIdentityLabel(record.contentIdentity)} 将依赖绑定到错误实例：${contentIdentityLabel(dependency)}`,
          );
        }
      }
    }
  }

  function validateNodeInstances(
    records: readonly GeneratorPackageState<CreationInput>[],
    nodeInstances: GeneratorNodeInstanceIds,
  ): void {
    const mappedIds = new Set(Object.values(nodeInstances));
    for (const record of records) {
      if (
        record.createdBy === "initialization" &&
        !mappedIds.has(record.packageDefinitionId)
      ) {
        throw new Error(
          `生成记录中的内容 ${contentIdentityLabel(record.contentIdentity)} 缺少必要节点实例映射：${record.packageDefinitionId}`,
        );
      }
    }
  }

  function validatePresetSelections(
    selections: readonly ContentIdentity[],
  ): void {
    for (const selection of selections) {
      if (!presetsByIdentity.has(presetSelectionKey(selection))) {
        throw new Error(
          `生成记录所选预设不可用：${contentIdentityLabel(selection)}`,
        );
      }
    }
  }

  function resolveNodeInstances(
    records: readonly GeneratorPackageState<CreationInput>[],
    nodeInstances: GeneratorNodeInstanceIds,
  ): GeneratorNodeInstances {
    return new Map(
      Object.entries(nodeInstances).map(
        ([nodeIdentity, packageDefinitionId]) => [
          nodeIdentity,
          findByPackageId(records, packageDefinitionId).definition,
        ],
      ),
    );
  }

  function addRecordNodes(
    records: readonly GeneratorPackageState<CreationInput>[],
  ): PackageNode<Context, Contribution, CreationInput, Content>[] {
    return records.map((record) => {
      return {
        content: requireContent(record.contentIdentity),
        definition: record.definition,
        createdBy: record.createdBy,
        configuration: record.configuration,
        ...(record.creationInput === null
          ? {}
          : { creationInput: record.creationInput }),
        providers: new Map(),
        record,
      };
    });
  }

  function createContribution(
    node: PackageNode<Context, Contribution, CreationInput, Content>,
    context: Context,
    allRecords: readonly GeneratorPackageState<CreationInput>[],
    nodeInstances: GeneratorNodeInstances,
  ): Contribution {
    if (node.contribution !== undefined) return node.contribution;
    const providerDefinitions = new Map<string, PackageDefinition>();
    const bindings = node.record?.bindings;
    if (bindings !== undefined) {
      for (const [identity, id] of Object.entries(bindings)) {
        const record = findByPackageId(allRecords, id);
        providerDefinitions.set(identity, record.definition);
      }
    } else {
      for (const [identity, provider] of node.providers) {
        if (provider.record === undefined) {
          throw new Error("内容闭包的包实例尚未登记：" + identity);
        }
        providerDefinitions.set(identity, provider.definition);
      }
    }
    const nativeBindings = options.strategy.bindings({
      content: node.content,
      contentByIdentity,
      providers: providerDefinitions,
    });
    const contributionOptions = {
      context,
      configuration: node.configuration,
      definition: node.definition,
      bindings: nativeBindings,
      createdBy: node.createdBy,
      nodeInstances,
      ...(node.preparationComplete ? { preparation: node.preparation } : {}),
      ...(node.creationInput === undefined
        ? {}
        : { creationInput: node.creationInput }),
    };
    const contribution =
      node.content.definition.contribute(contributionOptions);
    const contributionDefinition = contribution.definition;
    if (
      contributionDefinition.name !== node.definition.name ||
      contributionDefinition.path !== node.definition.path ||
      contributionDefinition.role !== node.definition.role ||
      ("packageDefinitionId" in contributionDefinition &&
        contributionDefinition.packageDefinitionId !==
          node.record?.packageDefinitionId)
    ) {
      throw new Error(
        `内容 ${contentIdentityLabel(node.content.identity)} 返回的包定义与已分配实例不一致：${node.definition.path}`,
      );
    }
    assertPackageContribution(
      {
        definition: node.definition,
        operations: contribution.operations,
      },
      {
        definitionName: contentIdentityLabel(node.content.identity),
        planner: "内容贡献",
      },
    );
    node.contribution = contribution;
    return node.contribution;
  }

  function storedRecord(
    state: State,
    records: readonly GeneratorPackageState<CreationInput>[],
    nodeInstances: GeneratorNodeInstanceIds,
    presetSelections: readonly ContentIdentity[],
  ): GeneratorRecord<CreationInput> {
    return {
      schemaVersion: 4,
      strategyIdentity: options.strategy.identity,
      strategyState: state,
      packages: records.map(({ definition: _definition, ...record }) => record),
      nodeInstances,
      presetSelections,
    };
  }

  function selectedPreset(preset: LoadedPreset): ContentIdentity {
    return preset.identity;
  }

  function mergePresetSelections(
    existing: readonly ContentIdentity[],
    added: readonly ContentIdentity[],
  ): ContentIdentity[] {
    const selections = new Map<string, ContentIdentity>();
    for (const selection of [...existing, ...added]) {
      selections.set(presetSelectionKey(selection), selection);
    }
    return [...selections.values()];
  }

  function computePresetProjectContributions(
    context: Context,
    contributions: readonly Contribution[],
    nodeInstances: GeneratorNodeInstances,
    presetSelections: readonly ContentIdentity[],
  ): PresetProjectContribution[] {
    return presetSelections.flatMap((selection) => {
      const presetMember = presetsByIdentity.get(presetSelectionKey(selection));
      if (presetMember === undefined) {
        throw new Error(
          `生成记录所选预设不可用：${contentIdentityLabel(selection)}`,
        );
      }
      if (presetMember.definition.project === undefined) return [];
      return presetMember.definition.project({
        context,
        contributions,
        nodeInstances,
      });
    });
  }

  function project(
    context: Context,
    state: State,
    blueprint: ProjectBlueprint,
    records: readonly GeneratorPackageState<CreationInput>[],
    contributions: readonly Contribution[],
    nodeInstances: GeneratorNodeInstanceIds,
    presetSelections: readonly ContentIdentity[],
  ) {
    const resolvedNodeInstances = resolveNodeInstances(records, nodeInstances);
    const presetProjectContributions = computePresetProjectContributions(
      context,
      contributions,
      resolvedNodeInstances,
      presetSelections,
    );
    const projection = options.strategy.project({
      context,
      state,
      blueprint,
      packages: records,
      contributions,
      nodeInstances: resolvedNodeInstances,
      presetProjectContributions,
    });
    const projectedBlueprint = assertProjectBlueprint(
      projection.blueprint ?? blueprint,
    );
    const allocatedDefinitions = new Map(
      records.map((record) => [record.packageDefinitionId, record.definition]),
    );
    if (projectedBlueprint.packages.length !== allocatedDefinitions.size) {
      throw new Error("策略蓝图必须引用完整且唯一的已分配包实例");
    }
    for (const projectedDefinition of projectedBlueprint.packages) {
      const allocated = allocatedDefinitions.get(
        projectedDefinition.packageDefinitionId,
      );
      if (
        allocated === undefined ||
        allocated.name !== projectedDefinition.name ||
        allocated.path !== projectedDefinition.path ||
        allocated.role !== projectedDefinition.role
      ) {
        throw new Error(
          "策略蓝图中的包定义必须与生成器分配的包实例一致：" +
            projectedDefinition.path,
        );
      }
      allocatedDefinitions.delete(projectedDefinition.packageDefinitionId);
    }
    if (allocatedDefinitions.size > 0) {
      throw new Error("策略蓝图遗漏了已分配的包实例");
    }
    const generationRecord = storedRecord(
      state,
      records,
      nodeInstances,
      presetSelections,
    );
    return {
      ...projection,
      blueprint: projectedBlueprint,
      operations: [
        ...projection.operations,
        {
          kind: "writeJson" as const,
          to: ".template/generation.json",
          value: generationRecord,
        },
      ],
      generationRecord,
    };
  }

  function hydrateNewNodes(options_: {
    readonly roots: readonly PackageNode<
      Context,
      Contribution,
      CreationInput,
      Content
    >[];
    readonly existing: readonly PackageNode<
      Context,
      Contribution,
      CreationInput,
      Content
    >[];
    readonly context: Context;
    readonly occupiedIds: Set<PackageDefinitionId>;
  }): PackageNode<Context, Contribution, CreationInput, Content>[] {
    const newNodes = new Map<
      string,
      PackageNode<Context, Contribution, CreationInput, Content>
    >();
    const visiting = new Set<string>();
    const expanded = new Set<string>();

    const visit = (
      node: PackageNode<Context, Contribution, CreationInput, Content>,
    ): void => {
      const identity = contentIdentityKey(node.content.identity);
      const key = identity + "\u0000" + node.definition.path;
      if (node.record !== undefined) return;
      if (visiting.has(key)) {
        throw new Error(
          "显式内容依赖形成循环：" +
            contentIdentityLabel(node.content.identity),
        );
      }
      if (expanded.has(key)) return;
      visiting.add(key);
      newNodes.set(key, node);
      node.preparation = prepareContent(node.content);
      node.preparationComplete = true;
      const dependencies = options.strategy.dependencies({
        content: node.content,
        contentByIdentity,
        configuration: node.configuration,
        ...(node.creationInput === undefined
          ? {}
          : { creationInput: node.creationInput }),
      });
      for (const dependencyIdentity of dependencies) {
        const dependencyKey = contentIdentityKey(dependencyIdentity);
        const dependency = requireContent(dependencyIdentity);
        const candidates = [...options_.existing, ...newNodes.values()].filter(
          (candidate) =>
            contentIdentityKey(candidate.content.identity) === dependencyKey,
        );
        if (candidates.length > 1) {
          throw new Error(
            "依赖内容有多个持久实例，无法唯一绑定：" +
              contentIdentityLabel(dependencyIdentity),
          );
        }
        let provider = candidates[0];
        if (provider === undefined) {
          if (dependency.definition.instance !== "shared") {
            throw new Error(
              "缺少明确的独立依赖实例：" +
                contentIdentityLabel(dependencyIdentity),
            );
          }
          const definition = options.strategy.createDefinition({
            context: options_.context,
            content: dependency,
          });
          const occupied = [...options_.existing, ...newNodes.values()].find(
            (candidate) =>
              candidate.definition.name === definition.name ||
              candidate.definition.path === definition.path,
          );
          if (occupied !== undefined) {
            throw new Error("共享依赖默认身份已被占用：" + definition.path);
          }
          provider = {
            content: dependency,
            definition,
            createdBy: "shared-dependency",
            configuration: normalizeConfiguration(dependency, undefined),
            providers: new Map(),
          };
          newNodes.set(dependencyKey + "\u0000" + definition.path, provider);
        }
        node.providers.set(dependencyKey, provider);
        visit(provider);
      }
      visiting.delete(key);
      expanded.add(key);
    };

    const explicitByContent = new Set<string>();
    const explicitByPath = new Set<string>();
    const explicitByNode = new Set<string>();
    for (const root of options_.roots) {
      const identity = contentIdentityKey(root.content.identity);
      const key = identity + "\u0000" + root.definition.path;
      if (explicitByNode.has(root.nodeIdentity ?? "")) {
        throw new Error("显式初始化节点身份重复：" + root.nodeIdentity);
      }
      explicitByNode.add(root.nodeIdentity ?? "");
      if (
        root.content.definition.instance === "independent" &&
        explicitByContent.has(identity)
      ) {
        throw new Error(
          "同一独立内容不能重复作为显式根：" +
            contentIdentityLabel(root.content.identity),
        );
      }
      explicitByContent.add(identity);
      if (explicitByPath.has(root.definition.path)) {
        throw new Error("显式初始化根路径重复：" + root.definition.path);
      }
      explicitByPath.add(root.definition.path);
      newNodes.set(key, root);
    }

    for (const root of options_.roots) visit(root);
    const nodes = [...newNodes.values()];
    for (const node of nodes) {
      const persisted: PersistedPackageDefinition = {
        ...node.definition,
        packageDefinitionId: packageId({
          contentIdentity: node.content.identity,
          createdBy: node.createdBy,
          definition: node.definition,
          occupied: options_.occupiedIds,
        }),
      };
      options_.occupiedIds.add(persisted.packageDefinitionId);
      node.definition = persisted;
      node.record = {
        contentIdentity: node.content.identity,
        createdBy: node.createdBy,
        packageDefinitionId: persisted.packageDefinitionId,
        creationInput: node.creationInput ?? null,
        configuration: node.configuration,
        bindings: {},
      };
    }
    for (const node of nodes) {
      const bindings = Object.fromEntries(
        [...node.providers].map(([identity, provider]) => {
          if (provider.record === undefined) {
            throw new Error("内容闭包绑定缺少包实例：" + identity);
          }
          return [identity, provider.record.packageDefinitionId];
        }),
      );
      node.record = { ...node.record!, bindings };
    }
    return nodes;
  }

  function persistedContributions(
    nodes: readonly PackageNode<
      Context,
      Contribution,
      CreationInput,
      Content
    >[],
    context: Context,
    records: readonly GeneratorPackageState<CreationInput>[],
    nodeInstances: GeneratorNodeInstances,
  ): Contribution[] {
    return nodes.map((node) =>
      createContribution(node, context, records, nodeInstances),
    );
  }

  async function init(initOptions: {
    readonly targetRoot: string;
    readonly selection: {
      readonly roots: readonly GeneratorSelectionInput<
        Content["definition"] & PresetReference,
        CreationInput,
        NodeLayout,
        Context,
        Contribution,
        PresetProjectContribution
      >[];
    };
    readonly strategyInput: Input;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult<CreationInput, OwnerFacts>> {
    try {
      const selectedPresets: ContentIdentity[] = [];
      for (const root of initOptions.selection.roots) {
        if (!("preset" in root)) continue;
        selectedPresets.push(selectedPreset(resolvePreset(root.preset)));
      }
      const presetSelections = mergePresetSelections([], selectedPresets);
      const selectionRoots = initOptions.selection.roots.flatMap((root) =>
        "preset" in root
          ? expandPreset({
              preset: resolvePreset(root.preset),
              operation: "init",
              configuration: root.configuration,
              ...(root.creationInput === undefined
                ? {}
                : { creationInput: root.creationInput }),
            })
          : [
              {
                ...root,
                contentIdentity: requireContent(root.contentIdentity).identity,
              },
            ],
      );
      if (selectionRoots.length === 0) {
        throw new Error("初始化至少需要一个显式内容根");
      }
      const rootsByIdentity = new Set<string>();
      for (const root of selectionRoots) {
        if (root.nodeIdentity.length === 0) {
          throw new Error("显式初始化节点身份不能为空");
        }
        if (rootsByIdentity.has(root.nodeIdentity)) {
          throw new Error("显式初始化节点身份重复：" + root.nodeIdentity);
        }
        rootsByIdentity.add(root.nodeIdentity);
        requireContent(root.contentIdentity);
      }
      const prepared = options.strategy.initialize({
        targetRoot: initOptions.targetRoot,
        input: initOptions.strategyInput,
        selection: selectionRoots,
        contentByIdentity,
      });
      const roots: PackageNode<
        Context,
        Contribution,
        CreationInput,
        Content
      >[] = selectionRoots.map((root) => {
        const content = requireContent(root.contentIdentity);
        const definition = options.strategy.createDefinition({
          context: prepared.context,
          content,
          ...(root.layout === undefined ? {} : { layout: root.layout }),
          ...(root.creationInput === undefined
            ? {}
            : { creationInput: root.creationInput }),
        });
        return {
          content,
          definition,
          nodeIdentity: root.nodeIdentity,
          createdBy: "initialization" as const,
          configuration: normalizeConfiguration(content, root.configuration),
          ...(root.creationInput === undefined
            ? {}
            : { creationInput: root.creationInput }),
          providers: new Map<
            string,
            PackageNode<Context, Contribution, CreationInput, Content>
          >(),
        };
      });
      const nodes = hydrateNewNodes({
        roots,
        existing: [],
        context: prepared.context,
        occupiedIds: new Set(),
      });
      const records = nodes.flatMap((node) =>
        node.record === undefined ? [] : [node.record],
      );
      const nodeInstances = Object.fromEntries(
        roots.map((root) => {
          if (root.record === undefined) {
            throw new Error("显式初始化节点没有持久实例：" + root.nodeIdentity);
          }
          return [root.nodeIdentity, root.record.packageDefinitionId];
        }),
      );
      const blueprint = assertProjectBlueprint({
        schemaVersion: 3,
        packages: nodes.map((node) => node.definition),
      });
      const packageStates = resolvePackageStates(records, blueprint);
      validateRequiredBindings(packageStates);
      validateNodeInstances(packageStates, nodeInstances);
      const contributions = persistedContributions(
        nodes,
        prepared.context,
        packageStates,
        resolveNodeInstances(packageStates, nodeInstances),
      );
      const projectPlan = project(
        prepared.context,
        prepared.state,
        blueprint,
        packageStates,
        contributions,
        nodeInstances,
        presetSelections,
      );
      await materializeProjectProjection({
        operations: projectPlan.operations,
        reconciliation: projectPlan.reconciliation,
      });
      if (!initOptions.dryRun) {
        try {
          await renderNewProject({
            targetRoot: path.resolve(initOptions.targetRoot),
            operations: [...projectPlan.operations],
          });
        } catch (error) {
          return fail("render", error);
        }
      }
      return {
        status: "success",
        dryRun: initOptions.dryRun ?? false,
        blueprint: projectPlan.blueprint,
        generationRecord: projectPlan.generationRecord,
        projection: projectPlan,
        actions: [],
      };
    } catch (error) {
      return fail("planning", error);
    }
  }

  async function add(
    addOptions: {
      readonly repositoryRoot: string;
      readonly creationInput?: CreationInput;
      readonly configuration?: unknown;
      readonly dryRun?: boolean;
    } & (
      | { readonly contentIdentity: ContentSelector }
      | {
          readonly preset:
            | PresetDefinition<
                Content["definition"] & PresetReference,
                NodeLayout,
                CreationInput,
                PresetProjectOptions<Context, Contribution>,
                PresetProjectContribution
              >
            | ContentSelector;
        }
    ),
  ): Promise<GeneratorResult<CreationInput, OwnerFacts>> {
    try {
      const repositoryRoot = path.resolve(addOptions.repositoryRoot);
      let blueprint: ProjectBlueprint;
      let record: GeneratorRecord<CreationInput>;
      let packageStates: GeneratorPackageState<CreationInput>[];
      let state: State;
      try {
        const blueprintValue = JSON.parse(
          await readFile(
            path.join(repositoryRoot, ".template/blueprint.json"),
            "utf8",
          ),
        ) as unknown;
        blueprint = assertProjectBlueprint(blueprintValue);
        record = parseGenerationRecord<CreationInput>(
          JSON.parse(
            await readFile(
              path.join(repositoryRoot, ".template/generation.json"),
              "utf8",
            ),
          ) as unknown,
        );
        if (record.strategyIdentity !== options.strategy.identity) {
          throw new Error("目标仓库使用了不兼容的工作区策略");
        }
        state = options.strategy.parseState(record.strategyState);
        packageStates = resolvePackageStates(record.packages, blueprint);
        validateNodeInstances(packageStates, record.nodeInstances);
        validatePresetSelections(record.presetSelections);
      } catch (error) {
        return fail(
          "metadata",
          error,
          options.strategy.diagnoseFailure?.(error),
        );
      }
      let requiredDependencies: ReadonlyMap<string, readonly ContentIdentity[]>;
      try {
        for (const packageRecord of packageStates) {
          prepareContent(requireContent(packageRecord.contentIdentity));
        }
        requiredDependencies = requiredDependencyIdentities(packageStates);
      } catch (error) {
        return fail("planning", error);
      }
      try {
        validateRequiredBindings(packageStates, requiredDependencies);
      } catch (error) {
        return fail(
          "metadata",
          error,
          options.strategy.diagnoseFailure?.(error),
        );
      }
      const additionRoots =
        "preset" in addOptions
          ? expandPreset({
              preset: resolvePreset(addOptions.preset),
              operation: "add",
              configuration: addOptions.configuration,
              ...(addOptions.creationInput === undefined
                ? {}
                : { creationInput: addOptions.creationInput }),
            })
          : [
              {
                nodeIdentity: "addition",
                configuration: addOptions.configuration,
                contentIdentity: addOptions.contentIdentity,
                ...(addOptions.creationInput === undefined
                  ? {}
                  : { creationInput: addOptions.creationInput }),
              },
            ];
      if (additionRoots.length !== 1) {
        throw new Error("加包预设必须恰好包含一个节点");
      }
      const selectionRoot = additionRoots[0];
      if (selectionRoot === undefined) {
        throw new Error("加包预设必须恰好包含一个节点");
      }
      const selected = requireContent(selectionRoot.contentIdentity);
      const creationInput = selectionRoot.creationInput;
      const configuration = normalizeConfiguration(
        selected,
        selectionRoot.configuration,
      );
      const addedPresetMember =
        "preset" in addOptions ? resolvePreset(addOptions.preset) : undefined;
      const addedPreset =
        addedPresetMember === undefined
          ? undefined
          : selectedPreset(addedPresetMember);
      const addedProjectPreset =
        addedPresetMember?.definition.project === undefined
          ? undefined
          : addedPreset;
      const existingNodes = addRecordNodes(packageStates);
      const currentNodeInstances = resolveNodeInstances(
        packageStates,
        record.nodeInstances,
      );
      try {
        for (const node of existingNodes) {
          node.preparation = preparations.get(node.content.definition);
          node.preparationComplete = preparedDefinitions.has(
            node.content.definition,
          );
        }
        prepareContent(selected);
      } catch (error) {
        return fail("planning", error);
      }
      let context: Context;
      try {
        context = await options.strategy.prepareAddition({
          targetRoot: repositoryRoot,
          state,
          content: selected,
          contentByIdentity,
          configuration,
          packages: packageStates,
          nodeInstances: currentNodeInstances,
          ...(creationInput === undefined ? {} : { creationInput }),
        });
      } catch (error) {
        return fail(
          "metadata",
          error,
          options.strategy.diagnoseFailure?.(error),
        );
      }
      const existingContributions = existingNodes.map((node) =>
        createContribution(node, context, packageStates, currentNodeInstances),
      );
      const definition = options.strategy.createDefinition({
        context,
        content: selected,
        ...(selectionRoot.layout === undefined
          ? {}
          : { layout: selectionRoot.layout }),
        ...(creationInput === undefined ? {} : { creationInput }),
      });
      const requested: PackageNode<
        Context,
        Contribution,
        CreationInput,
        Content
      > = {
        content: selected,
        definition,
        createdBy: "addition",
        configuration,
        ...(addedProjectPreset !== undefined
          ? { nodeIdentity: selectionRoot.nodeIdentity }
          : {}),
        ...(creationInput === undefined ? {} : { creationInput }),
        providers: new Map(),
      };
      let preparedAddition:
        | {
            readonly nodes: PackageNode<
              Context,
              Contribution,
              CreationInput,
              Content
            >[];
            readonly records: GeneratorPackageRecord<CreationInput>[];
            readonly packages: GeneratorPackageState<CreationInput>[];
            readonly blueprint: ProjectBlueprint;
            readonly nodeInstances: GeneratorNodeInstances;
            readonly contributions: Contribution[];
          }
        | undefined;
      const prepareAdditionNodes = (): NonNullable<typeof preparedAddition> => {
        if (preparedAddition !== undefined) return preparedAddition;
        try {
          const nodes = hydrateNewNodes({
            roots: [requested],
            existing: existingNodes,
            context,
            occupiedIds: new Set(
              record.packages.map((item) => item.packageDefinitionId),
            ),
          });
          const records = nodes.flatMap((node) =>
            node.record === undefined ? [] : [node.record],
          );
          const allRecords = [...record.packages, ...records];
          const afterBlueprint: ProjectBlueprint = {
            ...blueprint,
            packages: [
              ...blueprint.packages,
              ...nodes.map(
                (node) => node.definition as PersistedPackageDefinition,
              ),
            ],
          };
          const packages = resolvePackageStates(allRecords, afterBlueprint);
          const addedPackageIds = new Set(
            records.map((item) => item.packageDefinitionId),
          );
          const addedPackages = packages.filter((item) =>
            addedPackageIds.has(item.packageDefinitionId),
          );
          validateRequiredBindings(
            addedPackages,
            requiredDependencyIdentities(addedPackages),
            packages,
          );
          const nodeInstanceIds: Record<string, PackageDefinitionId> = {
            ...record.nodeInstances,
          };
          if (
            addedProjectPreset !== undefined &&
            !Object.hasOwn(nodeInstanceIds, selectionRoot.nodeIdentity)
          ) {
            const addedRoot = nodes.find(
              (node) => node.nodeIdentity === selectionRoot.nodeIdentity,
            );
            if (addedRoot?.record === undefined) {
              throw new Error(
                "加包预设节点没有持久实例：" + selectionRoot.nodeIdentity,
              );
            }
            nodeInstanceIds[selectionRoot.nodeIdentity] =
              addedRoot.record.packageDefinitionId;
          }
          const nodeInstances = resolveNodeInstances(packages, nodeInstanceIds);
          preparedAddition = {
            nodes,
            records,
            packages,
            blueprint: afterBlueprint,
            nodeInstances,
            contributions: persistedContributions(
              nodes,
              context,
              packages,
              nodeInstances,
            ),
          };
          return preparedAddition;
        } catch (error) {
          throw new AdditionPlanningFailure(error);
        }
      };
      try {
        const currentPresetProjectContributions =
          computePresetProjectContributions(
            context,
            existingContributions,
            currentNodeInstances,
            record.presetSelections,
          );
        const validation = await options.strategy.validateAddition?.({
          targetRoot: repositoryRoot,
          blueprint,
          content: selected,
          definition,
          ...(creationInput === undefined ? {} : { creationInput }),
          packages: packageStates,
          contributions: existingContributions,
          getAdditionContributions: () => prepareAdditionNodes().contributions,
          nodeInstances: currentNodeInstances,
          presetProjectContributions: currentPresetProjectContributions,
        });
        if (validation?.status === "input-invalid") return validation;
        if (validation?.status === "conflict") {
          return {
            status: "conflict",
            dryRun: addOptions.dryRun ?? false,
            reason: "工作区策略报告了包加法冲突。",
            conflicts: [],
            ownerConflict: validation.conflict,
            actions: [],
          };
        }
      } catch (error) {
        if (error instanceof AdditionPlanningFailure) {
          return fail("planning", error);
        }
        return fail(
          "metadata",
          error,
          options.strategy.diagnoseFailure?.(error),
        );
      }
      const conflicting = blueprint.packages.find(
        (candidate) =>
          candidate.name === definition.name ||
          candidate.path === definition.path,
      );
      if (conflicting !== undefined) {
        const prior = packageStates.find(
          (item) =>
            item.packageDefinitionId === conflicting.packageDefinitionId,
        );
        if (
          prior !== undefined &&
          contentIdentityKey(prior.contentIdentity) ===
            contentIdentityKey(selected.identity) &&
          prior.definition.name === definition.name &&
          prior.definition.path === definition.path &&
          isDeepStrictEqual(prior.configuration, configuration) &&
          isDeepStrictEqual(
            prior.creationInput ?? undefined,
            selectionRoot.creationInput,
          )
        ) {
          return {
            status: "success",
            dryRun: addOptions.dryRun ?? false,
            blueprint,
            generationRecord: record,
            projection: null,
            actions: [],
          };
        }
        const samePackageIdentity =
          prior !== undefined &&
          contentIdentityKey(prior.contentIdentity) ===
            contentIdentityKey(selected.identity) &&
          prior.definition.name === definition.name &&
          prior.definition.path === definition.path;
        return {
          status: "conflict",
          dryRun: addOptions.dryRun ?? false,
          reason: samePackageIdentity
            ? "已存在的包实例不能接受不同的加包输入。"
            : "目标包名称或路径已被其他实例占用。",
          conflicts: [],
          identityConflict: {
            existing: packageIdentity(conflicting),
            requested: packageIdentity(definition),
          },
          actions: [],
        };
      }
      const prepared = prepareAdditionNodes();
      const additions = prepared.nodes;
      const allRecords = prepared.packages;
      const afterBlueprint = assertProjectBlueprint(prepared.blueprint);
      const afterNodeInstanceIds: Record<string, PackageDefinitionId> = {
        ...record.nodeInstances,
      };
      if (addedProjectPreset !== undefined) {
        if (Object.hasOwn(record.nodeInstances, selectionRoot.nodeIdentity)) {
          throw new Error(
            "加包预设节点身份已存在：" + selectionRoot.nodeIdentity,
          );
        }
        const addedRoot = additions.find(
          (node) => node.nodeIdentity === selectionRoot.nodeIdentity,
        );
        if (addedRoot?.record === undefined) {
          throw new Error(
            "加包预设节点没有持久实例：" + selectionRoot.nodeIdentity,
          );
        }
        afterNodeInstanceIds[selectionRoot.nodeIdentity] =
          addedRoot.record.packageDefinitionId;
      }
      const afterPresetSelections = mergePresetSelections(
        record.presetSelections,
        addedPreset === undefined ? [] : [addedPreset],
      );
      const beforeContributions = persistedContributions(
        existingNodes,
        context,
        packageStates,
        currentNodeInstances,
      );
      const afterNodes = [...existingNodes, ...additions];
      const afterContributions = persistedContributions(
        afterNodes,
        context,
        allRecords,
        resolveNodeInstances(allRecords, afterNodeInstanceIds),
      );
      const before = project(
        context,
        state,
        blueprint,
        packageStates,
        beforeContributions,
        record.nodeInstances,
        record.presetSelections,
      );
      const after = project(
        context,
        state,
        afterBlueprint,
        allRecords,
        afterContributions,
        afterNodeInstanceIds,
        afterPresetSelections,
      );
      const projectedBlueprint = after.blueprint;
      const preconditions: ProjectProjectionPathPrecondition[] = additions.map(
        (node) => ({
          path: node.definition.path,
          kind: "must-not-exist",
          reason: "新包路径已存在：" + node.definition.path,
        }),
      );
      const reconciliation = await reconcileAndApplyProjectProjections({
        targetRoot: repositoryRoot,
        before: {
          operations: before.operations,
          reconciliation: before.reconciliation,
        },
        after: {
          operations: after.operations,
          reconciliation: after.reconciliation,
        },
        preconditions,
        ...(addOptions.dryRun === undefined
          ? {}
          : { dryRun: addOptions.dryRun }),
      });
      if (!reconciliation.ok) {
        return {
          status: "conflict",
          dryRun: addOptions.dryRun ?? false,
          reason: "目标工作区的现行内容与新增投影发生冲突。",
          conflicts: reconciliation.conflicts,
          actions: [],
        };
      }
      return {
        status: "success",
        dryRun: addOptions.dryRun ?? false,
        blueprint: projectedBlueprint,
        generationRecord: after.generationRecord,
        projection: after,
        actions: reconciliation.actions,
      };
    } catch (error) {
      return fail(
        error instanceof AdditionPlanningFailure
          ? "planning"
          : "reconciliation",
        error,
      );
    }
  }

  return { init, add };
}
