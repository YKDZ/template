export type CliCommandIdentity = {
  readonly commandName: string;
  readonly version: string;
};

const reservedSystemToolNames = new Set([
  "bash",
  "bun",
  "cmd",
  "corepack",
  "deno",
  "git",
  "node",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "pwsh",
  "sh",
  "yarn",
  "zsh",
]);

export function validateCliCommandName(
  commandName: string,
  occupiedCommandNames: readonly string[] = [],
): string {
  if (/[/\\]/u.test(commandName)) {
    throw new Error(
      `CLI command name must not be a path; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{White_Space}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain whitespace; received ${JSON.stringify(commandName)}`,
    );
  }
  if (/\p{Control}/u.test(commandName)) {
    throw new Error(
      `CLI command name must not contain a control character; received ${JSON.stringify(commandName)}`,
    );
  }
  if (commandName.startsWith("-")) {
    throw new Error(
      `CLI command name must not have a leading hyphen; received ${JSON.stringify(commandName)}`,
    );
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(commandName)) {
    throw new Error(
      `CLI command name must use lowercase ASCII letters, digits, and single hyphens; received ${JSON.stringify(commandName)}`,
    );
  }
  if (reservedSystemToolNames.has(commandName)) {
    throw new Error(
      `CLI command name is a reserved system tool; received ${JSON.stringify(commandName)}`,
    );
  }
  if (occupiedCommandNames.includes(commandName)) {
    throw new Error(
      `CLI command name is already used by another workspace package; received ${JSON.stringify(commandName)}`,
    );
  }
  return commandName;
}

export function cliCommandIdentity(
  manifest: unknown,
  occupiedCommandNames: readonly string[] = [],
): CliCommandIdentity {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error("CLI package manifest must be an object");
  }
  const manifestFacts = manifest as Readonly<Record<string, unknown>>;
  if (
    typeof manifestFacts.bin !== "object" ||
    manifestFacts.bin === null ||
    Array.isArray(manifestFacts.bin)
  ) {
    throw new Error("CLI package manifest must declare exactly one bin");
  }
  const binEntries = Object.entries(manifestFacts.bin);
  if (binEntries.length !== 1) {
    throw new Error("CLI package manifest must declare exactly one bin");
  }
  const [commandName, executable] = binEntries[0]!;
  if (executable !== "./dist/cli.js") {
    throw new Error('CLI package manifest bin must execute "./dist/cli.js"');
  }

  let version = "unpublished";
  if (manifestFacts.version !== undefined) {
    if (
      typeof manifestFacts.version !== "string" ||
      manifestFacts.version.length === 0
    ) {
      throw new Error(
        "CLI package manifest version must be a non-empty string when present",
      );
    }
    version = manifestFacts.version;
  }

  return {
    commandName: validateCliCommandName(commandName, occupiedCommandNames),
    version,
  };
}
