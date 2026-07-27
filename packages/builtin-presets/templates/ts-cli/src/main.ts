import { Command, CommanderError } from "commander";

// @template-anchor cli-command-name
export type Greeting = {
  readonly message: string;
};

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly streams: {
    readonly stdin: object;
    readonly stdout: { write(chunk: string): unknown };
    readonly stderr: { write(chunk: string): unknown };
  };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
  readonly version: string;
};

export function greet(name: string): Greeting {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error("Name must not be empty");
  }
  return { message: `Hello, ${normalizedName}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCliCommand(runtime: CliRuntime): Command {
  const command = new Command()
    .name(commandName)
    .description("A TypeScript command-line tool.")
    .version(runtime.version)
    .configureOutput({
      writeOut: (text) => runtime.streams.stdout.write(text),
      writeErr: (text) => runtime.streams.stderr.write(text),
    })
    .showHelpAfterError()
    .exitOverride();
  const greetCommand = command
    .command("greet")
    .description("Greet a person.")
    .argument("<name>", "name to greet")
    .action((name: string) => {
      try {
        runtime.streams.stdout.write(`${greet(name).message}\n`);
      } catch (error) {
        greetCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.greet.invalid-name",
        });
      }
    });
  return command;
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    await createCliCommand(runtime).parseAsync([...runtime.argv], {
      from: "node",
    });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}
