import type {
  ContentIdentity,
  ContentSelector,
  LoadedContentMember,
} from "./content-identity.ts";
import type { PackageContribution } from "./package-contribution.ts";
import type { PresetOwnerSelection } from "./preset-definition.ts";
import type {
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type { ProjectProjectionReconciliation } from "./project-projection.ts";
import type { RenderOperation } from "./renderer.ts";

export {
  generationRecordSchema,
  parseGenerationRecordStructure,
} from "./generation-record.ts";

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
  readonly contentIdentity: ContentSelector;
  readonly creationInput?: CreationInput;
  /** 仅由拥有策略解释；通用生成器不解析布局内容。 */
  readonly layout?: NodeLayout;
};

export type GeneratorPackageCreatedBy =
  | "initialization"
  | "addition"
  | "shared-dependency";

export type GeneratorContentDefinition<
  Context,
  Contribution extends PackageContribution,
  CreationInput = PackageCreationInput,
> = {
  readonly alias: string;
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

/** 本次实际公开入口装载的参考包；definition保留拥有者原对象。 */
export type GeneratorContent<
  Context,
  Contribution extends PackageContribution,
  CreationInput = PackageCreationInput,
> = LoadedContentMember<
  GeneratorContentDefinition<Context, Contribution, CreationInput>,
  "reference"
>;

export type GeneratorPackageRecord<CreationInput = PackageCreationInput> = {
  readonly contentIdentity: ContentIdentity;
  readonly createdBy: GeneratorPackageCreatedBy;
  readonly definition: PersistedPackageDefinition;
  /** 原始创建语义由内容消费；包定义仍只保存在蓝图中。 */
  readonly creationInput?: CreationInput;
  /** 以内容身份为键，记录已选包实例的持久化标识。 */
  readonly bindings: Readonly<Record<string, string>>;
};

/** 当前记录合同的实际公开形状；其持久化格式仍为 generator schema 1。 */
export type GenerationRecord<CreationInput = PackageCreationInput> = {
  readonly schemaVersion: 1;
  readonly strategyIdentity: string;
  readonly strategyState: unknown;
  readonly packages: readonly GeneratorPackageRecord<CreationInput>[];
  readonly nodeInstances: GeneratorNodeInstanceIds;
  readonly presetSelections: readonly PresetOwnerSelection[];
};

/** 持久化节点表仅引用蓝图已有的包实例身份。 */
export type GeneratorNodeInstanceIds = Readonly<
  Record<string, PackageDefinitionId>
>;

/** 策略计算看到的节点实例是解析后的真实 Definition。 */
export type GeneratorNodeInstances = ReadonlyMap<string, PackageDefinition>;

export type WorkspaceProjection<OwnerFacts = unknown> = {
  /** 策略拥有并封闭管理、并入当前蓝图的项目关系。 */
  readonly blueprint?: ProjectBlueprint;
  readonly operations: readonly RenderOperation[];
  readonly reconciliation: readonly ProjectProjectionReconciliation[];
  /** 所属策略为本次消费者提供的有限检查事实；生成器只原样透传。 */
  readonly ownerFacts?: OwnerFacts;
};

/** 所属 workspace owner 通过既有 generator 结果返回的用户输入诊断。 */
export type WorkspaceStrategyInputIssue = {
  readonly code: string;
};

export type WorkspaceStrategyValidationResult =
  | {
      readonly status: "input-invalid";
      readonly issues: readonly WorkspaceStrategyInputIssue[];
    }
  | {
      readonly status: "conflict";
      /** Owner 自有的冲突代码与事实由调用方原样解释。 */
      readonly conflict: { readonly code: string; readonly facts: unknown };
    }
  | void;

/** 策略为自身失败附带、供命令层原样显示的结构化诊断。 */
export type WorkspaceStrategyFailureDiagnostic = {
  readonly message: string;
  readonly suggestion: string;
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
  OwnerFacts = unknown,
> = {
  readonly identity: string;
  initialize(options: {
    readonly targetRoot: string;
    readonly input: Input;
    readonly selection: readonly GeneratorSelectionRoot<
      CreationInput,
      NodeLayout
    >[];
    /** 实际登记且已解析的参考内容，键为规范三元组编码。 */
    readonly contentByIdentity: ReadonlyMap<string, Content>;
  }): { readonly context: Context; readonly state: StrategyState };
  prepareAddition(options: {
    readonly targetRoot: string;
    readonly state: StrategyState;
    readonly content: Content;
    readonly contentByIdentity: ReadonlyMap<string, Content>;
    readonly packages: readonly GeneratorPackageRecord<CreationInput>[];
    readonly nodeInstances: GeneratorNodeInstances;
    /** 本次加包原始输入由策略解释，生成器只透传。 */
    readonly creationInput?: CreationInput;
  }): Context | Promise<Context>;
  /**
   * 上下文和当前贡献准备完成后，策略可校验仍生效的当前工作区事实。
   * 生成器只透传内容与预设计算，不解释所属策略的校验规则。
   */
  validateAddition?(options: {
    readonly targetRoot: string;
    readonly blueprint: ProjectBlueprint;
    readonly content: Content;
    readonly definition: PackageDefinition;
    readonly creationInput?: CreationInput;
    readonly packages: readonly GeneratorPackageRecord<CreationInput>[];
    readonly contributions: readonly Contribution[];
    /** 按需构造同次加包贡献，正式投影复用该结果。 */
    readonly getAdditionContributions: () => readonly Contribution[];
    readonly nodeInstances: GeneratorNodeInstances;
    readonly presetProjectContributions: readonly PresetProjectContribution[];
  }):
    | WorkspaceStrategyValidationResult
    | Promise<WorkspaceStrategyValidationResult>;
  /** 策略可将自身已知的错误转成面向调用方的诊断；生成器不解释其语义。 */
  diagnoseFailure?(
    error: unknown,
  ): WorkspaceStrategyFailureDiagnostic | undefined;
  parseState(value: unknown): StrategyState;
  /** 策略把原生依赖声明映射为显式内容身份。 */
  dependencies(options: {
    readonly content: Content;
    readonly contentByIdentity: ReadonlyMap<string, Content>;
  }): readonly ContentIdentity[];
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
  }): WorkspaceProjection<OwnerFacts>;
};
