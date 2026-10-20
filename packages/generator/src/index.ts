import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PackageContribution } from "@ykdz/template-core/package-contribution";
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
  GeneratorContent,
  GeneratorPackageRecord,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";

type GeneratorRecord = {
  readonly schemaVersion: 1;
  readonly strategyIdentity: string;
  readonly strategyState: unknown;
  readonly packages: readonly GeneratorPackageRecord[];
};

type PackageNode<
  Context,
  Contribution extends PackageContribution,
  Content extends GeneratorContent<Context, Contribution>,
> = {
  readonly content: Content;
  readonly definition: PackageDefinition;
  readonly createdBy: GeneratorPackageRecord["createdBy"];
  readonly providers: Map<string, PackageNode<Context, Contribution, Content>>;
  record?: GeneratorPackageRecord;
  contribution?: Contribution;
};

export type GeneratorResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly blueprint: ProjectBlueprint;
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

export type Generator<Input> = {
  init(options: {
    readonly targetRoot: string;
    readonly selection: { readonly contentIdentity: string };
    readonly strategyInput: Input;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult>;
  add(options: {
    readonly repositoryRoot: string;
    readonly contentIdentity: string;
    readonly leafName: string;
    readonly packagePath?: string;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  phase: "metadata" | "planning" | "render" | "reconciliation",
  error: unknown,
): GeneratorResult {
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

function parseGeneratorRecord(value: unknown): GeneratorRecord {
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
    return packageRecord as unknown as GeneratorPackageRecord;
  });
  return {
    schemaVersion: 1,
    strategyIdentity: record.strategyIdentity,
    strategyState: record.strategyState,
    packages,
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
  Content extends GeneratorContent<Context, Contribution>,
>(options: {
  readonly content: readonly Content[];
  readonly strategy: WorkspaceStrategy<
    Context,
    Input,
    State,
    Contribution,
    Content
  >;
}): Generator<Input> {
  const contentByIdentity = new Map(
    options.content.map((content) => [content.identity, content]),
  );
  if (contentByIdentity.size !== options.content.length) {
    throw new Error("显式内容身份必须唯一");
  }

  function requireContent(identity: string): Content {
    const content = contentByIdentity.get(identity);
    if (content === undefined) {
      throw new Error("显式内容中不存在：" + identity);
    }
    return content;
  }

  function findByPackageId(
    records: readonly GeneratorPackageRecord[],
    id: string,
  ): GeneratorPackageRecord {
    const record = records.find(
      (candidate) => candidate.definition.packageDefinitionId === id,
    );
    if (record === undefined) {
      throw new Error("生成记录引用了不存在的包实例：" + id);
    }
    return record;
  }

  function addRecordNodes(
    records: readonly GeneratorPackageRecord[],
    blueprint: ProjectBlueprint,
  ): PackageNode<Context, Contribution, Content>[] {
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
        providers: new Map(),
        record,
      };
    });
  }

  function createContribution(
    node: PackageNode<Context, Contribution, Content>,
    context: Context,
    allRecords: readonly GeneratorPackageRecord[],
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
    node.contribution = node.content.contribute({
      context,
      definition: node.definition,
      bindings: nativeBindings,
    });
    return node.contribution;
  }

  function storedRecord(
    state: State,
    records: readonly GeneratorPackageRecord[],
  ): GeneratorRecord {
    return {
      schemaVersion: 1,
      strategyIdentity: options.strategy.identity,
      strategyState: state,
      packages: records,
    };
  }

  function project(
    context: Context,
    state: State,
    blueprint: ProjectBlueprint,
    records: readonly GeneratorPackageRecord[],
    contributions: readonly Contribution[],
  ) {
    const projection = options.strategy.project({
      context,
      state,
      blueprint,
      packages: records,
      contributions,
    });
    return {
      operations: [
        ...projection.operations,
        {
          kind: "writeJson" as const,
          to: ".template/generation.json",
          value: storedRecord(state, records),
        },
      ],
      reconciliation: projection.reconciliation,
    };
  }

  function hydrateNewNodes(options_: {
    readonly roots: readonly PackageNode<Context, Contribution, Content>[];
    readonly existing: readonly PackageNode<Context, Contribution, Content>[];
    readonly context: Context;
    readonly occupiedIds: Set<PackageDefinitionId>;
  }): PackageNode<Context, Contribution, Content>[] {
    const newNodes = new Map<
      string,
      PackageNode<Context, Contribution, Content>
    >();
    const visiting = new Set<string>();
    const expanded = new Set<string>();

    const visit = (node: PackageNode<Context, Contribution, Content>): void => {
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
      node.record = {
        contentIdentity: node.content.identity,
        createdBy: node.createdBy,
        definition: persisted,
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
    nodes: readonly PackageNode<Context, Contribution, Content>[],
    context: Context,
    records: readonly GeneratorPackageRecord[],
  ): Contribution[] {
    return nodes.map((node) => createContribution(node, context, records));
  }

  async function init(initOptions: {
    readonly targetRoot: string;
    readonly selection: { readonly contentIdentity: string };
    readonly strategyInput: Input;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult> {
    try {
      const primaryContent = requireContent(
        initOptions.selection.contentIdentity,
      );
      const prepared = options.strategy.initialize({
        targetRoot: initOptions.targetRoot,
        input: initOptions.strategyInput,
        selection: primaryContent.identity,
      });
      const definition = options.strategy.createDefinition({
        context: prepared.context,
        content: primaryContent,
      });
      const primary: PackageNode<Context, Contribution, Content> = {
        content: primaryContent,
        definition,
        createdBy: "initialization",
        providers: new Map(),
      };
      const nodes = hydrateNewNodes({
        roots: [primary],
        existing: [],
        context: prepared.context,
        occupiedIds: new Set(),
      });
      const records = nodes.flatMap((node) =>
        node.record === undefined ? [] : [node.record],
      );
      const blueprint = assertProjectBlueprint({
        schemaVersion: 3,
        packages: records.map((record) => record.definition),
      });
      const contributions = persistedContributions(
        nodes,
        prepared.context,
        records,
      );
      const projectPlan = project(
        prepared.context,
        prepared.state,
        blueprint,
        records,
        contributions,
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
        blueprint,
        actions: [],
      };
    } catch (error) {
      return fail("planning", error);
    }
  }

  async function add(addOptions: {
    readonly repositoryRoot: string;
    readonly contentIdentity: string;
    readonly leafName: string;
    readonly packagePath?: string;
    readonly dryRun?: boolean;
  }): Promise<GeneratorResult> {
    try {
      const repositoryRoot = path.resolve(addOptions.repositoryRoot);
      const blueprintValue = JSON.parse(
        await readFile(
          path.join(repositoryRoot, ".template/blueprint.json"),
          "utf8",
        ),
      ) as unknown;
      const blueprint = assertProjectBlueprint(blueprintValue);
      const record = parseGeneratorRecord(
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
      const selected = requireContent(addOptions.contentIdentity);
      const existingNodes = addRecordNodes(record.packages, blueprint);
      let context: Context;
      try {
        context = await options.strategy.prepareAddition({
          targetRoot: repositoryRoot,
          state,
          content: selected,
          contentByIdentity,
          packages: record.packages,
        });
      } catch (error) {
        return fail("metadata", error);
      }
      for (const node of existingNodes) {
        createContribution(node, context, record.packages);
      }
      const definition = options.strategy.createDefinition({
        context,
        content: selected,
        leafName: addOptions.leafName,
        ...(addOptions.packagePath === undefined
          ? {}
          : { packagePath: addOptions.packagePath }),
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
          prior.definition.path === definition.path
        ) {
          return {
            status: "success",
            dryRun: addOptions.dryRun ?? false,
            blueprint,
            actions: [],
          };
        }
        return {
          status: "conflict",
          dryRun: addOptions.dryRun ?? false,
          reason: "目标包名称或路径已被其他实例占用。",
          conflicts: [],
          actions: [],
        };
      }
      const requested: PackageNode<Context, Contribution, Content> = {
        content: selected,
        definition,
        createdBy: "addition",
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
      );
      const afterNodes = [...existingNodes, ...additions];
      const afterContributions = persistedContributions(
        afterNodes,
        context,
        allRecords,
      );
      const before = project(
        context,
        state,
        blueprint,
        record.packages,
        beforeContributions,
      );
      const after = project(
        context,
        state,
        afterBlueprint,
        allRecords,
        afterContributions,
      );
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
        blueprint: afterBlueprint,
        actions: reconciliation.actions,
      };
    } catch (error) {
      return fail("reconciliation", error);
    }
  }

  return { init, add };
}
