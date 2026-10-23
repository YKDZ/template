import path from "node:path";

import * as v from "valibot";

/** 角色由内容与所属组合解释；它不决定包目录的输出权限。 */
export type PackageRole = string;

export type PackageDefinition = {
  readonly name: string;
  /** 规范包目录；`.` 表示目标根目录。 */
  readonly path: string;
  readonly role: PackageRole;
};

export type PackageDefinitionId = `package-${string}`;

export type PersistedPackageDefinition = PackageDefinition & {
  readonly packageDefinitionId: PackageDefinitionId;
};

/** 蓝图只通过持续实例身份表达包连接。 */
export type PackageLinkIntent = {
  readonly consumerId: PackageDefinitionId;
  readonly providerId: PackageDefinitionId;
};

export type ProjectBlueprint = {
  readonly schemaVersion: 4;
  readonly packages: readonly PersistedPackageDefinition[];
  readonly packageLinkIntents: readonly PackageLinkIntent[];
};

export type ProjectBlueprintDraft = {
  readonly schemaVersion: 4;
  readonly packages: readonly PackageDefinition[];
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

export type BlueprintValidationIssue = {
  readonly path: string;
  readonly message: string;
  readonly packageIdentityIssue?: BlueprintPackageIdentityIssue;
};

export type BlueprintPackageIdentityIssue =
  | {
      readonly kind: "duplicate";
      readonly field: "name" | "path";
      readonly existing: PackageDefinition;
      readonly requested: PackageDefinition;
    }
  | {
      readonly kind: "invalid";
      readonly field: "name" | "path";
    }
  | { readonly kind: "reserved"; readonly field: "path" };

export class ProjectBlueprintValidationError extends Error {
  readonly issues: readonly BlueprintValidationIssue[];

  constructor(issues: readonly BlueprintValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ProjectBlueprintValidationError";
    this.issues = issues;
  }

  get packageIdentityIssues(): readonly BlueprintPackageIdentityIssue[] {
    return this.issues.flatMap((issue) =>
      issue.packageIdentityIssue === undefined
        ? []
        : [issue.packageIdentityIssue],
    );
  }
}

export type BlueprintValidationResult =
  | { readonly ok: true; readonly value: ProjectBlueprint }
  | {
      readonly ok: false;
      readonly issues: readonly BlueprintValidationIssue[];
    };

const packageDefinitionSchema = v.strictObject({
  packageDefinitionId: v.pipe(v.string(), v.regex(/^package-[a-f0-9]{64}$/)),
  name: v.string(),
  path: v.string(),
  role: v.string(),
});

const packageLinkIntentSchema = v.strictObject({
  consumerId: v.pipe(v.string(), v.regex(/^package-[a-f0-9]{64}$/)),
  providerId: v.pipe(v.string(), v.regex(/^package-[a-f0-9]{64}$/)),
});

export const projectBlueprintSchema = v.strictObject({
  schemaVersion: v.literal(4),
  packages: v.array(packageDefinitionSchema),
  packageLinkIntents: v.array(packageLinkIntentSchema),
});

function isNormalizedPackagePath(value: string): boolean {
  if (value === ".") return true;
  const normalized = path.posix.normalize(value);
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    path.win32.parse(value).root.length === 0 &&
    !value.endsWith("/") &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized === value
  );
}

function blueprintIssuePath(issue: v.BaseIssue<unknown>): string {
  let result = ".";
  for (const item of issue.path ?? []) {
    if (typeof item.key === "number") {
      result += `[${item.key}]`;
    } else if (typeof item.key === "string") {
      result += `${result === "." ? "" : "."}${item.key}`;
    }
  }
  return result;
}

function validateBlueprintSemantics(
  blueprint: Omit<ProjectBlueprint, "packages"> & {
    readonly packages: readonly PackageDefinition[];
  },
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  for (const [index, definition] of blueprint.packages.entries()) {
    const itemPath = `.packages[${index}]`;
    if (definition.name.trim().length === 0) {
      issues.push({
        path: `${itemPath}.name`,
        message: "软件包名称不能为空",
        packageIdentityIssue: { kind: "invalid", field: "name" },
      });
    }
    if (definition.role.trim().length === 0) {
      issues.push({
        path: `${itemPath}.role`,
        message: "软件包角色不能为空",
      });
    }
    if (!isNormalizedPackagePath(definition.path)) {
      issues.push({
        path: `${itemPath}.path`,
        message: "软件包路径必须是规范化的安全相对路径",
        packageIdentityIssue: { kind: "invalid", field: "path" },
      });
    }
  }

  for (const [property, label] of [
    ["name", "软件包名称"],
    ["path", "软件包路径"],
  ] as const) {
    const seen = new Map<string, PackageDefinition>();
    for (const definition of blueprint.packages) {
      const member = definition[property];
      const existing = seen.get(member);
      if (existing !== undefined) {
        issues.push({
          path: ".packages",
          message: `${label}必须唯一：${member}`,
          packageIdentityIssue: {
            kind: "duplicate",
            field: property,
            existing: {
              name: existing.name,
              path: existing.path,
              role: existing.role,
            },
            requested: {
              name: definition.name,
              path: definition.path,
              role: definition.role,
            },
          },
        });
      }
      seen.set(member, definition);
    }
  }

  const ids = new Set<PackageDefinitionId>();
  for (const [index, definition] of blueprint.packages.entries()) {
    if (!("packageDefinitionId" in definition)) continue;
    const id = definition.packageDefinitionId;
    if (typeof id !== "string") continue;
    const packageId = id as PackageDefinitionId;
    if (ids.has(packageId)) {
      issues.push({
        path: `.packages[${index}].packageDefinitionId`,
        message: `包实例标识必须唯一：${packageId}`,
      });
    }
    ids.add(packageId);
  }

  const links = new Set<string>();
  for (const [index, intent] of blueprint.packageLinkIntents.entries()) {
    const itemPath = `.packageLinkIntents[${index}]`;
    if (!ids.has(intent.consumerId)) {
      issues.push({
        path: `${itemPath}.consumerId`,
        message: "包连接引用了不存在的使用方实例",
      });
    }
    if (!ids.has(intent.providerId)) {
      issues.push({
        path: `${itemPath}.providerId`,
        message: "包连接引用了不存在的提供方实例",
      });
    }
    if (intent.consumerId === intent.providerId) {
      issues.push({
        path: itemPath,
        message: "包连接不能指向自身",
      });
    }
    const key = `${intent.consumerId}\0${intent.providerId}`;
    if (links.has(key)) {
      issues.push({
        path: itemPath,
        message: "包连接不能重复",
      });
    }
    links.add(key);
  }
  return issues;
}

function structureIssues(value: unknown): BlueprintValidationIssue[] {
  const parsed = v.safeParse(projectBlueprintSchema, value);
  if (parsed.success) return [];
  return parsed.issues.map((issue) => {
    const issuePath = blueprintIssuePath(issue);
    if (issuePath === ".schemaVersion") {
      return {
        path: issuePath,
        message: `不支持的本地模板元数据版本 ${String(isObject(value) ? value.schemaVersion : undefined)}；当前只支持 schema4`,
      };
    }
    if (
      issue.type === "strict_object" &&
      issue.path?.at(-1)?.origin === "key"
    ) {
      return {
        path: issuePath,
        message:
          issue.expected === "never"
            ? "蓝图 v4 包含未知字段"
            : "蓝图缺少必需字段",
      };
    }
    return { path: issuePath, message: "字段类型或结构不符合蓝图要求" };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectBlueprint(
  value: unknown,
): BlueprintValidationResult {
  const structure = structureIssues(value);
  if (structure.length > 0) return { ok: false, issues: structure };

  const parsed = v.parse(projectBlueprintSchema, value);
  const blueprint: ProjectBlueprint = {
    schemaVersion: parsed.schemaVersion,
    packages: parsed.packages as readonly PersistedPackageDefinition[],
    packageLinkIntents:
      parsed.packageLinkIntents as readonly PackageLinkIntent[],
  };
  const issues = validateBlueprintSemantics(blueprint);
  return issues.length === 0
    ? { ok: true, value: blueprint }
    : { ok: false, issues };
}

export function assertProjectBlueprintDraft(
  value: ProjectBlueprintDraft,
): ProjectBlueprintDraft {
  if (value.schemaVersion !== 4) {
    throw new Error("项目蓝图草稿必须使用 schema4");
  }
  const issues = validateBlueprintSemantics({
    schemaVersion: value.schemaVersion,
    packages: value.packages,
    packageLinkIntents: value.packageLinkIntents ?? [],
  });
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return value;
}

export function assertProjectBlueprint(value: unknown): ProjectBlueprint {
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    throw new ProjectBlueprintValidationError(result.issues);
  }
  return result.value;
}
