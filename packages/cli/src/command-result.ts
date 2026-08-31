import {
  type BlueprintValidationCommandResult,
  type InitCommandResult,
  type PackageAdditionCommandResult,
  type PresetCatalogCommandResult,
} from "./application.ts";

export type TemplateCommandResult =
  | PresetCatalogCommandResult
  | BlueprintValidationCommandResult
  | InitCommandResult
  | PackageAdditionCommandResult;

export type CommandPresentation = {
  readonly destination: "stdout" | "stderr";
  readonly text: string;
  readonly exitCode: 0 | 1 | 2 | 64 | 65;
};

/** Pure projection; main owns identity prefixes and actual stream writes. */
export function projectCommandResult(
  result: TemplateCommandResult,
  json: boolean,
  cliVersion: string,
): CommandPresentation {
  const exitCode = exitCodeFor(result);
  if (json) {
    return {
      destination: "stdout",
      text: `${JSON.stringify({ ...result, cliVersion })}\n`,
      exitCode,
    };
  }
  return {
    destination: exitCode === 0 ? "stdout" : "stderr",
    text: `${formatHuman(result)}\n`,
    exitCode,
  };
}

function exitCodeFor(result: TemplateCommandResult): 0 | 1 | 2 | 64 | 65 {
  if (result.command === "presets") return 0;
  if (result.command === "blueprint validate") {
    return result.status === "success"
      ? 0
      : result.status === "invalid"
        ? 1
        : 65;
  }
  switch (result.status) {
    case "success":
      return 0;
    case "conflict":
      return 1;
    case "cancelled":
      return 2;
    case "usage-error":
      return 64;
    case "operation-failure":
      return 65;
  }
}

function formatHuman(result: TemplateCommandResult): string {
  if (result.command === "presets") return formatPresets(result);
  if (result.command === "blueprint validate") return formatBlueprint(result);
  if (result.command === "init") return formatInit(result);
  return formatAddition(result);
}

function formatInit(result: InitCommandResult): string {
  switch (result.status) {
    case "success":
      return [
        result.dryRun ? "项目生成预览" : "已初始化项目",
        "",
        ...rows([
          ["预设", result.resolved.preset],
          ["名称", result.resolved.packages.map(({ name }) => name).join(", ")],
          ["路径", result.resolved.packages.map(({ path }) => path).join(", ")],
          ["Scope", result.resolved.scope],
          ["目标", result.targetDir],
        ]),
        ...(result.dryRun
          ? []
          : [
              "",
              "下一步",
              "",
              ...result.nextSteps.map(
                (item, index) => `  ${index + 1}. ${item.display}`,
              ),
            ]),
        ...(result.publicationSetup === null
          ? []
          : [
              "",
              "一次性 npm 发布设置",
              "",
              `  ${result.publicationSetup.command}`,
            ]),
      ].join("\n");
    case "cancelled":
      return "已取消初始化；没有写入目标目录。";
    case "usage-error":
      return [
        `错误 [${result.code}]: 初始化参数无效。`,
        ...result.issues.map((issue) => `  ${initIssueMessage(issue.code)}`),
        "建议: 修正上述输入后重新运行初始化。",
      ].join("\n");
    case "operation-failure":
      return [
        `错误 [${result.code}]: ${result.error.message}`,
        `目标: ${result.targetDir}`,
        `建议: ${result.error.suggestion}`,
      ].join("\n");
  }
}

function rows(items: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...items.map(([label]) => `${label}:`.length));
  return items.map(
    ([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`,
  );
}
function initIssueMessage(
  code: InitCommandResult extends infer _
    ? Extract<
        InitCommandResult,
        { readonly status: "usage-error" }
      >["issues"][number]["code"]
    : never,
): string {
  switch (code) {
    case "PRESET_UNKNOWN":
      return "--preset 必须指定一个已支持的内置预设。";
    case "FIXED_TOPOLOGY_OVERRIDE":
      return "该预设使用固定初始包拓扑，不能同时使用 --name 或 --path。";
    case "INVALID_PACKAGE_NAME":
      return "--name 必须是有效的无 scope 包叶名称。";
    case "INVALID_PACKAGE_PATH":
      return "--path 必须恰好包含两个安全路径段。";
    case "RESERVED_PACKAGE_PATH":
      return "--path 不能使用保留的工作区集合。";
    case "INVALID_PACKAGE_SCOPE":
      return "--scope 必须是不含空白字符的有效 npm scope。";
    case "INVALID_REPOSITORY_SCOPE":
      return "目标目录名不能作为默认包 scope；请传入有效的 --scope。";
    case "CONFLICTING_PACKAGE_IDENTITY":
      return "初始包身份不能与 Foundation 的 TypeScript 配置包冲突。";
    case "NON_INTERACTIVE_CONFIRMATION_REQUIRED":
      return "非交互式初始化必须显式传入 --yes 接受默认值。";
  }
}

function formatPresets(result: PresetCatalogCommandResult): string {
  const width = Math.max(
    ...result.presets.map((preset) => `${preset.name}:`.length),
  );
  return [
    "内置预设",
    "",
    ...result.presets.map(
      (preset) =>
        `  ${`${preset.name}:`.padEnd(width)} ${preset.title} - ${preset.description}`,
    ),
  ].join("\n");
}

function formatBlueprint(result: BlueprintValidationCommandResult): string {
  switch (result.status) {
    case "success":
      return "蓝图有效。";
    case "invalid":
      return [
        `错误 [BLUEPRINT_INVALID]: 蓝图无效。`,
        "",
        ...result.issues.map(
          (issue) =>
            `  ${issue.path}: 该位置的 Blueprint 定义不符合要求；请检查必填字段、数据类型和拓扑约束。`,
        ),
        "",
        "建议: 修正上述 Blueprint 问题后重新验证。",
      ].join("\n");
    case "operation-failure":
      return [
        `错误 [${result.code}]: ${result.error.message}`,
        `路径: ${result.path}`,
        `建议: ${result.error.suggestion}`,
      ].join("\n");
  }
}

function formatAddition(result: PackageAdditionCommandResult): string {
  switch (result.status) {
    case "success":
      return [
        result.dryRun ? "Package Addition 预览" : "已添加 Package",
        "",
        ...(result.actions.length === 0
          ? ["没有变更。"]
          : result.actions.map(
              (action) =>
                `  ${action.action} ${action.path} (${action.driver})`,
            )),
      ].join("\n");
    case "conflict":
      return [
        "Package Addition 冲突",
        "",
        ...result.conflicts.flatMap((conflict) =>
          "kind" in conflict
            ? [
                `  ${conflict.kind === "missing-link" ? "Package Link" : "Package Identity"}`,
                `    已有: ${conflict.existing.name} (${conflict.existing.path}, ${conflict.existing.role})`,
                `    请求: ${conflict.requested.name} (${conflict.requested.path}, ${conflict.requested.role})`,
                ...(conflict.missingLink === undefined
                  ? []
                  : [
                      `    缺少链接: ${conflict.missingLink.consumerPackagePath} -> ${conflict.missingLink.providerPackagePath}`,
                    ]),
              ]
            : [
                `  ${conflict.path} (${conflict.driver})`,
                ...(conflict.location === undefined
                  ? []
                  : [`    位置: ${conflict.location || "<文档根>"}`]),
                ...(conflict.region === undefined
                  ? []
                  : [
                      `    区域: 生成前第 ${conflict.region.before.startLine} 行；当前第 ${conflict.region.current.startLine} 行；请求后第 ${conflict.region.after.startLine} 行`,
                    ]),
                ...(conflict.attribute === undefined
                  ? []
                  : [`    属性: ${conflict.attribute}`]),
                `    原因: ${conflict.reason}`,
                `    生成前: ${conflict.context.before}`,
                `    当前: ${conflict.context.current}`,
                `    请求后: ${conflict.context.after}`,
              ],
        ),
        "",
        "建议: 处理冲突后重试；命令没有写入工作区。",
      ].join("\n");
    case "usage-error":
      return [
        `错误 [${result.code}]: Package Addition 输入无效。`,
        ...result.issues.map(
          (issue) => `  ${additionIssueMessage(issue.code)}`,
        ),
        "建议: 修正上述输入后重新运行。",
      ].join("\n");
    case "operation-failure":
      return [
        `错误 [${result.code}]: ${result.error.message}`,
        `阶段: ${result.phase}`,
        `建议: ${result.error.suggestion}`,
      ].join("\n");
  }
}

function additionIssueMessage(
  code: Extract<
    PackageAdditionCommandResult,
    { readonly status: "usage-error" }
  >["issues"][number]["code"],
): string {
  switch (code) {
    case "PRESET_UNKNOWN":
      return "未找到该预设；使用 template presets 查看可用预设。";
    case "PRESET_NOT_ADDABLE":
      return "该预设不支持添加 Package；选择支持 Package Addition 的预设。";
    case "INVALID_PACKAGE_NAME":
      return "Package 名称必须是有效的小写 npm 叶名称。";
    case "INVALID_PACKAGE_PATH":
      return "Package 路径必须是两段小写路径，例如 packages/example。";
    case "RESERVED_PACKAGE_PATH":
      return "Package 路径不能使用保留工作区目录。";
    case "INVALID_LINK_FROM":
      return "--link-from 必须是两段现有 Package 路径。";
    case "RESERVED_LINK_FROM":
      return "--link-from 不能使用保留工作区目录。";
    case "UNKNOWN_LINK_FROM":
      return "--link-from 指向的 consumer Package 不存在；选择 Blueprint 中已有的 Package 路径。";
    case "UNSUPPORTED_LINK":
      return "该 consumer 与 provider 不支持 Package Link；选择兼容的 Package 角色与公开接口。";
  }
}
