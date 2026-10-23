import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";
import {
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
  type ProjectProjectionSource,
} from "@ykdz/template-core/project-projection";
import type { GenerationRecord } from "@ykdz/template-generator";
import { isDefaultWorkspaceMissingLinkConflict } from "@ykdz/template-workspace/default-workspace-strategy";
import type { DefaultWorkspaceOwnerFacts } from "@ykdz/template-workspace/default-workspace-strategy";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import {
  validateInitializationInput,
  validatePackageAdditionInput,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
} from "./input-validation.ts";
import {
  cliGenerator,
  cliPresets,
  cliWorkspaceStrategy,
  presetByAlias,
} from "./preset-catalog.ts";

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
      readonly nextSteps: DefaultWorkspaceOwnerFacts["nextSteps"];
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
      readonly phase:
        | "preset"
        | "planning"
        | "preflight"
        | "materialization"
        | "render";
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

type PackageAdditionBusinessConflict = {
  readonly kind: "identity" | "missing-link";
  readonly existing: {
    readonly name: string;
    readonly path: string;
    readonly role: string;
  };
  readonly requested: {
    readonly name: string;
    readonly path: string;
    readonly role: string;
  };
  readonly missingLink?: {
    readonly consumerPackagePath: string;
    readonly providerPackagePath: string;
  };
};

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
      readonly conflicts: readonly (
        | PackageAdditionCoreConflict
        | PackageAdditionBusinessConflict
      )[];
    }
  | {
      readonly status: "usage-error";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly phase: "metadata" | "default" | "planning" | "reconciliation";
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
  readonly phase: "metadata" | "planning" | "render" | "reconciliation";
  readonly targetDir: string;
  readonly message?: string;
}): Extract<InitCommandResult, { readonly status: "operation-failure" }> {
  const phase = options.phase === "render" ? "render" : "planning";
  const phaseName = phase === "planning" ? "生成规划" : "目标目录渲染";
  const fallbackMessage = `${phaseName}失败。`;
  return {
    status: "operation-failure",
    phase,
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
  return Object.keys(preset.definition.nodes).map((nodeIdentity) => {
    const packageDefinitionId = generationRecord.nodeInstances[nodeIdentity];
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
  const result = await cliGenerator.init({
    targetRoot: targetDir,
    selection: {
      roots: [
        {
          preset: preset.identity,
          ...(creationInput === undefined ? {} : { creationInput }),
        },
      ],
    },
    strategyInput: { repositoryName, defaultPackageScope, todo: options.todo },
    dryRun: options.dryRun,
  });
  if (result.status === "operation-failure") {
    return initOperationFailure({
      phase: result.phase,
      targetDir: options.dir,
      message: result.error.message,
    });
  }
  if (result.status === "input-invalid") {
    return {
      status: "usage-error",
      targetDir: options.dir,
      issues: result.issues.map(({ code }) => ({
        code: code as InitializationInputIssue["code"],
      })),
    };
  }
  if (result.status === "conflict") {
    return initOperationFailure({ phase: "render", targetDir: options.dir });
  }

  const strategyState = cliWorkspaceStrategy.parseState(
    result.generationRecord.strategyState,
  );
  const ownerFacts = result.projection?.ownerFacts;
  if (ownerFacts === undefined) {
    throw new Error("默认工作区策略未返回初始化事实");
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
      scope: strategyState.defaultPackageScope,
    },
    blueprint: result.blueprint,
    generationRecord: result.generationRecord,
    toolchain: toolchainReport(),
    nextSteps: ownerFacts.nextSteps,
    followUpDocument: {
      enabled: strategyState.todo,
      ...(strategyState.todo ? { path: "TODO.md" } : {}),
    },
  };
}

function packageUpdateOperationFailure(
  phase: "metadata" | "planning" | "render" | "reconciliation",
  diagnostic?: { readonly message: string; readonly suggestion: string },
  message?: string,
  fallbackMessage = "添加 Package 时发生操作失败。",
): Extract<
  PackageAdditionCommandResult,
  { readonly status: "operation-failure" }
> {
  const mappedPhase = phase === "render" ? "reconciliation" : phase;
  return {
    status: "operation-failure",
    phase: mappedPhase,
    error: diagnostic ?? {
      message:
        message === undefined
          ? fallbackMessage
          : safeGeneratorFailureMessage(message, fallbackMessage),
      suggestion:
        message === undefined
          ? "检查生成仓库元数据与工作区状态后重试；若问题持续发生，请人工处理。"
          : "根据错误信息检查生成记录、包绑定或所属内容资源后重试；若问题持续发生，请人工处理。",
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
  const result = await cliGenerator.add({
    repositoryRoot: runtime.cwd,
    preset: validation.preset.identity,
    creationInput: {
      leafName: options.name,
      ...(options.path === undefined ? {} : { packagePath: options.path }),
      ...(validation.linkFrom.length === 0
        ? {}
        : { linkFrom: validation.linkFrom }),
    },
    dryRun: options.dryRun,
  });
  if (result.status === "operation-failure") {
    return packageUpdateOperationFailure(
      result.phase,
      result.error.diagnostic,
      result.error.message,
    );
  }
  if (result.status === "input-invalid") {
    return {
      status: "usage-error",
      issues: result.issues.map(({ code }) => ({
        code: code as PackageAdditionInputIssue["code"],
      })),
    };
  }
  if (result.status === "conflict") {
    const missingLinkConflict = isDefaultWorkspaceMissingLinkConflict(
      result.ownerConflict,
    )
      ? {
          kind: "missing-link" as const,
          ...result.ownerConflict.facts,
        }
      : undefined;
    if (
      result.ownerConflict !== undefined &&
      missingLinkConflict === undefined
    ) {
      return packageUpdateOperationFailure("planning");
    }
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: [
        ...(result.identityConflict === undefined
          ? []
          : [{ kind: "identity" as const, ...result.identityConflict }]),
        ...(missingLinkConflict === undefined ? [] : [missingLinkConflict]),
        ...result.conflicts.map(packageAdditionConflict),
      ],
    };
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    actions: result.actions,
  };
}
