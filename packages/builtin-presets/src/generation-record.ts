import * as v from "valibot";

import type { GenerationContext } from "#template-core/preset-definition";
import type { PackageDefinitionId } from "#template-core/project-blueprint";
import {
  isValidNodeLtsMajor,
  isValidPackageManagerPin,
} from "#template-core/toolchain-resolution";

export type GeneratedPackagePlanningRecord = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly path: string;
  readonly definitionName: string;
  readonly planningContribution:
    | "foundationPlan"
    | "planInitialization"
    | "planPackageAddition";
  readonly contributionIdentity: string;
};

export type GenerationRecord = {
  readonly schemaVersion: 2;
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly preset: string;
  readonly templateVersion: "0.0.0";
  readonly toolchain: GenerationContext["toolchain"];
  readonly packages: readonly GeneratedPackagePlanningRecord[];
};

function strictObjectMessage(
  issue: v.StrictObjectIssue,
  objectMessage: string,
) {
  if (issue.path?.at(-1)?.origin !== "key") return objectMessage;
  const unknownKey =
    typeof issue.input === "string" ? issue.input : "<unknown>";
  return `contains unknown Generation Record field; contains unknown field: ${unknownKey}`;
}

const packagePlanningRecordSchema = v.strictObject(
  {
    packageDefinitionId: v.string(
      "packageDefinitionId must use the package-<sha256> format",
    ),
    path: v.string("path must be a non-empty string"),
    definitionName: v.string("definitionName must be a non-empty string"),
    planningContribution: v.picklist(
      ["foundationPlan", "planInitialization", "planPackageAddition"],
      "planningContribution is unsupported",
    ),
    contributionIdentity: v.string(
      "contributionIdentity must be a non-empty string",
    ),
  },
  (issue) =>
    strictObjectMessage(issue, "package planning fact must be an object"),
);

const generationRecordSchema = v.strictObject(
  {
    schemaVersion: v.literal(
      2,
      (issue) =>
        `Unsupported Generation Record schema version ${String(issue.input)}; expected 2`,
    ),
    repositoryName: v.string("repositoryName must be a non-empty string"),
    defaultPackageScope: v.string(
      "defaultPackageScope must be a valid npm scope",
    ),
    preset: v.string("preset must be a non-empty string"),
    templateVersion: v.literal("0.0.0", "templateVersion must be 0.0.0"),
    toolchain: v.strictObject(
      {
        nodeLtsMajor: v.string(
          "toolchain.nodeLtsMajor must be a numeric Node major",
        ),
        packageManagerPin: v.string(
          "toolchain.packageManagerPin must be an exact pnpm version pin",
        ),
      },
      (issue) => strictObjectMessage(issue, "toolchain must be an object"),
    ),
    packages: v.array(packagePlanningRecordSchema, "packages must be an array"),
  },
  (issue) =>
    strictObjectMessage(issue, "supported Generation Record must be an object"),
);

function issuePath(issue: v.InferIssue<typeof generationRecordSchema>): string {
  let result = "";
  for (const item of issue.path ?? []) {
    if (typeof item.key === "number") {
      result += `[${item.key}]`;
    } else if (typeof item.key === "string") {
      result += `${result.length === 0 ? "" : "."}${item.key}`;
    }
  }
  return result;
}

const missingFieldMessages = new Map<string, string>([
  [
    "schemaVersion",
    "Unsupported Generation Record schema version undefined; expected 2",
  ],
  ["repositoryName", "repositoryName must be a non-empty string"],
  ["defaultPackageScope", "defaultPackageScope must be a valid npm scope"],
  ["preset", "preset must be a non-empty string"],
  ["templateVersion", "templateVersion must be 0.0.0"],
  ["toolchain", "toolchain must be an object"],
  ["packages", "packages must be an array"],
]);

function missingFieldMessage(path: string, fallback: string): string {
  const exact = missingFieldMessages.get(path);
  if (exact !== undefined) return exact;
  if (path.endsWith(".nodeLtsMajor")) {
    return `${path} must be a numeric Node major`;
  }
  if (path.endsWith(".packageManagerPin")) {
    return `${path} must be an exact pnpm version pin`;
  }
  if (path.endsWith(".packageDefinitionId")) {
    return `${path} must use the package-<sha256> format`;
  }
  if (
    path.endsWith(".path") ||
    path.endsWith(".definitionName") ||
    path.endsWith(".contributionIdentity")
  ) {
    return `${path} must be a non-empty string`;
  }
  if (path.endsWith(".planningContribution")) {
    return `${path} is unsupported`;
  }
  return fallback;
}

function structuralError(
  issues: readonly v.InferIssue<typeof generationRecordSchema>[],
): Error {
  return new Error(
    `Package Addition Generation Record ${issues
      .map((issue) => {
        const path = issuePath(issue);
        const last = issue.path?.at(-1);
        if (
          issue.type === "strict_object" &&
          last?.origin === "key" &&
          issue.input !== undefined &&
          !path.includes(".") &&
          !path.includes("[")
        ) {
          const unknownKey =
            typeof issue.input === "string" ? issue.input : "<unknown>";
          return `contains unknown field: ${unknownKey}; ${path}: contains unknown Generation Record field`;
        }
        let message = issue.message;
        if (
          issue.type === "strict_object" &&
          last?.origin === "key" &&
          issue.input === undefined
        ) {
          message = missingFieldMessage(path, message);
        }
        const normalizedPath = path.length === 0 ? "." : path;
        return message.startsWith(normalizedPath)
          ? message
          : `${normalizedPath}: ${message}`;
      })
      .join("; ")}`,
  );
}

/** Strictly decodes the durable Record shape before semantic checks run. */
export function decodeGenerationRecordStructure(
  value: unknown,
): GenerationRecord {
  const parsed = v.safeParse(generationRecordSchema, value);
  if (!parsed.success) throw structuralError(parsed.issues);
  return parsed.output as GenerationRecord;
}

/** Validates semantic invariants that are independent of a Project Blueprint. */
export function parseGenerationRecord(value: unknown): GenerationRecord {
  const record = decodeGenerationRecordStructure(value);
  const issues: string[] = [];
  if (
    record.repositoryName.length === 0 ||
    record.repositoryName !== record.repositoryName.trim()
  ) {
    issues.push("repositoryName must be a non-empty string");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(record.defaultPackageScope)) {
    issues.push("defaultPackageScope must be a valid npm scope");
  }
  if (record.preset.length === 0 || record.preset !== record.preset.trim()) {
    issues.push("preset must be a non-empty string");
  }
  if (!isValidNodeLtsMajor(record.toolchain.nodeLtsMajor)) {
    issues.push("toolchain.nodeLtsMajor must be a numeric Node major");
  }
  if (!isValidPackageManagerPin(record.toolchain.packageManagerPin)) {
    issues.push(
      "toolchain.packageManagerPin must be an exact pnpm version pin",
    );
  }
  for (const [index, item] of record.packages.entries()) {
    if (!/^package-[a-f0-9]{64}$/.test(item.packageDefinitionId)) {
      issues.push(
        `packages[${index}].packageDefinitionId must use the package-<sha256> format`,
      );
    }
    if (item.path.length === 0) {
      issues.push(`packages[${index}].path must be a non-empty string`);
    }
    if (item.definitionName.length === 0) {
      issues.push(
        `packages[${index}].definitionName must be a non-empty string`,
      );
    }
    if (item.contributionIdentity.length === 0) {
      issues.push(
        `packages[${index}].contributionIdentity must be a non-empty string`,
      );
    }
  }
  const packageDefinitionIds = record.packages.map(
    (item) => item.packageDefinitionId,
  );
  if (new Set(packageDefinitionIds).size !== packageDefinitionIds.length) {
    issues.push("packages packageDefinitionId must be unique");
  }
  if (issues.length > 0) {
    throw new Error(`Package Addition Generation Record ${issues.join("; ")}`);
  }
  return record;
}
