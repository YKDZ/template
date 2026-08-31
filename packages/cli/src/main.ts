import { Command, CommanderError } from "commander";

import {
  listPresetCatalog,
  runAddPackage,
  runInit,
  validateBlueprintFile,
  type AddPackageCommandOptions,
  type ApplicationRuntime,
  type InitCommandOptions,
} from "./application.ts";
import {
  projectCommandResult,
  type TemplateCommandResult,
} from "./command-result.ts";

export type CliRuntime = ApplicationRuntime & {
  readonly argv: readonly string[];
  readonly streams: {
    readonly stdin: object;
    readonly stdout: { write(chunk: string): unknown };
    readonly stderr: { write(chunk: string): unknown };
  };
  readonly version: string;
};

type CliCommandName =
  | "template"
  | "init"
  | "add"
  | "add package"
  | "presets"
  | "blueprint"
  | "blueprint validate";

type CliFailure = {
  readonly code: string;
  readonly command: CliCommandName;
  readonly message: string;
  readonly suggestion?: string;
  readonly usage?: string;
};

class HandledCliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI exited with status ${exitCode}`);
    this.exitCode = exitCode;
  }
}

class OutputFailure extends Error {
  readonly destination: "stdout" | "stderr";
  readonly epiped: boolean;

  constructor(destination: "stdout" | "stderr", error: unknown) {
    super("Unable to write CLI output");
    this.destination = destination;
    this.epiped =
      typeof error === "object" && error !== null && "code" in error
        ? error.code === "EPIPE"
        : false;
  }
}

class ConfirmationFailure extends Error {
  constructor() {
    super("Confirmation adapter failed");
  }
}

function isConfirmationOutputResourceFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EPIPE" || error.code === "ENOSPC";
}

class HumanCommandIdentity {
  readonly #runtime: CliRuntime;
  #written = false;

  constructor(runtime: CliRuntime) {
    this.#runtime = runtime;
  }

  write(destination: "stdout" | "stderr"): void {
    if (this.#written) return;
    this.#written = true;
    this.#write(destination, `template ${this.#runtime.version}\n`);
  }

  writeText(destination: "stdout" | "stderr", text: string): void {
    this.write(destination);
    this.#write(destination, text);
  }

  #write(destination: "stdout" | "stderr", text: string): void {
    try {
      this.#runtime.streams[destination].write(text);
    } catch (error) {
      throw new OutputFailure(destination, error);
    }
  }
}

function commandName(argv: readonly string[]): CliCommandName {
  const [first, second] = argv.slice(2);
  if (first === "init" || first === "presets") return first;
  if (first === "add") return second === "package" ? "add package" : "add";
  if (first === "blueprint") {
    return second === "validate" ? "blueprint validate" : "blueprint";
  }
  return "template";
}

function hasJsonControlIntent(argv: readonly string[]): boolean {
  return argv.slice(2).includes("--json");
}

function localizeHelp(text: string): string {
  return text
    .replaceAll("Usage:", "用法:")
    .replaceAll("Options:", "选项:")
    .replaceAll("Commands:", "命令:")
    .replaceAll("output the version number", "输出版本号")
    .replaceAll("display help for command", "显示命令帮助")
    .replaceAll(
      "Resolve a Preset, initial package name and path, and package scope before initialization.",
      "初始化前解析预设、初始包名称、路径和包 scope。",
    )
    .replaceAll("Project preset to generate", "要生成的项目预设")
    .replaceAll(
      "Unscoped leaf name when the Preset supports Primary Package Identity overrides",
      "预设支持主包身份覆盖时使用的无 scope 叶名称",
    )
    .replaceAll(
      "Two-segment path when the Preset supports Primary Package Identity overrides",
      "预设支持主包身份覆盖时使用的两段路径",
    )
    .replaceAll("Resolved default package scope", "解析后的默认包 scope")
    .replaceAll(
      "Accept defaults for non-interactive generation",
      "接受非交互式生成的默认值",
    )
    .replaceAll(
      "Print the planned generation without writing files",
      "打印生成计划而不写文件",
    )
    .replaceAll("Print machine-readable output", "输出机器可读结果")
    .replaceAll(
      "Do not write the generated follow-up TODO.md",
      "不写入生成后的 TODO.md",
    )
    .replaceAll(
      "Add to a Generated Repository; package supports --dry-run and --json.",
      "向生成仓库添加内容；package 支持 --dry-run 和 --json。",
    )
    .replaceAll("Add a Package Boundary.", "添加一个 Package Boundary。")
    .replaceAll("Package preset to add", "要添加的 Package 预设")
    .replaceAll("Package name to add", "要添加的 Package 名称")
    .replaceAll("Two-segment Package Path to add", "要添加的两段 Package Path")
    .replaceAll(
      "Existing consumer Package Path to link from; repeatable",
      "要链接的现有 consumer Package Path；可重复传入",
    )
    .replaceAll(
      "Preview the Addition Delta without writing files",
      "预览 Addition Delta 而不写文件",
    )
    .replaceAll("List Built-in Presets.", "列出内置预设。")
    .replaceAll("Work with Project Blueprints.", "处理 Project Blueprint。")
    .replaceAll("Validate a Project Blueprint.", "校验 Project Blueprint。");
}

function commanderFailure(
  error: CommanderError,
  command: CliCommandName,
  capturedError: string,
): CliFailure {
  const usage = capturedError
    .split("\n")
    .find((line) => line.startsWith("Usage:"));
  const suggestion = error.message.match(/Did you mean (.+)\?/u)?.[1];
  const message =
    error.code === "commander.optionMissingArgument"
      ? error.message.replace(
          /option ('[^']+') argument missing/u,
          "选项 $1 缺少参数。",
        )
      : error.code === "commander.excessArguments"
        ? `命令 ${command} 参数过多。`
        : error.message;
  const localizedMessage = message
    .replace(/^error:\s*/u, "")
    .replace(/unknown command/u, "未知命令")
    .replace(/unknown option/u, "未知选项")
    .replace(/required option/u, "缺少必需选项")
    .replace(/missing required argument/u, "缺少必需参数")
    .replace(/ not specified$/u, "。");
  let code = "USAGE_INVALID_INVOCATION";
  if (error.code === "commander.unknownCommand") {
    code = "USAGE_UNKNOWN_COMMAND";
  } else if (error.code === "commander.unknownOption") {
    code = "USAGE_UNKNOWN_OPTION";
  } else if (error.code === "commander.optionMissingArgument") {
    code = "USAGE_OPTION_MISSING_ARGUMENT";
  } else if (error.code === "commander.excessArguments") {
    code = "USAGE_EXCESS_ARGUMENTS";
  } else if (error.message.includes("required option")) {
    code = "USAGE_MISSING_REQUIRED_OPTION";
  } else if (error.message.includes("required argument")) {
    code = "USAGE_MISSING_REQUIRED_ARGUMENT";
  }
  return {
    code,
    command,
    message: localizedMessage,
    ...(suggestion === undefined
      ? {}
      : { suggestion: `Did you mean ${suggestion}?` }),
    ...(usage === undefined
      ? {}
      : { usage: localizeHelp(usage).replace(/^用法:\s*/u, "") }),
  };
}

function applicationFailure(
  error: unknown,
  command: CliCommandName,
): CliFailure {
  return {
    code: "OPERATION_INTERNAL_ERROR",
    command,
    message: "命令遇到了内部错误；请重试，若持续发生请人工处理。",
  };
}

function exitCodeForOutputFailure(error: OutputFailure): number {
  return error.destination === "stdout" && error.epiped ? 0 : 65;
}

function writeFailure(
  runtime: CliRuntime,
  identity: HumanCommandIdentity,
  json: boolean,
  failure: CliFailure,
): void {
  if (json) {
    try {
      runtime.streams.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          cliVersion: runtime.version,
          command: failure.command,
          code: failure.code,
          status: "error",
          error: {
            message: failure.message,
            ...(failure.suggestion === undefined
              ? {}
              : { suggestion: failure.suggestion }),
            ...(failure.usage === undefined ? {} : { usage: failure.usage }),
          },
        })}\n`,
      );
      return;
    } catch (error) {
      throw new OutputFailure("stdout", error);
    }
  }
  const lines = [`错误 [${failure.code}]: ${failure.message}`];
  if (failure.suggestion !== undefined) {
    lines.push(`建议: ${failure.suggestion}`);
  }
  if (failure.usage !== undefined) {
    lines.push("", `用法: ${failure.usage}`);
  }
  identity.writeText("stderr", `${lines.join("\n")}\n`);
}

function writeOutput(
  runtime: CliRuntime,
  destination: "stdout" | "stderr",
  text: string,
): void {
  try {
    runtime.streams[destination].write(text);
  } catch (error) {
    if (error instanceof OutputFailure) throw error;
    throw new OutputFailure(destination, error);
  }
}

function writeClosedCommandResult(
  runtime: CliRuntime,
  result: TemplateCommandResult,
  json: boolean,
): void {
  const presentation = projectCommandResult(result, json, runtime.version);
  writeOutput(runtime, presentation.destination, presentation.text);
  if (presentation.exitCode !== 0)
    throw new HandledCliExit(presentation.exitCode);
}

function withHumanIdentity(
  runtime: CliRuntime,
  json: boolean,
): {
  readonly runtime: CliRuntime;
  readonly identity: HumanCommandIdentity;
} {
  const identity = new HumanCommandIdentity(runtime);
  if (json) return { runtime, identity };
  return {
    identity,
    runtime: {
      ...runtime,
      streams: {
        ...runtime.streams,
        stdout: {
          write(chunk) {
            identity.writeText("stdout", chunk);
          },
        },
        stderr: {
          write(chunk) {
            identity.writeText("stderr", chunk);
          },
        },
      },
      confirmation: {
        async confirm(request) {
          identity.write("stdout");
          try {
            return await runtime.confirmation.confirm(request);
          } catch (error) {
            if (isConfirmationOutputResourceFailure(error)) {
              throw new OutputFailure("stdout", error);
            }
            throw new ConfirmationFailure();
          }
        },
      },
    },
  };
}

export function createCliCommand(
  runtime: CliRuntime,
  commanderOutput?: { stdout: string; stderr: string },
): Command {
  const command = new Command()
    .name("template")
    .description("从维护的项目预设创建仓库。")
    .version(runtime.version)
    .configureOutput({
      writeOut: (text) => {
        if (commanderOutput === undefined) runtime.streams.stdout.write(text);
        else commanderOutput.stdout += text;
      },
      writeErr: (text) => {
        if (commanderOutput === undefined) runtime.streams.stderr.write(text);
        else commanderOutput.stderr += text;
      },
    })
    .configureHelp({
      subcommandTerm(subcommand) {
        switch (subcommand.name()) {
          case "init":
            return "template init <dir>";
          case "add":
            return "template add package";
          case "presets":
            return "template presets";
          case "blueprint":
            return "template blueprint validate <path>";
          default:
            return `template ${subcommand.name()}`;
        }
      },
    })
    .showHelpAfterError()
    .exitOverride();

  command
    .command("init <dir>")
    .description("初始化前解析预设、初始包名称、路径和包 scope。")
    .requiredOption("--preset <name>", "要生成的项目预设")
    .option("--name <name>", "预设支持主包身份覆盖时使用的无 scope 叶名称")
    .option("--path <path>", "预设支持主包身份覆盖时使用的两段路径")
    .option("--scope <name>", "解析后的默认包 scope")
    .option("-y, --yes", "接受非交互式生成的默认值")
    .option("--dry-run", "打印生成计划而不写文件")
    .option("--json", "输出机器可读结果")
    .option("--no-todo", "不写入生成后的 TODO.md")
    .action(
      async (
        dir: string,
        options: {
          readonly preset: string;
          readonly scope?: string;
          readonly name?: string;
          readonly path?: string;
          readonly yes?: boolean;
          readonly dryRun?: boolean;
          readonly json?: boolean;
          readonly todo: boolean;
        },
      ) => {
        const initOptions: InitCommandOptions = {
          dir,
          preset: options.preset,
          yes: Boolean(options.yes),
          dryRun: Boolean(options.dryRun),
          json: Boolean(options.json),
          todo: options.todo,
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.path === undefined ? {} : { path: options.path }),
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        };
        writeClosedCommandResult(
          runtime,
          await runInit(initOptions, runtime),
          initOptions.json,
        );
      },
    );

  const addCommand = command
    .command("add")
    .description("向生成仓库添加内容；package 支持 --dry-run 和 --json。");
  addCommand
    .command("package")
    .description("添加一个 Package Boundary。")
    .requiredOption("--preset <name>", "要添加的 Package 预设")
    .requiredOption("--name <name>", "要添加的 Package 名称")
    .option("--path <path>", "要添加的两段 Package Path")
    .option(
      "--link-from <path>",
      "要链接的现有 consumer Package Path；可重复传入",
      (value: string, previous: readonly string[]) => [...previous, value],
      [],
    )
    .option("--dry-run", "预览 Addition Delta 而不写文件")
    .option("--json", "输出机器可读结果")
    .action(
      async (options: {
        readonly preset: string;
        readonly name: string;
        readonly path?: string;
        readonly linkFrom: readonly string[];
        readonly dryRun?: boolean;
        readonly json?: boolean;
      }) => {
        const addOptions: AddPackageCommandOptions = {
          preset: options.preset,
          name: options.name,
          ...(options.path === undefined ? {} : { path: options.path }),
          linkFrom: options.linkFrom,
          dryRun: Boolean(options.dryRun),
          json: Boolean(options.json),
        };
        writeClosedCommandResult(
          runtime,
          await runAddPackage(addOptions, runtime),
          addOptions.json,
        );
      },
    );

  command
    .command("presets")
    .description("列出内置预设。")
    .option("--json", "输出机器可读结果")
    .action((options: { readonly json?: boolean }) => {
      writeClosedCommandResult(
        runtime,
        listPresetCatalog(),
        Boolean(options.json),
      );
    });

  command
    .command("blueprint")
    .description("处理 Project Blueprint。")
    .command("validate <path>")
    .description("校验 Project Blueprint。")
    .option("--json", "输出机器可读结果")
    .action(async (filePath: string, options: { readonly json?: boolean }) => {
      writeClosedCommandResult(
        runtime,
        await validateBlueprintFile(filePath, runtime),
        Boolean(options.json),
      );
    });

  return command;
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  let command: CliCommandName = "template";
  let json = false;
  let commandRuntime = runtime;
  let identity = new HumanCommandIdentity(runtime);
  const commanderOutput = { stdout: "", stderr: "" };
  try {
    command = commandName(runtime.argv);
    json = hasJsonControlIntent(runtime.argv);
    ({ runtime: commandRuntime, identity } = withHumanIdentity(runtime, json));
    const cli = createCliCommand(commandRuntime, commanderOutput);
    if (commandRuntime.argv.length <= 2) {
      cli.outputHelp();
      identity.writeText("stdout", localizeHelp(commanderOutput.stdout));
      return 0;
    }
    await cli.parseAsync([...commandRuntime.argv], { from: "node" });
    return 0;
  } catch (error) {
    if (error instanceof OutputFailure) return exitCodeForOutputFailure(error);
    if (error instanceof HandledCliExit) return error.exitCode;
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      try {
        identity.writeText(
          "stdout",
          error.code === "commander.version"
            ? ""
            : localizeHelp(commanderOutput.stdout),
        );
      } catch (writeError) {
        if (writeError instanceof OutputFailure) {
          return exitCodeForOutputFailure(writeError);
        }
        return 65;
      }
      return 0;
    }
    const failure =
      error instanceof CommanderError
        ? commanderFailure(error, command, commanderOutput.stderr)
        : applicationFailure(error, command);
    try {
      writeFailure(runtime, identity, json, failure);
    } catch (writeError) {
      if (writeError instanceof OutputFailure) {
        return exitCodeForOutputFailure(writeError);
      }
      return 65;
    }
    return failure.code.startsWith("USAGE_") ? 64 : 65;
  }
}
