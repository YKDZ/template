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
} from "#template-builtin-presets";
import { validateProjectBlueprint } from "#template-core/project-blueprint";
import {
  reconcileAndApplyProjectProjections,
  materializeProjectProjection,
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
} from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";
import {
  resolveToolchainVersions,
  type ResolvedToolchainVersions,
  type ToolchainResolutionSource,
} from "#template-core/toolchain-resolution";

export type ConfirmationRequest = {
  readonly message: string;
  readonly prompt: string;
};

export type ApplicationRuntime = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
  readonly confirmation: {
    confirm(request: ConfirmationRequest): Promise<boolean>;
  };
};

export type InitCommandOptions = {
  readonly dir: string;
  readonly preset: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
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
  readonly json: boolean;
};

export type InitCommandResult =
  | {
      readonly schemaVersion: 1;
      readonly command: "init";
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
      readonly schemaVersion: 1;
      readonly command: "init";
      readonly status: "cancelled";
      readonly code: "CANCELLED";
      readonly targetDir: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "init";
      readonly status: "usage-error";
      readonly code: "USAGE_INIT_INVALID";
      readonly targetDir: string;
      readonly issues: readonly (
        | InitializationInputIssue
        | { readonly code: "NON_INTERACTIVE_CONFIRMATION_REQUIRED" }
      )[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "init";
      readonly status: "operation-failure";
      readonly code: "OPERATION_INIT_FAILED";
      readonly phase:
        | "toolchain"
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
  readonly schemaVersion: 1;
  readonly command: "presets";
  readonly status: "success";
  readonly presets: readonly PresetCatalogEntry[];
};

export type BlueprintValidationCommandResult =
  | {
      readonly schemaVersion: 1;
      readonly command: "blueprint validate";
      readonly status: "success";
      readonly path: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "blueprint validate";
      readonly status: "invalid";
      readonly code: "BLUEPRINT_INVALID";
      readonly path: string;
      readonly issues: readonly {
        readonly path: string;
        readonly message: string;
      }[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "blueprint validate";
      readonly status: "operation-failure";
      readonly code:
        | "OPERATION_BLUEPRINT_READ_FAILED"
        | "OPERATION_BLUEPRINT_PARSE_FAILED";
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
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "success";
      readonly dryRun: boolean;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly actions: readonly [];
      readonly conflicts: readonly (
        | PackageAdditionCoreConflict
        | PackageAdditionBusinessConflict
      )[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "usage-error";
      readonly code: "USAGE_ADD_PACKAGE_INVALID";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly schemaVersion: 1;
      readonly command: "add package";
      readonly status: "operation-failure";
      readonly code: "OPERATION_ADD_PACKAGE_FAILED";
      readonly phase: "metadata" | "default" | "planning" | "reconciliation";
      readonly error: { readonly message: string; readonly suggestion: string };
    };

export function listPresetCatalog(): PresetCatalogCommandResult {
  return {
    schemaVersion: 1,
    command: "presets",
    status: "success",
    presets: builtInPresetRegistry.all().map((definition) => ({
      name: definition.metadata.name,
      title: definition.metadata.title,
      description: definition.metadata.description,
    })),
  };
}

function toolchainSourceFromEnv(
  env: ApplicationRuntime["env"],
): ToolchainResolutionSource | undefined {
  const source = env.TEMPLATE_TOOLCHAIN_RESOLUTION;
  return source === "online" || source === "bundled-fallback"
    ? source
    : undefined;
}

async function resolveToolchain(
  env: ApplicationRuntime["env"],
): Promise<ResolvedToolchainVersions> {
  return await resolveToolchainVersions({
    source: toolchainSourceFromEnv(env),
    nodeReleaseIndexUrl: env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL,
    pnpmRegistryUrl: env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL,
  });
}

function toolchainReport(toolchain: ResolvedToolchainVersions) {
  return {
    nodeLtsMajor: toolchain.nodeLtsMajor.value,
    packageManagerPin: toolchain.packageManagerPin.value,
    source: toolchain.source,
    diagnostics: toolchain.diagnostics,
  };
}

function formatRows(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => `${label}:`.length));
  return rows.map(
    ([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`,
  );
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
      schemaVersion: 1,
      command: "blueprint validate",
      status: "operation-failure",
      code: "OPERATION_BLUEPRINT_PARSE_FAILED",
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
      schemaVersion: 1,
      command: "blueprint validate",
      status: "invalid",
      code: "BLUEPRINT_INVALID",
      path: resolvedPath,
      issues: result.issues,
    };
  }
  return {
    schemaVersion: 1,
    command: "blueprint validate",
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
    schemaVersion: 1,
    command: "blueprint validate",
    status: "operation-failure",
    code: "OPERATION_BLUEPRINT_READ_FAILED",
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
    options.phase === "toolchain"
      ? "工具链解析"
      : options.phase === "preset"
        ? "预设准备"
        : options.phase === "planning"
          ? "生成规划"
          : options.phase === "preflight"
            ? "生成预检"
            : options.phase === "materialization"
              ? "生成物料化"
              : "目标目录渲染";
  return {
    schemaVersion: 1,
    command: "init",
    status: "operation-failure",
    code: "OPERATION_INIT_FAILED",
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
  if (
    !options.dryRun &&
    !options.yes &&
    (options.json || !runtime.tty.stdin || !runtime.tty.stdout)
  ) {
    return {
      schemaVersion: 1,
      command: "init",
      status: "usage-error",
      code: "USAGE_INIT_INVALID",
      targetDir: options.dir,
      issues: [{ code: "NON_INTERACTIVE_CONFIRMATION_REQUIRED" }],
    };
  }
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
      schemaVersion: 1,
      command: "init",
      status: "usage-error",
      code: "USAGE_INIT_INVALID",
      targetDir: options.dir,
      issues: input.issues,
    };
  }
  let toolchain: ResolvedToolchainVersions;
  try {
    toolchain = await resolveToolchain(runtime.env);
  } catch {
    return initOperationFailure({ phase: "toolchain", targetDir: options.dir });
  }
  const preparation = prepareGeneratedRepositoryInitialization({
    preset: options.preset,
    targetDir,
    toolchain: {
      nodeLtsMajor: toolchain.nodeLtsMajor.value,
      packageManagerPin: toolchain.packageManagerPin.value,
    },
    ...(overrides === undefined ? {} : { overrides }),
  });
  if (preparation.status === "input-invalid") {
    return {
      schemaVersion: 1,
      command: "init",
      status: "usage-error",
      code: "USAGE_INIT_INVALID",
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
    schemaVersion: 1,
    command: "init",
    status: "success",
    dryRun: options.dryRun,
    targetDir: options.dir,
    resolved,
    blueprint: plan.blueprint,
    generationRecord: plan.generationRecord,
    toolchain: toolchainReport(toolchain),
    nextSteps: plan.nextStepInstructions,
    publicationSetup,
    followUpDocument: {
      enabled: options.todo,
      ...(options.todo ? { path: "TODO.md" } : {}),
    },
  };
  if (options.dryRun) return output;

  if (
    !options.yes &&
    !(await runtime.confirmation.confirm({
      message: [
        "计划生成的项目",
        "",
        ...formatRows([
          ["预设", resolved.preset],
          ["名称", resolved.packages.map(({ name }) => name).join(", ")],
          [
            "路径",
            resolved.packages
              .map(({ path: packagePath }) => packagePath)
              .join(", "),
          ],
          ["Scope", resolved.scope],
          ["目标", options.dir],
          ["包数量", String(plan.blueprint.packages.length)],
        ]),
      ].join("\n"),
      prompt: "生成这个项目？[y/N] ",
    }))
  ) {
    return {
      schemaVersion: 1,
      command: "init",
      status: "cancelled",
      code: "CANCELLED",
      targetDir: options.dir,
    };
  }

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
      schemaVersion: 1,
      command: "add package",
      status: "usage-error",
      code: "USAGE_ADD_PACKAGE_INVALID",
      issues: preparation.issues,
    };
  }
  if (preparation.status === "operation-failure") {
    return packageAdditionOperationFailure(preparation.phase);
  }
  if (preparation.status === "conflict") {
    return {
      schemaVersion: 1,
      command: "add package",
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
      schemaVersion: 1,
      command: "add package",
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: reconciliation.conflicts.map(packageAdditionConflict),
    };
  }
  return {
    schemaVersion: 1,
    command: "add package",
    status: "success",
    dryRun: options.dryRun,
    actions: reconciliation.actions,
  };
}

function packageAdditionOperationFailure(
  phase: "metadata" | "default" | "planning" | "reconciliation",
): PackageAdditionCommandResult {
  return {
    schemaVersion: 1,
    command: "add package",
    status: "operation-failure",
    code: "OPERATION_ADD_PACKAGE_FAILED",
    phase,
    error: {
      message: "添加 Package 时发生操作失败。",
      suggestion:
        "检查生成仓库元数据与工作区状态后重试；若问题持续发生，请人工处理。",
    },
  };
}
