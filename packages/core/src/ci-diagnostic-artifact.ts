import type { PackageBoundaryOwner } from "./module-graph.ts";

/** Closed, owner-scoped native evidence a Package Contribution may retain in CI. */
export type CiDiagnosticArtifactDeclaration = {
  readonly kind: "playwright";
  readonly owner: PackageBoundaryOwner;
};

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
 * Validates the intentionally closed diagnostic declaration surface.  It does
 * not accept paths: native paths are derived only after the owner is known.
 */
export function assertCiDiagnosticArtifactDeclaration(
  value: unknown,
): CiDiagnosticArtifactDeclaration {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "owner"])) {
    throw new Error(
      "CI Diagnostic Artifact declarations may contain only kind and owner",
    );
  }
  if (value.kind !== "playwright") {
    throw new Error("Unsupported CI Diagnostic Artifact kind");
  }
  if (!isRecord(value.owner) || !hasExactKeys(value.owner, ["kind", "path"])) {
    throw new Error("CI Diagnostic Artifact requires a Package Boundary owner");
  }
  if (
    value.owner.kind !== "package-boundary" ||
    typeof value.owner.path !== "string" ||
    !isSafePackagePath(value.owner.path)
  ) {
    throw new Error(
      "CI Diagnostic Artifact owner has an unsafe Package Boundary path",
    );
  }
  return {
    kind: "playwright",
    owner: { kind: "package-boundary", path: value.owner.path },
  };
}

/**
 * Composes closed native diagnostics independently of presets and environment
 * preparation. Equivalent declarations collapse into stable owner order.
 */
export function composeCiDiagnosticArtifacts(options: {
  readonly packagePaths: readonly string[];
  readonly declarations: readonly unknown[];
}): readonly CiDiagnosticArtifactDeclaration[] {
  for (const packagePath of options.packagePaths) {
    if (!isSafePackagePath(packagePath)) {
      throw new Error(
        `CI Diagnostic Artifact Package Boundary path is unsafe: ${packagePath}`,
      );
    }
  }
  const owners = new Set(options.packagePaths);
  const artifacts = new Map<string, CiDiagnosticArtifactDeclaration>();
  for (const value of options.declarations) {
    const declaration = assertCiDiagnosticArtifactDeclaration(value);
    if (!owners.has(declaration.owner.path)) {
      throw new Error(
        `CI Diagnostic Artifact owner is not a declared Package Boundary: ${declaration.owner.path}`,
      );
    }
    const key = `${declaration.kind}:${declaration.owner.path}`;
    artifacts.set(key, declaration);
  }
  return [...artifacts.values()].toSorted((left, right) =>
    left.owner.path.localeCompare(right.owner.path),
  );
}
