import type { PackageContribution } from "./package-contribution.ts";
import type {
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type { ProjectProjectionReconciliation } from "./project-projection.ts";
import type { RenderOperation } from "./renderer.ts";

/** 生成器显式接收的一项内容定义。 */
export type PackageCreationInput<Variant = unknown> = {
  /** 可由工作区策略解释的有限包布局输入。 */
  readonly leafName?: string;
  readonly packagePath?: string;
  /** 内容拥有的有限选择，生成器只保存并透传。 */
  readonly variant?: Variant;
};

export type GeneratorSelectionRoot<
  CreationInput = PackageCreationInput,
  NodeLayout = unknown,
> = {
  /** 在本次组合中稳定的节点身份，用于把策略计算连到持久包实例。 */
  readonly nodeIdentity: string;
  readonly contentIdentity: string;
  readonly creationInput?: CreationInput;
  /** 仅由拥有策略解释；通用生成器不解析布局内容。 */
  readonly layout?: NodeLayout;
};

export type GeneratorPackageCreatedBy =
  | "initialization"
  | "addition"
  | "shared-dependency";

export type GeneratorContent<
  Context,
  Contribution extends PackageContribution,
  CreationInput = PackageCreationInput,
> = {
  readonly identity: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath: string;
  readonly role: PackageDefinition["role"];
  contribute(options: {
    readonly context: Context;
    readonly definition: PackageDefinition;
    readonly bindings?: ReadonlyMap<string, PackageDefinition>;
    /** 创建该包实例时持久化的原始操作。 */
    readonly createdBy: GeneratorPackageCreatedBy;
    readonly creationInput?: CreationInput;
    /** 按稳定节点身份解析、供项目行为使用的实例。 */
    readonly nodeInstances: GeneratorNodeInstances;
  }): Contribution;
};

export type GeneratorPackageRecord<CreationInput = PackageCreationInput> = {
  readonly contentIdentity: string;
  readonly createdBy: GeneratorPackageCreatedBy;
  readonly definition: PersistedPackageDefinition;
  /** 原始创建语义由内容消费；包定义仍只保存在蓝图中。 */
  readonly creationInput?: CreationInput;
  /** 以内容身份为键，记录已选包实例的持久化标识。 */
  readonly bindings: Readonly<Record<string, string>>;
};

/** 持久化节点表仅引用蓝图已有的包实例身份。 */
export type GeneratorNodeInstanceIds = Readonly<
  Record<string, PackageDefinitionId>
>;

/** 策略计算看到的节点实例是解析后的真实 Definition。 */
export type GeneratorNodeInstances = ReadonlyMap<string, PackageDefinition>;

export type WorkspaceProjection = {
  /** 策略拥有并封闭管理、并入当前蓝图的项目关系。 */
  readonly blueprint?: ProjectBlueprint;
  readonly operations: readonly RenderOperation[];
  readonly reconciliation: readonly ProjectProjectionReconciliation[];
};

/**
 * 工作区策略拥有自身持久事实、上下文解释和根投影。生成器不解释策略状态，
 * 只负责包实例、绑定、记录演化以及 Before/After 组合。
 */
export type WorkspaceStrategy<
  Context,
  Input,
  StrategyState,
  Contribution extends PackageContribution,
  CreationInput extends PackageCreationInput = PackageCreationInput,
  Content extends GeneratorContent<Context, Contribution, CreationInput> =
    GeneratorContent<Context, Contribution, CreationInput>,
  NodeLayout = unknown,
  PresetProjectContribution = unknown,
> = {
  readonly identity: string;
  initialize(options: {
    readonly targetRoot: string;
    readonly input: Input;
    readonly selection: readonly GeneratorSelectionRoot<
      CreationInput,
      NodeLayout
    >[];
  }): { readonly context: Context; readonly state: StrategyState };
  prepareAddition(options: {
    readonly targetRoot: string;
    readonly state: StrategyState;
    readonly content: Content;
    readonly contentByIdentity: ReadonlyMap<string, Content>;
    readonly packages: readonly GeneratorPackageRecord<CreationInput>[];
    readonly nodeInstances: GeneratorNodeInstances;
  }): Context | Promise<Context>;
  parseState(value: unknown): StrategyState;
  /** 策略把原生依赖声明映射为显式内容身份。 */
  dependencies(options: {
    readonly content: Content;
    readonly contentByIdentity: ReadonlyMap<string, Content>;
  }): readonly string[];
  /** 策略把已选依赖实例映射为内容原生的绑定键。 */
  bindings(options: {
    readonly content: Content;
    readonly contentByIdentity: ReadonlyMap<string, Content>;
    readonly providers: ReadonlyMap<string, PackageDefinition>;
  }): ReadonlyMap<string, PackageDefinition>;
  createDefinition(options: {
    readonly context: Context;
    readonly content: Content;
    readonly creationInput?: CreationInput;
    readonly layout?: NodeLayout;
  }): PackageDefinition;
  project(options: {
    readonly context: Context;
    readonly state: StrategyState;
    readonly blueprint: ProjectBlueprint;
    readonly packages: readonly GeneratorPackageRecord<CreationInput>[];
    readonly contributions: readonly Contribution[];
    readonly nodeInstances: GeneratorNodeInstances;
    /** 各已选预设计算的封闭项目贡献由策略解释。 */
    readonly presetProjectContributions: readonly PresetProjectContribution[];
  }): WorkspaceProjection;
};
