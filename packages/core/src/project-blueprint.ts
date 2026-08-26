import { isBuiltin } from "node:module";

import * as v from "valibot";

/**
 * The durable, preset-agnostic topology used by local template follow-up
 * operations. Preset provenance deliberately belongs in Generation Record.
 */
const packageRoles = [
  "cli-tool",
  "runtime-service",
  "shared-library",
  "native-package",
] as const;

export type PackageRole = (typeof packageRoles)[number];

export type PackageDefinition = {
  readonly name: string;
  readonly path: string;
  readonly role: PackageRole;
};

/** Opaque durable identity assigned once when a Package Definition is created. */
export type PackageDefinitionId = `package-${string}`;

export type PersistedPackageDefinition = PackageDefinition & {
  readonly packageDefinitionId: PackageDefinitionId;
};

export type PackageLinkIntent = {
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
};

export type ProjectBlueprint = {
  readonly schemaVersion: 3;
  readonly packages: readonly PersistedPackageDefinition[];
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

/** Preset-owned topology before Foundation assigns durable package identities. */
export type ProjectBlueprintDraft = {
  readonly schemaVersion: 3;
  readonly packages: readonly PackageDefinition[];
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

export type BlueprintValidationIssue = {
  readonly path: string;
  readonly message: string;
};

export type BlueprintValidationResult =
  | { readonly ok: true; readonly value: ProjectBlueprint }
  | {
      readonly ok: false;
      readonly issues: readonly BlueprintValidationIssue[];
    };

const packagePath = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
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

const unknownBlueprintField = "Unknown Blueprint v3 field";

const packageDefinitionEntries = {
  name: v.string("Package name must be a string"),
  path: v.string("Package Path must be a string"),
  role: v.picklist(
    packageRoles,
    "Package Role must be cli-tool, runtime-service, shared-library, or native-package",
  ),
} as const;

function packageDefinitionMessage(issue: v.BaseIssue<unknown>): string {
  return issue.path?.at(-1)?.origin === "key" && issue.input !== undefined
    ? unknownBlueprintField
    : "Package Definition must be an object";
}

const packageDefinitionSchema = v.strictObject(
  {
    packageDefinitionId: v.string(
      "Package Definition ID must use the package-<sha256> format",
    ),
    ...packageDefinitionEntries,
  },
  packageDefinitionMessage,
);

const packageLinkIntentSchema = v.strictObject(
  {
    consumerPackagePath: v.string(
      "Package Link Intent consumer Package Path must be a string",
    ),
    providerPackagePath: v.string(
      "Package Link Intent provider Package Path must be a string",
    ),
  },
  (issue) =>
    issue.path?.at(-1)?.origin === "key" && issue.input !== undefined
      ? unknownBlueprintField
      : "Package Link Intent must be an object",
);

const projectBlueprintSchema = v.strictObject(
  {
    schemaVersion: v.literal(
      3,
      (issue) =>
        `Unsupported Local Template Metadata schema version ${String(issue.input)}; expected 3`,
    ),
    packages: v.array(
      packageDefinitionSchema,
      "Package Definitions must be an array",
    ),
    packageLinkIntents: v.optional(
      v.array(packageLinkIntentSchema, "Package Link Intents must be an array"),
    ),
  },
  (issue) =>
    issue.path?.at(-1)?.origin === "key" && issue.input !== undefined
      ? unknownBlueprintField
      : "Local Template Metadata must be an object",
);

/** Canonical npm package-name predicate shared by Blueprint and input preparation. */
export function isValidNewNpmPackageName(value: string): boolean {
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

export type NewPackagePathValidation = {
  readonly hasValidShape: boolean;
  readonly reservedWorkspaceCollection?: string;
};

/** Canonical Package Path facts shared by Blueprint and input preparation. */
export function validateNewPackagePath(
  value: string,
): NewPackagePathValidation {
  const workspaceCollection = value.split("/", 1)[0]!;
  return {
    hasValidShape: packagePath.test(value),
    ...(reservedWorkspaceCollections.has(workspaceCollection)
      ? { reservedWorkspaceCollection: workspaceCollection }
      : {}),
  };
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

function blueprintStructureMessage(issue: v.BaseIssue<unknown>): string {
  if (
    issue.type !== "strict_object" ||
    issue.path?.at(-1)?.origin !== "key" ||
    issue.input !== undefined
  ) {
    return issue.message;
  }
  const path = blueprintIssuePath(issue);
  if (path === ".schemaVersion") {
    return "Unsupported Local Template Metadata schema version undefined; expected 3";
  }
  if (path === ".packages") return "Package Definitions must be an array";
  if (path.endsWith(".name")) return "Package name must be a string";
  if (path.endsWith(".packageDefinitionId")) {
    return "Package Definition ID must use the package-<sha256> format";
  }
  if (path.endsWith(".path")) return "Package Path must be a string";
  if (path.endsWith(".role")) {
    return "Package Role must be cli-tool, runtime-service, shared-library, or native-package";
  }
  if (path === ".packageLinkIntents") {
    return "Package Link Intents must be an array";
  }
  if (path.endsWith(".consumerPackagePath")) {
    return "Package Link Intent consumer Package Path must be a string";
  }
  if (path.endsWith(".providerPackagePath")) {
    return "Package Link Intent provider Package Path must be a string";
  }
  return issue.message;
}

function validateBlueprintTopologySemantics(
  blueprint: ProjectBlueprintDraft,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  for (const [index, definition] of blueprint.packages.entries()) {
    const itemPath = `.packages[${index}]`;
    const pathValidation = validateNewPackagePath(definition.path);
    if (!isValidNewNpmPackageName(definition.name)) {
      issues.push({
        path: `${itemPath}.name`,
        message:
          "Package name must be a valid npm package name for new packages",
      });
    }
    if (pathValidation.reservedWorkspaceCollection !== undefined) {
      issues.push({
        path: `${itemPath}.path`,
        message: `Package Path ${definition.path} uses reserved workspace collection ${pathValidation.reservedWorkspaceCollection}`,
      });
    } else if (!pathValidation.hasValidShape) {
      issues.push({
        path: `${itemPath}.path`,
        message: "Package Path must be exactly two safe path segments",
      });
    }
  }
  for (const [property, label] of [
    ["name", "Package name"],
    ["path", "Package Path"],
  ] as const) {
    const seen = new Set<string>();
    for (const definition of blueprint.packages) {
      const member = definition[property];
      if (seen.has(member)) {
        issues.push({
          path: ".packages",
          message: `${label} must be unique: ${member}`,
        });
      }
      seen.add(member);
    }
  }

  const paths = new Set(
    blueprint.packages.map((definition) => definition.path),
  );
  const links = new Set<string>();
  for (const [index, intent] of (
    blueprint.packageLinkIntents ?? []
  ).entries()) {
    const itemPath = `.packageLinkIntents[${index}]`;
    if (!paths.has(intent.consumerPackagePath)) {
      issues.push({
        path: `${itemPath}.consumerPackagePath`,
        message: "Package Link Intent references an unknown consumer package",
      });
    }
    if (!paths.has(intent.providerPackagePath)) {
      issues.push({
        path: `${itemPath}.providerPackagePath`,
        message: "Package Link Intent references an unknown provider package",
      });
    }
    if (intent.consumerPackagePath === intent.providerPackagePath) {
      issues.push({
        path: itemPath,
        message: "Package Link Intent cannot link a package to itself",
      });
    }
    const key = `${intent.consumerPackagePath}\u0000${intent.providerPackagePath}`;
    if (links.has(key)) {
      issues.push({
        path: itemPath,
        message: "Package Link Intent must be unique",
      });
    }
    links.add(key);
  }
  return issues;
}

function validatePersistedPackageIds(
  blueprint: ProjectBlueprint,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const seen = new Set<PackageDefinitionId>();
  for (const [index, definition] of blueprint.packages.entries()) {
    if (!/^package-[a-f0-9]{64}$/.test(definition.packageDefinitionId)) {
      issues.push({
        path: `.packages[${index}].packageDefinitionId`,
        message: "Package Definition ID must use the package-<sha256> format",
      });
    }
    if (seen.has(definition.packageDefinitionId)) {
      issues.push({
        path: ".packages",
        message: `Package Definition ID must be unique: ${definition.packageDefinitionId}`,
      });
    }
    seen.add(definition.packageDefinitionId);
  }
  return issues;
}

/** Validates persisted metadata before it is used to plan or render changes. */
export function validateProjectBlueprint(
  value: unknown,
): BlueprintValidationResult {
  const parsed = v.safeParse(projectBlueprintSchema, value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({
        path: blueprintIssuePath(issue),
        message: blueprintStructureMessage(issue),
      })),
    };
  }
  const blueprint: ProjectBlueprint = {
    schemaVersion: parsed.output.schemaVersion,
    packages: parsed.output.packages as readonly PersistedPackageDefinition[],
    ...(parsed.output.packageLinkIntents === undefined
      ? {}
      : { packageLinkIntents: parsed.output.packageLinkIntents }),
  };
  const issues = [
    ...validateBlueprintTopologySemantics(blueprint),
    ...validatePersistedPackageIds(blueprint),
  ];
  return issues.length === 0
    ? { ok: true, value: blueprint }
    : { ok: false, issues };
}

/** Validates preset-owned topology before any persisted identity is assigned. */
export function assertProjectBlueprintDraft(
  value: ProjectBlueprintDraft,
): ProjectBlueprintDraft {
  const issues = validateBlueprintTopologySemantics(value);
  if (issues.length > 0) {
    throw new Error(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  }
  return value;
}

export function assertProjectBlueprint(value: unknown): ProjectBlueprint {
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    throw new Error(
      result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  }
  return result.value;
}
