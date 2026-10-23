import {
  assertContentIdentity,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { ReferenceDependency } from "@ykdz/template-core/reference-package";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicReferenceSpecifierAddress(specifier: string): {
  readonly packageName: string;
  readonly exportPath: string;
} {
  if (
    specifier.trim() !== specifier ||
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.includes("\\")
  ) {
    throw new Error(`原生依赖必须使用规范公开包specifier：${specifier}`);
  }
  const parts = specifier.split("/");
  const packageLength = specifier.startsWith("@") ? 2 : 1;
  if (
    parts.length < packageLength ||
    parts.slice(0, packageLength).some((part) => part.length === 0) ||
    parts.slice(packageLength).some((part) => part.length === 0)
  ) {
    throw new Error(`原生依赖的公开包specifier无效：${specifier}`);
  }
  const packageName = parts.slice(0, packageLength).join("/");
  const exportSegments = parts.slice(packageLength);
  return {
    packageName,
    exportPath:
      exportSegments.length === 0 ? "." : `./${exportSegments.join("/")}`,
  };
}

function canonicalModuleURL(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label}不是绝对模块URL：${value}`, { cause: error });
  }
  if (url.protocol !== "file:") {
    throw new Error(`${label}必须是文件URL：${value}`);
  }
  return url.href;
}

/** 用consumer所在命名空间、公开地址和解析模块URL规范化引用身份。 */
export function resolveReferenceDependencyIdentity(options: {
  readonly consumerIdentity: ContentIdentity;
  readonly dependency: ReferenceDependency;
  readonly members: readonly LoadedContentMember[];
}): ContentIdentity {
  if ("contentIdentity" in options.dependency) {
    assertContentIdentity(options.dependency.contentIdentity);
    return options.dependency.contentIdentity;
  }

  const { ownerLocal } = options.dependency;
  const address = publicReferenceSpecifierAddress(ownerLocal.specifier);
  let resolved: string;
  try {
    resolved = ownerLocal.resolve(ownerLocal.specifier);
  } catch (error) {
    throw new Error(
      `原生依赖公开入口解析失败：${ownerLocal.specifier}：${errorMessage(error)}`,
      { cause: error },
    );
  }
  const resolvedURL = canonicalModuleURL(resolved, "原生依赖解析结果");
  const namespaceCandidates = options.members.filter(
    (member) =>
      member.kind === "reference" &&
      member.identity.namespace === options.consumerIdentity.namespace &&
      member.identity.packageName === address.packageName &&
      member.identity.exportPath === address.exportPath,
  );
  const resolvedCandidates = namespaceCandidates.filter(
    (member) =>
      canonicalModuleURL(member.source.moduleURL, "内容成员公开模块入口") ===
      resolvedURL,
  );
  if (resolvedCandidates.length > 1) {
    throw new Error(
      `原生依赖解析到同一公开身份的多个内容修订，不能猜选：${ownerLocal.specifier}`,
    );
  }
  if (resolvedCandidates.length === 1) {
    return resolvedCandidates[0]!.identity;
  }
  if (namespaceCandidates.length > 0) {
    throw new Error(
      `原生依赖 ${ownerLocal.specifier} 未解析到当前内容修订的公开模块入口`,
    );
  }
  const sameNamespaceModuleCandidates = options.members.filter(
    (member) =>
      member.kind === "reference" &&
      member.identity.namespace === options.consumerIdentity.namespace &&
      canonicalModuleURL(member.source.moduleURL, "内容成员公开模块入口") ===
        resolvedURL,
  );
  if (sameNamespaceModuleCandidates.length > 0) {
    throw new Error(
      `原生依赖公开地址与实际内容入口不一致：${ownerLocal.specifier}`,
    );
  }
  throw new Error(
    `原生依赖 ${ownerLocal.specifier} 必须由消费内容的同一命名空间公开，且解析到当前修订`,
  );
}
