export type PresetOperation = "init" | "add";

export type PresetReference = {
  readonly identity: string;
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`预设${label}不能为空`);
  }
}

/** 创建不读取资源、不执行规划的预设组合声明。 */
export function definePreset<const Nodes extends PresetNodeMap>(options: {
  readonly metadata: PresetDefinition<NodeReference<Nodes>>["metadata"];
  readonly operations: readonly PresetOperation[];
  readonly nodes: Nodes;
}): PresetDefinition<
  NodeReference<Nodes>,
  NodeLayout<Nodes>,
  NodeCreationInput<Nodes>
> & { readonly nodes: Nodes } {
  requireText(options.metadata.alias, "别名");
  requireText(options.metadata.title, "标题");
  requireText(options.metadata.description, "说明");
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
  const independentReferences = new Set<string>();
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
      typeof value.reference.identity !== "string" ||
      value.reference.identity.length === 0 ||
      !["shared", "independent"].includes(String(value.reference.instance))
    ) {
      throw new Error(`预设节点缺少有效参考：${identity}`);
    }
    const reference = value.reference as NodeReference<Nodes>;
    if (reference.instance === "independent") {
      if (independentReferences.has(reference.identity)) {
        throw new Error(`预设重复选择独立参考：${reference.identity}`);
      }
      independentReferences.add(reference.identity);
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
  }) as unknown as PresetDefinition<
    NodeReference<Nodes>,
    NodeLayout<Nodes>,
    NodeCreationInput<Nodes>
  > & { readonly nodes: Nodes };
}
