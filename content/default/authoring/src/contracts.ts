import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageBinding } from "@ykdz/template-core/reference-package";
import type { TemplateSourceHandle } from "@ykdz/template-core/template-source";
import type { NativeContentManifest } from "@ykdz/template-workspace-authoring/content-artifact";
import type { YAMLMap } from "yaml";

export type ReferencePackageManifest = NativeContentManifest & {
  readonly imports?: Readonly<Record<string, unknown>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export type DefaultWorkspaceConventions = {
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly todo?: boolean;
};

export type DefaultNativeDocument = {
  /** 相对目标所属包目录的路径。 */
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly mode: number;
  readonly scope: "package" | "composition";
  /** 保留源资源路径以便诊断与完整身份归属。 */
  readonly sourcePath: string;
};

export type DefaultCompositionFile = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly sourcePath: string;
};

export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: string;
};

export type WorkspaceOrchestrationOwner = {
  readonly kind: "workspace-orchestration";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner | WorkspaceOrchestrationOwner;

export type PlaywrightBrowserAssetsEnvironmentNeed = {
  readonly kind: "playwright-browser-assets";
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
};

export type ShellCheckEnvironmentNeed = {
  readonly kind: "shellcheck-command";
  readonly owner: ComponentOwner;
};

/** Rust 任务必须在本地与 CI 计划中使用已维护的工具链。 */
export type RustToolchainEnvironmentNeed = {
  readonly kind: "rust-toolchain";
  readonly owner: ComponentOwner;
  readonly toolchain: "stable";
};

/** Docker 仅在独立部署验收中使用，不属于常规生成检查环境。 */
export type DockerEngineEnvironmentNeed = {
  readonly kind: "docker-engine";
};

export type CheckEnvironmentNeed =
  | PlaywrightBrowserAssetsEnvironmentNeed
  | ShellCheckEnvironmentNeed
  | RustToolchainEnvironmentNeed;

export type DeploymentEnvironmentNeed = DockerEngineEnvironmentNeed;

export type EnvironmentNeedsMetadata = {
  readonly schemaVersion: 1;
  readonly check: readonly CheckEnvironmentNeed[];
  readonly deployment: readonly DeploymentEnvironmentNeed[];
};

/** 包贡献可在 CI 中保留的封闭式、按所有者限定的原生诊断制品。 */
export type CiDiagnosticArtifactDeclaration = {
  readonly kind: "playwright" | "vitest-browser";
  readonly owner: ComponentOwner;
};

export type RustToolchainRequirement = {
  readonly toolchain: string;
  readonly components: readonly string[];
  readonly configurationText: string;
};

export type RustToolchainTarget = {
  readonly channel: string;
  readonly declaration: string;
};

export type ApplicationRequirements = {
  readonly rustToolchain?: RustToolchainRequirement & {
    readonly existingDeclaration?: string;
  };
};

export type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "devcontainers"
  | "rust-toolchain";

export type DependabotDirectory = `/${string}`;

/** 内容可以请求的有限根级依赖维护范围。 */
export type DependencyMaintenancePolicy = {
  readonly ecosystems: readonly DependencyEcosystem[];
  readonly directories?: Partial<
    Record<DependencyEcosystem, DependabotDirectory>
  >;
  readonly extraDirectories?: Partial<
    Record<DependencyEcosystem, readonly DependabotDirectory[]>
  >;
  readonly interval: "weekly";
};

type SharedRootCiStep =
  | (Readonly<Record<string, unknown>> & {
      readonly id: string;
    })
  | YAMLMap<unknown>;

/** 内容作者声明共享根文件中的领域条目；不取得根文件写入权。 */
export type SharedRootContribution = {
  readonly kind: "shared-root-files";
  readonly source: string;
  readonly manifest?: {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly imports?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  readonly turboTasks?: Readonly<Record<string, unknown>>;
  readonly typescript?: {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly include?: readonly string[];
  };
  readonly ciSteps?: readonly {
    readonly before?: string;
    readonly steps: readonly SharedRootCiStep[];
  }[];
  readonly ciJob?: {
    readonly name?: string;
    readonly timeoutMinutes?: number;
  };
  readonly environmentNeeds?: {
    readonly check?: readonly CheckEnvironmentNeed[];
    readonly deployment?: readonly DeploymentEnvironmentNeed[];
  };
  readonly dependencyMaintenance?: DependencyMaintenancePolicy;
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
};

export type DefaultRootDeclarationData = {
  /** 只有本次出现该模板执行依赖的内容被选中时才合入根。 */
  readonly requiredTemplateDependency?: string;
  readonly manifest?: Readonly<{
    readonly scripts?: Readonly<Record<string, string>>;
    readonly imports?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  }>;
  readonly turboTasks?: Readonly<Record<string, unknown>>;
  /** 根 TypeScript 项目的完整编译选项与有序 include 片段。 */
  readonly typescript?: Readonly<{
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly include?: readonly string[];
  }>;
  /** 作为有序片段连接，包含反向规则时不得排序。 */
  readonly gitignoreFragments?: readonly string[];
  /** 根检查与部署运行所需的封闭环境声明。 */
  readonly environmentNeeds?: Readonly<{
    readonly check?: readonly CheckEnvironmentNeed[];
    readonly deployment?: readonly DeploymentEnvironmentNeed[];
  }>;
  /** 由共享根文件合成器按冲突与来源规则消费。 */
  readonly ciJob?: SharedRootContribution["ciJob"];
  /** 保留插入锚点、声明顺序和步骤身份。 */
  readonly ciSteps?: SharedRootContribution["ciSteps"];
  /** 由外层工作区规则投影到Dependabot根配置。 */
  readonly dependencyMaintenance?: SharedRootContribution["dependencyMaintenance"];
  /** 根级 CI 工作流的诊断制品声明。 */
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
  /** 工具 owner 在准备阶段声明的本次工作区共同要求。 */
  readonly applicationRequirements?: ApplicationRequirements;
  /** 根位置的独占原生资源；由默认组合校验来源与路径冲突。 */
  readonly files?: readonly DefaultCompositionFile[];
};

export type DefaultReferencePreparedFacts<OwnerFacts = undefined> = {
  readonly nativeDocuments: readonly DefaultNativeDocument[];
  readonly ownerFacts: OwnerFacts;
};

export type ReferenceTemplateDependencyPurpose =
  | "target"
  | "template-execution"
  | "template-build";

export type ReferenceTemplateDependency = {
  readonly name: string;
  readonly purpose: ReferenceTemplateDependencyPurpose;
};

/** 原生清单依赖按目标消费与模板执行用途归一化。 */
export type ReferenceDependencyUse = {
  readonly name: string;
  readonly purposes: readonly ReferenceTemplateDependencyPurpose[];
};

export type DefaultReferenceContributionFacts<OwnerFacts = unknown> = {
  readonly sourcePackageName: string;
  /** 完整目标package.json原生文档；组合前不拆成覆盖片段。 */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly exposure: {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly imports: Readonly<Record<string, unknown>>;
  };
  readonly nativeDocuments: readonly DefaultNativeDocument[];
  readonly compositionFiles: readonly DefaultCompositionFile[];
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  readonly foundation: Readonly<Record<string, unknown>>;
  readonly environmentNeeds: readonly (
    | CheckEnvironmentNeed
    | DeploymentEnvironmentNeed
  )[];
  readonly ciDiagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
  readonly rootDeclaration?: DefaultRootDeclarationData;
  readonly workspaceConfiguration?: {
    readonly kind: "typescript-workspace-configuration";
  };
  readonly referenceBindings: Readonly<Record<string, unknown>>;
  readonly ownerFacts: OwnerFacts;
};

export type NativeReferenceResourceMapping = {
  /** 所属包内的资源路径。 */
  readonly path: string;
  /** 由所属作者通过公开包入口解析得到的外部资源句柄。 */
  readonly source?: TemplateSourceHandle;
  /** 生成目标包内的路径；组合资源不属于当前包时省略。 */
  readonly targetPath?: string;
  /** 只作为 owner 准备输入，不复制到目标包。 */
  readonly prepareOnly?: boolean;
  /** 默认普通文件；有执行位的资源由owner显式声明。 */
  readonly mode?: number;
};

export type DefaultReferenceEvaluationContext<CreationInput, OwnerFacts> = {
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly ownerFacts: OwnerFacts;
  readonly stableCommon: unknown;
};

export type DefaultReferenceManifestTransformOptions<
  CreationInput,
  OwnerFacts,
> = {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly stableCommon: unknown;
  readonly ownerFacts: OwnerFacts;
};

export type DefaultReferenceDocumentTransformOptions<
  CreationInput,
  OwnerFacts,
> = Omit<
  DefaultReferenceManifestTransformOptions<CreationInput, OwnerFacts>,
  "manifest"
> & {
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
};
