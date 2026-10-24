import { isBuiltin } from "node:module";

import {
  defaultPackageRoles,
  isDefaultPackageRole,
} from "@ykdz/default-content-authoring/package-role";
import {
  assertProjectBlueprintDraft,
  ProjectBlueprintValidationError,
  validateProjectBlueprint,
  type BlueprintValidationIssue,
  type BlueprintValidationResult,
  type PackageDefinition,
  type ProjectBlueprint,
  type ProjectBlueprintDraft,
} from "@ykdz/template-core/project-blueprint";

const defaultPackagePath = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const reservedWorkspaceCollections = new Set([
  ".git",
  ".github",
  ".devcontainer",
  ".template",
  "node_modules",
  "dist",
  "target",
]);
const reservedPackageNames = new Set(["node_modules", "favicon.ico"]);
const defaultPackageScope = /^[a-z0-9][a-z0-9._-]*$/u;

export type DefaultPackagePathValidation = {
  readonly hasValidShape: boolean;
  readonly reservedWorkspaceCollection?: string;
};

/** 默认策略用来校验新 npm 包名的事实。 */
export function isValidDefaultNpmPackageName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value === "." ||
    value === ".." ||
    reservedPackageNames.has(value) ||
    isBuiltin(value)
  ) {
    return false;
  }

  const scopedMatch = /^@([^/]+)\/([^/]+)$/.exec(value);
  if (value.startsWith("@") && scopedMatch === null) return false;

  const scope = scopedMatch?.[1];
  const leaf = scopedMatch?.[2] ?? value;
  if (scope === undefined && /^[._-]/.test(leaf)) {
    return false;
  }
  if (scope !== undefined && leaf.startsWith(".")) {
    return false;
  }
  if (/[~'!()*]/.test(leaf)) return false;

  return (
    encodeURIComponent(leaf) === leaf &&
    (scope === undefined || encodeURIComponent(scope) === scope)
  );
}

/** 默认工作区 scope 的 npm 身份片段规则。 */
export function isValidDefaultPackageScope(value: string): boolean {
  return defaultPackageScope.test(value);
}

/** 默认工作区包采用两段目录，并保留工作区工具目录。 */
export function validateDefaultPackagePath(
  value: string,
): DefaultPackagePathValidation {
  const workspaceCollection = value.split("/", 1)[0]!;
  return {
    hasValidShape: defaultPackagePath.test(value),
    ...(reservedWorkspaceCollections.has(workspaceCollection)
      ? { reservedWorkspaceCollection: workspaceCollection }
      : {}),
  };
}

function defaultPackageIssues(
  definition: PackageDefinition,
  index: number,
): BlueprintValidationIssue[] {
  const itemPath = `.packages[${index}]`;
  const issues: BlueprintValidationIssue[] = [];
  if (!isDefaultPackageRole(definition.role)) {
    const supportedRoles = `${defaultPackageRoles
      .slice(0, -1)
      .join(", ")}, or ${defaultPackageRoles.at(-1)}`;
    issues.push({
      path: `${itemPath}.role`,
      message: `Package Role must be ${supportedRoles}`,
    });
  }
  if (!isValidDefaultNpmPackageName(definition.name)) {
    issues.push({
      path: `${itemPath}.name`,
      message: "Package name must be a valid npm package name for new packages",
      packageIdentityIssue: { kind: "invalid", field: "name" },
    });
  }
  const isNativeWorkspaceRoot =
    definition.path === "." && definition.role === "native-package";
  if (!isNativeWorkspaceRoot) {
    const pathValidation = validateDefaultPackagePath(definition.path);
    if (pathValidation.reservedWorkspaceCollection !== undefined) {
      issues.push({
        path: `${itemPath}.path`,
        message: `Package Path ${definition.path} uses reserved workspace collection ${pathValidation.reservedWorkspaceCollection}`,
        packageIdentityIssue: { kind: "reserved", field: "path" },
      });
    } else if (!pathValidation.hasValidShape) {
      issues.push({
        path: `${itemPath}.path`,
        message: "Package Path must be exactly two safe path segments",
        packageIdentityIssue: { kind: "invalid", field: "path" },
      });
    }
  }
  return issues;
}

function defaultBlueprintIssues(
  blueprint: Pick<ProjectBlueprint, "packages"> | ProjectBlueprintDraft,
): BlueprintValidationIssue[] {
  return blueprint.packages.flatMap(defaultPackageIssues);
}

/** 验证默认策略持久化蓝图的 npm 命名、角色与目录合同。 */
export function validateDefaultProjectBlueprint(
  value: unknown,
): BlueprintValidationResult {
  const result = validateProjectBlueprint(value);
  if (!result.ok) return result;
  const issues = defaultBlueprintIssues(result.value);
  return issues.length === 0 ? result : { ok: false, issues };
}

/** 验证默认策略在分配持久化实例标识前的包拓扑。 */
export function assertDefaultProjectBlueprintDraft(
  value: ProjectBlueprintDraft,
): ProjectBlueprintDraft {
  const blueprint = assertProjectBlueprintDraft(value);
  const issues = defaultBlueprintIssues(blueprint);
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return blueprint;
}

/** 验证默认策略已经持久化的蓝图。 */
export function assertDefaultProjectBlueprint(
  value: unknown,
): ProjectBlueprint {
  const result = validateDefaultProjectBlueprint(value);
  if (!result.ok) {
    throw new ProjectBlueprintValidationError(result.issues);
  }
  return result.value;
}

/** 在默认策略创建实例时校验其角色、npm 名称和目录。 */
export function assertDefaultPackageDefinition(
  definition: PackageDefinition,
): PackageDefinition {
  const issues = defaultPackageIssues(definition, 0);
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return definition;
}
