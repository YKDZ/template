import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertPackageContribution,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import type {
  PresetDefinition,
  PresetNode,
  PresetOwnerSelection,
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
import type {
  GenerationRecord,
  GeneratorContent,
  GeneratorNodeInstanceIds,
  GeneratorNodeInstances,
  GeneratorPackageRecord,
  GeneratorSelectionRoot,
  PackageCreationInput,
  WorkspaceProjection,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";

export type { GenerationRecord } from "@ykdz/template-core/workspace-strategy";

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
  readonly providers: Map<
    string,
    PackageNode<Context, Contribution, CreationInput, Content>
  >;
  record?: GeneratorPackageRecord<CreationInput>;
  contribution?: Contribution;
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
      readonly actions: readonly [];
    }
  | {
      readonly status: "operation-failure";
      readonly phase: "metadata" | "planning" | "render" | "reconciliation";
      readonly error: { readonly message: string };
    };

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
      readonly dryRun?: boolean;
    } & (
      | { readonly contentIdentity: string }
      | {
          readonly preset: PresetDefinition<
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
      readonly preset: PresetDefinition<
        Reference,
        NodeLayout,
        CreationInput,
        PresetProjectOptions<Context, Contribution>,
        PresetProjectContribution
      >;
      readonly creationInput?: CreationInput;
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

function mergeCreationInput<CreationInput extends PackageCreationInput>(
  defaults: CreationInput | undefined,
  supplied: CreationInput | undefined,
): CreationInput | undefined {
  if (defaults === undefined) return supplied;
  if (supplied === undefined) return defaults;
  return { ...defaults, ...supplied } as CreationInput;
}

function fail(
  phase: "metadata" | "planning" | "render" | "reconciliation",
  error: unknown,
): {
  readonly status: "operation-failure";
  readonly phase: "metadata" | "planning" | "render" | "reconciliation";
  readonly error: { readonly message: string };
} {
  return {
    status: "operation-failure",
    phase,
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}

function readJson(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + " must be an object");
  return value;
}

function presetOwnerKey(owner: PresetOwnerSelection): string {
  return JSON.stringify([owner.packageName, owner.exportPath]);
}

function parsePresetSelections(value: unknown): PresetOwnerSelection[] {
  if (!Array.isArray(value)) throw new Error("生成记录的预设选择无效");
  const seen = new Set<string>();
  return value.map((item) => {
    const owner = readJson(item, "生成记录预设选择");
    if (
      typeof owner.packageName !== "string" ||
      owner.packageName.length === 0 ||
      typeof owner.exportPath !== "string" ||
      (owner.exportPath !== "." && !owner.exportPath.startsWith("./"))
    ) {
      throw new Error("生成记录的预设选择无效");
    }
    const selection = {
      packageName: owner.packageName,
      exportPath: owner.exportPath,
    };
    const key = presetOwnerKey(selection);
    if (seen.has(key)) throw new Error("生成记录的预设选择重复");
    seen.add(key);
    return selection;
  });
}

export function parseGenerationRecord<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(value: unknown): GenerationRecord<CreationInput> {
  const record = readJson(value, "生成记录");
  if (
    record.schemaVersion !== 1 ||
    typeof record.strategyIdentity !== "string" ||
    !Array.isArray(record.packages)
  ) {
    throw new Error("不支持的生成记录");
  }
  const packages = record.packages.map((item, index) => {
    const packageRecord = readJson(item, "生成记录包项");
    const definition = readJson(packageRecord.definition, "生成记录包身份");
    if (
      typeof packageRecord.contentIdentity !== "string" ||
      !["initialization", "addition", "shared-dependency"].includes(
        String(packageRecord.createdBy),
      ) ||
      typeof definition.packageDefinitionId !== "string" ||
      typeof definition.name !== "string" ||
      typeof definition.path !== "string" ||
      typeof definition.role !== "string" ||
      !isRecord(packageRecord.bindings)
    ) {
      throw new Error("生成记录的包项无效：" + index);
    }
    return packageRecord as unknown as GeneratorPackageRecord<CreationInput>;
  });
  const nodeInstances =
    record.nodeInstances === undefined
      ? {}
      : readJson(record.nodeInstances, "生成记录节点实例");
  for (const [nodeIdentity, packageDefinitionId] of Object.entries(
    nodeInstances,
  )) {
    if (
      nodeIdentity.length === 0 ||
      typeof packageDefinitionId !== "string" ||
      !packages.some(
        (packageRecord) =>
          packageRecord.definition.packageDefinitionId === packageDefinitionId,
      )
    ) {
      throw new Error("生成记录的节点实例映射无效");
    }
  }
  return {
    schemaVersion: 1,
    strategyIdentity: record.strategyIdentity,
    strategyState: record.strategyState,
    packages,
    nodeInstances: nodeInstances as GeneratorNodeInstanceIds,
    presetSelections: parsePresetSelections(record.presetSelections),
  };
}

function packageId(options: {
  readonly contentIdentity: string;
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
  readonly content: readonly (
    | Content
    | PresetDefinition<
        Content,
        NoInfer<NodeLayout>,
        NoInfer<CreationInput>,
        PresetProjectOptions<Context, Contribution>,
        NoInfer<PresetProjectContribution>
      >
  )[];
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
  Content,
  NodeLayout,
  Context,
  Contribution,
  PresetProjectContribution,
  OwnerFacts
> {
  const contentMembers = options.content.filter(
    (content): content is Content =>
      !isPresetDefinition<
        Content,
        NodeLayout,
        CreationInput,
        PresetProjectOptions<Context, Contribution>,
        PresetProjectContribution
      >(content),
  );
  const presetMembers = options.content.filter(
    (
      content,
    ): content is PresetDefinition<
      Content,
      NodeLayout,
      CreationInput,
      PresetProjectOptions<Context, Contribution>,
      PresetProjectContribution
    > =>
      isPresetDefinition<
        Content,
        NodeLayout,
        CreationInput,
        PresetProjectOptions<Context, Contribution>,
        PresetProjectContribution
      >(content),
  );
  const contentByIdentity = new Map(
    contentMembers.map((content) => [content.identity, content]),
  );
  if (contentByIdentity.size !== contentMembers.length) {
    throw new Error("显式内容身份必须唯一");
  }
  const presets = new Set(presetMembers);
  if (presets.size !== presetMembers.length) {
    throw new Error("显式预设成员不能重复");
  }
  const projectPresetsByOwner = new Map<
    string,
    PresetDefinition<
      Content,
      NodeLayout,
      CreationInput,
      PresetProjectOptions<Context, Contribution>,
      PresetProjectContribution
    >
  >();
  for (const preset of presets) {
    if (preset.project !== undefined) {
      const owner = preset.owner;
      if (owner === undefined) {
        throw new Error("项目预设缺少所属包公开导出身份");
      }
      const ownerKey = JSON.stringify([owner.packageName, owner.exportPath]);
      if (projectPresetsByOwner.has(ownerKey)) {
        throw new Error("项目预设所属包导出身份重复");
      }
      projectPresetsByOwner.set(ownerKey, preset);
    }
    for (const node of Object.values(preset.nodes)) {
      const reference = contentByIdentity.get(node.reference.identity);
      if (reference !== node.reference) {
        throw new Error(
          `显式内容集合缺少预设参考成员：${node.reference.identity}`,
        );
      }
    }
  }

  function requireContent(identity: string): Content {
    const content = contentByIdentity.get(identity);
    if (content === undefined) {
      throw new Error("显式内容中不存在：" + identity);
    }
    return content;
  }

  function expandPreset(options_: {
    readonly preset: PresetDefinition<
      Content,
      NodeLayout,
      CreationInput,
      PresetProjectOptions<Context, Contribution>,
      PresetProjectContribution
    >;
    readonly operation: "init" | "add";
    readonly creationInput?: CreationInput;
  }): GeneratorSelectionRoot<CreationInput, NodeLayout>[] {
    if (!presets.has(options_.preset)) {
      throw new Error("所选预设未由显式内容集合提供");
    }
    if (!options_.preset.operations.includes(options_.operation)) {
      throw new Error(`预设不支持${options_.operation}操作`);
    }
    const nodes = Object.entries(options_.preset.nodes) as [
      string,
      PresetNode<Content, NodeLayout, CreationInput>,
    ][];
    if (options_.creationInput !== undefined && nodes.length !== 1) {
      throw new Error("多节点预设不能接收单一包创建输入");
    }
    return nodes.map(([nodeIdentity, node]) => {
      const creationInput = mergeCreationInput(
        node.creationInput?.[options_.operation],
        options_.creationInput,
      );
      return {
        nodeIdentity,
        contentIdentity: node.reference.identity,
        ...(node.layout === undefined ? {} : { layout: node.layout }),
        ...(creationInput === undefined ? {} : { creationInput }),
      };
    });
  }

  function findByPackageId(
    records: readonly GeneratorPackageRecord<CreationInput>[],
    id: string,
  ): GeneratorPackageRecord<CreationInput> {
    const record = records.find(
      (candidate) => candidate.definition.packageDefinitionId === id,
    );
    if (record === undefined) {
      throw new Error("生成记录引用了不存在的包实例：" + id);
    }
    return record;
  }

  function resolveNodeInstances(
    records: readonly GeneratorPackageRecord<CreationInput>[],
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
    records: readonly GeneratorPackageRecord<CreationInput>[],
    blueprint: ProjectBlueprint,
  ): PackageNode<Context, Contribution, CreationInput, Content>[] {
    return records.map((record) => {
      const definition = blueprint.packages.find(
        (candidate) =>
          candidate.packageDefinitionId ===
          record.definition.packageDefinitionId,
      );
      if (definition === undefined) {
        throw new Error("蓝图缺少生成记录包实例：" + record.definition.path);
      }
      return {
        content: requireContent(record.contentIdentity),
        definition,
        createdBy: record.createdBy,
        ...(record.creationInput === undefined
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
    allRecords: readonly GeneratorPackageRecord<CreationInput>[],
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
        providerDefinitions.set(identity, provider.record.definition);
      }
    }
    const nativeBindings = options.strategy.bindings({
      content: node.content,
      contentByIdentity,
      providers: providerDefinitions,
    });
    const contributionOptions = {
      context,
      definition: node.definition,
      bindings: nativeBindings,
      createdBy: node.createdBy,
      nodeInstances,
      ...(node.creationInput === undefined
        ? {}
        : { creationInput: node.creationInput }),
    };
    const contribution = node.content.contribute(contributionOptions);
    const contributionDefinition = contribution.definition;
    if (
      contributionDefinition.name !== node.definition.name ||
      contributionDefinition.path !== node.definition.path ||
      contributionDefinition.role !== node.definition.role ||
      ("packageDefinitionId" in contributionDefinition &&
        contributionDefinition.packageDefinitionId !==
          node.record?.definition.packageDefinitionId)
    ) {
      throw new Error(
        `内容 ${node.content.identity} 返回的包定义与已分配实例不一致：${node.definition.path}`,
      );
    }
    assertPackageContribution(
      {
        definition: node.definition,
        operations: contribution.operations,
      },
      { definitionName: node.content.identity, planner: "内容贡献" },
    );
    node.contribution = contribution;
    return node.contribution;
  }

  function storedRecord(
    state: State,
    records: readonly GeneratorPackageRecord<CreationInput>[],
    nodeInstances: GeneratorNodeInstanceIds,
    presetSelections: readonly PresetOwnerSelection[],
  ): GeneratorRecord<CreationInput> {
    return {
      schemaVersion: 1,
      strategyIdentity: options.strategy.identity,
      strategyState: state,
      packages: records,
      nodeInstances,
      presetSelections,
    };
  }

  function projectOwner(
    preset: PresetDefinition<
      Content,
      NodeLayout,
      CreationInput,
      PresetProjectOptions<Context, Contribution>,
      PresetProjectContribution
    >,
  ): PresetOwnerSelection | undefined {
    if (preset.project === undefined) return undefined;
    if (preset.owner === undefined) {
      throw new Error("项目预设缺少所属包公开导出身份");
    }
    return preset.owner;
  }

  function mergePresetSelections(
    existing: readonly PresetOwnerSelection[],
    added: readonly PresetOwnerSelection[],
  ): PresetOwnerSelection[] {
    const selections = new Map<string, PresetOwnerSelection>();
    for (const selection of [...existing, ...added]) {
      selections.set(presetOwnerKey(selection), selection);
    }
    return [...selections.values()];
  }

  function computePresetProjectContributions(
    context: Context,
    contributions: readonly Contribution[],
    nodeInstances: GeneratorNodeInstances,
    presetSelections: readonly PresetOwnerSelection[],
  ): PresetProjectContribution[] {
    return presetSelections.map((selection) => {
      const preset = projectPresetsByOwner.get(presetOwnerKey(selection));
      if (preset?.project === undefined) {
        throw new Error(
          `生成记录所选预设不可用：${selection.packageName}${selection.exportPath}`,
        );
      }
      return preset.project({ context, contributions, nodeInstances });
    });
  }

  function project(
    context: Context,
    state: State,
    blueprint: ProjectBlueprint,
    records: readonly GeneratorPackageRecord<CreationInput>[],
    contributions: readonly Contribution[],
    nodeInstances: GeneratorNodeInstanceIds,
    presetSelections: readonly PresetOwnerSelection[],
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
      records.map((record) => [
        record.definition.packageDefinitionId,
        record.definition,
      ]),
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
      const key = node.content.identity + "\u0000" + node.definition.path;
      if (node.record !== undefined) return;
      if (visiting.has(key)) {
        throw new Error("显式内容依赖形成循环：" + node.content.identity);
      }
      if (expanded.has(key)) return;
      visiting.add(key);
      newNodes.set(key, node);
      const dependencies = options.strategy.dependencies({
        content: node.content,
        contentByIdentity,
      });
      for (const identity of dependencies) {
        const dependency = requireContent(identity);
        const candidates = [...options_.existing, ...newNodes.values()].filter(
          (candidate) => candidate.content.identity === identity,
        );
        if (candidates.length > 1) {
          throw new Error("依赖内容有多个持久实例，无法唯一绑定：" + identity);
        }
        let provider = candidates[0];
        if (provider === undefined) {
          if (dependency.instance !== "shared") {
            throw new Error("缺少明确的独立依赖实例：" + identity);
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
            providers: new Map(),
          };
          newNodes.set(identity + "\u0000" + definition.path, provider);
        }
        node.providers.set(identity, provider);
        visit(provider);
      }
      visiting.delete(key);
      expanded.add(key);
    };

    const explicitByContent = new Set<string>();
    const explicitByPath = new Set<string>();
    const explicitByNode = new Set<string>();
    for (const root of options_.roots) {
      const key = root.content.identity + "\u0000" + root.definition.path;
      if (explicitByNode.has(root.nodeIdentity ?? "")) {
        throw new Error("显式初始化节点身份重复：" + root.nodeIdentity);
      }
      explicitByNode.add(root.nodeIdentity ?? "");
      if (
        root.content.instance === "independent" &&
        explicitByContent.has(root.content.identity)
      ) {
        throw new Error(
          "同一独立内容不能重复作为显式根：" + root.content.identity,
        );
      }
      explicitByContent.add(root.content.identity);
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
        definition: persisted,
        ...(node.creationInput === undefined
          ? {}
          : { creationInput: node.creationInput }),
        bindings: {},
      };
    }
    for (const node of nodes) {
      const bindings = Object.fromEntries(
        [...node.providers].map(([identity, provider]) => {
          if (provider.record === undefined) {
            throw new Error("内容闭包绑定缺少包实例：" + identity);
          }
          return [identity, provider.record.definition.packageDefinitionId];
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
    records: readonly GeneratorPackageRecord<CreationInput>[],
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
        Content,
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
      const selectedProjectPresets: PresetOwnerSelection[] = [];
      for (const root of initOptions.selection.roots) {
        if (!("preset" in root)) continue;
        const owner = projectOwner(root.preset);
        if (owner !== undefined) selectedProjectPresets.push(owner);
      }
      const presetSelections = mergePresetSelections(
        [],
        selectedProjectPresets,
      );
      const selectionRoots = initOptions.selection.roots.flatMap((root) =>
        "preset" in root
          ? expandPreset({
              preset: root.preset,
              operation: "init",
              ...(root.creationInput === undefined
                ? {}
                : { creationInput: root.creationInput }),
            })
          : [root],
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
          return [
            root.nodeIdentity,
            root.record.definition.packageDefinitionId,
          ];
        }),
      );
      const blueprint = assertProjectBlueprint({
        schemaVersion: 3,
        packages: records.map((record) => record.definition),
      });
      const contributions = persistedContributions(
        nodes,
        prepared.context,
        records,
        resolveNodeInstances(records, nodeInstances),
      );
      const projectPlan = project(
        prepared.context,
        prepared.state,
        blueprint,
        records,
        contributions,
        nodeInstances,
        presetSelections,
      );
      await materializeProjectProjection({
        operations: projectPlan.operations,
        reconciliation: projectPlan.reconciliation,
      });
      if (!initOptions.dryRun) {
        await renderNewProject({
          targetRoot: path.resolve(initOptions.targetRoot),
          operations: [...projectPlan.operations],
        });
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
      readonly dryRun?: boolean;
    } & (
      | { readonly contentIdentity: string }
      | {
          readonly preset: PresetDefinition<
            Content,
            NodeLayout,
            CreationInput,
            PresetProjectOptions<Context, Contribution>,
            PresetProjectContribution
          >;
        }
    ),
  ): Promise<GeneratorResult<CreationInput, OwnerFacts>> {
    try {
      const repositoryRoot = path.resolve(addOptions.repositoryRoot);
      const blueprintValue = JSON.parse(
        await readFile(
          path.join(repositoryRoot, ".template/blueprint.json"),
          "utf8",
        ),
      ) as unknown;
      const blueprint = assertProjectBlueprint(blueprintValue);
      const record = parseGenerationRecord<CreationInput>(
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
      const state = options.strategy.parseState(record.strategyState);
      const additionRoots =
        "preset" in addOptions
          ? expandPreset({
              preset: addOptions.preset,
              operation: "add",
              ...(addOptions.creationInput === undefined
                ? {}
                : { creationInput: addOptions.creationInput }),
            })
          : [
              {
                nodeIdentity: "addition",
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
      const addedProjectPreset =
        "preset" in addOptions ? projectOwner(addOptions.preset) : undefined;
      const existingNodes = addRecordNodes(record.packages, blueprint);
      const currentNodeInstances = resolveNodeInstances(
        record.packages,
        record.nodeInstances,
      );
      let context: Context;
      try {
        context = await options.strategy.prepareAddition({
          targetRoot: repositoryRoot,
          state,
          content: selected,
          contentByIdentity,
          packages: record.packages,
          nodeInstances: currentNodeInstances,
          ...(creationInput === undefined ? {} : { creationInput }),
        });
      } catch (error) {
        return fail("metadata", error);
      }
      const existingContributions = existingNodes.map((node) =>
        createContribution(
          node,
          context,
          record.packages,
          currentNodeInstances,
        ),
      );
      try {
        const currentPresetProjectContributions =
          computePresetProjectContributions(
            context,
            existingContributions,
            currentNodeInstances,
            record.presetSelections,
          );
        await options.strategy.validateAddition?.({
          targetRoot: repositoryRoot,
          packages: record.packages,
          contributions: existingContributions,
          nodeInstances: currentNodeInstances,
          presetProjectContributions: currentPresetProjectContributions,
        });
      } catch (error) {
        return fail("metadata", error);
      }
      const definition = options.strategy.createDefinition({
        context,
        content: selected,
        ...(selectionRoot.layout === undefined
          ? {}
          : { layout: selectionRoot.layout }),
        ...(creationInput === undefined ? {} : { creationInput }),
      });
      const conflicting = blueprint.packages.find(
        (candidate) =>
          candidate.name === definition.name ||
          candidate.path === definition.path,
      );
      if (conflicting !== undefined) {
        const prior = record.packages.find(
          (item) =>
            item.definition.packageDefinitionId ===
            conflicting.packageDefinitionId,
        );
        if (
          prior?.contentIdentity === selected.identity &&
          prior.definition.name === definition.name &&
          prior.definition.path === definition.path &&
          isDeepStrictEqual(prior.creationInput, selectionRoot.creationInput)
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
          prior?.contentIdentity === selected.identity &&
          prior.definition.name === definition.name &&
          prior.definition.path === definition.path;
        return {
          status: "conflict",
          dryRun: addOptions.dryRun ?? false,
          reason: samePackageIdentity
            ? "已存在的包实例不能接受不同的加包输入。"
            : "目标包名称或路径已被其他实例占用。",
          conflicts: [],
          actions: [],
        };
      }
      const requested: PackageNode<
        Context,
        Contribution,
        CreationInput,
        Content
      > = {
        content: selected,
        definition,
        createdBy: "addition",
        ...(addedProjectPreset !== undefined
          ? { nodeIdentity: selectionRoot.nodeIdentity }
          : {}),
        ...(creationInput === undefined ? {} : { creationInput }),
        providers: new Map(),
      };
      const newNodes = hydrateNewNodes({
        roots: [requested],
        existing: existingNodes,
        context,
        occupiedIds: new Set(
          record.packages.map((item) => item.definition.packageDefinitionId),
        ),
      });
      const additions = newNodes;
      const newRecords = additions.flatMap((node) =>
        node.record === undefined ? [] : [node.record],
      );
      const allRecords = [...record.packages, ...newRecords];
      const afterNodeInstanceIds: Record<string, PackageDefinitionId> = {
        ...record.nodeInstances,
      };
      if (addedProjectPreset !== undefined) {
        if (Object.hasOwn(afterNodeInstanceIds, selectionRoot.nodeIdentity)) {
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
          addedRoot.record.definition.packageDefinitionId;
      }
      const afterPresetSelections = mergePresetSelections(
        record.presetSelections,
        addedProjectPreset === undefined ? [] : [addedProjectPreset],
      );
      const allDefinitions = [
        ...blueprint.packages,
        ...newRecords.map((item) => item.definition),
      ];
      const afterBlueprint = assertProjectBlueprint({
        ...blueprint,
        packages: allDefinitions,
      });
      const beforeContributions = persistedContributions(
        existingNodes,
        context,
        record.packages,
        resolveNodeInstances(record.packages, record.nodeInstances),
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
        record.packages,
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
      return fail("reconciliation", error);
    }
  }

  return { init, add };
}
