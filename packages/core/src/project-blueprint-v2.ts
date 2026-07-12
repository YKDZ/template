/**
 * The durable, preset-agnostic topology used by local template follow-up
 * operations. Preset provenance deliberately belongs in Generation Record.
 */
export type PackageRole =
  | "runtime-service"
  | "shared-library"
  | "native-package";

export type PackageDefinition = {
  readonly name: string;
  readonly path: string;
  readonly role: PackageRole;
};

export type PackageLinkIntent = {
  readonly consumerPackagePath: string;
  readonly providerPackagePath: string;
};

export type ProjectBlueprintV2 = {
  readonly schemaVersion: 2;
  readonly packages: readonly PackageDefinition[];
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

export type BlueprintV2ValidationIssue = {
  readonly path: string;
  readonly message: string;
};

export type BlueprintV2ValidationResult =
  | { readonly ok: true; readonly value: ProjectBlueprintV2 }
  | {
      readonly ok: false;
      readonly issues: readonly BlueprintV2ValidationIssue[];
    };

const packageName = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const packagePath = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const roles = new Set<PackageRole>([
  "runtime-service",
  "shared-library",
  "native-package",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: BlueprintV2ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "Unknown Blueprint v2 field",
      });
    }
  }
}

/** Validates persisted metadata before it is used to plan or render changes. */
export function validateProjectBlueprintV2(
  value: unknown,
): BlueprintV2ValidationResult {
  const issues: BlueprintV2ValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [
        { path: ".", message: "Local Template Metadata must be an object" },
      ],
    };
  }
  reportUnknownKeys(
    value,
    ["schemaVersion", "packages", "packageLinkIntents"],
    ".",
    issues,
  );
  if (value.schemaVersion !== 2) {
    issues.push({
      path: ".schemaVersion",
      message: `Unsupported Local Template Metadata schema version ${String(value.schemaVersion)}; expected 2`,
    });
  }
  if (!Array.isArray(value.packages)) {
    issues.push({
      path: ".packages",
      message: "Package Definitions must be an array",
    });
  }

  const definitions: PackageDefinition[] = [];
  if (Array.isArray(value.packages)) {
    for (const [index, item] of value.packages.entries()) {
      const itemPath = `.packages[${index}]`;
      if (!isRecord(item)) {
        issues.push({
          path: itemPath,
          message: "Package Definition must be an object",
        });
        continue;
      }
      reportUnknownKeys(item, ["name", "path", "role"], itemPath, issues);
      if (typeof item.name !== "string" || !packageName.test(item.name)) {
        issues.push({
          path: `${itemPath}.name`,
          message: "Package name must be a scoped lowercase package name",
        });
      }
      if (typeof item.path !== "string" || !packagePath.test(item.path)) {
        issues.push({
          path: `${itemPath}.path`,
          message: "Package Path must be exactly two safe path segments",
        });
      }
      if (
        typeof item.role !== "string" ||
        !roles.has(item.role as PackageRole)
      ) {
        issues.push({
          path: `${itemPath}.role`,
          message:
            "Package Role must be runtime-service, shared-library, or native-package",
        });
      }
      if (
        typeof item.name === "string" &&
        typeof item.path === "string" &&
        typeof item.role === "string" &&
        packageName.test(item.name) &&
        packagePath.test(item.path) &&
        roles.has(item.role as PackageRole)
      ) {
        definitions.push(item as PackageDefinition);
      }
    }
  }
  for (const [property, label] of [
    ["name", "Package name"],
    ["path", "Package Path"],
  ] as const) {
    const seen = new Set<string>();
    for (const definition of definitions) {
      const member = definition[property];
      if (seen.has(member))
        issues.push({
          path: ".packages",
          message: `${label} must be unique: ${member}`,
        });
      seen.add(member);
    }
  }

  if (
    value.packageLinkIntents !== undefined &&
    !Array.isArray(value.packageLinkIntents)
  ) {
    issues.push({
      path: ".packageLinkIntents",
      message: "Package Link Intents must be an array",
    });
  }
  const paths = new Set(definitions.map((definition) => definition.path));
  const links = new Set<string>();
  if (Array.isArray(value.packageLinkIntents)) {
    for (const [index, item] of value.packageLinkIntents.entries()) {
      const itemPath = `.packageLinkIntents[${index}]`;
      if (!isRecord(item)) {
        issues.push({
          path: itemPath,
          message: "Package Link Intent must be an object",
        });
        continue;
      }
      reportUnknownKeys(
        item,
        ["consumerPackagePath", "providerPackagePath"],
        itemPath,
        issues,
      );
      const consumer = item.consumerPackagePath;
      const provider = item.providerPackagePath;
      if (typeof consumer !== "string" || !paths.has(consumer))
        issues.push({
          path: `${itemPath}.consumerPackagePath`,
          message: "Package Link Intent references an unknown consumer package",
        });
      if (typeof provider !== "string" || !paths.has(provider))
        issues.push({
          path: `${itemPath}.providerPackagePath`,
          message: "Package Link Intent references an unknown provider package",
        });
      if (consumer === provider && typeof consumer === "string")
        issues.push({
          path: itemPath,
          message: "Package Link Intent cannot link a package to itself",
        });
      if (typeof consumer === "string" && typeof provider === "string") {
        const key = `${consumer}\u0000${provider}`;
        if (links.has(key))
          issues.push({
            path: itemPath,
            message: "Package Link Intent must be unique",
          });
        links.add(key);
      }
    }
  }
  return issues.length === 0
    ? { ok: true, value: value as ProjectBlueprintV2 }
    : { ok: false, issues };
}

export function assertProjectBlueprintV2(value: unknown): ProjectBlueprintV2 {
  const result = validateProjectBlueprintV2(value);
  if (!result.ok) {
    throw new Error(
      result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  }
  return result.value;
}
