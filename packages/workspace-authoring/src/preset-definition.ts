import type {
  PackageDefinition,
  ProjectBlueprintDraft,
} from "@ykdz/template-core/project-blueprint";
import type { TemplateSourceHandle } from "@ykdz/template-core/renderer";

import type { DefaultPackageRole } from "./default-package-role.ts";
import type { PackageContribution } from "./package-contribution.ts";

/** 工具链事实解析后提供的稳定、与预设无关的输入。 */
export type GenerationContext = {
  readonly targetDir: string;
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly foundationPackages: {
    readonly typescriptConfiguration: {
      readonly name: string;
    };
  };
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly packageManagerPin: string;
    /**
     * 只有确实已知的精确三段 Node 版本才写入：初始化取自 CLI 发版快照，加包取自目标根现行精确声明。
     * 纯大版本根保持缺省，不从 nodeLtsMajor 伪造 patch；该字段也不是任何版本回退的来源。
     */
    readonly nodeVersion?: string;
    /**
     * 只有确实已知的 Rust channel 才写入：初始化取自 CLI 发版快照的精确版本，已有 Rust 能力的
     * 目标仓库在加包时取自其根 rust-toolchain.toml 的现行声明。该字段同样不是版本回退的来源，
     * 也不进入 Environment Needs 或 Generation Record。
     */
    readonly rustVersion?: string;
  };
};

/** 标记了稳定回放适配器的内存计划。 */
export type PlannedPackageContribution = PackageContribution & {
  readonly planningIdentity: string;
};

/** 通过稳定适配器身份访问初始化时的同级包。 */
export type InitialPackageDefinitionLookup = {
  require(identity: string): PackageDefinition;
};

export type PackageContributionReplayAdapter = {
  readonly identity: string;
  identify(contribution: PackageContribution): PlannedPackageContribution;
  replay(options: {
    readonly context: GenerationContext;
    readonly planningContribution:
      | "foundationPlan"
      | "planInitialization"
      | "planPackageAddition";
    readonly packageDefinition: PackageDefinition;
    readonly packageLeafName: string;
    readonly initialPackages: InitialPackageDefinitionLookup;
  }): PackageContribution;
};

/**
 * 声明一种稳定的回放语义。持久化来源的选择和诊断由 Foundation 负责，
 * 不泄漏到 Preset。
 */
export function definePackageContributionReplayAdapter(options: {
  readonly identity: string;
  readonly replay: PackageContributionReplayAdapter["replay"];
}): PackageContributionReplayAdapter {
  if (options.identity.length === 0) {
    throw new Error("Package Contribution replay adapter identity is required");
  }
  return {
    identity: options.identity,
    identify(contribution) {
      return { ...contribution, planningIdentity: options.identity };
    },
    replay: options.replay,
  };
}

export type ResolvedPrimaryPackageIdentity = {
  readonly leafName: string;
  readonly definition: PackageDefinition;
};

/** 仅由可配置初始包的 Preset 持有的可选行为。 */
export type InitialPrimaryPackageCapability = {
  readonly defaultLeafName: string;
  readonly role: DefaultPackageRole;
  defaultPackagePath(options: { readonly packageLeafName: string }): string;
  planInitialContribution(options: {
    readonly context: GenerationContext;
    readonly resolvedPackageIdentity: ResolvedPrimaryPackageIdentity;
  }): PlannedPackageContribution;
};

type BuiltInPresetDefinitionBase = {
  readonly metadata: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
  };
  /** Definition 持有预设本地的自检模板源码。 */
  readonly source: TemplateSourceHandle;
  /** 由模板边界检查审查的规划器源码。 */
  readonly plannerSourceFile: string;
  /** 用于回放持久化 Package Definition 的稳定语义。 */
  readonly packageContributionReplayAdapters: readonly PackageContributionReplayAdapter[];
  /** 即使调用方省略 --path，包布局仍由 Preset 持有。 */
  defaultPackagePath?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
  }): string;
  planPackageAddition?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
    readonly packagePath: string;
  }): PlannedPackageContribution;
};

type ConfigurablePrimaryPackagePresetDefinition =
  BuiltInPresetDefinitionBase & {
    readonly initialPrimaryPackage: InitialPrimaryPackageCapability;
    readonly blueprint?: never;
    readonly planInitialization?: never;
    readonly planInitializationContributions?: never;
  };

type FixedTopologyPresetDefinition = BuiltInPresetDefinitionBase & {
  readonly initialPrimaryPackage?: never;
  blueprint(context: GenerationContext): ProjectBlueprintDraft;
  planInitialization(context: GenerationContext): PlannedPackageContribution;
  /** 多包 Definition 直接公开其完整拥有拓扑。 */
  planInitializationContributions?(
    context: GenerationContext,
  ): readonly PlannedPackageContribution[];
};

/** 无副作用的内置 Preset 规划器。 */
export type BuiltInPresetDefinition =
  | ConfigurablePrimaryPackagePresetDefinition
  | FixedTopologyPresetDefinition;
