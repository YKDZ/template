import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetRegistry,
  prepareGeneratedRepositoryPackageAddition,
  validateGeneratedRepositoryInitializationInput,
  prepareGeneratedRepositoryInitialization,
  templateSources,
  type GeneratedRepositoryPlan,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
  type NextStepInstruction,
  type ProjectBlueprint,
  type PublicationSetupHandoff,
  type ResolvedInitialization,
} from "@ykdz/template-builtin-presets";
import { validateProjectBlueprint } from "@ykdz/template-core/project-blueprint";
import {
  reconcileAndApplyProjectProjections,
  materializeProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

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

export type InitCommandResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly targetDir: string;
      readonly resolved: ResolvedInitialization;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GeneratedRepositoryPlan["generationRecord"];
      readonly toolchain: ReturnType<typeof toolchainReport>;
      readonly nextSteps: readonly NextStepInstruction[];
      readonly publicationSetup: PublicationSetupHandoff;
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
  "before" | "current" | "after"
> & {
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
    presets: builtInPresetRegistry.all().map((definition) => ({
      name: definition.metadata.name,
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
  const { before, current, after, ...details } = conflict;
  return {
    ...details,
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
  readonly phase: Extract<
    InitCommandResult,
    { readonly status: "operation-failure" }
  >["phase"];
  readonly targetDir: string;
}): Extract<InitCommandResult, { readonly status: "operation-failure" }> {
  const phase =
    options.phase === "preset"
      ? "预设准备"
      : options.phase === "planning"
        ? "生成规划"
        : options.phase === "preflight"
          ? "生成预检"
          : options.phase === "materialization"
            ? "生成物料化"
            : "目标目录渲染";
  return {
    status: "operation-failure",

    phase: options.phase,
    targetDir: options.targetDir,
    error: {
      message: `${phase}失败。`,
      suggestion: "检查目标目录与运行环境后重试；若问题持续发生，请人工处理。",
    },
  };
}

export async function runInit(
  options: InitCommandOptions,
  runtime: ApplicationRuntime,
): Promise<InitCommandResult> {
  const targetDir = path.resolve(runtime.cwd, options.dir);
  const overrides =
    (options.name ?? options.path ?? options.scope) === undefined
      ? undefined
      : {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.path === undefined ? {} : { path: options.path }),
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        };
  const input = validateGeneratedRepositoryInitializationInput({
    preset: options.preset,
    targetDir,
    ...(overrides === undefined ? {} : { overrides }),
  });
  if (input.status === "input-invalid") {
    return {
      status: "usage-error",

      targetDir: options.dir,
      issues: input.issues,
    };
  }
  const preparation = prepareGeneratedRepositoryInitialization({
    preset: options.preset,
    targetDir,
    ...(overrides === undefined ? {} : { overrides }),
  });
  if (preparation.status === "input-invalid") {
    return {
      status: "usage-error",

      targetDir: options.dir,
      issues: preparation.issues,
    };
  }
  if (preparation.status === "operation-failure") {
    return initOperationFailure({
      phase: preparation.phase,
      targetDir: options.dir,
    });
  }
  const { plan, resolved, publicationSetup } = preparation;
  const operations = [
    ...plan.operations,
    ...(options.todo
      ? [
          {
            kind: "writeTextTemplate" as const,
            source: templateSources.foundation,
            from: "TODO.md.template",
            to: "TODO.md",
            replacements: {
              NEXT_STEPS: plan.nextStepInstructions
                .map(
                  (instruction, index) =>
                    `${index + 1}. \`${instruction.display}\``,
                )
                .join("\n"),
            },
          },
        ]
      : []),
  ];
  try {
    await materializeProjectProjection({
      operations,
      reconciliation: plan.reconciliation,
    });
  } catch {
    return initOperationFailure({
      phase: "materialization",
      targetDir: options.dir,
    });
  }
  const output: Extract<InitCommandResult, { readonly status: "success" }> = {
    status: "success",
    dryRun: options.dryRun,
    targetDir: options.dir,
    resolved,
    blueprint: plan.blueprint,
    generationRecord: plan.generationRecord,
    toolchain: toolchainReport(),
    nextSteps: plan.nextStepInstructions,
    publicationSetup,
    followUpDocument: {
      enabled: options.todo,
      ...(options.todo ? { path: "TODO.md" } : {}),
    },
  };
  if (options.dryRun) return output;

  try {
    await renderNewProject({
      targetRoot: path.resolve(runtime.cwd, options.dir),
      operations,
    });
  } catch {
    return initOperationFailure({ phase: "render", targetDir: options.dir });
  }
  return output;
}

export async function runAddPackage(
  options: AddPackageCommandOptions,
  runtime: ApplicationRuntime,
): Promise<PackageAdditionCommandResult> {
  const preparation = prepareGeneratedRepositoryPackageAddition({
    repositoryRoot: runtime.cwd,
    preset: options.preset,
    packageLeafName: options.name,
    ...(options.path === undefined ? {} : { packagePath: options.path }),
    ...(options.linkFrom.length === 0 ? {} : { linkFrom: options.linkFrom }),
  });
  if (preparation.status === "input-invalid") {
    return {
      status: "usage-error",

      issues: preparation.issues,
    };
  }
  if (preparation.status === "operation-failure") {
    return packageAdditionOperationFailure(
      preparation.phase,
      preparation.diagnostic,
    );
  }
  if (preparation.status === "conflict") {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: [
        {
          kind: preparation.conflict.kind,
          existing: {
            name: preparation.conflict.existing.name,
            path: preparation.conflict.existing.path,
            role: preparation.conflict.existing.role,
          },
          requested: {
            name: preparation.conflict.requested.name,
            path: preparation.conflict.requested.path,
            role: preparation.conflict.requested.role,
          },
          ...(preparation.conflict.missingLink === undefined
            ? {}
            : { missingLink: preparation.conflict.missingLink }),
        },
      ],
    };
  }
  let reconciliation: Awaited<
    ReturnType<typeof reconcileAndApplyProjectProjections>
  >;
  try {
    reconciliation = await reconcileAndApplyProjectProjections({
      targetRoot: runtime.cwd,
      ...preparation.plan.projectProjections,
      dryRun: options.dryRun,
    });
  } catch {
    return packageAdditionOperationFailure("reconciliation");
  }
  if (!reconciliation.ok) {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: reconciliation.conflicts.map(packageAdditionConflict),
    };
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    actions: reconciliation.actions,
  };
}

function packageAdditionOperationFailure(
  phase: "metadata" | "default" | "planning" | "reconciliation",
  diagnostic?: { readonly message: string; readonly suggestion: string },
): PackageAdditionCommandResult {
  return {
    status: "operation-failure",

    phase,
    error: diagnostic ?? {
      message: "添加 Package 时发生操作失败。",
      suggestion:
        "检查生成仓库元数据与工作区状态后重试；若问题持续发生，请人工处理。",
    },
  };
}
