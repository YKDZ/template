import { isDeepStrictEqual } from "node:util";

import {
  createContentIndex,
  type ContentIdentity,
  type ContentKind,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { ReferencePackageDefinition } from "@ykdz/template-core/reference-package";

export type ContentSourceOptions = Readonly<{
  readonly namespace: string;
  /** 解析函数必须由拥有该集合的模块提供。 */
  readonly resolve: (specifier: string) => string;
  /** 每个成员只登记一个实际公开代码入口。 */
  readonly members: readonly string[];
}>;

/** 以公开specifier和字面量import共同选择一个内容模块。 */
export type ContentSourceEntry<Module = unknown> = Readonly<{
  readonly specifier: string;
  readonly load: () => Promise<Module>;
}>;

type DefinitionFromModule<Module> = Module extends {
  readonly referencePackage: infer Definition;
}
  ? Module extends { readonly preset: unknown }
    ? never
    : LoadedContentMember<Definition, "reference">
  : Module extends { readonly preset: infer Definition }
    ? LoadedContentMember<Definition, "preset">
    : never;

/** 从公开原生模块导出推导一个来源成员的定义与种类。 */
export type LoadedContentSourceMember<Module = unknown> =
  DefinitionFromModule<Module>;

/** 保留每个选择回调中真实模块的主定义类型和种类。 */
export type LoadedContentSourceMembers<
  Entries extends readonly ContentSourceEntry[],
> = {
  readonly [Index in keyof Entries]: LoadedContentSourceMember<
    Awaited<ReturnType<Entries[Index]["load"]>>
  >;
};

export type DynamicLoadedSourceMember =
  | LoadedContentMember<unknown, "reference">
  | LoadedContentMember<unknown, "preset">;

type ContentSourceBaseOptions = Omit<ContentSourceOptions, "members">;
type RuntimeContentSourceEntry = ContentSourceEntry<unknown>;
type RuntimeContentSourceOptions = ContentSourceBaseOptions &
  Readonly<{
    readonly members: readonly (string | RuntimeContentSourceEntry)[];
  }>;

type NativeManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly exports: Readonly<Record<string, unknown>>;
};

type PresetDefinition = Readonly<{
  readonly kind: "preset";
  readonly metadata: Readonly<{ readonly alias: string }>;
  readonly owner?: Readonly<{
    readonly packageName: string;
    readonly exportPath: string;
  }>;
}>;

export type LoadedSourceMember = DynamicLoadedSourceMember;

/** 经来源自己的Node解析器，从公开代码与数据入口装载本次内容集合。 */
export function loadContentSource<
  const Entries extends readonly ContentSourceEntry[],
>(
  options: ContentSourceBaseOptions & Readonly<{ readonly members: Entries }>,
): Promise<LoadedContentSourceMembers<Entries>>;
export function loadContentSource(
  options: ContentSourceOptions,
): Promise<readonly LoadedSourceMember[]>;
export async function loadContentSource(
  options: RuntimeContentSourceOptions,
): Promise<readonly LoadedSourceMember[]> {
  if (options.namespace.trim().length === 0) {
    throw new Error("内容来源命名空间不能为空");
  }
  const members = await Promise.all(
    options.members.map(async (entry) =>
      typeof entry === "string"
        ? await loadMember(options, entry)
        : await loadMember(options, entry.specifier, entry.load),
    ),
  );
  createContentIndex(members);
  return Object.freeze(members);
}

async function loadMember(
  options: RuntimeContentSourceOptions,
  specifier: string,
  typeLoader?: () => Promise<unknown>,
): Promise<LoadedSourceMember> {
  const address = publicSpecifierAddress(specifier);
  const resolvedModuleURL = resolveLocalURL(
    options.resolve,
    specifier,
    "代码入口",
  );
  const resolvedManifestURL = resolveLocalURL(
    options.resolve,
    `${address.packageName}/reference`,
    "原生清单入口",
  );
  const [moduleNamespace, manifestNamespace] = await Promise.all([
    import(resolvedModuleURL),
    import(resolvedManifestURL, { with: { type: "json" } }),
  ]);
  if (typeLoader !== undefined) {
    const typedNamespace = await typeLoader();
    if (typedNamespace !== moduleNamespace) {
      throw new Error(
        `内容${specifier}的类型回调与resolver解析的公开代码入口不一致`,
      );
    }
  }
  const manifestValue = isRecord(manifestNamespace)
    ? manifestNamespace.default
    : undefined;
  const manifest = assertNativeManifest(manifestValue, specifier);
  if (manifest.name !== address.packageName) {
    throw new Error(
      `内容${specifier}的原生清单包名不匹配：预期${address.packageName}，实际${manifest.name}`,
    );
  }
  if (!Object.hasOwn(manifest.exports, address.exportPath)) {
    throw new Error(
      `内容${specifier}未由原生清单公开导出入口${address.exportPath}`,
    );
  }

  const loaded = primaryDefinition(moduleNamespace, specifier);
  if (loaded.kind === "reference") {
    if (
      "manifest" in loaded.definition &&
      !isDeepStrictEqual(loaded.definition.manifest, manifest)
    ) {
      throw new Error(`内容${specifier}的参考包定义清单与原生清单不一致`);
    }
  } else if (
    loaded.definition.owner !== undefined &&
    (loaded.definition.owner.packageName !== manifest.name ||
      loaded.definition.owner.exportPath !== address.exportPath)
  ) {
    throw new Error(`预设${specifier}的所属入口与实际公开内容入口不一致`);
  }

  const identity: ContentIdentity = Object.freeze({
    namespace: options.namespace,
    packageName: manifest.name,
    exportPath: address.exportPath,
  });
  return Object.freeze({
    identity,
    kind: loaded.kind,
    alias: loaded.alias,
    definition: loaded.definition,
    source: Object.freeze({
      specifier,
      moduleURL: resolvedModuleURL,
      manifestURL: resolvedManifestURL,
    }),
  });
}

function primaryDefinition(
  moduleNamespace: unknown,
  specifier: string,
):
  | {
      readonly kind: "reference";
      readonly alias: string;
      readonly definition: ReferencePackageDefinition;
    }
  | {
      readonly kind: "preset";
      readonly alias: string;
      readonly definition: PresetDefinition;
    } {
  if (!isRecord(moduleNamespace)) {
    throw new Error(`内容${specifier}的公开代码入口未导出对象`);
  }
  const candidates: { readonly kind: ContentKind; readonly value: unknown }[] =
    [];
  if (Object.hasOwn(moduleNamespace, "preset")) {
    candidates.push({ kind: "preset", value: moduleNamespace.preset });
  }
  if (Object.hasOwn(moduleNamespace, "referencePackage")) {
    candidates.push({
      kind: "reference",
      value: moduleNamespace.referencePackage,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`内容${specifier}必须只公开一个预设或参考包主定义`);
  }
  const candidate = candidates[0]!;
  if (candidate.kind === "preset") {
    if (
      !isRecord(candidate.value) ||
      candidate.value.kind !== "preset" ||
      !isRecord(candidate.value.metadata)
    ) {
      throw new Error(`内容${specifier}的公开定义不是预设`);
    }
    const definition = candidate.value as unknown as PresetDefinition;
    return {
      kind: "preset",
      alias: requireAlias(definition.metadata.alias, specifier),
      definition,
    };
  }

  const definition = candidate.value;
  if (!isReferencePackageDefinition(definition)) {
    throw new Error(`内容${specifier}的公开定义不是有效参考包定义`);
  }
  return {
    kind: "reference",
    alias: requireAlias(definition.alias, specifier),
    definition,
  };
}

function publicSpecifierAddress(specifier: string): {
  readonly packageName: string;
  readonly exportPath: string;
} {
  if (
    specifier.trim() !== specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  ) {
    throw new Error(`内容成员必须使用公开包specifier：${specifier}`);
  }
  const parts = specifier.split("/");
  const packageLength = specifier.startsWith("@") ? 2 : 1;
  if (
    parts.length < packageLength ||
    parts.slice(0, packageLength).some((part) => part.length === 0)
  ) {
    throw new Error(`内容成员的公开包specifier无效：${specifier}`);
  }
  const packageName = parts.slice(0, packageLength).join("/");
  const exportSegments = parts.slice(packageLength);
  return {
    packageName,
    exportPath:
      exportSegments.length === 0 ? "." : `./${exportSegments.join("/")}`,
  };
}

function resolveLocalURL(
  resolve: (specifier: string) => string,
  specifier: string,
  label: string,
): string {
  let resolved: string;
  try {
    resolved = resolve(specifier);
  } catch (error) {
    throw new Error(
      `${label}解析失败：${specifier}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`${label}解析结果不是绝对URL：${specifier}`);
  }
  if (url.protocol !== "file:") {
    throw new Error(`${label}必须解析为本地文件URL：${specifier}`);
  }
  return url.href;
}

function assertNativeManifest(
  value: unknown,
  specifier: string,
): NativeManifest {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !isRecord(value.exports)
  ) {
    throw new Error(`内容${specifier}的公开原生清单缺少包名或exports`);
  }
  return value as NativeManifest;
}

function isReferencePackageDefinition(
  value: unknown,
): value is ReferencePackageDefinition {
  if (
    !isRecord(value) ||
    typeof value.alias !== "string" ||
    (value.instance !== "shared" && value.instance !== "independent")
  ) {
    return false;
  }
  return (
    typeof value.prepare === "function" &&
    typeof value.parseCreationInput === "function" &&
    typeof value.createDefinition === "function" &&
    typeof value.evaluate === "function"
  );
}

function requireAlias(value: unknown, specifier: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`内容${specifier}的公开定义缺少有效别名`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
