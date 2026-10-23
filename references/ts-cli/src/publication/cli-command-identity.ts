export type CliCommandIdentity = {
  readonly commandName: string;
  readonly version: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (occupiedCommandNames.includes(commandName)) {
    throw new Error(
      `CLI command name is already used by another workspace package; received ${JSON.stringify(commandName)}`,
    );
  }
  return commandName;
}

/** 将 CLI 原生清单按目标命令名和工作区 Node 大版本投影。 */
export function projectCliPackageManifest(options: {
  readonly manifest: unknown;
  readonly commandName: string;
  readonly nodeDeclaration: string;
}): Readonly<Record<string, unknown>> {
  if (!isRecord(options.manifest)) {
    throw new Error("CLI package manifest must be an object");
  }
  const bin = options.manifest.bin;
  if (!isRecord(bin)) {
    throw new Error("CLI package manifest must declare exactly one bin");
  }
  const entries = Object.entries(bin);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    typeof entry[1] !== "string"
  ) {
    throw new Error("CLI package manifest must declare exactly one bin");
  }

  return {
    ...options.manifest,
    bin: {
      [validateCliCommandName(options.commandName)]: entry[1],
    },
    engines: { node: `>=${options.nodeDeclaration.split(".", 1)[0]}` },
  };
}

export function cliCommandIdentity(
  manifest: unknown,
  occupiedCommandNames: readonly string[] = [],
): CliCommandIdentity {
  if (!isRecord(manifest)) {
    throw new Error("CLI package manifest must be an object");
  }
  const manifestFacts = manifest;
  if (!isRecord(manifestFacts.bin)) {
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
