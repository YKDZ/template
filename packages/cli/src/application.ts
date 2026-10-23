import { readFile } from "node:fs/promises";
import path from "node:path";

import { contentIdentityKey } from "@ykdz/template-core/content-identity";
import type { GenerationRecord } from "@ykdz/template-core/generation-record";
import {
  type BlueprintPackageIdentityIssue,
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import {
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
  type ProjectProjectionSource,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import {
  validateInitializationInput,
  validatePackageAdditionInput,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
} from "./input-validation.ts";
import { cliGenerator, cliPresets, presetByAlias } from "./preset-catalog.ts";

export type ApplicationRuntime = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export type InitCommandOptions = {
  readonly dir: string;
  readonly preset: string;
  readonly dryRun: boolean;
  readonly todo: boolean;
  readonly name?: string;
  readonly path?: string;
  readonly scope?: string;
};

export type AddPackageCommandOptions = {
  readonly preset: string;
  readonly name: string;
  readonly path?: string;
  readonly linkFrom: readonly string[];
  readonly dryRun: boolean;
};

type ResolvedInitialization = {
  readonly preset: string;
  readonly topology: "configurable-primary-package" | "fixed";
  readonly packages: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly scope: string;
};

export type InitCommandResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly targetDir: string;
      readonly resolved: ResolvedInitialization;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GenerationRecord;
      readonly toolchain: ReturnType<typeof toolchainReport>;
      readonly nextSteps: readonly { readonly display: string }[];
      readonly followUpDocument: {
        readonly enabled: boolean;
        readonly path?: string;
      };
    }
  | {
      readonly status: "usage-error";
      readonly targetDir: string;
      readonly issues: readonly InitializationInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly targetDir: string;
      readonly error: { readonly message: string; readonly suggestion: string };
    };

type PresetCatalogEntry = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
};

export type PresetCatalogCommandResult = {
  readonly status: "success";
  readonly presets: readonly PresetCatalogEntry[];
};

export type BlueprintValidationCommandResult =
  | {
      readonly status: "success";
      readonly path: string;
    }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly issues: readonly {
        readonly path: string;
        readonly message: string;
      }[];
    }
  | {
      readonly status: "operation-failure";
      readonly path: string;
      readonly reason:
        | "not-found"
        | "permission-denied"
        | "not-a-file"
        | "unreadable"
        | "invalid-json";
      readonly error: {
        readonly message: string;
        readonly suggestion: string;
      };
    };

type PackageAdditionCoreConflict = Omit<
  ProjectProjectionConflict,
  "before" | "current" | "after" | "sources"
> & {
  readonly sources?: ProjectProjectionSource[];
  readonly context: {
    readonly before: string;
    readonly current: string;
    readonly after: string;
  };
};

type PackageAdditionIdentityConflict = {
  readonly kind: "identity";
  readonly existing: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >["existing"];
  readonly requested: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >["requested"];
};

type PackageAdditionConflict =
  | PackageAdditionCoreConflict
  | PackageAdditionIdentityConflict;

export type PackageAdditionCommandResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly actions: readonly [];
      readonly conflicts: readonly PackageAdditionConflict[];
    }
  | {
      readonly status: "usage-error";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly error: { readonly message: string; readonly suggestion: string };
    };

export function listPresetCatalog(): PresetCatalogCommandResult {
  return {
    status: "success",
    presets: cliPresets.map(({ definition }) => ({
      name: definition.metadata.alias,
      title: definition.metadata.title,
      description: definition.metadata.description,
    })),
  };
}

/**
 * 初始化结果如实报告随 CLI 发版的不可变工具链快照：没有在线解析来源，也没有回退诊断。
 */
function toolchainReport() {
  return {
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  };
}

function packageAdditionConflict(
  conflict: ProjectProjectionConflict,
): PackageAdditionCoreConflict {
  const { before, current, after, sources, ...details } = conflict;
  return {
    ...details,
    ...(sources === undefined ? {} : { sources: [...sources] }),
    context: { before, current, after },
  };
}

function packageAdditionIdentityConflict(
  conflict: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >,
): PackageAdditionIdentityConflict {
  return {
    kind: "identity",
    existing: conflict.existing,
    requested: conflict.requested,
  };
}

function samePackageIdentityConflict(
  left: PackageAdditionIdentityConflict,
  right: PackageAdditionIdentityConflict,
): boolean {
  return (
    left.existing.name === right.existing.name &&
    left.existing.path === right.existing.path &&
    left.existing.role === right.existing.role &&
    left.requested.name === right.requested.name &&
    left.requested.path === right.requested.path &&
    left.requested.role === right.requested.role
  );
}

export async function validateBlueprintFile(
  filePath: string,
  runtime: ApplicationRuntime,
): Promise<BlueprintValidationCommandResult> {
  const resolvedPath = path.resolve(runtime.cwd, filePath);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    return readBlueprintFailure(resolvedPath, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      status: "operation-failure",
      path: resolvedPath,
      reason: "invalid-json",
      error: {
        message: "Blueprint JSON 格式无效。",
        suggestion: "修正 JSON 语法后重新验证；若文件来源不明确，请人工处理。",
      },
    };
  }
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    return {
      status: "invalid",
      path: resolvedPath,
      issues: result.issues,
    };
  }
  return {
    status: "success",
    path: resolvedPath,
  };
}

function readBlueprintFailure(
  filePath: string,
  error: unknown,
): Extract<
  BlueprintValidationCommandResult,
  { readonly status: "operation-failure" }
> {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const [reason, message, suggestion]: readonly [
    Extract<
      BlueprintValidationCommandResult,
      { readonly status: "operation-failure" }
    >["reason"],
    string,
    string,
  ] =
    errorCode === "ENOENT"
      ? ["not-found", "找不到 Blueprint 文件。", "检查路径是否正确后重新验证。"]
      : errorCode === "EACCES" || errorCode === "EPERM"
        ? [
            "permission-denied",
            "没有读取 Blueprint 文件的权限。",
            "授予读取权限后重新验证；若权限归属不明确，请人工处理。",
          ]
        : errorCode === "EISDIR" || errorCode === "ENOTDIR"
          ? [
              "not-a-file",
              "Blueprint 目标不是可读取的文件。",
              "提供一个可读取的 Blueprint JSON 文件路径后重新验证。",
            ]
          : [
              "unreadable",
              "无法读取 Blueprint 文件。",
              "检查路径、文件权限和挂载状态后重试；若需要其他访问权限，请人工处理。",
            ];
  return {
    status: "operation-failure",
    path: filePath,
    reason,
    error: { message, suggestion },
  };
}

function initOperationFailure(options: {
  readonly targetDir: string;
  readonly message?: string;
}): Extract<InitCommandResult, { readonly status: "operation-failure" }> {
  const fallbackMessage = "初始化失败。";
  return {
    status: "operation-failure",
    targetDir: options.targetDir,
    error: {
      message:
        options.message === undefined
          ? fallbackMessage
          : safeGeneratorFailureMessage(options.message, fallbackMessage),
      suggestion:
        options.message === undefined
          ? "检查目标目录与运行环境后重试；若问题持续发生，请人工处理。"
          : "根据错误信息检查所属内容包及其声明资源、目标目录后重试；若问题持续发生，请人工处理。",
    },
  };
}

function safeGeneratorFailureMessage(
  message: string,
  fallback: string,
): string {
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return fallback;
  return firstLine
    .replace(/file:\/\/\S+/gu, "本地模块路径")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:[\\/]|\/)[^\s"'`)]*/gu, "$1本地路径");
}

function initPackageIdentities(
  presetAlias: string,
  generationRecord: GenerationRecord,
  blueprint: ProjectBlueprint,
): ResolvedInitialization["packages"] {
  const preset = presetByAlias(presetAlias);
  if (preset === undefined) throw new Error("初始化预设在结果映射时不存在");
  const selection = generationRecord.selections.find(
    (candidate) =>
      candidate.presetIdentity !== null &&
      contentIdentityKey(candidate.presetIdentity) ===
        contentIdentityKey(preset.identity),
  );
  if (selection === undefined) {
    throw new Error("生成结果缺少预设选择对应的包实例");
  }
  return Object.entries(preset.definition.nodes).map(([nodeIdentity]) => {
    const packageDefinitionId = selection.nodes[nodeIdentity];
    if (packageDefinitionId === undefined) {
      throw new Error("生成结果缺少预设节点对应的包实例：" + nodeIdentity);
    }
    const record = generationRecord.packages.find(
      (candidate) => candidate.packageDefinitionId === packageDefinitionId,
    );
    if (record === undefined) {
      throw new Error("生成结果缺少预设节点对应的包实例：" + nodeIdentity);
    }
    const definition = blueprint.packages.find(
      (candidate) =>
        candidate.packageDefinitionId === record.packageDefinitionId,
    );
    if (definition === undefined) {
      throw new Error("生成结果蓝图缺少预设节点对应的包定义：" + nodeIdentity);
    }
    return {
      name: definition.name,
      path: definition.path,
    };
  });
}

export async function runInit(
  options: InitCommandOptions,
  runtime: ApplicationRuntime,
): Promise<InitCommandResult> {
  const targetDir = path.resolve(runtime.cwd, options.dir);
  const validation = validateInitializationInput({
    preset: options.preset,
    targetDir,
    overrides: {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    },
  });
  if (validation.status === "input-invalid") {
    return {
      status: "usage-error",
      targetDir: options.dir,
      issues: validation.issues,
    };
  }
  const { preset, repositoryName, defaultPackageScope } = validation.value;
  const creationInput =
    options.name === undefined && options.path === undefined
      ? undefined
      : {
          ...(options.name === undefined ? {} : { leafName: options.name }),
          ...(options.path === undefined ? {} : { packagePath: options.path }),
        };
  const planned = await cliGenerator.planInit({
    targetRoot: targetDir,
    selection: {
      presets: [
        {
          contentIdentity: preset.identity,
          ...(creationInput === undefined ? {} : { creationInput }),
        },
      ],
    },
    conventions: { repositoryName, defaultPackageScope, todo: options.todo },
  });
  if (planned.status === "operation-failure") {
    return initializationFailureFromPlanning({
      targetDir: options.dir,
      message: planned.error.message,
      ...(planned.error.packageIdentityIssues === undefined
        ? {}
        : { packageIdentityIssues: planned.error.packageIdentityIssues }),
      inputOverrides: {
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      },
    });
  }
  if (planned.status === "conflict") {
    return initOperationFailure({
      targetDir: options.dir,
      message: planned.reason,
    });
  }

  const result = options.dryRun
    ? { ...planned, status: "success" as const, dryRun: true }
    : await cliGenerator.commitPlan(planned.plan);
  if (result.status === "operation-failure") {
    return initOperationFailure({
      targetDir: options.dir,
      message: result.error.message,
    });
  }
  if (result.status === "conflict") {
    return initOperationFailure({
      targetDir: options.dir,
      message: result.reason,
    });
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    targetDir: options.dir,
    resolved: {
      preset: preset.definition.metadata.alias,
      topology:
        Object.keys(preset.definition.nodes).length === 1
          ? "configurable-primary-package"
          : "fixed",
      packages: initPackageIdentities(
        preset.definition.metadata.alias,
        result.generationRecord,
        result.blueprint,
      ),
      scope: defaultPackageScope,
    },
    blueprint: result.blueprint,
    generationRecord: result.generationRecord,
    toolchain: toolchainReport(),
    nextSteps: [
      { display: "pnpm install" },
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ],
    followUpDocument: {
      enabled: options.todo,
      ...(options.todo ? { path: "TODO.md" } : {}),
    },
  };
}

function initializationFailureFromPlanning(options: {
  readonly targetDir: string;
  readonly message: string;
  readonly packageIdentityIssues?: readonly BlueprintPackageIdentityIssue[];
  readonly inputOverrides: {
    readonly name?: string;
    readonly scope?: string;
  };
}): InitCommandResult {
  const identityIssues = options.packageIdentityIssues ?? [];
  const issues = identityIssues.map((issue) => {
    if (issue.kind === "duplicate") {
      return { code: "CONFLICTING_PACKAGE_IDENTITY" as const };
    }
    if (issue.field === "name") {
      return {
        code:
          options.inputOverrides.name !== undefined
            ? ("INVALID_PACKAGE_NAME" as const)
            : options.inputOverrides.scope !== undefined
              ? ("INVALID_PACKAGE_SCOPE" as const)
              : ("INVALID_REPOSITORY_SCOPE" as const),
      };
    }
    return {
      code:
        issue.kind === "reserved"
          ? ("RESERVED_PACKAGE_PATH" as const)
          : ("INVALID_PACKAGE_PATH" as const),
    };
  });
  if (issues.length > 0) {
    return {
      status: "usage-error",
      targetDir: options.targetDir,
      issues: issues.filter(
        (issue, index) =>
          issues.findIndex((candidate) => candidate.code === issue.code) ===
          index,
      ),
    };
  }
  return initOperationFailure(options);
}

function packageUpdateOperationFailure(
  diagnostic?: { readonly message: string; readonly suggestion: string },
  message?: string,
  fallbackMessage = "添加包时发生操作失败。",
): Extract<
  PackageAdditionCommandResult,
  { readonly status: "operation-failure" }
> {
  return {
    status: "operation-failure",
    error: diagnostic ?? {
      message:
        message === undefined
          ? fallbackMessage
          : safeGeneratorFailureMessage(message, fallbackMessage),
      suggestion:
        message === undefined
          ? "检查目标仓库与运行环境后重试；若问题持续发生，请人工处理。"
          : "检查目标项目的配置与目录内容后重试；若问题持续发生，请人工处理。",
    },
  };
}

export async function runAddPackage(
  options: AddPackageCommandOptions,
  runtime: ApplicationRuntime,
): Promise<PackageAdditionCommandResult> {
  const validation = validatePackageAdditionInput({
    preset: options.preset,
    packageLeafName: options.name,
    linkFrom: options.linkFrom,
    ...(options.path === undefined ? {} : { packagePath: options.path }),
  });
  if (validation.status === "input-invalid") {
    return { status: "usage-error", issues: validation.issues };
  }
  const planned = await cliGenerator.planAdd({
    repositoryRoot: runtime.cwd,
    preset: validation.preset.identity,
    creationInput: {
      leafName: options.name,
      ...(options.path === undefined ? {} : { packagePath: options.path }),
      ...(validation.linkFrom.length === 0
        ? {}
        : { linkFrom: validation.linkFrom }),
    },
  });
  if (planned.status === "operation-failure") {
    const rootToolchainIssue = planned.error.rootToolchainIssue;
    if (rootToolchainIssue !== undefined) {
      return packageUpdateOperationFailure({
        message: safeGeneratorFailureMessage(
          planned.error.message,
          "加包需要有效的根工具链声明。",
        ),
        suggestion:
          rootToolchainIssue.kind === "invalid-node-declaration"
            ? "请先修改根 package.json 的 engines.node 声明再加包。"
            : "请先修改根 package.json 的 packageManager 声明再加包。",
      });
    }
    const packageLinkIssue = planned.error.packageLinkIssue;
    if (packageLinkIssue !== undefined) {
      return {
        status: "usage-error",
        issues: [
          {
            code:
              packageLinkIssue.kind === "unknown-consumer"
                ? "UNKNOWN_LINK_FROM"
                : "UNSUPPORTED_LINK",
          },
        ],
      };
    }
    const identityIssues = planned.error.packageIdentityIssues ?? [];
    const identityConflicts = identityIssues
      .filter(
        (
          issue,
        ): issue is Extract<
          BlueprintPackageIdentityIssue,
          { readonly kind: "duplicate" }
        > => issue.kind === "duplicate",
      )
      .filter(
        (issue, index, issues) =>
          issues.findIndex((candidate) =>
            samePackageIdentityConflict(
              packageAdditionIdentityConflict(candidate),
              packageAdditionIdentityConflict(issue),
            ),
          ) === index,
      );
    if (identityConflicts.length > 0) {
      return {
        status: "conflict",
        dryRun: options.dryRun,
        actions: [],
        conflicts: identityConflicts.map(packageAdditionIdentityConflict),
      };
    }
    const usageIssues = identityIssues.map((issue) => ({
      code:
        issue.field === "name"
          ? ("INVALID_PACKAGE_NAME" as const)
          : issue.kind === "reserved"
            ? ("RESERVED_PACKAGE_PATH" as const)
            : ("INVALID_PACKAGE_PATH" as const),
    }));
    if (usageIssues.length > 0) {
      return {
        status: "usage-error",
        issues: usageIssues.filter(
          (issue, index) =>
            usageIssues.findIndex(
              (candidate) => candidate.code === issue.code,
            ) === index,
        ),
      };
    }
    return packageUpdateOperationFailure(undefined, planned.error.message);
  }
  if (planned.status === "conflict") {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: planned.conflicts.map(packageAdditionConflict),
    };
  }
  const result = options.dryRun
    ? { status: "success" as const, dryRun: true, actions: planned.actions }
    : await cliGenerator.commitPlan(planned.plan);
  if (result.status === "operation-failure") {
    return packageUpdateOperationFailure(undefined, result.error.message);
  }
  if (result.status === "conflict") {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: result.conflicts.map(packageAdditionConflict),
    };
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    actions: result.actions,
  };
}
