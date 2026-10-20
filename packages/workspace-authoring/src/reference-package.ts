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
import ignore, { type Ignore } from "ignore";
import { parse, type ParseError } from "jsonc-parser";

import type { DefaultPackageRole } from "./default-package-role.ts";
import type { GenerationContext } from "./generation-context.ts";
import type { PackageContribution } from "./package-contribution.ts";
import { mapPackageNamesInJson } from "./package-name-projection.ts";
import { resourceIgnoreSnapshot } from "./resource-ignore-snapshot.ts";
import { mapTypeScriptModuleSpecifiers } from "./typescript-module-specifiers.ts";

export type ReferencePackageManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly imports?: Readonly<Record<string, unknown>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export type ReferenceTemplateDependency = {
  readonly name: string;
  readonly purpose: "template-execution" | "template-build";
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
  readonly resources: readonly PreparedReferenceResource[];
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
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  readonly ownerFacts: OwnerFacts;
};

export type ReferenceContributionOptions<
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = {
  readonly context: GenerationContext;
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
  readonly manifest: ReferencePackageManifest;
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  /** prepare完成后从所属资源集合中取得的CLI发布身份来源。 */
  readonly publicationIdentitySource?: TemplateSourceHandle;
  prepare(): ReferencePackagePreparation<OwnerFacts>;
  source(file: string): TemplateSourceHandle;
  operations(targetPath: string): CopyFileOperation[];
  payloadOperations(targetPath: string): CopyFileOperation[];
  contribute(
    options: ReferenceContributionOptions<CreationInput>,
  ): PackageContribution;
};

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
  readonly resolve: (specifier: string) => string;
  readonly alias: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath?: string;
  readonly role: DefaultPackageRole;
  readonly resources: readonly string[];
  readonly resourceIgnore?: string;
  readonly template: {
    readonly dependencies: readonly ReferenceTemplateDependency[];
    readonly exports?: readonly string[];
    readonly scripts: readonly string[];
    readonly resources?: readonly string[];
  };
  readonly prepare?: (options: ReferencePackagePreparationInput) => OwnerFacts;
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
  const templateResources = (options.template.resources ?? []).map(
    normalizeOwnedResource,
  );
  const templateDependencies = Object.freeze(
    options.template.dependencies.map((dependency) =>
      Object.freeze({ ...dependency }),
    ),
  );
  const publicationIdentitySource = options.publicationIdentitySource;
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
  const resolveAsset = (file: string): string => {
    if (!inDeclaredResources(file)) {
      throw new Error(
        `参考包 ${options.packageName} prepare 阶段资源超出声明范围：${file}`,
      );
    }
    const resolved = fileURLToPath(
      options.resolve(
        `${options.packageName}/assets/${file === "." ? "package.json" : file}`,
      ),
    );
    // 原生清单也是公开资产，作为包资源根的锚点；不定位未公开的邻包内容。
    return file === "." ? path.dirname(resolved) : resolved;
  };
  const sourceCache = new Map<string, TemplateSourceHandle>();
  const source = (file: string): TemplateSourceHandle => {
    const normalized = path.posix.normalize(file);
    const existing = sourceCache.get(normalized);
    if (existing !== undefined) return existing;
    const handle = createTemplateSourceHandle(resolveAsset(normalized));
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
      const nativeDependencies = new Set(
        [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.optionalDependencies,
          manifest.peerDependencies,
        ].flatMap((record) =>
          typeof record === "object" && record !== null
            ? Object.keys(record)
            : [],
        ),
      );
      const seenTemplateDependencies = new Set<string>();
      for (const dependency of templateDependencies) {
        if (
          dependency.purpose !== "template-execution" &&
          dependency.purpose !== "template-build"
        ) {
          throw new Error(
            `模板依赖用途无效：${dependency.name} (${String(dependency.purpose)})`,
          );
        }
        if (seenTemplateDependencies.has(dependency.name)) {
          throw new Error(`模板依赖用途重复：${dependency.name}`);
        }
        seenTemplateDependencies.add(dependency.name);
        if (!nativeDependencies.has(dependency.name)) {
          throw new Error(
            `模板依赖未在原生清单声明：${dependency.name} (${dependency.purpose})`,
          );
        }
      }

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
            rules.add(readFileSync(resolveAsset(ignoreFile), "utf8"));
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
        for (const entry of readdirSync(resolveAsset(directory), {
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
          entry = statSync(resolveAsset(resource));
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
          const sourcePath = resolveAsset(file);
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
      for (const resource of templateResources) {
        if (
          !resources.some(
            (preparedResource) =>
              preparedResource.path === resource ||
              preparedResource.path.startsWith(`${resource}/`),
          )
        ) {
          throw new Error(`模板资源未包含在参考资源范围中：${resource}`);
        }
      }
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
        resources,
        readText(resourcePath) {
          const normalized = path.posix.normalize(resourcePath);
          if (!preparedResourcePaths.has(normalized)) {
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
        templateDependencies,
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
    defaultPath: options.defaultPath ?? `packages/${options.defaultLeafName}`,
    role: options.role,
    manifest,
    templateDependencies,
    prepare,
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
        "./assets",
        "./assets/*",
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
        for (const name of templateDependencies
          .filter((dependency) => dependency.purpose === "template-execution")
          .map((dependency) => dependency.name))
          delete dependencies[name];
        for (const [nativeName, definition] of bindings) {
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
        foundation: contextual(options.foundation, input),
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
