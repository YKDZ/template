import {
  type ContentIdentity,
  type ContentSelector,
  type LoadedContentMember,
} from "./content-identity.ts";
import type { JsonValue } from "./json.ts";
import type { PackageContribution } from "./package-contribution.ts";
import type {
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
} from "./project-blueprint.ts";

export type ResourceFileSnapshot = {
  /** 所属参考包中的规范相对路径。 */
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
};

export type PreparedReference<Facts = JsonValue> = {
  readonly resources: readonly ResourceFileSnapshot[];
  readonly facts: Facts;
};

/** 从显式资源快照读取 UTF-8 文本；不会回读作者目录。 */
export function readTextResource(
  prepared: PreparedReference,
  resourcePath: string,
): string {
  const resource = prepared.resources.find(
    (item) => item.path === resourcePath,
  );
  if (resource === undefined) {
    throw new Error(`资源快照中不存在文件：${resourcePath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(resource.content);
  } catch (cause) {
    throw new Error(`资源快照不是有效 UTF-8 文本：${resourcePath}`, { cause });
  }
}

export type ContentIdentityReferenceDependency<
  CreationInput extends JsonValue = JsonValue,
> = {
  /** 所属内容稳定拥有的要求键。 */
  readonly key: string;
  readonly contentIdentity: ContentIdentity;
  readonly creationInput?: CreationInput;
};

/** 由所属包公开入口解析、只可绑定同一来源命名空间的原生依赖。 */
export type OwnerLocalReferenceDependency<
  CreationInput extends JsonValue = JsonValue,
> = {
  /** 所属内容稳定拥有的要求键。 */
  readonly key: string;
  readonly ownerLocal: {
    /** 规范原生包与公开子路径，例如 @scope/tooling/template。 */
    readonly specifier: string;
    /** 必须来自声明所属模块的公开包解析器。 */
    readonly resolve: (specifier: string) => string;
  };
  readonly creationInput?: CreationInput;
};

/** 新作者可声明完整来源身份，原生包可声明自己的公开入口。 */
export type ReferenceDependency<CreationInput extends JsonValue = JsonValue> =
  | ContentIdentityReferenceDependency<CreationInput>
  | OwnerLocalReferenceDependency<CreationInput>;

export type PackageBinding = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly contentIdentity: ContentIdentity;
  readonly definition: PersistedPackageDefinition;
  readonly facts: unknown;
};

export type ReferencePackageEvaluationOptions<
  Conventions,
  CreationInput extends JsonValue,
  PreparedFacts,
  StableCommon,
  PackageInput,
> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly definition: PersistedPackageDefinition;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly creationInput: CreationInput | undefined;
  readonly prepared: PreparedReference<PreparedFacts>;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly conventions: Conventions;
  readonly stableCommon: StableCommon;
  readonly packageInput: PackageInput | undefined;
};

/** 作者拥有自身资源、布局、依赖声明和纯计算。 */
export type ReferencePackageDefinition<
  Conventions = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  PreparedFacts = JsonValue,
  StableCommon = JsonValue,
  PackageInput = JsonValue,
  ContributionFacts = JsonValue,
> = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
  prepare(options?: {
    /** 已知嵌套包的目标路径，作者在收集资源前排除这些子作用域。 */
    readonly excludedPackagePaths: readonly string[];
  }):
    | PreparedReference<PreparedFacts>
    | Promise<PreparedReference<PreparedFacts>>;
  /** 本内容声明的公开依赖身份及稳定要求键。 */
  readonly dependencies?: readonly ReferenceDependency<CreationInput>[];
  parseCreationInput(value: unknown): CreationInput;
  createDefinition(options: {
    readonly conventions: Conventions;
    readonly creationInput: CreationInput | undefined;
    readonly layout?: unknown;
  }): PackageDefinition;
  evaluate(
    options: ReferencePackageEvaluationOptions<
      Conventions,
      CreationInput,
      PreparedFacts,
      StableCommon,
      PackageInput
    >,
  ): PackageContribution<ContributionFacts>;
};

export type ReferencePackage<
  Definition extends ReferencePackageDefinition = ReferencePackageDefinition,
> = LoadedContentMember<Definition, "reference">;

export type ReferenceSelectionRoot<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly nodeIdentity: string;
  readonly contentIdentity: ContentSelector;
  readonly creationInput?: CreationInput;
  readonly layout?: unknown;
};

export type PresetReference = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
};

export type PresetSelectionDefinition<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly kind: "preset";
  readonly operations: readonly ("init" | "add")[];
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly reference: PresetReference;
        readonly layout?: unknown;
        readonly creationInput?: Partial<Record<"init" | "add", CreationInput>>;
      }
    >
  >;
};

export type PresetSelectionRequest<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly contentIdentity: ContentSelector;
  readonly creationInput?: CreationInput;
};
