import type { PackageContribution } from "./package-contribution.ts";
import type {
  PackageDefinition,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type { ProjectProjectionReconciliation } from "./project-projection.ts";
import type { RenderOperation } from "./renderer.ts";

/** 生成器显式接收的一项内容定义。 */
export type GeneratorContent<
  Context,
  Contribution extends PackageContribution,
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
  }): Contribution;
};

export type GeneratorPackageRecord = {
  readonly contentIdentity: string;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly definition: PersistedPackageDefinition;
  /** 以内容身份为键，记录已选包实例的持久化标识。 */
  readonly bindings: Readonly<Record<string, string>>;
};

export type WorkspaceProjection = {
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
  Content extends GeneratorContent<Context, Contribution> = GeneratorContent<
    Context,
    Contribution
  >,
> = {
  readonly identity: string;
  initialize(options: {
    readonly targetRoot: string;
    readonly input: Input;
    readonly selection: string;
  }): { readonly context: Context; readonly state: StrategyState };
  restore(options: {
    readonly targetRoot: string;
    readonly state: StrategyState;
  }): Context;
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
    readonly leafName?: string;
    readonly packagePath?: string;
  }): PackageDefinition;
  project(options: {
    readonly context: Context;
    readonly state: StrategyState;
    readonly blueprint: ProjectBlueprint;
    readonly packages: readonly GeneratorPackageRecord[];
    readonly contributions: readonly Contribution[];
  }): WorkspaceProjection;
};
