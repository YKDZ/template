import type { CiDiagnosticArtifactDeclaration } from "@ykdz/default-content-authoring/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

const reservedWorkspaceCollections = new Set([
  ".git",
  ".github",
  ".devcontainer",
  ".template",
  "node_modules",
  "dist",
  "target",
]);

function isSafePackagePath(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(value) &&
    !reservedWorkspaceCollections.has(value.split("/", 1)[0]!)
  );
}

/**
 * 校验封闭式诊断声明。声明不接收路径，原生路径只能在确定所有者后派生。
 */
export function assertCiDiagnosticArtifactDeclaration(
  value: unknown,
): CiDiagnosticArtifactDeclaration {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "owner"])) {
    throw new Error("CI 诊断制品声明只能包含 kind 和 owner");
  }
  if (value.kind !== "playwright" && value.kind !== "vitest-browser") {
    throw new Error("不支持的 CI 诊断制品 kind");
  }
  if (!isRecord(value.owner) || !hasExactKeys(value.owner, ["kind", "path"])) {
    throw new Error("CI 诊断制品必须声明包边界所有者");
  }
  if (
    (value.owner.kind !== "workspace-orchestration" ||
      value.owner.path !== ".") &&
    (value.owner.kind !== "package-boundary" ||
      typeof value.owner.path !== "string" ||
      !isSafePackagePath(value.owner.path))
  ) {
    throw new Error("CI 诊断制品所有者的包边界路径不安全");
  }
  return {
    kind: value.kind,
    owner:
      value.owner.kind === "workspace-orchestration"
        ? { kind: "workspace-orchestration", path: "." }
        : { kind: "package-boundary", path: value.owner.path },
  };
}

/**
 * 独立于预设与环境准备来合成封闭式原生诊断。同一声明按所有者稳定排序后合并。
 */
export function composeCiDiagnosticArtifacts(options: {
  readonly packagePaths: readonly string[];
  readonly declarations: readonly unknown[];
}): readonly CiDiagnosticArtifactDeclaration[] {
  for (const packagePath of options.packagePaths) {
    if (!isSafePackagePath(packagePath)) {
      throw new Error(`CI 诊断制品包边界路径不安全：${packagePath}`);
    }
  }
  const owners = new Set(options.packagePaths);
  const artifacts = new Map<string, CiDiagnosticArtifactDeclaration>();
  for (const value of options.declarations) {
    const declaration = assertCiDiagnosticArtifactDeclaration(value);
    if (
      declaration.owner.kind === "package-boundary" &&
      !owners.has(declaration.owner.path)
    ) {
      throw new Error(
        `CI 诊断制品所有者不是已声明的包边界：${declaration.owner.path}`,
      );
    }
    const key = `${declaration.kind}:${declaration.owner.path}`;
    artifacts.set(key, declaration);
  }
  return [...artifacts.values()].toSorted((left, right) => {
    const ownerOrder = left.owner.path.localeCompare(right.owner.path);
    return ownerOrder === 0 ? left.kind.localeCompare(right.kind) : ownerOrder;
  });
}
