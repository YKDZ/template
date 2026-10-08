import {
  CliWriteError,
  type WriteCliOutput,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  text,
  versionCapability,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import * as v from "valibot";

import {
  listPresetCatalog,
  runInit,
  runAddPackage,
  validateBlueprintFile,
  type ApplicationRuntime,
} from "./application.ts";
import {
  initializationInputSchema,
  packageAdditionInputSchema,
} from "./input-schemas.ts";
import {
  initializationSchema,
  packageAdditionSchema,
  packageConflictSchema,
} from "./result-schemas.ts";
import { standardSchema } from "./standard-schema.ts";

export type CliRuntime = ApplicationRuntime & {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly commandName: string;
  readonly version: string;
};

function initializationDetails(
  result: NonNullable<
    (typeof initializationSchema)["~standard"]["types"]
  >["output"],
): string[] {
  return [
    `预设: ${result.resolved.preset}`,
    `Scope: ${result.resolved.scope}`,
    ...result.resolved.packages.map(
      ({ name, path }) => `包: ${name}（${path}）`,
    ),
    `工具链: Node ${result.toolchain.nodeVersion}；${result.toolchain.packageManagerPin}`,
    `跟进文档: ${result.followUpDocument.enabled ? result.followUpDocument.path : "不生成"}`,
  ];
}

function createCliContract(runtime: CliRuntime) {
  const define = defineCli<
    ApplicationRuntime & { getManifest(): Record<string, unknown> }
  >();
  return define({
    root: "template",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "用法",
        commands: "命令",
        arguments: "参数",
        options: "选项",
      },
      wording: {
        commandPlaceholder: "命令",
        choices: "候选：{choices}",
        default: "默认：{value}",
      },
    }),
    version: versionCapability({
      value: text.line(`${runtime.commandName} ${runtime.version}`),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 2,
    commands: {
      template: {
        kind: "rootGroup",
        name: runtime.commandName,
        description: "生成和维护项目仓库。",
      },
      ...define.command("init")({
        kind: "command",
        parent: "template",
        name: "init",
        description: "初始化项目仓库。",
        input: initializationInputSchema(runtime.cwd),
        fields: {
          dir: { kind: "positional", description: "目标目录" },
          preset: {
            kind: "valueOption",
            longOption: "--preset",
            description: "项目预设",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description: "无 scope 的 npm 包叶名称；仅可配置主包的预设支持覆盖",
          },
          path: {
            kind: "valueOption",
            longOption: "--path",
            description:
              "两个安全路径段，不能使用保留目录；仅可配置主包的预设支持覆盖",
          },
          scope: {
            kind: "valueOption",
            longOption: "--scope",
            description: "有效 npm scope；省略时使用目标目录名",
          },
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "预览生成计划",
          },
          todo: {
            kind: "flag",
            longOption: "--todo",
            negatedLongOption: "--no-todo",
            description: "生成后续步骤文档",
          },
        },
        success: {
          kind: "data",
          variants: {
            initialized: {
              description: "已初始化仓库",
              schema: initializationSchema,
              exitCode: 0,
              text: (data) =>
                text.lines([
                  `已初始化项目: ${data.targetDir}`,
                  ...initializationDetails(data),
                  "下一步",
                  ...data.nextSteps.map(({ display }) => display),
                  ...(data.publicationSetup === null
                    ? []
                    : ["一次性 npm 发布设置", data.publicationSetup.command]),
                ]),
            },
            planned: {
              description: "初始化预览",
              schema: initializationSchema,
              exitCode: 0,
              text: (data) =>
                text.lines([
                  `项目生成预览: ${data.targetDir}`,
                  ...initializationDetails(data),
                ]),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "初始化操作失败",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                targetDir: v.string(),
                phase: v.picklist([
                  "preset",
                  "planning",
                  "preflight",
                  "materialization",
                  "render",
                ]),
                error: v.object({
                  message: v.string(),
                  suggestion: v.string(),
                }),
              }),
            ),
            text: ({ targetDir, error }) =>
              text.lines([
                error.message,
                `目录: ${targetDir}`,
                `建议: ${error.suggestion}`,
              ]),
          },
        },
        async handler({ input, dependencies, outcome }) {
          const result = await runInit(
            {
              dir: input.dir,
              preset: input.preset,
              dryRun: input.dryRun,
              todo: input.todo,
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.path === undefined ? {} : { path: input.path }),
              ...(input.scope === undefined ? {} : { scope: input.scope }),
            },
            dependencies,
          );
          if (result.status === "operation-failure")
            return outcome.failure.operationFailed({
              targetDir: result.targetDir,
              phase: result.phase,
              error: result.error,
            });
          if (result.status !== "success")
            throw new Error("初始化输入校验与契约不一致");
          const { status: _status, ...data } = result;
          const payload = {
            ...data,
            resolved: {
              ...data.resolved,
              packages: [...data.resolved.packages],
            },
            nextSteps: [...data.nextSteps],
            blueprint: {
              schemaVersion: data.blueprint.schemaVersion,
              packages: [...data.blueprint.packages],
              ...(data.blueprint.packageLinkIntents === undefined
                ? {}
                : {
                    packageLinkIntents: [...data.blueprint.packageLinkIntents],
                  }),
            },
            generationRecord: {
              ...data.generationRecord,
              packages: [...data.generationRecord.packages],
            },
          };
          return input.dryRun
            ? outcome.data.planned(payload)
            : outcome.data.initialized(payload);
        },
      }),
      add: {
        kind: "commandGroup",
        parent: "template",
        name: "add",
        description: "扩展生成仓库。",
      },
      ...define.command("addPackage")({
        kind: "command",
        parent: "add",
        name: "package",
        description: "非破坏性地新增工作区包。",
        input: packageAdditionInputSchema,
        fields: {
          preset: {
            kind: "valueOption",
            longOption: "--preset",
            description: "支持新增包的预设",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description: "无 scope 的 npm 包叶名称",
          },
          path: {
            kind: "valueOption",
            longOption: "--path",
            description: "两个安全路径段，不能使用保留工作区目录",
          },
          linkFrom: {
            kind: "repeatableOption",
            longOption: "--link-from",
            description:
              "消费包的两个安全路径段，不能使用保留工作区目录；可重复",
          },
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "预览变更",
          },
        },
        success: {
          kind: "data",
          variants: {
            planned: {
              description: "新增包预览",
              schema: packageAdditionSchema,
              exitCode: 0,
              text: ({ actions }) =>
                text.lines([
                  "新增包预览",
                  ...actions.map(
                    ({ path, action }) =>
                      `${action === "create" ? "创建" : "更新"}: ${path}`,
                  ),
                ]),
            },
            added: {
              description: "已新增包",
              schema: packageAdditionSchema,
              exitCode: 0,
              text: ({ actions }) =>
                text.lines([
                  "已新增包",
                  ...actions.map(
                    ({ path, action }) =>
                      `${action === "create" ? "创建" : "更新"}: ${path}`,
                  ),
                ]),
            },
            unchanged: {
              description: "请求已满足，无需变更",
              schema: packageAdditionSchema,
              exitCode: 0,
              text: () => text.line("请求已满足，无需变更。"),
            },
          },
        },
        failures: {
          invalidRequest: {
            description: "仓库不支持所请求的消费关系",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                issues: v.array(
                  v.object({
                    code: v.picklist(["UNKNOWN_LINK_FROM", "UNSUPPORTED_LINK"]),
                  }),
                ),
              }),
            ),
            text: ({ issues }) =>
              text.lines([
                "新增包请求无效。",
                ...issues.map(({ code }) =>
                  code === "UNKNOWN_LINK_FROM"
                    ? "指定的消费包不存在，请检查 --link-from。"
                    : "指定的包角色不支持此链接，请调整 --link-from。",
                ),
              ]),
          },
          operationFailed: {
            description: "新增包操作失败",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                phase: v.picklist([
                  "metadata",
                  "default",
                  "planning",
                  "reconciliation",
                ]),
                error: v.object({
                  message: v.string(),
                  suggestion: v.string(),
                }),
              }),
            ),
            text: ({ error }) =>
              text.lines([error.message, `建议: ${error.suggestion}`]),
          },
          conflict: {
            description: "新增包冲突，未写入变更",
            exitCode: 1,
            schema: packageConflictSchema,
            text: ({ conflicts }) =>
              text.lines([
                "新增包存在冲突，未写入变更。",
                ...conflicts.flatMap((conflict) =>
                  "kind" in conflict
                    ? [
                        `${conflict.requested.path}: 包身份或链接与当前仓库冲突。`,
                        `现有包: ${conflict.existing.name} (${conflict.existing.path})`,
                        `请求包: ${conflict.requested.name} (${conflict.requested.path})`,
                      ]
                    : [
                        `${conflict.path} (${conflict.driver})`,
                        ...(conflict.location === undefined
                          ? []
                          : [`位置: ${conflict.location || "<文档根>"}`]),
                        ...(conflict.region === undefined
                          ? []
                          : [
                              `区域: 生成前第 ${conflict.region.before.startLine} 行；当前第 ${conflict.region.current.startLine} 行；请求后第 ${conflict.region.after.startLine} 行`,
                            ]),
                        ...(conflict.attribute === undefined
                          ? []
                          : [`属性: ${conflict.attribute}`]),
                        `原因: ${conflict.reason}`,
                        `生成前: ${conflict.context.before}`,
                        `当前: ${conflict.context.current}`,
                        `请求后: ${conflict.context.after}`,
                      ].flatMap((line) =>
                        line.replaceAll("\0", "\\0").split(/\r\n|\r|\n/u),
                      ),
                ),
              ]),
          },
        },
        async handler({ input, dependencies, outcome }) {
          const result = await runAddPackage(
            {
              preset: input.preset,
              name: input.name,
              linkFrom: input.linkFrom,
              dryRun: input.dryRun,
              ...(input.path === undefined ? {} : { path: input.path }),
            },
            dependencies,
          );
          if (result.status === "operation-failure")
            return outcome.failure.operationFailed({
              phase: result.phase,
              error: result.error,
            });
          if (result.status === "conflict")
            return outcome.failure.conflict({
              dryRun: result.dryRun,
              actions: [],
              conflicts: [...result.conflicts],
            });
          if (result.status === "usage-error") {
            const issues = result.issues.map(({ code }) => {
              if (code !== "UNKNOWN_LINK_FROM" && code !== "UNSUPPORTED_LINK")
                throw new Error("新增包输入校验与契约不一致");
              return { code };
            });
            return outcome.failure.invalidRequest({ issues });
          }
          const data = { dryRun: result.dryRun, actions: [...result.actions] };
          return result.dryRun
            ? outcome.data.planned(data)
            : result.actions.length === 0
              ? outcome.data.unchanged(data)
              : outcome.data.added(data);
        },
      }),
      blueprint: {
        kind: "commandGroup",
        parent: "template",
        name: "blueprint",
        description: "处理项目蓝图。",
      },
      ...define.command("validateBlueprint")({
        kind: "command",
        parent: "blueprint",
        name: "validate",
        description: "只读校验项目蓝图。",
        fields: { path: { kind: "positional", description: "蓝图文件路径" } },
        input: standardSchema(
          v.object({ path: v.pipe(v.string(), v.nonEmpty()) }),
        ),
        success: {
          kind: "data",
          variants: {
            valid: {
              description: "蓝图有效",
              schema: standardSchema(v.object({ path: v.string() })),
              exitCode: 0,
              text: () => text.line("蓝图有效。"),
            },
          },
        },
        failures: {
          operationFailed: {
            description: "蓝图读取或解析失败",
            schema: standardSchema(
              v.object({
                path: v.string(),
                reason: v.picklist([
                  "not-found",
                  "permission-denied",
                  "not-a-file",
                  "unreadable",
                  "invalid-json",
                ]),
                error: v.object({
                  message: v.string(),
                  suggestion: v.string(),
                }),
              }),
            ),
            exitCode: 1,
            text: ({ path, error }) =>
              text.lines([
                error.message,
                `路径: ${path}`,
                `建议: ${error.suggestion}`,
              ]),
          },
          invalid: {
            description: "蓝图无效",
            schema: standardSchema(
              v.object({
                path: v.string(),
                issues: v.array(
                  v.object({ path: v.string(), message: v.string() }),
                ),
              }),
            ),
            exitCode: 1,
            text: ({ path, issues }) =>
              text.lines([
                "蓝图无效。",
                `路径: ${path}`,
                ...issues.map(
                  (issue) => `${issue.path}: 该位置的蓝图定义不符合要求。`,
                ),
                "建议: 修正蓝图后重新验证。",
              ]),
          },
        },
        async handler({ input, dependencies, outcome }) {
          const result = await validateBlueprintFile(input.path, dependencies);
          if (result.status === "invalid")
            return outcome.failure.invalid({
              path: result.path,
              issues: [...result.issues],
            });
          if (result.status === "operation-failure")
            return outcome.failure.operationFailed({
              path: result.path,
              reason: result.reason,
              error: result.error,
            });
          return outcome.data.valid({ path: result.path });
        },
      }),
      ...define.command("schema")({
        kind: "command",
        parent: "template",
        name: "schema",
        description: "导出完整 CLI 契约及输入/输出 Schema。",
        input: standardSchema(v.object({})),
        fields: {},
        success: {
          kind: "data",
          variants: {
            exported: {
              description: "完整 CLI 契约",
              exitCode: 0,
              schema: standardSchema(
                v.object({ manifest: v.record(v.string(), v.unknown()) }),
              ),
              text: ({ manifest }) =>
                text.lines([
                  "CLI 契约",
                  ...JSON.stringify(manifest, null, 2).split("\n"),
                ]),
            },
          },
        },
        failures: {},
        handler: ({ dependencies, outcome }) =>
          outcome.data.exported({ manifest: dependencies.getManifest() }),
      }),
      ...define.command("presets")({
        kind: "command",
        parent: "template",
        name: "presets",
        description: "列出内置预设。",
        fields: {},
        input: standardSchema(v.object({})),
        success: {
          kind: "data",
          variants: {
            listed: {
              description: "内置预设列表",
              schema: standardSchema(
                v.object({
                  presets: v.array(
                    v.object({
                      name: v.string(),
                      title: v.string(),
                      description: v.string(),
                    }),
                  ),
                }),
              ),
              exitCode: 0,
              text: ({ presets }) =>
                text.lines([
                  "内置预设",
                  ...presets.map(
                    (preset) =>
                      `  ${preset.name}: ${preset.title} - ${preset.description}`,
                  ),
                ]),
            },
          },
        },
        failures: {},
        handler: ({ outcome }) =>
          outcome.data.listed({ presets: [...listPresetCatalog().presets] }),
      }),
    },
  });
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: {
        ...runtime,
        getManifest: () => ({ ...contract.manifest }),
      },
      write: runtime.write,
    });
    return result.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    try {
      await runtime.write({
        destination: "stderr",
        chunk: "命令执行失败；请检查运行环境或报告此问题。\n",
      });
    } catch {
      // 诊断通道不可用时仍保留原始故障退出类别。
    }
    return 70;
  }
}
