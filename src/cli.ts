#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { initHonoApiProject } from "./hono-api.js";
import { initRustBinProject } from "./rust-bin.js";
import { initTsLibProject } from "./ts-lib.js";
import { initVueHonoAppProject } from "./vue-hono-app.js";
import { initVueAppProject } from "./vue-app.js";
import { addPackage } from "./package-addition.js";
import {
  planPostCommands,
  runPostCommands,
  type PostCommand,
  type PostCommandExecution,
  type PostCommandPlan
} from "./post-commands.js";
import {
  blueprintJsonSchema,
  builtInPresets,
  presetFileJsonSchema,
  validatePresetFile,
  validateProjectBlueprint,
  type BuiltInPreset,
  type ProjectBlueprint,
  type PresetName,
  type ValidationIssue
} from "./declarations.js";

type InitOptions = {
  dir: string;
  preset: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  ready: boolean;
  scope?: string;
};

type AddPackageOptions = {
  preset: string;
  name: string;
};

function usage(): string {
  return [
    "Usage:",
    "  template init <dir> --preset <name> --yes",
    "  template add package --preset <name> --name <name>",
    "  template presets",
    "  template schema preset",
    "  template schema blueprint",
    "  template preset validate <path>",
    "  template blueprint validate <path>",
    "",
    "Options:",
    "  --preset <name>  Project preset to generate",
    "  --name <name>    Package name to add",
    "  --scope <name>   Package scope for workspace package names",
    "  --yes            Accept defaults for non-interactive generation",
    "  --ready          Run template-maintained Post Commands after writing files",
    "  --dry-run        Print the planned generation without writing files",
    "  --json           Print machine-readable output"
  ].join("\n");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readJsonDeclaration(filePath: string): Promise<unknown> {
  if (path.extname(filePath) !== ".json") {
    throw new Error(`Declaration files must be JSON: ${filePath}`);
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
}

function formatPresetCatalog(): string {
  return [
    "Built-in presets",
    ...builtInPresets.map(
      (preset) =>
        `  ${preset.name.padEnd(8)} ${preset.title} (${preset.generation}) - ${preset.description}`
    )
  ].join("\n");
}

function parseInitOptions(args: string[]): InitOptions {
  const dir = args[1];
  let preset = "";
  let yes = false;
  let dryRun = false;
  let json = false;
  let ready = false;
  let scope: string | undefined;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--ready") {
      ready = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--scope") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--scope requires a value");
      }
      scope = normalizeNpmScope(value);
      index += 1;
      continue;
    }

    if (arg === "--preset") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--preset requires a value");
      }
      preset = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!dir) {
    throw new Error("init requires a target directory");
  }

  return { dir, preset, yes, dryRun, json, ready, scope };
}

function normalizeNpmScope(value: string): string {
  if (value !== value.trim() || /\s/.test(value)) {
    throw new Error("--scope must be a valid npm scope without whitespace");
  }

  const scope = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error("--scope must be a valid npm scope");
  }

  return scope;
}

function supportedPreset(name: string): BuiltInPreset {
  const preset = builtInPresets.find(
    (candidate) => candidate.name === name && candidate.generation === "supported"
  );

  if (!preset) {
    throw new Error(
      "Only the ts-lib, hono-api, vue-app, vue-hono-app, and rust-bin presets are supported in this version"
    );
  }

  return preset;
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function scopeFromOptions(projectName: string, scope?: string): string {
  return scope ?? projectName;
}

function blueprintForInit(options: InitOptions): ProjectBlueprint {
  const preset = supportedPreset(options.preset);
  const projectName = projectNameFromDir(options.dir);
  const packageScope = scopeFromOptions(projectName, options.scope);
  const blueprint: ProjectBlueprint = {
    schemaVersion: 1,
    preset: preset.name,
    projectKind: preset.supportedProjectKinds[0],
    features: [...preset.features]
  };

  if (preset.supportedPackageManagers[0]) {
    blueprint.packageManager = preset.supportedPackageManagers[0];
  }

  if (preset.name === "vue-hono-app") {
    blueprint.packages = [
      { name: `@${packageScope}/web`, path: "apps/web" },
      { name: `@${packageScope}/api`, path: "apps/api" }
    ];
  }

  return blueprint;
}

function formatBlueprintSummary(targetDir: string, blueprint: ProjectBlueprint): string {
  const lines = [
    "Project Blueprint",
    `  Target: ${targetDir}`,
    `  Preset: ${blueprint.preset}`,
    `  Project kind: ${blueprint.projectKind}`
  ];

  if (blueprint.packageManager) {
    lines.push(`  Package manager: ${blueprint.packageManager}`);
  }

  if (blueprint.packages) {
    lines.push("  Packages:");
    for (const pkg of blueprint.packages) {
      lines.push(`    - ${pkg.name} (${pkg.path})`);
    }
  }

  lines.push(`  Features: ${blueprint.features.join(", ")}`);
  return lines.join("\n");
}

function formatPostCommand(command: PostCommand): string {
  return [command.command, ...command.args].join(" ");
}

function formatPostCommandPlan(commands: readonly PostCommand[]): string {
  if (commands.length === 0) {
    return ["Post Commands:", "  (none)"].join("\n");
  }

  return [
    "Post Commands:",
    ...commands.map((command) => `  ${command.label}: ${formatPostCommand(command)}`)
  ].join("\n");
}

type InitJsonOutput = {
  command: "init";
  dryRun: boolean;
  ready: boolean;
  targetDir: string;
  blueprint: ProjectBlueprint;
  postCommands: PostCommandReport;
  nextSteps?: string[];
};

type PostCommandReport = {
  planned: Array<{
    id: string;
    label: string;
    command: string;
    args: string[];
    cwd: string;
  }>;
  run: Array<{ id: string; exitCode: number }>;
  failed: Array<{ id: string; exitCode: number | null; error: string }>;
  skipped: Array<{ id: string; reason: string }>;
};

function nextStepsForPreset(preset: PresetName): string[] {
  if (preset === "rust-bin") {
    return ["cd <target>", "./scripts/check"];
  }

  return ["cd <target>", "pnpm install", "pnpm run check"];
}

function formatNextSteps(targetDir: string, preset: PresetName): string {
  return [
    "Next steps:",
    ...nextStepsForPreset(preset).map((step) => `  ${step.replace("<target>", targetDir)}`)
  ].join("\n");
}

function postCommandReport(
  planned: readonly PostCommand[],
  executions: PostCommandExecution[],
  skipped: Array<{ id: string; reason: string }>
): PostCommandReport {
  return {
    planned: planned.map((command) => ({
      id: command.id,
      label: command.label,
      command: command.command,
      args: [...command.args],
      cwd: command.cwd
    })),
    run: executions
      .filter((execution) => execution.status === "run")
      .map((execution) => ({
        id: execution.command.id,
        exitCode: execution.exitCode
      })),
    failed: executions
      .filter((execution) => execution.status === "failed")
      .map((execution) => ({
        id: execution.command.id,
        exitCode: execution.exitCode,
        error: execution.error
      })),
    skipped
  };
}

function failedPostCommand(
  executions: PostCommandExecution[]
): Extract<PostCommandExecution, { status: "failed" }> | undefined {
  return executions.find(
    (execution): execution is Extract<PostCommandExecution, { status: "failed" }> =>
      execution.status === "failed"
  );
}

function skippedPostCommands(
  commands: readonly PostCommand[],
  reason: string
): Array<{ id: string; reason: string }> {
  return commands.map((command) => ({ id: command.id, reason }));
}

async function generateInitProject(options: InitOptions): Promise<void> {
  if (options.preset === "ts-lib") {
    await initTsLibProject(options.dir);
    return;
  }

  if (options.preset === "hono-api") {
    await initHonoApiProject(options.dir);
    return;
  }

  if (options.preset === "vue-app") {
    await initVueAppProject(options.dir);
    return;
  }

  if (options.preset === "vue-hono-app") {
    await initVueHonoAppProject(options.dir, { scope: options.scope });
    return;
  }

  if (options.preset === "rust-bin") {
    await initRustBinProject(options.dir);
    return;
  }

  throw new Error(
    "Only the ts-lib, hono-api, vue-app, vue-hono-app, and rust-bin presets are supported in this version"
  );
}

function printInitComplete(
  options: InitOptions,
  blueprint: ProjectBlueprint,
  report: PostCommandReport
): void {
  const preset = blueprint.preset as PresetName;

  if (options.json) {
    printJson({
      command: "init",
      dryRun: false,
      ready: options.ready,
      targetDir: options.dir,
      blueprint,
      postCommands: report,
      nextSteps: nextStepsForPreset(preset).map((step) => step.replace("<target>", options.dir))
    } satisfies InitJsonOutput);
    return;
  }

  console.log(`Initialized ${options.preset} project in ${options.dir}`);
  if (options.ready) {
    console.log(formatPostCommandPlan(report.planned));
  }
  console.log(formatNextSteps(options.dir, preset));
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirmInit(targetDir: string, blueprint: ProjectBlueprint): Promise<boolean> {
  console.log(formatBlueprintSummary(targetDir, blueprint));
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await readline.question("Generate this project? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

function parseAddPackageOptions(args: string[]): AddPackageOptions {
  let preset = "";
  let name = "";

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--preset") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--preset requires a value");
      }
      preset = value;
      index += 1;
      continue;
    }

    if (arg === "--name") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--name requires a value");
      }
      name = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!preset) {
    throw new Error("add package requires --preset");
  }

  if (!name) {
    throw new Error("add package requires --name");
  }

  return { preset, name };
}

async function main(args: string[]): Promise<void> {
  const command = args[0];

  if (command === "presets") {
    console.log(formatPresetCatalog());
    return;
  }

  if (command === "schema") {
    const schemaName = args[1];

    if (schemaName === "preset") {
      printJson(presetFileJsonSchema);
      return;
    }

    if (schemaName === "blueprint") {
      printJson(blueprintJsonSchema);
      return;
    }

    throw new Error("schema requires preset or blueprint");
  }

  if (command === "preset" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) {
      throw new Error("preset validate requires a path");
    }

    const result = validatePresetFile(await readJsonDeclaration(filePath));
    if (!result.ok) {
      throw new Error(`Preset file is invalid:\n${formatValidationIssues(result.issues)}`);
    }

    console.log(`Preset file is valid: ${result.value.name}`);
    return;
  }

  if (command === "blueprint" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) {
      throw new Error("blueprint validate requires a path");
    }

    const result = validateProjectBlueprint(await readJsonDeclaration(filePath));
    if (!result.ok) {
      throw new Error(`Blueprint is invalid:\n${formatValidationIssues(result.issues)}`);
    }

    console.log(`Blueprint is valid: ${result.value.preset}`);
    return;
  }

  if (command === "init") {
    const options = parseInitOptions(args);
    const blueprint = blueprintForInit(options);

    if (options.dryRun) {
      const postCommandPlan = planPostCommands({
        preset: blueprint.preset as PresetName,
        targetDir: options.dir
      });

      if (options.json) {
        printJson({
          command: "init",
          dryRun: true,
          ready: options.ready,
          targetDir: options.dir,
          blueprint,
          postCommands: postCommandReport(
            postCommandPlan.commands,
            [],
            skippedPostCommands(postCommandPlan.commands, "dry-run")
          )
        } satisfies InitJsonOutput);
        return;
      }

      console.log(formatBlueprintSummary(options.dir, blueprint));
      console.log(formatPostCommandPlan(postCommandPlan.commands));
      return;
    }

    if (!options.yes && (options.json || !isInteractiveTerminal())) {
      throw new Error("Non-interactive init requires --yes");
    }

    if (!options.yes && !(await confirmInit(options.dir, blueprint))) {
      throw new Error("Init cancelled");
    }

    const postCommandPlan: PostCommandPlan = planPostCommands({
      preset: blueprint.preset as PresetName,
      targetDir: options.dir
    });
    await generateInitProject(options);
    const executions = options.ready ? await runPostCommands({ plan: postCommandPlan }) : [];
    const failedExecution = failedPostCommand(executions);
    printInitComplete(
      options,
      blueprint,
      postCommandReport(
        postCommandPlan.commands,
        executions,
        options.ready
          ? []
          : skippedPostCommands(postCommandPlan.commands, "ready-mode-not-requested")
      )
    );
    if (failedExecution) {
      throw new Error(failedExecution.error);
    }
    return;
  }

  if (command === "add" && args[1] === "package") {
    const options = parseAddPackageOptions(args);
    await addPackage({ cwd: process.cwd(), preset: options.preset, name: options.name });
    console.log(`Added ${options.preset} package ${options.name}`);
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  throw new Error(command ? `Unknown command: ${command}` : "Missing command");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
});
