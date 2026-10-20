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
};

type Contextual<
  Value,
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = Value | ((options: ReferenceContributionOptions<CreationInput>) => Value);

export type ReferencePackage<
  CreationInput extends PackageCreationInput = PackageCreationInput,
> = {
  readonly identity: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath: string;
  readonly role: DefaultPackageRole;
  readonly manifest: ReferencePackageManifest;
  readonly authoringDependencies: readonly string[];
  readonly publicationIdentitySource?: TemplateSourceHandle;
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
    ? (value as (context: ReferenceContributionOptions) => Value)(options)
    : value;
}

/** 原生包声明是生成事实源，描述只补充资源范围与局部差异。 */
export function defineReferencePackage<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(options: {
  readonly packageName: string;
  readonly resolve: (specifier: string) => string;
  readonly identity: string;
  readonly instance: "shared" | "independent";
  readonly defaultLeafName: string;
  readonly defaultPath?: string;
  readonly role: DefaultPackageRole;
  readonly resources: readonly string[];
  readonly resourceIgnore?: string;
  readonly authoring: {
    readonly dependencies: readonly string[];
    readonly exports?: readonly string[];
    readonly scripts: readonly string[];
    readonly resources?: readonly string[];
  };
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
    options: ReferenceContributionOptions<CreationInput>,
  ) => PackageContribution;
}): ReferencePackage<CreationInput> {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(options.resolve(`${options.packageName}/reference`)),
      "utf8",
    ),
  ) as ReferencePackageManifest;
  const resolveAsset = (file: string): string => {
    const resolved = fileURLToPath(
      options.resolve(
        `${options.packageName}/assets/${file === "." ? "package.json" : file}`,
      ),
    );
    // 原生清单也是公开资产，作为整包资源范围的锚点；不定位未公开的邻包内容。
    return file === "." ? path.dirname(resolved) : resolved;
  };
  const source = (file: string): TemplateSourceHandle =>
    createTemplateSourceHandle(resolveAsset(file));
  const isAuthoringResource = (file: string): boolean => {
    const normalized = path.posix.normalize(file);
    return (options.authoring.resources ?? []).some((resource) => {
      const owned = path.posix.normalize(resource).replace(/\/$/u, "");
      return normalized === owned || normalized.startsWith(`${owned}/`);
    });
  };
  for (const resource of options.resources) {
    if (/[!*?{}[\]]/u.test(resource))
      throw new Error(`参考资源只接受字面路径：${manifest.name} ${resource}`);
  }
  const collectOperations = (
    targetPath: string,
    authoring: boolean,
  ): CopyFileOperation[] => {
    const files = new Set<string>();
    type IgnoreScope = { readonly directory: string; readonly rules: Ignore };
    const scopes = new Map<string, IgnoreScope>();
    const scopeFor = (directory: string): IgnoreScope => {
      const existing = scopes.get(directory);
      if (existing !== undefined) return existing;
      const rules = ignore();
      if (directory === ".")
        rules.add(options.resourceIgnore ?? resourceIgnoreSnapshot);
      try {
        rules.add(
          readFileSync(
            resolveAsset(path.posix.join(directory, ".gitignore")),
            "utf8",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const scope = { directory, rules };
      scopes.set(directory, scope);
      return scope;
    };
    const ignored = (file: string, directory: boolean): boolean => {
      if (file === ".git" || file.startsWith(".git/")) return true;
      if (!authoring && isAuthoringResource(file)) return true;
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
    for (const resource of options.resources) {
      if (resource === ".") visit(resource);
      else {
        const parent = path.posix.dirname(resource);
        const entry = readdirSync(resolveAsset(parent), {
          withFileTypes: true,
        }).find(
          (candidate) => candidate.name === path.posix.basename(resource),
        );
        if (entry === undefined)
          throw new Error(`参考资源不存在：${manifest.name} ${resource}`);
        if (ignored(resource, entry.isDirectory())) continue;
        if (entry.isDirectory()) visit(resource);
        else if (resource !== "package.json") files.add(resource);
      }
    }
    return [...files].map((file) => ({
      kind: "copyFile",
      source: source(file),
      from: ".",
      to: path.posix.join(targetPath, file),
    }));
  };
  const operations = (targetPath: string): CopyFileOperation[] =>
    collectOperations(targetPath, false);
  return {
    identity: options.identity,
    instance: options.instance,
    defaultLeafName: options.defaultLeafName,
    defaultPath: options.defaultPath ?? `packages/${options.defaultLeafName}`,
    role: options.role,
    manifest,
    authoringDependencies: options.authoring.dependencies,
    ...(options.publicationIdentitySource === undefined
      ? {}
      : {
          publicationIdentitySource: source(options.publicationIdentitySource),
        }),
    source,
    operations,
    payloadOperations: (targetPath) => collectOperations(targetPath, true),
    contribute(input) {
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
        ...(options.authoring.exports ?? []),
      ])
        delete exports[key];
      const scripts = { ...manifest.scripts };
      for (const script of options.authoring.scripts) delete scripts[script];
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
        for (const name of options.authoring.dependencies)
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
          const errors: ParseError[] = [];
          const original: unknown = parse(
            readFileSync(resolveAsset(relative), "utf8"),
            errors,
            { allowTrailingComma: true },
          );
          if (
            errors.length > 0 ||
            typeof original !== "object" ||
            original === null ||
            Array.isArray(original)
          ) {
            throw new Error(
              `原生工具配置必须是有效的 JSONC 对象：${manifest.name} ${relative}`,
            );
          }
          const value = mapPackageNamesInJson(original, names) as Record<
            string,
            unknown
          >;
          if (isTypeScriptConfig && Array.isArray(value.include))
            value.include = value.include.filter(
              (entry: unknown) =>
                typeof entry !== "string" || !isAuthoringResource(entry),
            );
          if (
            isTurboConfig &&
            typeof value.tasks === "object" &&
            value.tasks !== null
          ) {
            const tasks = value.tasks as Record<string, unknown>;
            for (const script of options.authoring.scripts) {
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
          const original = readFileSync(sourceFile, "utf8");
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
                  mode: statSync(sourceFile).mode & 0o777,
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
      return options.project?.(contribution, input) ?? contribution;
    },
  };
}
