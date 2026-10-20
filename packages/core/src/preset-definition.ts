import type { ContentIdentity } from "./content-identity.ts";
import type { PackageDefinition } from "./project-blueprint.ts";

export type PresetOperation = "init" | "add";

/** 声明预设项目行为的所属原生包出口。 */
export type PresetOwnerDeclaration = {
  readonly packageName: string;
  readonly exportPath: string;
};

/** 记录中的预设选择使用完整规范身份。 */
export type PresetOwnerSelection = ContentIdentity;

/** 从包清单实际公开指向预设声明的出口推导其持久身份。 */
export function presetOwnerFromManifest(
  manifest: unknown,
  exportPath: string,
): PresetOwnerDeclaration {
  if (!isRecord(manifest) || typeof manifest.name !== "string") {
    throw new Error("预设所属包清单缺少包名");
  }
  requireText(manifest.name, "所属包名");
  if (!isRecord(manifest.exports)) {
    throw new Error("预设所属包清单缺少公开出口");
  }
  if (
    (exportPath !== "." && !exportPath.startsWith("./")) ||
    !Object.hasOwn(manifest.exports, exportPath)
  ) {
    throw new Error("预设所属包清单未公开所选预设入口");
  }
  return { packageName: manifest.name, exportPath };
}

/** 预设只计算项目要求；实际写入仍由工作区策略解释并投影。 */
export type PresetProjectOptions<Context, Contribution> = {
  readonly context: Context;
  readonly contributions: readonly Contribution[];
  readonly nodeInstances: ReadonlyMap<string, PackageDefinition>;
};

type PresetProjectFields<Options, ProjectContribution> = {
  readonly owner?: PresetOwnerDeclaration;
  readonly project?: [Options] extends [never]
    ? never
    : (options: Options) => ProjectContribution;
};

export type PresetReference = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
};

export type PresetNode<
  Reference extends PresetReference,
  Layout = never,
  CreationInput = never,
> = {
  readonly reference: Reference;
  /** 由工作区策略解释的节点布局覆盖。 */
  readonly layout?: Layout;
  /** 按操作应用、并可由单次调用补充的原生创建输入。 */
  readonly creationInput?: Partial<Record<PresetOperation, CreationInput>>;
};

type PresetNodeMap = Readonly<
  Record<
    string,
    {
      readonly reference: PresetReference;
      readonly layout?: unknown;
      readonly creationInput?: Partial<Record<PresetOperation, unknown>>;
    }
  >
>;

type NodeReference<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes]["reference"];

type NodeLayout<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes] extends infer Node
    ? Node extends { readonly layout: infer Layout }
      ? Layout
      : never
    : never;

type NodeCreationInput<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes] extends infer Node
    ? Node extends { readonly creationInput: infer Inputs }
      ? Inputs extends object
        ? Inputs[keyof Inputs]
        : never
      : never
    : never;

export type PresetDefinition<
  Reference extends PresetReference,
  Layout = never,
  CreationInput = never,
  ProjectOptions = never,
  ProjectContribution = never,
> = {
  readonly kind: "preset";
  readonly metadata: {
    readonly alias: string;
    readonly title: string;
    readonly description: string;
  };
  readonly operations: readonly PresetOperation[];
  readonly nodes: Readonly<
    Record<string, PresetNode<Reference, Layout, CreationInput>>
  >;
} & PresetProjectFields<ProjectOptions, ProjectContribution>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`预设${label}不能为空`);
  }
}

type PresetBaseOptions<Nodes extends PresetNodeMap> = {
  readonly metadata: PresetDefinition<NodeReference<Nodes>>["metadata"];
  readonly operations: readonly PresetOperation[];
  readonly nodes: Nodes;
};

/** 创建不读取资源、不执行规划的预设组合声明。 */
export function definePreset<const Nodes extends PresetNodeMap>(
  options: PresetBaseOptions<Nodes> & {
    readonly owner?: PresetOwnerDeclaration;
    readonly project?: never;
  },
): PresetDefinition<
  NodeReference<Nodes>,
  NodeLayout<Nodes>,
  NodeCreationInput<Nodes>
> & { readonly nodes: Nodes };
export function definePreset<
  const Nodes extends PresetNodeMap,
  ProjectOptions extends PresetProjectOptions<unknown, unknown>,
  ProjectContribution,
>(
  options: PresetBaseOptions<Nodes> & {
    readonly owner: PresetOwnerDeclaration;
    readonly project: (options: ProjectOptions) => ProjectContribution;
  },
): PresetDefinition<
  NodeReference<Nodes>,
  NodeLayout<Nodes>,
  NodeCreationInput<Nodes>,
  ProjectOptions,
  ProjectContribution
> & { readonly nodes: Nodes };
export function definePreset<const Nodes extends PresetNodeMap>(
  options: PresetBaseOptions<Nodes> & {
    readonly owner?: PresetOwnerDeclaration;
    readonly project?: (...args: never[]) => unknown;
  },
): unknown {
  requireText(options.metadata.alias, "别名");
  requireText(options.metadata.title, "标题");
  requireText(options.metadata.description, "说明");
  if (options.project !== undefined) {
    if (!isRecord(options.owner)) {
      throw new Error("项目预设必须声明所属包的公开导出身份");
    }
    requireText(options.owner.packageName, "所属包名");
    requireText(options.owner.exportPath, "公开导出路径");
    if (
      options.owner.exportPath !== "." &&
      !options.owner.exportPath.startsWith("./")
    ) {
      throw new Error("预设公开导出路径必须是包的公开入口");
    }
  }
  if (!Array.isArray(options.operations) || options.operations.length === 0) {
    throw new Error("预设至少允许一种操作");
  }
  const operations: PresetOperation[] = [];
  for (const operation of options.operations) {
    if (operation !== "init" && operation !== "add") {
      throw new Error(`预设操作无效：${String(operation)}`);
    }
    if (operations.includes(operation)) {
      throw new Error(`预设操作重复：${operation}`);
    }
    operations.push(operation);
  }
  const nodeEntries = Object.entries(options.nodes);
  if (nodeEntries.length === 0) {
    throw new Error("预设至少声明一个节点");
  }
  const independentReferences = new Set<PresetReference>();
  const nodes: Record<
    string,
    PresetNode<NodeReference<Nodes>, unknown, unknown>
  > = {};
  for (const [identity, value] of nodeEntries) {
    if (!/^[a-z][a-z0-9-]*$/u.test(identity)) {
      throw new Error(`预设节点身份无效：${identity}`);
    }
    if (
      !isRecord(value) ||
      !isRecord(value.reference) ||
      typeof value.reference.alias !== "string" ||
      value.reference.alias.trim().length === 0 ||
      !["shared", "independent"].includes(String(value.reference.instance))
    ) {
      throw new Error(`预设节点缺少有效参考：${identity}`);
    }
    const reference = value.reference as NodeReference<Nodes>;
    if (reference.instance === "independent") {
      if (independentReferences.has(reference)) {
        throw new Error(`预设重复选择独立参考：${reference.alias}`);
      }
      independentReferences.add(reference);
    }
    if (value.creationInput !== undefined) {
      if (!isRecord(value.creationInput)) {
        throw new Error(`预设节点创建输入无效：${identity}`);
      }
      for (const operation of Object.keys(value.creationInput)) {
        if (
          (operation !== "init" && operation !== "add") ||
          !options.operations.includes(operation)
        ) {
          throw new Error(`预设节点创建输入操作无效：${identity}/${operation}`);
        }
        if (!isRecord(value.creationInput[operation])) {
          throw new Error(
            `预设节点创建输入必须是对象：${identity}/${operation}`,
          );
        }
      }
    }
    nodes[identity] = Object.freeze({
      ...value,
      reference,
    });
  }
  return Object.freeze({
    kind: "preset",
    metadata: Object.freeze({ ...options.metadata }),
    operations: Object.freeze(operations),
    nodes: Object.freeze(nodes) as Nodes,
    ...(options.owner === undefined
      ? {}
      : { owner: Object.freeze({ ...options.owner }) }),
    ...(options.project === undefined ? {} : { project: options.project }),
  }) as unknown as PresetDefinition<
    NodeReference<Nodes>,
    NodeLayout<Nodes>,
    NodeCreationInput<Nodes>,
    never,
    never
  > & { readonly nodes: Nodes };
}
