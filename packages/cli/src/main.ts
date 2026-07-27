import { Command, CommanderError } from "commander";

import {
  formatPresetCatalog,
  runAddPackage,
  runInit,
  validateBlueprintFile,
  type AddPackageCommandOptions,
  type ApplicationRuntime,
  type InitCommandOptions,
} from "./application.ts";

export type CliRuntime = ApplicationRuntime & {
  readonly argv: readonly string[];
  readonly streams: {
    readonly stdin: object;
    readonly stdout: { write(chunk: string): unknown };
    readonly stderr: { write(chunk: string): unknown };
  };
  readonly version: string;
};

class HandledCliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI exited with status ${exitCode}`);
    this.exitCode = exitCode;
  }
}

function writeResult(
  runtime: CliRuntime,
  result: {
    readonly exitCode: number;
    readonly stdout?: string;
    readonly stderr?: string;
  },
): void {
  if (result.stdout !== undefined) {
    runtime.streams.stdout.write(`${result.stdout}\n`);
  }
  if (result.stderr !== undefined) {
    runtime.streams.stderr.write(`${result.stderr}\n`);
  }
  if (result.exitCode !== 0) throw new HandledCliExit(result.exitCode);
}

export function createCliCommand(runtime: CliRuntime): Command {
  const command = new Command()
    .name("template")
    .description("Create repositories from maintained project presets.")
    .version(runtime.version)
    .configureOutput({
      writeOut: (text) => runtime.streams.stdout.write(text),
      writeErr: (text) => runtime.streams.stderr.write(text),
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
    .description("Initialize a repository.")
    .requiredOption("--preset <name>", "Project preset to generate")
    .option("--scope <name>", "Package scope for workspace package names")
    .option("-y, --yes", "Accept defaults for non-interactive generation")
    .option("--dry-run", "Print the planned generation without writing files")
    .option("--json", "Print machine-readable output")
    .option("--no-todo", "Do not write the generated follow-up TODO.md")
    .action(
      async (
        dir: string,
        options: {
          readonly preset: string;
          readonly scope?: string;
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
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        };
        runtime.streams.stdout.write(
          `${await runInit(initOptions, runtime)}\n`,
        );
      },
    );

  const addCommand = command
    .command("add")
    .description(
      "Add to a Generated Repository; package supports --dry-run and --json.",
    );
  addCommand
    .command("package")
    .description("Add a Package Boundary.")
    .requiredOption("--preset <name>", "Package preset to add")
    .requiredOption("--name <name>", "Package name to add")
    .option("--path <path>", "Two-segment Package Path to add")
    .option(
      "--link-from <path>",
      "Existing consumer Package Path to link from; repeatable",
      (value: string, previous: readonly string[]) => [...previous, value],
      [],
    )
    .option("--dry-run", "Preview the Addition Delta without writing files")
    .option("--json", "Print machine-readable output")
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
        writeResult(runtime, await runAddPackage(addOptions, runtime));
      },
    );

  command
    .command("presets")
    .description("List Built-in Presets.")
    .action(() => {
      runtime.streams.stdout.write(`${formatPresetCatalog()}\n`);
    });

  command
    .command("blueprint")
    .description("Work with Project Blueprints.")
    .command("validate <path>")
    .description("Validate a Project Blueprint.")
    .action(async (filePath: string) => {
      runtime.streams.stdout.write(
        `${await validateBlueprintFile(filePath, runtime)}\n`,
      );
    });

  return command;
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const command = createCliCommand(runtime);
    if (runtime.argv.length <= 2) {
      command.error("error: missing command", {
        exitCode: 1,
        code: "commander.missingCommand",
      });
    }
    await command.parseAsync([...runtime.argv], {
      from: "node",
    });
    return 0;
  } catch (error) {
    if (error instanceof HandledCliExit) return error.exitCode;
    if (error instanceof CommanderError) return error.exitCode;
    runtime.streams.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n\nRun \`template --help\` for usage.\n`,
    );
    return 1;
  }
}
