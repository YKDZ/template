import path from "node:path";

import {
  isValidDefaultNpmPackageName,
  isValidDefaultPackageScope,
  validateDefaultPackagePath,
} from "@ykdz/template-workspace/default-package-identity";
import { defaultWorkspaceConfigurationIdentity } from "@ykdz/template-workspace/default-workspace-strategy";

import { presetByAlias, type CliPreset } from "./preset-catalog.ts";

export type InitializationInputIssue = {
  readonly code:
    | "PRESET_UNKNOWN"
    | "FIXED_TOPOLOGY_OVERRIDE"
    | "INVALID_PACKAGE_NAME"
    | "INVALID_PACKAGE_PATH"
    | "RESERVED_PACKAGE_PATH"
    | "INVALID_PACKAGE_SCOPE"
    | "INVALID_REPOSITORY_SCOPE"
    | "CONFLICTING_PACKAGE_IDENTITY";
};

export type PackageAdditionInputIssue = {
  readonly code:
    | "PRESET_UNKNOWN"
    | "PRESET_NOT_ADDABLE"
    | "INVALID_PACKAGE_NAME"
    | "INVALID_PACKAGE_PATH"
    | "RESERVED_PACKAGE_PATH"
    | "INVALID_LINK_FROM"
    | "RESERVED_LINK_FROM"
    | "UNKNOWN_LINK_FROM"
    | "UNSUPPORTED_LINK";
};

type InitializationInput = {
  readonly preset: string;
  readonly targetDir: string;
  readonly overrides?: {
    readonly name?: string;
    readonly path?: string;
    readonly scope?: string;
  };
};

export type ValidInitializationInput = {
  readonly preset: CliPreset;
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
};

export type InitializationInputValidation =
  | { readonly status: "valid"; readonly value: ValidInitializationInput }
  | {
      readonly status: "input-invalid";
      readonly issues: readonly InitializationInputIssue[];
    };

function deduplicateIssues<T extends { readonly code: string }>(
  issues: readonly T[],
): readonly T[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex((candidate) => candidate.code === issue.code) === index,
  );
}

function validScope(value: string): boolean {
  return (
    isValidDefaultPackageScope(value) &&
    isValidDefaultNpmPackageName(
      defaultWorkspaceConfigurationIdentity(value).name,
    )
  );
}

export function validateInitializationInput(
  input: InitializationInput,
): InitializationInputValidation {
  const issues: InitializationInputIssue[] = [];
  const preset = presetByAlias(input.preset);
  if (preset === undefined || !preset.operations.includes("init")) {
    return {
      status: "input-invalid",
      issues: [{ code: "PRESET_UNKNOWN" }],
    };
  }

  const override = input.overrides;
  const repositoryName = path.basename(path.resolve(input.targetDir));
  const scopeInput = override?.scope;
  const normalizedScope = scopeInput?.startsWith("@")
    ? scopeInput.slice(1)
    : scopeInput;
  const configurable = Object.keys(preset.nodes).length === 1;
  if (
    !configurable &&
    (override?.name !== undefined || override?.path !== undefined)
  ) {
    issues.push({ code: "FIXED_TOPOLOGY_OVERRIDE" });
  }

  const validName =
    override?.name !== undefined &&
    isValidDefaultNpmPackageName(`@x/${override.name}`);
  if (override?.name !== undefined && !validName) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }

  if (override?.path !== undefined) {
    const validation = validateDefaultPackagePath(override.path);
    if (!validation.hasValidShape) {
      issues.push({ code: "INVALID_PACKAGE_PATH" });
    }
    if (validation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_PACKAGE_PATH" });
    }
  }

  const validScopeOverride =
    normalizedScope !== undefined &&
    scopeInput === scopeInput?.trim() &&
    validScope(normalizedScope);
  if (normalizedScope !== undefined && !validScopeOverride) {
    issues.push({ code: "INVALID_PACKAGE_SCOPE" });
  }
  const validRepositoryScope = validScope(repositoryName);
  if (normalizedScope === undefined && !validRepositoryScope) {
    issues.push({ code: "INVALID_REPOSITORY_SCOPE" });
  }

  const defaultPackageScope = validScopeOverride
    ? (normalizedScope ?? "repository")
    : validRepositoryScope
      ? repositoryName
      : "repository";
  const nodeLeafNames = Object.values(preset.nodes).map(
    ({ reference }) => reference.defaultLeafName,
  );
  if (
    nodeLeafNames.some(
      (leafName) =>
        !isValidDefaultNpmPackageName(`@${defaultPackageScope}/${leafName}`),
    ) ||
    (configurable &&
      validName &&
      !isValidDefaultNpmPackageName(`@${defaultPackageScope}/${override.name}`))
  ) {
    issues.push({
      code:
        override?.name !== undefined
          ? "INVALID_PACKAGE_NAME"
          : scopeInput !== undefined
            ? "INVALID_PACKAGE_SCOPE"
            : "INVALID_REPOSITORY_SCOPE",
    });
  }

  if (
    (override?.name !== undefined &&
      defaultWorkspaceConfigurationIdentity(defaultPackageScope).name ===
        `@${defaultPackageScope}/${override.name}`) ||
    (override?.path !== undefined &&
      defaultWorkspaceConfigurationIdentity(defaultPackageScope).path ===
        override.path)
  ) {
    issues.push({ code: "CONFLICTING_PACKAGE_IDENTITY" });
  }

  if (issues.length > 0) {
    return {
      status: "input-invalid",
      issues: deduplicateIssues(issues),
    };
  }
  return {
    status: "valid",
    value: { preset, repositoryName, defaultPackageScope },
  };
}

export function validatePackageAdditionInput(input: {
  readonly preset: string;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
}):
  | {
      readonly status: "valid";
      readonly preset: CliPreset;
      readonly linkFrom: readonly string[];
    }
  | {
      readonly status: "input-invalid";
      readonly issues: readonly PackageAdditionInputIssue[];
    } {
  const issues: PackageAdditionInputIssue[] = [];
  const preset = presetByAlias(input.preset);
  if (preset === undefined) issues.push({ code: "PRESET_UNKNOWN" });
  else if (!preset.operations.includes("add")) {
    issues.push({ code: "PRESET_NOT_ADDABLE" });
  }
  if (!isValidDefaultNpmPackageName(`@x/${input.packageLeafName}`)) {
    issues.push({ code: "INVALID_PACKAGE_NAME" });
  }
  if (input.packagePath !== undefined) {
    const validation = validateDefaultPackagePath(input.packagePath);
    if (!validation.hasValidShape) {
      issues.push({ code: "INVALID_PACKAGE_PATH" });
    }
    if (validation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_PACKAGE_PATH" });
    }
  }
  const linkFrom = [...new Set(input.linkFrom ?? [])];
  for (const packagePath of linkFrom) {
    const validation = validateDefaultPackagePath(packagePath);
    if (!validation.hasValidShape) {
      issues.push({ code: "INVALID_LINK_FROM" });
    }
    if (validation.reservedWorkspaceCollection !== undefined) {
      issues.push({ code: "RESERVED_LINK_FROM" });
    }
  }
  if (issues.length > 0 || preset === undefined) {
    return { status: "input-invalid", issues: deduplicateIssues(issues) };
  }
  return { status: "valid", preset, linkFrom };
}
