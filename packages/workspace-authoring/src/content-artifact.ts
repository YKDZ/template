import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PreparedReference,
  ResourceFileSnapshot,
} from "@ykdz/template-core/reference-package";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

export type NativeContentManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly version?: string;
  readonly exports?: Readonly<Record<string, unknown>>;
};

export type NativeContentArtifactFile = {
  /** 所属原生包内的公开相对路径。 */
  readonly path: string;
  /** 在所属包边界内读取出的字节；collection无需再访问作者文件系统。 */
  readonly data: Uint8Array;
  readonly mode: number;
};

export type NativeContentArtifactResource = {
  /** owner原生包内的资源坐标，随完整制品分发。 */
  readonly path: string;
  /** 资源在当前模板包目标目录内的实际位置；用于排除嵌套owner作用域。 */
  readonly targetPath?: string;
  readonly source: TemplateSourceHandle;
  readonly mode: number;
};

export type NativeContentArtifactDependency = {
  readonly name: string;
  readonly specifier: string;
  readonly purposes: readonly ("target" | "template-execution")[];
};

export type PreparedNativeContentArtifact = {
  readonly coordinate: { readonly name: string; readonly version: string };
  readonly exportPath: string;
  readonly manifest: NativeContentManifest;
  readonly entry: {
    readonly default: string;
    readonly types?: string;
  };
  readonly compiled: readonly NativeContentArtifactFile[];
  readonly resources: readonly NativeContentArtifactFile[];
  readonly dependencies: readonly NativeContentArtifactDependency[];
};

export type PrepareNativeContentArtifactOptions = {
  readonly manifest: NativeContentManifest;
  readonly resourceRoot: URL;
  readonly exportPath: string;
  /** 仅原生清单没有version时由所属包显式提供。 */
  readonly artifactVersion?: string;
  readonly resources?: readonly NativeContentArtifactResource[];
  readonly dependencyPurposes?: ReadonlyMap<
    string,
    readonly ("target" | "template-execution")[]
  >;
};

export type DefineNativeContentArtifactOptions = Omit<
  PrepareNativeContentArtifactOptions,
  "dependencyPurposes"
> & {
  /** 仅列出package.json devDependencies中真正由模板入口执行的名称。 */
  readonly executionDependencies?: readonly string[];
};

export type NativeReferenceContentDefinition = Readonly<{
  readonly alias: string;
  readonly instance: "shared" | "independent";
}>;

export type DefineNativeReferenceContentArtifactOptions<Facts> = Omit<
  DefineNativeContentArtifactOptions,
  "resources"
> &
  Readonly<{
    readonly resources?: readonly NativeContentArtifactResource[];
    readonly prepareFacts?: (
      resources: readonly ResourceFileSnapshot[],
      options: Readonly<{ readonly excludedPackagePaths: readonly string[] }>,
    ) => Facts;
  }>;

type NativeReferenceContentArtifact<Definition extends object, Facts> = Omit<
  Definition,
  "prepare"
> &
  Readonly<{
    readonly prepare: (options?: {
      readonly excludedPackagePaths: readonly string[];
    }) => PreparedReference<Facts>;
    readonly prepareArtifact: () => PreparedNativeContentArtifact;
  }>;

function exportEntry(
  manifest: NativeContentManifest,
  exportPath: string,
): { readonly default: string; readonly types?: string } {
  const value = manifest.exports?.[exportPath];
  if (typeof value === "string") return { default: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`所属包 ${manifest.name} 未公开内容入口 ${exportPath}`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.default !== "string") {
    throw new Error(
      `所属包 ${manifest.name} 的内容入口 ${exportPath} 缺少 default 条件`,
    );
  }
  if (entry.types !== undefined && typeof entry.types !== "string") {
    throw new Error(
      `所属包 ${manifest.name} 的内容入口 ${exportPath} types 条件无效`,
    );
  }
  return {
    default: entry.default,
    ...(typeof entry.types === "string" ? { types: entry.types } : {}),
  };
}

function packagePath(value: string, label: string): string {
  if (
    !value.startsWith("./") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === "..")
  ) {
    throw new Error(`所属内容${label}必须是包内相对路径：${value}`);
  }
  return path.posix.normalize(value.slice(2));
}

function dependencyFacts(
  manifest: NativeContentManifest,
  dependencyPurposes: PrepareNativeContentArtifactOptions["dependencyPurposes"],
): readonly NativeContentArtifactDependency[] {
  const purposesByName = dependencyPurposes ?? new Map();
  const dependencies = new Map<string, string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    for (const [name, specifier] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof specifier !== "string") continue;
      dependencies.set(name, specifier);
    }
  }
  return Object.freeze(
    [...dependencies].map(([name, specifier]) =>
      Object.freeze({
        name,
        specifier,
        purposes: Object.freeze([
          ...(purposesByName.get(name) ?? ["template-execution"]),
        ]),
      }),
    ),
  );
}

/** 把所属包可见的原生编译与资源事实制成collection可消费的句柄。 */
export function prepareNativeContentArtifact(
  options: PrepareNativeContentArtifactOptions,
): PreparedNativeContentArtifact {
  const coordinateVersion =
    typeof options.manifest.version === "string" &&
    options.manifest.version.trim().length > 0
      ? options.manifest.version
      : options.artifactVersion;
  if (
    coordinateVersion === undefined ||
    coordinateVersion.trim().length === 0
  ) {
    throw new Error(
      `所属包 ${options.manifest.name} 缺少制品版本；无原生version时必须显式声明artifactVersion`,
    );
  }
  const entry = exportEntry(options.manifest, options.exportPath);
  const entryPath = packagePath(entry.default, "default入口");
  const resourceRoot = path.resolve(fileURLToPath(options.resourceRoot));
  const compiledRoot = path.resolve(
    resourceRoot,
    path.posix.dirname(entryPath),
  );
  const rootRelative = path.relative(resourceRoot, compiledRoot);
  if (
    rootRelative === ".." ||
    rootRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rootRelative)
  ) {
    throw new Error(
      `所属包 ${options.manifest.name} 的内容编译入口超出包根目录`,
    );
  }

  const compiled: NativeContentArtifactFile[] = [];
  const visit = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(
          `所属包 ${options.manifest.name} 的编译产物包含符号链接：${path.relative(resourceRoot, absolutePath)}`,
        );
      }
      if (child.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const relativePath = path
        .relative(resourceRoot, absolutePath)
        .split(path.sep)
        .join("/");
      compiled.push({
        path: relativePath,
        data: readFileSync(absolutePath),
        mode: statSync(absolutePath).mode & 0o777,
      });
    }
  };
  try {
    visit(compiledRoot);
  } catch (error) {
    throw new Error(
      `所属包 ${options.manifest.name} 的编译入口尚未准备：${entry.default}`,
      { cause: error },
    );
  }
  const typesPath =
    entry.types === undefined
      ? undefined
      : packagePath(entry.types, "types入口");
  if (
    !compiled.some((file) => file.path === entryPath) ||
    (typesPath !== undefined &&
      !compiled.some((file) => file.path === typesPath))
  ) {
    throw new Error(
      `所属包 ${options.manifest.name} 的编译制品未包含公开入口 ${entry.default}`,
    );
  }

  const resources = new Map<string, NativeContentArtifactFile>();
  for (const resource of options.resources ?? []) {
    resources.set(resource.path, {
      path: resource.path,
      data: readFileSync(resolveTemplateSource(resource.source, ".")),
      mode: resource.mode,
    });
  }
  return Object.freeze({
    coordinate: Object.freeze({
      name: options.manifest.name,
      version: coordinateVersion,
    }),
    exportPath: options.exportPath,
    manifest: options.manifest,
    entry: Object.freeze(entry),
    compiled: Object.freeze(compiled),
    resources: Object.freeze([...resources.values()]),
    dependencies: dependencyFacts(options.manifest, options.dependencyPurposes),
  });
}

/** 让预设owner公开与参考owner相同的准备句柄，而不改变core定义合同。 */
export function defineNativeContentArtifact<Definition extends object>(
  definition: Definition,
  options: DefineNativeContentArtifactOptions,
): Definition & {
  readonly prepareArtifact: () => PreparedNativeContentArtifact;
} {
  const dependencyPurposes = new Map<
    string,
    readonly ("target" | "template-execution")[]
  >();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = options.manifest[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    for (const name of Object.keys(value)) {
      dependencyPurposes.set(
        name,
        field === "dependencies" ? ["template-execution"] : [],
      );
    }
  }
  for (const name of options.executionDependencies ?? []) {
    const declared = dependencyPurposes.get(name);
    if (declared === undefined) {
      throw new Error(
        `预设模板执行依赖未在所属清单声明：${options.manifest.name}/${name}`,
      );
    }
    dependencyPurposes.set(name, ["template-execution"]);
  }
  const { executionDependencies: _executionDependencies, ...artifactOptions } =
    options;
  return Object.freeze({
    ...definition,
    prepareArtifact: () =>
      prepareNativeContentArtifact({
        ...artifactOptions,
        dependencyPurposes,
      }),
  });
}

/** 让同一所属资源声明驱动参考包快照与正式内容制品。 */
export function defineNativeReferenceContentArtifact<
  Definition extends NativeReferenceContentDefinition,
  Facts,
>(
  definition: Definition,
  options: DefineNativeReferenceContentArtifactOptions<Facts> & {
    readonly prepareFacts: NonNullable<
      DefineNativeReferenceContentArtifactOptions<Facts>["prepareFacts"]
    >;
  },
): NativeReferenceContentArtifact<Definition, Facts>;
export function defineNativeReferenceContentArtifact<
  Definition extends NativeReferenceContentDefinition,
>(
  definition: Definition,
  options: DefineNativeReferenceContentArtifactOptions<undefined> & {
    readonly prepareFacts?: undefined;
  },
): NativeReferenceContentArtifact<Definition, undefined>;
export function defineNativeReferenceContentArtifact(
  definition: NativeReferenceContentDefinition,
  options: DefineNativeReferenceContentArtifactOptions<unknown>,
): object {
  const resourceSpecifications = options.resources ?? [];
  const nativeArtifact = defineNativeContentArtifact(definition, options);
  return Object.freeze({
    ...nativeArtifact,
    prepare(prepareOptions?: {
      readonly excludedPackagePaths: readonly string[];
    }) {
      const excludedPackagePaths = prepareOptions?.excludedPackagePaths ?? [];
      const resources = resourceSpecifications
        .filter(
          ({ targetPath }) =>
            targetPath === undefined ||
            !excludedPackagePaths.some(
              (packagePath) =>
                targetPath === packagePath ||
                targetPath.startsWith(`${packagePath}/`),
            ),
        )
        .map(({ path: resourcePath, source, mode }) => ({
          path: resourcePath,
          content: readFileSync(resolveTemplateSource(source, ".")),
          mode: mode & 0o111,
        }));
      const snapshot = Object.freeze(resources);
      return Object.freeze({
        resources: snapshot,
        facts: options.prepareFacts?.(snapshot, {
          excludedPackagePaths,
        }),
      });
    },
  });
}
