import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import {
  createTemplateSourceHandle,
  resolveTemplateSource,
  type CopyFileOperation,
  type RenderOperation,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";
import type {
  GeneratorNodeInstances,
  GeneratorPackageCreatedBy,
  PackageCreationInput,
} from "@ykdz/template-core/workspace-strategy";
import {
  prepareNativeContentArtifact,
  type PreparedNativeContentArtifact,
} from "@ykdz/template-workspace-authoring/content-artifact";
import { mapPackageNamesInJson } from "@ykdz/template-workspace-authoring/package-name-projection";
import { resourceIgnoreSnapshot } from "@ykdz/template-workspace-authoring/resource-ignore-snapshot";
import { mapTypeScriptModuleSpecifiers } from "@ykdz/template-workspace-authoring/typescript-module-specifiers";
import ignore, { type Ignore } from "ignore";
import { parse, type ParseError } from "jsonc-parser";

import type { DefaultPackageRole } from "./default-package-role.ts";
import type { GenerationContext } from "./generation-context.ts";
import type { PackageContribution } from "./package-contribution.ts";

export type ReferencePackageManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly imports?: Readonly<Record<string, unknown>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export type ReferenceTemplateDependencyPurpose =
  | "target"
  | "template-execution"
  | "template-build";

export type ReferenceTemplateDependency = {
  readonly name: string;
  readonly purpose: ReferenceTemplateDependencyPurpose;
};

/** 按所属声明归一化后的同一依赖用途事实。 */
export type ReferenceDependencyUse = {
  readonly name: string;
  readonly purposes: readonly ReferenceTemplateDependencyPurpose[];
};

export type PreparedReferenceResource = {
  /** 仅为所属包内的公开资源路径，不包含物理工作区位置。 */
  readonly path: string;
  readonly source: TemplateSourceHandle;
  readonly mode: number;
};

/** 所属自定义读取器仅能消费已声明并准备的文本资源。 */
export type ReferencePackagePreparationInput = {
  readonly manifest: ReferencePackageManifest;
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  readonly resources: readonly PreparedReferenceResource[];
  readonly executionData: readonly PreparedReferenceResource[];
  readText(path: string): string;
};

/** 所属准备返回的公开原生事实和不暴露物理路径的资源句柄。 */
export type ReferencePackagePreparation<OwnerFacts = unknown> = {
  readonly owner: {
    readonly packageName: string;
    readonly exportPath: "./template";
  };
  readonly manifest: ReferencePackageManifest;
  readonly resources: readonly PreparedReferenceResource[];
  /** 模板执行阶段会读取的数据；它可以与目标排除资源重叠。 */
  readonly executionData: readonly PreparedReferenceResource[];
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  readonly ownerFacts: OwnerFacts;
};

export type ReferenceContributionOptions<
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = {
  readonly context: GenerationContext;
  readonly configuration?: unknown;
  readonly definition: PackageDefinition;
  readonly bindings?: ReadonlyMap<string, PackageDefinition>;
  /** 公开生成器传入的持久创建语义。 */
  readonly createdBy?: GeneratorPackageCreatedBy;
  readonly creationInput?: CreationInput;
  readonly nodeInstances?: GeneratorNodeInstances;
  /** 已由公开生成器或所属适配器执行的同一包准备结果。 */
  readonly preparation?: unknown;
};

type Contextual<
  Value,
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = Value | ((options: ReferenceContributionOptions<CreationInput>) => Value);

type ReferencePackageProjectOptions<
  CreationInput extends PackageCreationInput,
  OwnerFacts,
> = Omit<ReferenceContributionOptions<CreationInput>, "preparation"> & {
  readonly preparation: ReferencePackagePreparation<OwnerFacts>;
};

export type ReferencePackage<
  CreationInput extends PackageCreationInput = PackageCreationInput,
  OwnerFacts = unknown,
> = {
  readonly alias: string;
  readonly resolve: (specifier: string) => string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath: string;
  readonly role: DefaultPackageRole;
  /** 由参考包自身提供默认工作区实例身份，供外部调用者校验碰撞。 */
  defaultIdentity(scope: string): {
    readonly name: string;
    readonly path: string;
    readonly role: DefaultPackageRole;
  };
  /** 实际配置拥有者标记的有限工作区配置能力。 */
  readonly workspaceConfiguration?: {
    readonly kind: "typescript-workspace-configuration";
  };
  /** 内容被选中时需要根策略准备 Rust 工具链事实。 */
  readonly requiresRootRustToolchain?: true;
  readonly manifest: ReferencePackageManifest;
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  /** prepare 后可供策略和贡献共同消费的用途归一化事实。 */
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  normalizeConfiguration?(input: unknown): unknown;
  targetDependencyNames(options: {
    readonly configuration: unknown;
    readonly creationInput?: CreationInput;
  }): readonly string[];
  /** prepare完成后从所属资源集合中取得的CLI发布身份来源。 */
  readonly publicationIdentitySource?: TemplateSourceHandle;
  prepare(): ReferencePackagePreparation<OwnerFacts>;
  /** 完成原生模板编译后，公开可供collection装配的所属制品句柄。 */
  prepareArtifact(): PreparedNativeContentArtifact;
  source(file: string): TemplateSourceHandle;
  operations(targetPath: string): CopyFileOperation[];
  payloadOperations(targetPath: string): CopyFileOperation[];
  contribute(
    options: ReferenceContributionOptions<CreationInput>,
  ): PackageContribution;
};

const dependencyPurposeOrder: readonly ReferenceTemplateDependencyPurpose[] = [
  "target",
  "template-execution",
  "template-build",
];

function normalizeDependencyUses(
  manifest: ReferencePackageManifest,
  templateDependencies: readonly ReferenceTemplateDependency[],
): readonly ReferenceDependencyUse[] {
  const uses = new Map<string, Set<ReferenceTemplateDependencyPurpose>>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const name of Object.keys(dependencies)) {
      if (!uses.has(name)) uses.set(name, new Set(["target"]));
    }
  }

  const declared = new Set<string>();
  const seen = new Set<string>();
  for (const dependency of templateDependencies) {
    if (
      !dependencyPurposeOrder.includes(dependency.purpose) ||
      typeof dependency.name !== "string" ||
      dependency.name.length === 0
    ) {
      throw new Error(
        `模板依赖用途无效：${String(dependency.name)} (${String(dependency.purpose)})`,
      );
    }
    const purposes = uses.get(dependency.name);
    if (purposes === undefined) {
      throw new Error(
        `模板依赖未在原生清单声明：${dependency.name} (${dependency.purpose})`,
      );
    }
    const identity = `${dependency.name}\u0000${dependency.purpose}`;
    if (seen.has(identity)) {
      throw new Error(
        `模板依赖用途重复：${dependency.name} (${dependency.purpose})`,
      );
    }
    seen.add(identity);
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

function contextual<
  Value,
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(
  value: Contextual<Value, CreationInput>,
  options: ReferenceContributionOptions<CreationInput>,
): Value {
  return typeof value === "function"
    ? (
        value as (context: ReferenceContributionOptions<CreationInput>) => Value
      )(options)
    : value;
}

/** 原生包声明是生成事实源，描述只补充资源范围与局部差异。 */
export function defineReferencePackage<
  CreationInput extends PackageCreationInput = PackageCreationInput,
  OwnerFacts = undefined,
>(options: {
  readonly packageName: string;
  /** 原生清单未声明version时由所属包提供的安装制品坐标。 */
  readonly artifactVersion?: string;
  readonly resolve: (specifier: string) => string;
  /** 所属包公开准备职责选择的本包资源根目录。 */
  readonly resourceRoot: URL;
  readonly alias: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath?: string;
  readonly role: DefaultPackageRole;
  readonly workspaceConfiguration?: {
    readonly kind: "typescript-workspace-configuration";
  };
  /** 内容被选中时需要根策略准备 Rust 工具链事实。 */
  readonly requiresRootRustToolchain?: true;
  readonly resources: readonly string[];
  readonly resourceIgnore?: string;
  readonly template: {
    readonly dependencies: readonly ReferenceTemplateDependency[];
    readonly exports?: readonly string[];
    readonly scripts: readonly string[];
    readonly resources?: readonly string[];
    /** 模板执行会读取的数据资源；与生成目标排除规则分开声明。 */
    readonly executionData?: readonly string[];
  };
  readonly prepare?: (options: ReferencePackagePreparationInput) => OwnerFacts;
  readonly normalizeConfiguration?: (input: unknown) => unknown;
  /** 仅从原生声明的目标依赖全集中按实例配置选择。 */
  readonly targetDependencies?: (options: {
    readonly configuration: unknown;
    readonly creationInput?: CreationInput;
    readonly dependencies: readonly string[];
  }) => readonly string[];
  readonly publicationIdentitySource?: string;
  readonly foundation: Contextual<
    PackageContribution["foundation"],
    CreationInput
  >;
  readonly environmentNeeds: Contextual<
    PackageContribution["environmentNeeds"],
    CreationInput
  >;
  readonly project?: (
    contribution: PackageContribution,
    options: ReferencePackageProjectOptions<CreationInput, OwnerFacts>,
  ) => PackageContribution;
}): ReferencePackage<CreationInput, OwnerFacts> {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(options.resolve(`${options.packageName}/reference`)),
      "utf8",
    ),
  ) as ReferencePackageManifest;
  const normalizeOwnedResource = (resource: string): string => {
    const normalized = path.posix.normalize(resource);
    if (
      resource.length === 0 ||
      path.posix.isAbsolute(resource) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      /[!*?{}[\]]/u.test(resource)
    ) {
      throw new Error(
        `参考包 ${options.packageName} prepare 阶段资源声明无效：${resource}`,
      );
    }
    return normalized;
  };
  const normalizedResources = options.resources.map(normalizeOwnedResource);
  const resourceRoot = path.resolve(fileURLToPath(options.resourceRoot));
  const templateResources = (options.template.resources ?? []).map(
    normalizeOwnedResource,
  );
  const executionDataPaths = (options.template.executionData ?? []).map(
    normalizeOwnedResource,
  );
  const templateDependencies = Object.freeze(
    options.template.dependencies.map((dependency) =>
      Object.freeze({ ...dependency }),
    ),
  );
  let normalizedDependencyUses: readonly ReferenceDependencyUse[] | undefined;
  const dependencyUses = (): readonly ReferenceDependencyUse[] => {
    normalizedDependencyUses ??= normalizeDependencyUses(
      manifest,
      templateDependencies,
    );
    return normalizedDependencyUses;
  };
  const targetDependencyNames = (input: {
    readonly configuration: unknown;
    readonly creationInput?: CreationInput;
  }): readonly string[] => {
    const dependencies = dependencyUses()
      .filter((dependency) => dependency.purposes.includes("target"))
      .map((dependency) => dependency.name);
    const selected =
      options.targetDependencies?.({ ...input, dependencies }) ?? dependencies;
    for (const name of selected)
      if (!dependencies.includes(name))
        throw new Error(
          `参考包 ${options.packageName} 选择了未声明的目标依赖：${name}`,
        );
    return selected;
  };
  const publicationIdentitySource = options.publicationIdentitySource;
  const defaultPath =
    options.defaultPath ?? `packages/${options.defaultLeafName}`;
  const inDeclaredResources = (file: string): boolean => {
    const normalized = path.posix.normalize(file);
    return normalizedResources.some(
      (resource) =>
        resource === "." ||
        normalized === resource ||
        normalized.startsWith(`${resource}/`),
    );
  };
  const isTemplateResource = (file: string): boolean => {
    const normalized = path.posix.normalize(file);
    return templateResources.some(
      (resource) =>
        normalized === resource || normalized.startsWith(`${resource}/`),
    );
  };
  const resolveOwnedResource = (file: string): string => {
    const normalized = normalizeOwnedResource(file);
    if (!inDeclaredResources(normalized)) {
      throw new Error(
        `参考包 ${options.packageName} prepare 阶段资源超出声明范围：${file}`,
      );
    }
    const resolved = path.resolve(resourceRoot, ...normalized.split("/"));
    const relative = path.relative(resourceRoot, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `参考包 ${options.packageName} prepare 阶段资源超出所属根目录：${file}`,
      );
    }
    return resolved;
  };
  const sourceCache = new Map<string, TemplateSourceHandle>();
  const source = (file: string): TemplateSourceHandle => {
    const normalized = path.posix.normalize(file);
    const existing = sourceCache.get(normalized);
    if (existing !== undefined) return existing;
    const handle = createTemplateSourceHandle(resolveOwnedResource(normalized));
    sourceCache.set(normalized, handle);
    return handle;
  };
  const contents = new Map<string, string>();
  const jsonDocuments = new Map<string, unknown>();
  let preparation: ReferencePackagePreparation<OwnerFacts> | undefined;
  let preparedRuntimeResources: readonly PreparedReferenceResource[] = [];
  let preparedTemplateResources: readonly PreparedReferenceResource[] = [];
  let preparedResourcesByPath = new Map<string, PreparedReferenceResource>();

  const prepare = (): ReferencePackagePreparation<OwnerFacts> => {
    if (preparation !== undefined) return preparation;
    try {
      const preparedDependencyUses = dependencyUses();
      type IgnoreScope = { readonly directory: string; readonly rules: Ignore };
      const scopes = new Map<string, IgnoreScope>();
      const scopeFor = (directory: string): IgnoreScope => {
        const existing = scopes.get(directory);
        if (existing !== undefined) return existing;
        const rules = ignore();
        if (directory === ".")
          rules.add(options.resourceIgnore ?? resourceIgnoreSnapshot);
        const ignoreFile = path.posix.join(directory, ".gitignore");
        try {
          if (inDeclaredResources(ignoreFile)) {
            rules.add(readFileSync(resolveOwnedResource(ignoreFile), "utf8"));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const scope = { directory, rules };
        scopes.set(directory, scope);
        return scope;
      };
      const ignored = (file: string, directory: boolean): boolean => {
        if (file === ".git" || file.startsWith(".git/")) return true;
        let excluded = false;
        let parent = ".";
        for (const part of ["", ...file.split("/").slice(0, -1)]) {
          if (part !== "") parent = path.posix.join(parent, part);
          const scope = scopeFor(parent);
          const relative = path.posix.relative(scope.directory, file);
          const result = scope.rules.test(relative + (directory ? "/" : ""));
          if (result.ignored) excluded = true;
          else if (result.unignored) excluded = false;
        }
        return excluded;
      };
      const files = new Set<string>();
      const visit = (directory: string): void => {
        for (const entry of readdirSync(resolveOwnedResource(directory), {
          withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
          const file = path.posix.join(directory, entry.name);
          if (ignored(file, entry.isDirectory())) continue;
          if (entry.isDirectory()) visit(file);
          else if (file !== "package.json") files.add(file);
        }
      };
      for (const resource of normalizedResources) {
        if (resource === ".") {
          visit(resource);
          continue;
        }
        let entry;
        try {
          entry = statSync(resolveOwnedResource(resource));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`参考资源不存在：${resource}`, { cause: error });
          }
          throw error;
        }
        if (ignored(resource, entry.isDirectory())) continue;
        if (entry.isDirectory()) visit(resource);
        else if (resource !== "package.json") files.add(resource);
      }

      const resources = [...files]
        .toSorted((left, right) => left.localeCompare(right))
        .map((file) => {
          const sourcePath = resolveOwnedResource(file);
          const sourceText = readFileSync(sourcePath).toString("utf8");
          const mode = statSync(sourcePath).mode & 0o777;
          contents.set(file, sourceText);
          if (
            /^tsconfig(?:\.[^/]+)?\.json$/u.test(file) ||
            /(^|\/)turbo\.jsonc?$/u.test(file)
          ) {
            const errors: ParseError[] = [];
            const parsed: unknown = parse(sourceText, errors, {
              allowTrailingComma: true,
            });
            if (
              errors.length > 0 ||
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              throw new Error(`原生工具配置必须是有效的 JSONC 对象：${file}`);
            }
            jsonDocuments.set(file, parsed);
          }
          return { path: file, source: source(file), mode };
        });
      preparedResourcesByPath = new Map(
        resources.map((resource) => [resource.path, resource]),
      );
      const executionData = executionDataPaths.map((resourcePath) => {
        const resource = preparedResourcesByPath.get(resourcePath);
        if (resource === undefined) {
          throw new Error(
            `模板执行数据未包含在参考资源范围中：${resourcePath}`,
          );
        }
        return resource;
      });
      if (
        publicationIdentitySource !== undefined &&
        !preparedResourcesByPath.has(
          path.posix.normalize(publicationIdentitySource),
        )
      ) {
        throw new Error(
          `发布身份资源未包含在参考资源范围中：${publicationIdentitySource}`,
        );
      }
      preparedRuntimeResources = resources.filter(
        (resource) => !isTemplateResource(resource.path),
      );
      preparedTemplateResources = resources;
      const preparedResourcePaths = new Set(preparedResourcesByPath.keys());
      const ownerFacts = options.prepare?.({
        manifest,
        dependencyUses: preparedDependencyUses,
        resources,
        executionData,
        readText(resourcePath) {
          const normalized = path.posix.normalize(resourcePath);
          if (
            !preparedResourcePaths.has(normalized) ||
            !executionDataPaths.includes(normalized)
          ) {
            throw new Error(
              `所属准备请求了未声明或缺失的文本资源：${resourcePath}`,
            );
          }
          const content = contents.get(normalized);
          if (content === undefined) {
            throw new Error(`所属准备请求的资源不是文本：${resourcePath}`);
          }
          return content;
        },
      }) as OwnerFacts;
      preparation = Object.freeze({
        owner: Object.freeze({
          packageName: manifest.name,
          exportPath: "./template" as const,
        }),
        manifest,
        resources: Object.freeze(resources),
        executionData: Object.freeze(executionData),
        templateDependencies,
        dependencyUses: preparedDependencyUses,
        ownerFacts: ownerFacts as OwnerFacts,
      });
      return preparation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `参考包 ${options.packageName}/./template prepare 阶段失败：${message}`,
        { cause: error },
      );
    }
  };
  const requirePreparation = (): ReferencePackagePreparation<OwnerFacts> => {
    if (preparation === undefined) {
      throw new Error(
        `参考包 ${options.packageName}/./template 尚未完成 prepare 阶段`,
      );
    }
    return preparation;
  };
  const collectOperations = (
    targetPath: string,
    includeTemplateResources: boolean,
  ): CopyFileOperation[] => {
    requirePreparation();
    const resources = includeTemplateResources
      ? preparedTemplateResources
      : preparedRuntimeResources;
    return resources.map((resource) => ({
      kind: "copyFile",
      source: resource.source,
      from: ".",
      to: path.posix.join(targetPath, resource.path),
    }));
  };
  const operations = (targetPath: string): CopyFileOperation[] =>
    collectOperations(targetPath, false);
  const referencePackage: ReferencePackage<CreationInput, OwnerFacts> = {
    alias: options.alias,
    resolve: options.resolve,
    instance: options.instance,
    defaultLeafName: options.defaultLeafName,
    defaultPath,
    role: options.role,
    defaultIdentity(scope) {
      return {
        name: `@${scope}/${options.defaultLeafName}`,
        path: defaultPath,
        role: options.role,
      };
    },
    ...(options.workspaceConfiguration === undefined
      ? {}
      : { workspaceConfiguration: options.workspaceConfiguration }),
    ...(options.requiresRootRustToolchain === undefined
      ? {}
      : { requiresRootRustToolchain: options.requiresRootRustToolchain }),
    manifest,
    templateDependencies,
    get dependencyUses() {
      return dependencyUses();
    },
    ...(options.normalizeConfiguration === undefined
      ? {}
      : { normalizeConfiguration: options.normalizeConfiguration }),
    targetDependencyNames,
    prepare,
    prepareArtifact() {
      const prepared = prepare();
      const dependencyPurposes = new Map(
        prepared.dependencyUses.map((dependency) => [
          dependency.name,
          dependency.purposes.filter(
            (purpose): purpose is "target" | "template-execution" =>
              purpose === "target" || purpose === "template-execution",
          ),
        ]),
      );
      const resources = new Map(
        [...preparedRuntimeResources, ...prepared.executionData].map(
          (resource) => [resource.path, resource],
        ),
      );
      return prepareNativeContentArtifact({
        manifest: prepared.manifest,
        resourceRoot: options.resourceRoot,
        exportPath: "./template",
        ...(options.artifactVersion === undefined
          ? {}
          : { artifactVersion: options.artifactVersion }),
        resources: [...resources.values()],
        dependencyPurposes,
      });
    },
    source,
    operations,
    payloadOperations: (targetPath) => collectOperations(targetPath, true),
    contribute(input) {
      const prepared =
        (input.preparation as
          | ReferencePackagePreparation<OwnerFacts>
          | undefined) ?? requirePreparation();
      if (
        prepared.owner.packageName !== options.packageName ||
        prepared.owner.exportPath !== "./template"
      ) {
        throw new Error(
          `参考包 ${options.packageName}/./template 收到不匹配的所属 prepare 事实：${prepared.owner.packageName}#${prepared.owner.exportPath}`,
        );
      }
      const manifest = prepared.manifest;
      const bindings = input.bindings ?? new Map<string, PackageDefinition>();
      const targetDependencies = new Set(
        targetDependencyNames({
          configuration:
            input.configuration ??
            options.normalizeConfiguration?.(undefined) ??
            null,
          ...(input.creationInput === undefined
            ? {}
            : { creationInput: input.creationInput }),
        }),
      );
      const names = new Map(
        [...bindings].map(([name, definition]) => [name, definition.name]),
      );
      names.set(manifest.name, input.definition.name);
      const projected = mapPackageNamesInJson(manifest, names) as Record<
        string,
        unknown
      >;
      const exports = {
        ...(projected.exports as Record<string, unknown> | undefined),
      };
      for (const key of [
        "./reference",
        "./template",
        ...(options.template.exports ?? []),
      ])
        delete exports[key];
      const scripts = { ...manifest.scripts };
      for (const script of options.template.scripts) delete scripts[script];
      if (Object.keys(exports).length > 0) projected.exports = exports;
      else delete projected.exports;
      projected.scripts = scripts;
      projected.name = input.definition.name;
      projected.engines = {
        ...(manifest.engines as Record<string, unknown>),
        node: input.context.toolchain.nodeLtsMajor,
      };
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ] as const) {
        if (manifest[field] === undefined) continue;
        const dependencies = {
          ...(projected[field] as Record<string, string>),
        };
        for (const dependency of prepared.dependencyUses) {
          if (!targetDependencies.has(dependency.name))
            delete dependencies[names.get(dependency.name) ?? dependency.name];
        }
        for (const [nativeName, definition] of bindings) {
          if (!targetDependencies.has(nativeName)) continue;
          const native = (manifest[field] as Record<string, string>)[
            nativeName
          ];
          if (native === undefined) continue;
          const relative = path.posix.relative(
            input.definition.path,
            definition.path,
          );
          dependencies[definition.name] = native.startsWith("link:")
            ? `link:${relative}`
            : native.startsWith("workspace:.")
              ? `workspace:${relative}`
              : native;
        }
        projected[field] = dependencies;
      }
      const outputOperations: RenderOperation[] = [
        {
          kind: "writeJson",
          to: `${input.definition.path}/package.json`,
          value: {},
        },
      ];
      for (const operation of operations(input.definition.path)) {
        const relative = path.posix.relative(
          input.definition.path,
          operation.to,
        );
        const isTypeScriptConfig = /^tsconfig(?:\.[^/]+)?\.json$/u.test(
          relative,
        );
        const isTurboConfig =
          relative === "turbo.json" || relative === "turbo.jsonc";
        if (isTypeScriptConfig || isTurboConfig) {
          const original = jsonDocuments.get(relative);
          if (original === undefined)
            throw new Error(`准备结果缺少已解析配置：${relative}`);
          const value = mapPackageNamesInJson(original, names) as Record<
            string,
            unknown
          >;
          if (isTypeScriptConfig && Array.isArray(value.include))
            value.include = value.include.filter(
              (entry: unknown) =>
                typeof entry !== "string" || !isTemplateResource(entry),
            );
          if (
            isTurboConfig &&
            typeof value.tasks === "object" &&
            value.tasks !== null
          ) {
            const tasks = value.tasks as Record<string, unknown>;
            for (const script of options.template.scripts) {
              delete tasks[script];
              delete tasks[`${input.definition.name}#${script}`];
            }
          }
          outputOperations.push(
            isDeepStrictEqual(original, value)
              ? operation
              : { kind: "writeJson", to: operation.to, value },
          );
        } else if (relative.endsWith(".ts")) {
          const sourceFile = resolveTemplateSource(
            operation.source,
            operation.from,
          );
          const original = contents.get(relative);
          const preparedResource = preparedResourcesByPath.get(relative);
          if (original === undefined || preparedResource === undefined) {
            throw new Error(`准备结果缺少已读取源码资源：${relative}`);
          }
          const text = mapTypeScriptModuleSpecifiers(
            original,
            names,
            sourceFile,
          );
          outputOperations.push(
            text === original
              ? operation
              : {
                  kind: "writeText",
                  to: operation.to,
                  text,
                  mode: preparedResource.mode,
                  templateSource: {
                    handle: operation.source,
                    path: operation.from,
                  },
                  ...(operation.overwrite === undefined
                    ? {}
                    : { overwrite: operation.overwrite }),
                  ...(operation.provenance === undefined
                    ? {}
                    : { provenance: operation.provenance }),
                },
          );
        } else {
          outputOperations.push(operation);
        }
      }
      const contribution: PackageContribution = {
        definition: input.definition,
        manifest: projected,
        exposure: {
          exports,
          imports: (projected.imports ?? {}) as Record<string, unknown>,
        },
        operations: outputOperations,
        foundation: {
          ...contextual(options.foundation, input),
          ...(options.workspaceConfiguration === undefined
            ? {}
            : { workspaceConfiguration: options.workspaceConfiguration }),
        },
        environmentNeeds: contextual(options.environmentNeeds, input),
        referenceSource: manifest.name,
        referenceBindings: Object.fromEntries(bindings),
      };
      return (
        options.project?.(contribution, {
          ...input,
          preparation: prepared,
        }) ?? contribution
      );
    },
  };
  if (publicationIdentitySource !== undefined) {
    Object.defineProperty(referencePackage, "publicationIdentitySource", {
      enumerable: true,
      get() {
        const resourcePath = path.posix.normalize(publicationIdentitySource);
        const preparedResource = requirePreparation().resources.find(
          (resource) => resource.path === resourcePath,
        );
        if (preparedResource === undefined) {
          throw new Error(
            `参考包 ${options.packageName}/./template prepare 阶段缺少发布身份资源：${resourcePath}`,
          );
        }
        return preparedResource.source;
      },
    });
  }
  return referencePackage;
}
