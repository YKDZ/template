import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "@ykdz/template-core/json";
import { assertJsonValue } from "@ykdz/template-core/json";
import type {
  PackageContribution,
  PackageContributionFile,
} from "@ykdz/template-core/package-contribution";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { ProjectProjectionReconciliation } from "@ykdz/template-core/project-projection";
import type {
  PackageBinding,
  ReferenceDependency,
  ReferencePackageDefinition,
  ResourceFileSnapshot,
} from "@ykdz/template-core/reference-package";
import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";
import {
  defineNativeReferenceContentArtifact,
  type NativeContentArtifactResource,
  type NativeContentManifest,
} from "@ykdz/template-workspace-authoring/content-artifact";
import { mapPackageNamesInJson } from "@ykdz/template-workspace-authoring/package-name-projection";
import { mapTypeScriptModuleSpecifiers } from "@ykdz/template-workspace-authoring/typescript-module-specifiers";
import { parse, type ParseError } from "jsonc-parser";

import type { ApplicationRequirements } from "./application-requirements.ts";
import type { CiDiagnosticArtifactDeclaration } from "./ci-diagnostic-artifact.ts";
import type { DefaultPackageRole } from "./default-package-role.ts";
import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
} from "./environment-needs.ts";
import type { SharedRootContribution } from "./shared-root-files.ts";

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

export type NativeReferenceResourceMapping = {
  /** 所属包内的资源路径。 */
  readonly path: string;
  /** 生成目标包内的路径；组合资源不属于当前包时省略。 */
  readonly targetPath?: string;
  /** 只作为 owner 准备输入，不复制到目标包。 */
  readonly prepareOnly?: boolean;
  /** 默认普通文件；有执行位的资源由owner显式声明。 */
  readonly mode?: number;
};

export type DefaultReferenceEvaluationContext<
  CreationInput extends JsonValue,
  OwnerFacts,
> = {
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly ownerFacts: OwnerFacts;
  readonly stableCommon: unknown;
};

export type DefaultReferenceManifestTransformOptions<
  CreationInput extends JsonValue,
  OwnerFacts,
> = {
  /** 由原生清单和明确包绑定投影的目标清单。 */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly stableCommon: unknown;
  readonly ownerFacts: OwnerFacts;
};

export type DefaultReferenceDocumentTransformOptions<
  CreationInput extends JsonValue,
  OwnerFacts,
> = Omit<
  DefaultReferenceManifestTransformOptions<CreationInput, OwnerFacts>,
  "manifest"
> & {
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
};

const dependencyPurposeOrder: readonly ReferenceTemplateDependencyPurpose[] = [
  "target",
  "template-execution",
  "template-build",
];

const packageManifestKeyOrder = [
  "name",
  "version",
  "private",
  "bin",
  "files",
  "type",
  "types",
  "imports",
  "exports",
  "publishConfig",
  "scripts",
  "dependencies",
  "devDependencies",
  "dependenciesMeta",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "packageManager",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResourcePath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /[!*?{}[\]]/u.test(value)
  ) {
    throw new Error(`原生参考包资源路径无效：${value}`);
  }
  return normalized;
}

function ownerResource(
  resourceRoot: URL,
  mapping: NativeReferenceResourceMapping,
): NativeContentArtifactResource {
  const resourcePath = normalizeResourcePath(mapping.path);
  const absolutePath = path.resolve(
    fileURLToPath(resourceRoot),
    ...resourcePath.split("/"),
  );
  const rootPath = path.resolve(fileURLToPath(resourceRoot));
  const relative = path.relative(rootPath, absolutePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`原生参考包资源越过所属包目录：${mapping.path}`);
  }
  return {
    path: resourcePath,
    ...(mapping.targetPath === undefined
      ? {}
      : { targetPath: normalizeResourcePath(mapping.targetPath) }),
    source: createTemplateSourceHandle(absolutePath),
    mode: mapping.mode ?? 0o644,
  };
}

function manifestDependencyNames(
  manifest: ReferencePackageManifest,
): Set<string> {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[field];
    if (!isRecord(value)) continue;
    for (const name of Object.keys(value)) names.add(name);
  }
  return names;
}

function normalizeDependencyUses(
  manifest: ReferencePackageManifest,
  templateDependencies: readonly ReferenceTemplateDependency[],
): readonly ReferenceDependencyUse[] {
  const uses = new Map<string, Set<ReferenceTemplateDependencyPurpose>>();
  for (const name of manifestDependencyNames(manifest)) {
    uses.set(name, new Set(["target"]));
  }

  const declared = new Set<string>();
  const seen = new Set<string>();
  for (const dependency of templateDependencies) {
    if (
      dependency.name.trim() !== dependency.name ||
      dependency.name.length === 0 ||
      !dependencyPurposeOrder.includes(dependency.purpose)
    ) {
      throw new Error(
        `模板依赖用途无效：${dependency.name} (${dependency.purpose})`,
      );
    }
    const purposes = uses.get(dependency.name);
    if (purposes === undefined) {
      throw new Error(
        `模板依赖未在原生清单声明：${dependency.name} (${dependency.purpose})`,
      );
    }
    const key = `${dependency.name}\u0000${dependency.purpose}`;
    if (seen.has(key)) {
      throw new Error(
        `模板依赖用途重复：${dependency.name} (${dependency.purpose})`,
      );
    }
    seen.add(key);
    if (!declared.has(dependency.name)) {
      purposes.clear();
      declared.add(dependency.name);
    }
    purposes.add(dependency.purpose);
  }

  return Object.freeze(
    [...uses].map(([name, purposes]) =>
      Object.freeze({
        name,
        purposes: Object.freeze(
          dependencyPurposeOrder.filter((purpose) => purposes.has(purpose)),
        ),
      }),
    ),
  );
}

function dependencyPackageName(specifier: string): string {
  const parts = specifier.split("/");
  const packageLength = specifier.startsWith("@") ? 2 : 1;
  if (
    parts.length < packageLength ||
    parts.slice(0, packageLength).some((part) => part.length === 0)
  ) {
    throw new Error(`原生依赖公开入口无效：${specifier}`);
  }
  return parts.slice(0, packageLength).join("/");
}

function assertNativeDocument(
  sourcePath: string,
  content: Uint8Array,
): Readonly<Record<string, unknown>> {
  const errors: ParseError[] = [];
  let value: unknown;
  try {
    value = parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
      errors,
      {
        allowTrailingComma: true,
      },
    );
  } catch (error) {
    throw new Error(`原生JSON文档不是有效UTF-8：${sourcePath}`, {
      cause: error,
    });
  }
  if (!isRecord(value) || errors.length > 0) {
    throw new Error(`原生工具配置必须是有效的JSONC对象：${sourcePath}`);
  }
  return value;
}

function formatJsonValue(
  value: unknown,
  depth: number,
  column: number,
  pathSegments: readonly string[],
  multilineArrayPaths: ReadonlySet<string>,
  trailingComma = false,
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    const scalarItems = value.every(
      (item) => item === null || typeof item !== "object",
    );
    if (scalarItems) {
      const inline = `[${value
        .map((item) => JSON.stringify(item) ?? "null")
        .join(", ")}]`;
      if (
        !multilineArrayPaths.has(pathSegments.join(".")) &&
        column + inline.length + (trailingComma ? 1 : 0) <= 80
      ) {
        return inline;
      }
    }
    if (value.length === 0) return "[]";
    const itemIndent = "  ".repeat(depth + 1);
    return `[\n${itemIndent}${value
      .map((item, index) =>
        formatJsonValue(
          item,
          depth + 1,
          itemIndent.length,
          [...pathSegments, String(index)],
          multilineArrayPaths,
          index < value.length - 1,
        ),
      )
      .join(`,\n${itemIndent}`)}\n${indent}]`;
  }
  if (!isRecord(value)) {
    throw new Error("原生JSON文档只能包含普通对象");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const childIndent = "  ".repeat(depth + 1);
  return `{\n${childIndent}${entries
    .map(([key, child], index) => {
      const prefix = `${JSON.stringify(key)}: `;
      return `${prefix}${formatJsonValue(
        child,
        depth + 1,
        childIndent.length + prefix.length,
        [...pathSegments, key],
        multilineArrayPaths,
        index < entries.length - 1,
      )}`;
    })
    .join(`,\n${childIndent}`)}\n${indent}}`;
}

export function serializeNativeJson(
  value: unknown,
  options: { readonly multilineArrayPaths?: readonly string[] } = {},
): Uint8Array {
  return new TextEncoder().encode(
    `${formatJsonValue(
      value,
      0,
      0,
      [],
      new Set(options.multilineArrayPaths ?? []),
    )}\n`,
  );
}

function reconciliationDriver(resourcePath: string): "text" | "canonical" {
  return /(?:^|\/)(?:Dockerfile|\.gitignore|\.npmignore|\.dockerignore)$/iu.test(
    resourcePath,
  ) ||
    /\.(?:[cm]?[jt]sx?|jsonc?|md|mdx|txt|ya?ml|toml|xml|html|css|scss|vue|sh|svg)$/iu.test(
      resourcePath,
    )
    ? "text"
    : "canonical";
}

function isNativeDocumentPath(resourcePath: string): boolean {
  return (
    /(?:^|\/)tsconfig[^/]*\.jsonc?$/u.test(resourcePath) ||
    /(?:^|\/)turbo\.jsonc?$/u.test(resourcePath)
  );
}

function packageNameMapping(options: {
  readonly ownerPackageName: string;
  readonly definition: { readonly name: string; readonly path: string };
  readonly dependencies: readonly ReferenceDependency[];
  readonly bindings: ReadonlyMap<string, PackageBinding>;
}): Map<string, string> {
  const names = new Map<string, string>([
    [options.ownerPackageName, options.definition.name],
  ]);
  for (const dependency of options.dependencies) {
    const binding = options.bindings.get(dependency.key);
    if (binding === undefined) {
      throw new Error(`原生参考依赖缺少提供者绑定：${dependency.key}`);
    }
    names.set(binding.contentIdentity.packageName, binding.definition.name);
  }
  return names;
}

function outputManifest(options: {
  readonly manifest: ReferencePackageManifest;
  readonly definition: {
    readonly name: string;
    readonly path: string;
  };
  readonly conventions: DefaultWorkspaceConventions;
  readonly stableCommon: unknown;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly dependencies: readonly ReferenceDependency[];
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  readonly templateScripts: readonly string[];
  readonly templateExports: readonly string[];
  readonly names: ReadonlyMap<string, string>;
}): Readonly<Record<string, unknown>> {
  const manifest = mapPackageNamesInJson(
    structuredClone(options.manifest),
    options.names,
  ) as Record<string, unknown>;
  manifest.name = options.definition.name;

  const exports = isRecord(manifest.exports) ? { ...manifest.exports } : {};
  for (const name of [
    "./reference",
    "./template",
    ...options.templateExports,
  ]) {
    delete exports[name];
  }
  if (Object.keys(exports).length > 0) manifest.exports = exports;
  else delete manifest.exports;

  const scripts = isRecord(manifest.scripts) ? { ...manifest.scripts } : {};
  for (const name of options.templateScripts) delete scripts[name];
  if (Object.keys(scripts).length > 0) manifest.scripts = scripts;
  else delete manifest.scripts;

  const targetDependencyNames = new Set(
    normalizeDependencyUses(options.manifest, options.templateDependencies)
      .filter(({ purposes }) => purposes.includes("target"))
      .map(({ name }) => name),
  );
  const dependencyBindings = new Map<string, PackageBinding>();
  for (const dependency of options.dependencies) {
    const sourcePackageName =
      "contentIdentity" in dependency
        ? dependency.contentIdentity.packageName
        : dependencyPackageName(dependency.ownerLocal.specifier);
    const binding = options.bindings.get(dependency.key);
    if (binding === undefined) {
      throw new Error(`原生参考依赖缺少提供者绑定：${dependency.key}`);
    }
    dependencyBindings.set(sourcePackageName, binding);
  }

  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const sourceDependencies = options.manifest[field];
    if (!isRecord(sourceDependencies)) continue;
    const dependencies: Record<string, unknown> = {};
    for (const [sourceName, specifier] of Object.entries(sourceDependencies)) {
      if (!targetDependencyNames.has(sourceName)) continue;
      const targetName = options.names.get(sourceName) ?? sourceName;
      const binding = dependencyBindings.get(sourceName);
      if (binding === undefined) {
        dependencies[targetName] = specifier;
        continue;
      }
      if (typeof specifier !== "string") {
        throw new Error(`原生依赖版本必须是字符串：${sourceName}`);
      }
      if (
        !specifier.startsWith("link:") &&
        !specifier.startsWith("workspace:./") &&
        !specifier.startsWith("workspace:../")
      ) {
        dependencies[targetName] = specifier;
        continue;
      }
      const relative = path.posix.relative(
        options.definition.path,
        binding.definition.path,
      );
      const protocol = specifier.startsWith("link:") ? "link:" : "workspace:";
      const relativeSpecifier = relative.startsWith(".")
        ? relative
        : `./${relative}`;
      dependencies[binding.definition.name] = `${protocol}${relativeSpecifier}`;
    }
    manifest[field] = dependencies;
  }

  if (isRecord(manifest.engines) && isRecord(options.stableCommon)) {
    const nodeDeclaration = options.stableCommon.nodeDeclaration;
    if (typeof nodeDeclaration === "string") {
      manifest.engines = { ...manifest.engines, node: nodeDeclaration };
    }
  }
  if (options.definition.path === ".") {
    delete manifest.version;
    if (isRecord(options.stableCommon)) {
      if (typeof options.stableCommon.nodeDeclaration === "string") {
        manifest.engines = {
          ...(isRecord(manifest.engines) ? manifest.engines : {}),
          node: options.stableCommon.nodeDeclaration,
        };
      }
      if (typeof options.stableCommon.packageManagerPin === "string") {
        manifest.packageManager = options.stableCommon.packageManagerPin;
      }
    }
    manifest.name = options.conventions.repositoryName;
  }
  return Object.freeze(manifest);
}

function packagePath(options: {
  readonly creationInput: JsonValue | undefined;
  readonly layout: unknown;
  readonly defaultPath: string;
  readonly defaultLeafName: string;
}): string {
  const layoutPath = isRecord(options.layout)
    ? options.layout.packageDirectory
    : undefined;
  const creationPath = isRecord(options.creationInput)
    ? options.creationInput.packagePath
    : undefined;
  if (options.defaultPath === ".") return ".";
  const defaultPath =
    typeof layoutPath === "string"
      ? path.posix.join(layoutPath, options.defaultLeafName)
      : options.defaultPath;
  const leafName = isRecord(options.creationInput)
    ? options.creationInput.leafName
    : undefined;
  const parentPath = path.posix.dirname(defaultPath);
  const selected =
    typeof creationPath === "string"
      ? creationPath
      : typeof leafName === "string"
        ? path.posix.join(
            parentPath === "." ? "packages" : parentPath,
            leafName,
          )
        : defaultPath;
  const normalized = path.posix.normalize(selected);
  if (
    normalized !== selected ||
    selected.startsWith("/") ||
    selected === ".." ||
    selected.startsWith("../") ||
    selected.includes("\\")
  ) {
    throw new Error(`默认参考包目录无效：${selected}`);
  }
  return selected;
}

function packageName(options: {
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: JsonValue | undefined;
  readonly defaultLeafName: string;
  readonly defaultPath: string;
}): string {
  if (options.defaultPath === ".") return options.conventions.repositoryName;
  const inputName = isRecord(options.creationInput)
    ? options.creationInput.packageName
    : undefined;
  if (typeof inputName === "string") return inputName;
  const inputLeaf = isRecord(options.creationInput)
    ? options.creationInput.leafName
    : undefined;
  const leaf =
    typeof inputLeaf === "string" ? inputLeaf : options.defaultLeafName;
  return `@${options.conventions.defaultPackageScope}/${leaf}`;
}

/** 以所属原生manifest和资源快照生成统一ReferencePackageDefinition。 */
export type DefaultReferencePackageDefinition<
  CreationInput extends JsonValue = JsonValue,
  OwnerFacts = undefined,
> = ReturnType<
  typeof defineNativeReferenceContentArtifact<
    ReferencePackageDefinition<
      DefaultWorkspaceConventions,
      CreationInput,
      DefaultReferencePreparedFacts<OwnerFacts>,
      unknown,
      unknown,
      DefaultReferenceContributionFacts<OwnerFacts>
    >,
    DefaultReferencePreparedFacts<OwnerFacts>
  >
> & {
  readonly manifest: ReferencePackageManifest;
  readonly defaultPath: string;
  readonly role: DefaultPackageRole;
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  readonly targetExports: Readonly<Record<string, unknown>>;
  readonly targetDependencyNames: readonly string[];
  readonly targetDependencyKeys: readonly string[];
  readonly rootDeclarationAvailable: boolean;
  readonly prepareRootDeclaration: (
    ownerFacts: OwnerFacts,
  ) => DefaultRootDeclarationData | undefined;
};

export function defineReferencePackage<
  CreationInput extends JsonValue = JsonValue,
  OwnerFacts = undefined,
>(options: {
  readonly manifest: ReferencePackageManifest;
  readonly artifactVersion?: string;
  readonly resourceRoot: URL;
  readonly alias: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath?: string;
  readonly role: DefaultPackageRole;
  readonly workspaceConfiguration?: {
    readonly kind: "typescript-workspace-configuration";
  };
  readonly resources: readonly NativeReferenceResourceMapping[];
  readonly compositionResources?: readonly NativeReferenceResourceMapping[];
  readonly dependencies?: readonly ReferenceDependency<CreationInput>[];
  /** 不创建包实例、只声明所需原生根附件owner的引用。 */
  readonly rootAttachmentDependencies?: readonly ReferenceDependency[];
  readonly templateDependencies?: readonly ReferenceTemplateDependency[];
  readonly executionDependencies?: readonly string[];
  readonly templateScripts?: readonly string[];
  readonly templateExports?: readonly string[];
  readonly foundation?:
    | Readonly<Record<string, unknown>>
    | ((
        context: DefaultReferenceEvaluationContext<CreationInput, OwnerFacts>,
      ) => Readonly<Record<string, unknown>>);
  readonly environmentNeeds?:
    | readonly (CheckEnvironmentNeed | DeploymentEnvironmentNeed)[]
    | ((
        context: DefaultReferenceEvaluationContext<CreationInput, OwnerFacts>,
      ) => readonly (CheckEnvironmentNeed | DeploymentEnvironmentNeed)[]);
  readonly ciDiagnosticArtifacts?:
    | readonly CiDiagnosticArtifactDeclaration[]
    | ((
        context: DefaultReferenceEvaluationContext<CreationInput, OwnerFacts>,
      ) => readonly CiDiagnosticArtifactDeclaration[]);
  readonly rootDeclaration?: (
    ownerFacts: OwnerFacts,
    stableCommon?: unknown,
  ) => DefaultRootDeclarationData | undefined;
  readonly prepareFacts?: (
    resources: readonly ResourceFileSnapshot[],
    options: Readonly<{ readonly excludedPackagePaths: readonly string[] }>,
  ) => OwnerFacts;
  /** 在默认原生清单投影后应用本包的纯清单规则。 */
  readonly transformManifest?: (
    options: DefaultReferenceManifestTransformOptions<
      CreationInput,
      OwnerFacts
    >,
  ) => Readonly<Record<string, unknown>>;
  /** 在所属原生 JSON 文档投影后应用本包的纯变换。 */
  readonly transformDocument?: (
    options: DefaultReferenceDocumentTransformOptions<
      CreationInput,
      OwnerFacts
    >,
  ) => Readonly<Record<string, unknown>>;
}): DefaultReferencePackageDefinition<CreationInput, OwnerFacts> {
  const defaultPath =
    options.defaultPath ?? `packages/${options.defaultLeafName}`;
  const templateDependencies = options.templateDependencies ?? [];
  const dependencyUses = normalizeDependencyUses(
    options.manifest,
    templateDependencies,
  );
  const templateDependencyNames = new Set(
    templateDependencies.map(({ name }) => name),
  );
  const executionDependencies = options.executionDependencies ?? [];
  for (const name of executionDependencies) {
    if (!templateDependencyNames.has(name)) {
      throw new Error(
        `模板执行依赖必须同时声明模板用途：${options.manifest.name}/${name}`,
      );
    }
  }
  const dependencyPurposes = new Map<
    string,
    readonly ("target" | "template-execution")[]
  >(
    dependencyUses.map(({ name, purposes }) => [
      name,
      purposes.filter(
        (purpose): purpose is "target" | "template-execution" =>
          purpose !== "template-build",
      ),
    ]),
  );
  const resourceMappings = [
    ...options.resources,
    ...(options.compositionResources ?? []),
  ].map((mapping) => ({
    ...mapping,
    path: normalizeResourcePath(mapping.path),
    ...(mapping.targetPath === undefined
      ? {}
      : { targetPath: normalizeResourcePath(mapping.targetPath) }),
  }));
  const resourcePaths = new Set<string>();
  for (const resource of resourceMappings) {
    if (resourcePaths.has(resource.path)) {
      throw new Error(`原生参考包重复声明资源：${resource.path}`);
    }
    resourcePaths.add(resource.path);
  }
  const resources = resourceMappings.map((mapping) =>
    ownerResource(options.resourceRoot, mapping),
  );
  const mappingsBySourcePath = new Map(
    resourceMappings.map((mapping) => [mapping.path, mapping]),
  );
  const compositionResourcePaths = new Set(
    (options.compositionResources ?? []).map(({ path: resourcePath }) =>
      normalizeResourcePath(resourcePath),
    ),
  );
  const contentDependencies = Object.freeze(
    [...(options.dependencies ?? [])].map((dependency) =>
      Object.freeze(dependency),
    ),
  );
  const rootAttachmentDependencies = Object.freeze(
    [...(options.rootAttachmentDependencies ?? [])].map((dependency) =>
      Object.freeze(dependency),
    ),
  );
  const rootAttachmentKeys = new Set<string>();
  for (const dependency of rootAttachmentDependencies) {
    if (
      dependency.key.trim().length === 0 ||
      rootAttachmentKeys.has(dependency.key)
    ) {
      throw new Error(
        `原生根附件依赖键不能为空且不能重复：${options.manifest.name}/${dependency.key}`,
      );
    }
    rootAttachmentKeys.add(dependency.key);
  }
  const templateScripts = Object.freeze([...(options.templateScripts ?? [])]);
  const templateExports = Object.freeze([...(options.templateExports ?? [])]);
  const removedExports = new Set([
    "./reference",
    "./template",
    ...templateExports,
  ]);
  const targetExports = Object.freeze(
    Object.fromEntries(
      Object.entries(options.manifest.exports ?? {}).filter(
        ([name]) => !removedExports.has(name),
      ),
    ),
  );
  const targetDependencyKeys = Object.freeze(
    contentDependencies
      .filter((dependency) => {
        const sourceName =
          "contentIdentity" in dependency
            ? dependency.contentIdentity.packageName
            : dependencyPackageName(dependency.ownerLocal.specifier);
        return (
          dependencyUses.some(
            (use) => use.name === sourceName && use.purposes.includes("target"),
          ) && manifestDependencyNames(options.manifest).has(sourceName)
        );
      })
      .map(({ key }) => key),
  );

  const definition = {
    alias: options.alias,
    instance: options.instance,
    manifest: options.manifest,
    defaultPath,
    role: options.role,
    dependencyUses,
    targetExports,
    targetDependencyKeys,
    rootDeclarationAvailable: options.rootDeclaration !== undefined,
    dependencies: contentDependencies,
    rootAttachmentDependencies,
    prepareRootDeclaration(ownerFacts: OwnerFacts) {
      return options.rootDeclaration?.(ownerFacts);
    },
    parseCreationInput(value: unknown): CreationInput {
      assertJsonValue(value, "原生参考包创建输入");
      return value as CreationInput;
    },
    createDefinition(input: {
      readonly conventions: DefaultWorkspaceConventions;
      readonly creationInput: CreationInput | undefined;
      readonly layout?: unknown;
    }) {
      return {
        name: packageName({
          conventions: input.conventions,
          creationInput: input.creationInput,
          defaultLeafName: options.defaultLeafName,
          defaultPath,
        }),
        path: packagePath({
          creationInput: input.creationInput,
          layout: input.layout,
          defaultPath,
          defaultLeafName: options.defaultLeafName,
        }),
        role: options.role,
      };
    },
    evaluate(
      input: Parameters<
        ReferencePackageDefinition<
          DefaultWorkspaceConventions,
          CreationInput,
          DefaultReferencePreparedFacts<OwnerFacts>,
          unknown,
          unknown,
          DefaultReferenceContributionFacts<OwnerFacts>
        >["evaluate"]
      >[0],
    ): PackageContribution<DefaultReferenceContributionFacts<OwnerFacts>> {
      const names = packageNameMapping({
        ownerPackageName: options.manifest.name,
        definition: input.definition,
        dependencies: contentDependencies,
        bindings: input.bindings,
      });
      const defaultManifest = outputManifest({
        manifest: options.manifest,
        definition: input.definition,
        conventions: input.conventions,
        stableCommon: input.stableCommon,
        bindings: input.bindings,
        dependencies: contentDependencies,
        templateDependencies,
        templateScripts,
        templateExports,
        names,
      });
      const manifest =
        options.transformManifest?.({
          manifest: defaultManifest,
          definition: input.definition,
          conventions: input.conventions,
          creationInput: input.creationInput,
          bindings: input.bindings,
          stableCommon: input.stableCommon,
          ownerFacts: input.prepared.facts.ownerFacts,
        }) ?? defaultManifest;
      const sourceDocuments = input.prepared.facts.nativeDocuments;
      const nativeDocuments = sourceDocuments.map((document) => {
        if (document.path === "package.json" && document.scope === "package") {
          return { ...document, value: manifest };
        }
        const value = mapPackageNamesInJson(document.value, names) as Record<
          string,
          unknown
        >;
        if (
          (document.path === "turbo.json" || document.path === "turbo.jsonc") &&
          isRecord(value.tasks)
        ) {
          const tasks = { ...value.tasks };
          for (const script of templateScripts) {
            delete tasks[script];
            delete tasks[`${input.definition.name}#${script}`];
          }
          value.tasks = tasks;
        }
        const transformedDocument =
          options.transformDocument?.({
            path: document.path,
            value,
            definition: input.definition,
            conventions: input.conventions,
            creationInput: input.creationInput,
            bindings: input.bindings,
            stableCommon: input.stableCommon,
            ownerFacts: input.prepared.facts.ownerFacts,
          }) ?? value;
        return {
          ...document,
          value: transformedDocument,
        };
      });
      const documentBySourcePath = new Map(
        nativeDocuments.map((document) => [document.sourcePath, document]),
      );
      const packageFiles: PackageContributionFile[] = [];
      const compositionFiles: DefaultCompositionFile[] = [];
      for (const resource of input.prepared.resources) {
        const mapping = mappingsBySourcePath.get(resource.path);
        if (mapping === undefined) {
          throw new Error(`准备结果包含未声明资源：${resource.path}`);
        }
        if (mapping.prepareOnly === true) continue;
        const document = documentBySourcePath.get(resource.path);
        if (document !== undefined) {
          if (document.scope === "composition") {
            compositionFiles.push({
              path: document.path,
              content: serializeNativeReferenceDocument(document),
              mode: document.mode,
              sourcePath: resource.path,
            });
          }
          continue;
        }
        const textExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"];
        const isTextModule = textExtensions.some((extension) =>
          resource.path.endsWith(extension),
        );
        const text = isTextModule
          ? new TextDecoder("utf-8", { fatal: true }).decode(resource.content)
          : undefined;
        const content =
          text === undefined
            ? resource.content.slice()
            : new TextEncoder().encode(
                mapTypeScriptModuleSpecifiers(text, names, resource.path),
              );
        if (compositionResourcePaths.has(resource.path)) {
          const targetPath = mapping.targetPath;
          if (targetPath === undefined) {
            throw new Error(`组合资源必须声明根目标路径：${resource.path}`);
          }
          compositionFiles.push({
            path: targetPath,
            content,
            mode: resource.mode,
            sourcePath: resource.path,
          });
          continue;
        }
        const targetPath = mapping.targetPath ?? resource.path;
        packageFiles.push({
          path: targetPath,
          content,
          mode: resource.mode,
        });
      }
      const reconciliationByPath = new Map<
        string,
        ProjectProjectionReconciliation
      >(
        nativeDocuments
          .filter((document) => document.scope === "package")
          .map((document): [string, ProjectProjectionReconciliation] => [
            document.path,
            { path: document.path, driver: "structured" },
          ]),
      );
      for (const file of packageFiles) {
        if (!reconciliationByPath.has(file.path)) {
          reconciliationByPath.set(file.path, {
            path: file.path,
            driver: reconciliationDriver(file.path),
          });
        }
      }
      const reconciliations = [...reconciliationByPath.values()];
      const exposureExports = isRecord(manifest.exports)
        ? manifest.exports
        : {};
      const exposureImports = isRecord(manifest.imports)
        ? manifest.imports
        : {};
      const evaluationContext: DefaultReferenceEvaluationContext<
        CreationInput,
        OwnerFacts
      > = {
        definition: input.definition,
        conventions: input.conventions,
        creationInput: input.creationInput,
        bindings: input.bindings,
        ownerFacts: input.prepared.facts.ownerFacts,
        stableCommon: input.stableCommon,
      };
      const rootDeclaration = options.rootDeclaration?.(
        input.prepared.facts.ownerFacts,
        input.stableCommon,
      );
      const foundation =
        typeof options.foundation === "function"
          ? options.foundation(evaluationContext)
          : (options.foundation ?? {});
      const environmentNeeds =
        typeof options.environmentNeeds === "function"
          ? options.environmentNeeds(evaluationContext)
          : (options.environmentNeeds ?? []);
      const ciDiagnosticArtifacts =
        typeof options.ciDiagnosticArtifacts === "function"
          ? options.ciDiagnosticArtifacts(evaluationContext)
          : (options.ciDiagnosticArtifacts ?? []);
      const facts: DefaultReferenceContributionFacts<OwnerFacts> = {
        sourcePackageName: options.manifest.name,
        manifest,
        exposure: {
          exports: exposureExports,
          imports: exposureImports,
        },
        nativeDocuments,
        compositionFiles,
        dependencyUses,
        templateDependencies: Object.freeze([...templateDependencies]),
        foundation,
        environmentNeeds,
        ciDiagnosticArtifacts,
        ...(rootDeclaration === undefined ? {} : { rootDeclaration }),
        ...(options.workspaceConfiguration === undefined
          ? {}
          : { workspaceConfiguration: options.workspaceConfiguration }),
        referenceBindings: Object.fromEntries(
          [...input.bindings].map(([key, binding]) => [
            key,
            binding.definition,
          ]),
        ),
        ownerFacts: input.prepared.facts.ownerFacts,
      };
      return {
        packageDefinitionId: input.packageDefinitionId,
        files: packageFiles,
        reconciliation: reconciliations,
        facts,
      };
    },
  } satisfies Omit<
    ReferencePackageDefinition<
      DefaultWorkspaceConventions,
      CreationInput,
      DefaultReferencePreparedFacts<OwnerFacts>,
      unknown,
      unknown,
      DefaultReferenceContributionFacts<OwnerFacts>
    >,
    "prepare"
  > & {
    readonly manifest: ReferencePackageManifest;
    readonly defaultPath: string;
    readonly role: DefaultPackageRole;
    readonly dependencyUses: readonly ReferenceDependencyUse[];
    readonly targetExports: Readonly<Record<string, unknown>>;
    readonly targetDependencyKeys: readonly string[];
    readonly rootDeclarationAvailable: boolean;
    readonly rootAttachmentDependencies: readonly ReferenceDependency[];
    readonly prepareRootDeclaration: (
      ownerFacts: OwnerFacts,
    ) => DefaultRootDeclarationData | undefined;
  };

  const native = defineNativeReferenceContentArtifact(definition, {
    manifest: options.manifest,
    resourceRoot: options.resourceRoot,
    exportPath: "./template",
    templateExports,
    ...(options.artifactVersion === undefined
      ? {}
      : { artifactVersion: options.artifactVersion }),
    resources,
    dependencyPurposes,
    executionDependencies,
    prepareFacts(snapshot, prepareOptions) {
      const nativeDocuments: DefaultNativeDocument[] = [
        {
          path: "package.json",
          sourcePath: "package.json",
          value: options.manifest,
          mode: 0,
          scope: "package",
        },
      ];
      for (const resource of snapshot) {
        const mapping = mappingsBySourcePath.get(resource.path);
        if (mapping === undefined) {
          throw new Error(`原生配置没有资源映射：${resource.path}`);
        }
        const targetPath = mapping.targetPath ?? resource.path;
        if (!isNativeDocumentPath(targetPath)) continue;
        const document = assertNativeDocument(targetPath, resource.content);
        const scope = compositionResourcePaths.has(resource.path)
          ? "composition"
          : "package";
        nativeDocuments.push({
          path: targetPath,
          sourcePath: resource.path,
          value: document,
          mode: resource.mode,
          scope,
        });
      }
      return {
        nativeDocuments: Object.freeze(nativeDocuments),
        ownerFacts: options.prepareFacts?.(
          snapshot,
          prepareOptions,
        ) as OwnerFacts,
      };
    },
  });
  return Object.freeze({
    ...native,
    manifest: options.manifest,
    defaultPath,
    role: options.role,
    dependencyUses,
    targetExports,
    targetDependencyNames: Object.freeze(
      dependencyUses
        .filter(({ purposes }) => purposes.includes("target"))
        .map(({ name }) => name),
    ),
    targetDependencyKeys,
  });
}

export function serializeNativeReferenceDocument(
  document: DefaultNativeDocument,
): Uint8Array {
  if (document.path !== "package.json") {
    return serializeNativeJson(document.value);
  }
  const manifest = Object.fromEntries(
    Object.entries(document.value).sort(([left], [right]) => {
      const leftIndex = packageManifestKeyOrder.indexOf(
        left as (typeof packageManifestKeyOrder)[number],
      );
      const rightIndex = packageManifestKeyOrder.indexOf(
        right as (typeof packageManifestKeyOrder)[number],
      );
      if (leftIndex === -1 && rightIndex === -1) {
        return left.localeCompare(right);
      }
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }),
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[field];
    if (isRecord(value)) {
      manifest[field] = Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
  }
  return serializeNativeJson(manifest, { multilineArrayPaths: ["files"] });
}
