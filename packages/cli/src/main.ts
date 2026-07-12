import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  templateSources,
} from "@ykdz/template-builtin-presets";
import {
  assertProjectBlueprintV2,
  validateProjectBlueprintV2,
  type ProjectBlueprintV2,
} from "@ykdz/template-core/project-blueprint-v2";
import {
  renderNewProject,
  renderProjectAtomically,
} from "@ykdz/template-core/renderer";
import {
  resolveToolchainVersions,
  type ResolvedToolchainVersions,
  type ToolchainResolutionSource,
} from "@ykdz/template-core/toolchain-resolution";

type InitOptions = {
  readonly dir: string;
  readonly preset: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly todo: boolean;
  readonly scope?: string;
};

type AddPackageOptions = {
  readonly preset: string;
  readonly name: string;
  readonly path?: string;
  readonly linkFrom: readonly string[];
};

function usage(): string {
  return [
    "template CLI",
    "",
    "Usage:",
    "  template <command> [options]",
    "",
    "Commands:",
    "  template init <dir> --preset <name> --yes",
    "  template add package --preset <name> --name <name> [--path <package-path>] [--link-from <package-path>]...",
    "  template presets",
    "  template blueprint validate <path>",
    "",
    "Init options:",
    "  --preset <name>  Project preset to generate",
    "  --scope <name>   Package scope for workspace package names",
    "  --yes            Accept defaults for non-interactive generation",
    "  --dry-run        Print the planned generation without writing files",
    "  --json           Print machine-readable output",
    "  --no-todo        Do not write the generated follow-up TODO.md document",
    "",
    "Add package options:",
    "  --preset <name>     Package preset to add",
    "  --name <name>       Package name to add",
    "  --path <path>       Two-segment Package Path to add",
    "  --link-from <path>  Existing consumer Package Path to link from; repeatable",
  ].join("\n");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function formatRows(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => `${label}:`.length));
  return rows.map(
    ([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`,
  );
}

function formatCatalog(): string {
  return [
    "Built-in presets",
    "",
    ...formatRows(
      builtInPresetRegistry
        .all()
        .map((definition) => [
          definition.metadata.name,
          `${definition.metadata.title} - ${definition.metadata.description}`,
        ]),
    ),
  ].join("\n");
}

function normalizeNpmScope(value: string): string {
  const scope = value.startsWith("@") ? value.slice(1) : value;
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error("--scope must be a valid npm scope without whitespace");
  }
  return scope;
}

function parseInitOptions(args: readonly string[]): InitOptions {
  const dir = args[1];
  if (!dir) throw new Error("init requires a target directory");
  let preset = "";
  let yes = false;
  let dryRun = false;
  let json = false;
  let todo = true;
  let scope: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-todo") todo = false;
    else if (arg === "--preset" || arg === "--scope") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--preset") preset = value;
      else scope = normalizeNpmScope(value);
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { dir, preset, yes, dryRun, json, todo, ...(scope ? { scope } : {}) };
}

function parseAddPackageOptions(args: readonly string[]): AddPackageOptions {
  let preset = "";
  let name = "";
  let packagePath: string | undefined;
  const linkFrom: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!["--preset", "--name", "--path", "--link-from"].includes(arg ?? "")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--preset") preset = value;
    if (arg === "--name") name = value;
    if (arg === "--path") packagePath = value;
    if (arg === "--link-from") linkFrom.push(value);
    index += 1;
  }
  if (!preset) throw new Error("add package requires --preset");
  if (!name) throw new Error("add package requires --name");
  return {
    preset,
    name,
    ...(packagePath ? { path: packagePath } : {}),
    linkFrom,
  };
}

function toolchainSourceFromEnv(): ToolchainResolutionSource | undefined {
  const source = process.env.TEMPLATE_TOOLCHAIN_RESOLUTION;
  return source === "online" || source === "bundled-fallback"
    ? source
    : undefined;
}

async function resolveToolchain(): Promise<ResolvedToolchainVersions> {
  return await resolveToolchainVersions({
    source: toolchainSourceFromEnv(),
    nodeReleaseIndexUrl: process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL,
    pnpmRegistryUrl: process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL,
  });
}

async function planInitialization(options: InitOptions) {
  const definition = builtInPresetRegistry.require(options.preset);
  const toolchain = await resolveToolchain();
  const context = createGenerationContext({
    targetDir: options.dir,
    ...(options.scope ? { scope: options.scope } : {}),
    toolchain: {
      nodeLtsMajor: toolchain.nodeLtsMajor.value,
      packageManagerPin: toolchain.packageManagerPin.value,
    },
  });
  return {
    definition,
    context,
    toolchain,
    plan: planGeneratedRepositoryInitialization({ definition, context }),
  };
}

function toolchainReport(toolchain: ResolvedToolchainVersions) {
  return {
    nodeLtsMajor: toolchain.nodeLtsMajor.value,
    packageManagerPin: toolchain.packageManagerPin.value,
    source: toolchain.source,
    diagnostics: toolchain.diagnostics,
  };
}

function initOutput(
  options: InitOptions,
  result: Awaited<ReturnType<typeof planInitialization>>,
) {
  return {
    command: "init",
    dryRun: options.dryRun,
    targetDir: options.dir,
    blueprint: result.plan.blueprint,
    generationRecord: result.plan.generationRecord,
    toolchain: toolchainReport(result.toolchain),
    nextSteps: result.plan.nextStepInstructions,
    followUpDocument: {
      enabled: options.todo,
      path: options.todo ? "TODO.md" : undefined,
    },
  };
}

function followUpDocumentOperation(
  result: Awaited<ReturnType<typeof planInitialization>>,
) {
  return {
    kind: "writeTextTemplate" as const,
    source: templateSources.foundation,
    from: "TODO.md.template",
    to: "TODO.md",
    replacements: {
      NEXT_STEPS: result.plan.nextStepInstructions
        .map((instruction, index) => `${index + 1}. \`${instruction.display}\``)
        .join("\n"),
    },
  };
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

async function confirmInit(
  options: InitOptions,
  blueprint: ProjectBlueprintV2,
): Promise<boolean> {
  console.log(
    [
      "Planned project",
      "",
      ...formatRows([
        ["Target", options.dir],
        ["Packages", String(blueprint.packages.length)],
      ]),
    ].join("\n"),
  );
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question("Generate this project? [y/N] ");
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

async function readBlueprint(filePath: string): Promise<ProjectBlueprintV2> {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
  ) {
    throw new Error(
      "Unsupported Local Template Metadata: Blueprint version 1 is not supported",
    );
  }
  return assertProjectBlueprintV2(value);
}

/**
 * Package Addition has no Preset provenance to consult.  The current
 * Blueprint topology and the real package manifests are the durable facts;
 * their shared npm scope is the context for a newly planned package.
 */
async function deriveExistingPackageScope(options: {
  readonly targetDir: string;
  readonly blueprint: ProjectBlueprintV2;
}): Promise<string> {
  const scopes = new Set<string>();
  for (const definition of options.blueprint.packages) {
    const match = definition.name.match(/^@([^/]+)\//);
    if (!match?.[1]) {
      throw new Error(
        `Package Addition requires a scoped Package Definition: ${definition.name}`,
      );
    }
    const manifestPath = path.join(
      options.targetDir,
      definition.path,
      "package.json",
    );
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      (manifest as { name?: unknown }).name !== definition.name
    ) {
      throw new Error(
        `Package Addition requires manifest truth for ${definition.path}: expected name ${definition.name}`,
      );
    }
    scopes.add(match[1]);
  }
  if (scopes.size !== 1) {
    throw new Error(
      `Package Addition requires exactly one existing npm scope; found ${[...scopes].join(", ") || "none"}`,
    );
  }
  return [...scopes][0]!;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "presets") {
    console.log(formatCatalog());
    return;
  }
  if (command === "blueprint" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) throw new Error("blueprint validate requires a path");
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      value.schemaVersion === 1
    ) {
      throw new Error(
        "Unsupported Local Template Metadata: Blueprint version 1 is not supported",
      );
    }
    const result = validateProjectBlueprintV2(value);
    if (!result.ok)
      throw new Error(
        result.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n"),
      );
    console.log("Blueprint is valid");
    return;
  }
  if (command === "init") {
    const options = parseInitOptions(args);
    const result = await planInitialization(options);
    if (options.dryRun) {
      if (options.json) printJson(initOutput(options, result));
      else console.log(JSON.stringify(initOutput(options, result), null, 2));
      return;
    }
    if (!options.yes && (options.json || !isInteractiveTerminal())) {
      throw new Error("Non-interactive init requires --yes");
    }
    if (!options.yes && !(await confirmInit(options, result.plan.blueprint)))
      throw new Error("Init cancelled");
    await renderNewProject({
      targetRoot: options.dir,
      operations: [
        ...result.plan.operations,
        ...(options.todo ? [followUpDocumentOperation(result)] : []),
      ],
    });
    if (options.json) printJson(initOutput(options, result));
    else
      console.log(
        [
          "Initialized project",
          "",
          ...formatRows([
            ["Preset", result.definition.metadata.name],
            ["Target", options.dir],
          ]),
          "",
          "Next steps",
          "",
          ...result.plan.nextStepInstructions.map(
            (instruction, index) => `  ${index + 1}. ${instruction.display}`,
          ),
        ].join("\n"),
      );
    return;
  }
  if (command === "add" && args[1] === "package") {
    const options = parseAddPackageOptions(args);
    const blueprint = await readBlueprint(
      path.join(process.cwd(), ".template/blueprint.json"),
    );
    const toolchain = await resolveToolchain();
    const definition = builtInPresetRegistry.require(options.preset);
    const context = createGenerationContext({
      targetDir: process.cwd(),
      scope: await deriveExistingPackageScope({
        targetDir: process.cwd(),
        blueprint,
      }),
      toolchain: {
        nodeLtsMajor: toolchain.nodeLtsMajor.value,
        packageManagerPin: toolchain.packageManagerPin.value,
      },
    });
    const plan = planGeneratedRepositoryPackageAddition({
      definition,
      context,
      blueprint,
      packageLeafName: options.name,
      ...(options.path ? { packagePath: options.path } : {}),
      ...(options.linkFrom.length > 0 ? { linkFrom: options.linkFrom } : {}),
    });
    await renderProjectAtomically({
      targetRoot: process.cwd(),
      operations: [...plan.operations],
    });
    console.log(
      [
        "Added package",
        "",
        ...formatRows([
          ["Preset", definition.metadata.name],
          ["Name", options.name],
        ]),
      ].join("\n"),
    );
    return;
  }
  throw new Error(command ? `Unknown command: ${command}` : "Missing command");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("\nRun `template --help` for usage.");
  process.exitCode = 1;
});
