#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  findBuiltInPresetProjection,
  projectPresetThroughRegistry,
} from "../templates/registry.js";
import {
  blueprintJsonSchema,
  builtInPresets,
  presetFileJsonSchema,
  validatePresetFile,
  validateProjectBlueprint,
  type BuiltInPreset,
  type ProjectBlueprint,
  type ValidationIssue,
} from "./declarations.js";
import {
  assembleGenerationContext,
  type GenerationContext,
} from "./generation-context.js";
import type { NextStepInstruction } from "./next-step-instructions.js";
import { addPackage } from "./package-addition.js";
import {
  planNextStepInstructionsForProjection,
  type PresetProjectionPlan,
} from "./preset-projection.js";
import {
  presetSourceManifestJsonSchema,
  validateBuiltInPresetSourceManifest,
  validatePresetSourceManifest,
} from "./preset-source.js";
import {
  resolveToolchainVersions,
  type ResolvedToolchainVersions,
  type ToolchainResolutionSource,
} from "./toolchain-resolution.js";

type InitOptions = {
  dir: string;
  preset: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  scope?: string;
};

type AddPackageOptions = {
  preset: string;
  name: string;
  path?: string;
  linkFrom: readonly string[];
};

function usage(): string {
  return [
    "Usage:",
    "  template init <dir> --preset <name> --yes",
    "  template add package --preset <name> --name <name> [--path <package-path>] [--link-from <package-path>]...",
    "  template presets",
    "  template schema preset",
    "  template schema preset-source",
    "  template schema blueprint",
    "  template preset validate <path>",
    "  template preset-source validate <path>",
    "  template blueprint validate <path>",
    "",
    "Options:",
    "  --preset <name>  Project preset to generate",
    "  --name <name>    Package name to add",
    "  --path <path>    Two-segment Package Path to add",
    "  --link-from <path>  Existing consumer Package Path to link from; repeatable",
    "  --scope <name>   Package scope for workspace package names",
    "  --yes            Accept defaults for non-interactive generation",
    "  --dry-run        Print the planned generation without writing files",
    "  --json           Print machine-readable output",
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
  return issues
    .map((issue) => `  - ${issue.path}: ${issue.message}`)
    .join("\n");
}

function formatPresetCatalog(): string {
  return [
    "Built-in presets",
    ...builtInPresets.map(
      (preset) =>
        `  ${preset.name.padEnd(8)} ${preset.title} (${preset.generation}) - ${preset.description}`,
    ),
  ].join("\n");
}

function parseInitOptions(args: string[]): InitOptions {
  const dir = args[1];
  let preset = "";
  let yes = false;
  let dryRun = false;
  let json = false;
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

  return { dir, preset, yes, dryRun, json, scope };
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
    (candidate) =>
      candidate.name === name && candidate.generation === "supported",
  );

  if (!preset) {
    throw new Error(formatSupportedPresetError());
  }

  return preset;
}

function formatSupportedPresetError(): string {
  const supportedPresetNames = builtInPresets
    .filter((preset) => preset.generation === "supported")
    .map((preset) => preset.name);

  return `Only the ${formatList(supportedPresetNames)} presets are supported in this version`;
}

function formatList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "";
  }

  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function blueprintForInit(options: InitOptions): ProjectBlueprint {
  const preset = supportedPreset(options.preset);
  const projection = findBuiltInPresetProjection(preset.name);
  if (projection) {
    return projection.blueprint({
      targetDir: options.dir,
      scope: options.scope,
    });
  }

  const blueprint: ProjectBlueprint = {
    schemaVersion: 1,
    preset: preset.name,
    projectKind: preset.supportedProjectKinds[0],
    features: [...preset.features],
  };

  if (preset.supportedPackageManagers[0]) {
    blueprint.packageManager = preset.supportedPackageManagers[0];
  }

  return blueprint;
}

function formatBlueprintSummary(
  targetDir: string,
  blueprint: ProjectBlueprint,
): string {
  const lines = [
    "Project Blueprint",
    `  Target: ${targetDir}`,
    `  Preset: ${blueprint.preset}`,
    `  Project kind: ${blueprint.projectKind}`,
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

type InitJsonOutput = {
  command: "init";
  dryRun: boolean;
  targetDir: string;
  blueprint: ProjectBlueprint;
  toolchain?: ToolchainReport;
  nextSteps: readonly NextStepInstruction[];
};

type ToolchainReport = {
  nodeLtsMajor: string;
  packageManagerPin: string;
  source: ToolchainResolutionSource;
  diagnostics: string[];
};

function formatProjectionNextSteps(
  targetDir: string,
  projectionPlan: PresetProjectionPlan,
): string {
  const steps = planNextStepInstructionsForProjection({
    targetDir,
    plan: projectionPlan,
  });

  return [
    "Next Step Instructions:",
    ...steps.map((step) => `  ${step.label}: ${step.display}`),
  ].join("\n");
}

function toolchainReport(
  toolchain: ResolvedToolchainVersions,
): ToolchainReport {
  return {
    nodeLtsMajor: toolchain.nodeLtsMajor.value,
    packageManagerPin: toolchain.packageManagerPin.value,
    source: toolchain.source,
    diagnostics: [...toolchain.diagnostics],
  };
}

function formatToolchainReport(toolchain: ResolvedToolchainVersions): string {
  return [
    "Toolchain Resolution:",
    `  Source: ${toolchain.source}`,
    `  Node LTS major: ${toolchain.nodeLtsMajor.value}`,
    `  Package Manager Pin: ${toolchain.packageManagerPin.value}`,
    ...toolchain.diagnostics.map((diagnostic) => `  ${diagnostic}`),
  ].join("\n");
}

function toolchainResolutionSourceFromEnv():
  | ToolchainResolutionSource
  | undefined {
  if (
    process.env.TEMPLATE_TOOLCHAIN_RESOLUTION === "online" ||
    process.env.TEMPLATE_TOOLCHAIN_RESOLUTION === "bundled-fallback"
  ) {
    return process.env.TEMPLATE_TOOLCHAIN_RESOLUTION;
  }

  return undefined;
}

async function generationContextForInit(
  options: InitOptions,
  blueprint: ProjectBlueprint,
): Promise<GenerationContext | undefined> {
  if (!findBuiltInPresetProjection(options.preset)) {
    return undefined;
  }

  return assembleGenerationContext({
    targetDir: options.dir,
    blueprint,
    toolchain: await resolveToolchainVersions({
      source: toolchainResolutionSourceFromEnv(),
      nodeReleaseIndexUrl:
        process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL,
      pnpmRegistryUrl: process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL,
    }),
  });
}

async function generateInitProject(
  options: InitOptions,
  generationContext?: GenerationContext,
): Promise<void> {
  const projection = findBuiltInPresetProjection(options.preset);
  if (projection) {
    if (!generationContext) {
      throw new Error(
        `Missing Generation Context for Preset Projection: ${options.preset}`,
      );
    }
    const plan = projection.project(generationContext);
    await projection.render({ targetDir: options.dir, plan });
    return;
  }

  throw new Error(formatSupportedPresetError());
}

function printInitComplete(
  options: InitOptions,
  blueprint: ProjectBlueprint,
  generationContext?: GenerationContext,
): void {
  const projectionPlan = generationContext
    ? projectPresetThroughRegistry(generationContext)
    : undefined;
  if (!projectionPlan) {
    throw new Error(`Missing Preset Projection plan: ${blueprint.preset}`);
  }
  const nextSteps = planNextStepInstructionsForProjection({
    targetDir: options.dir,
    plan: projectionPlan,
  });

  if (options.json) {
    printJson({
      command: "init",
      dryRun: false,
      targetDir: options.dir,
      blueprint,
      toolchain: generationContext
        ? toolchainReport(generationContext.toolchain)
        : undefined,
      nextSteps,
    } satisfies InitJsonOutput);
    return;
  }

  console.log(`Initialized ${options.preset} project in ${options.dir}`);
  if (generationContext) {
    console.log(formatToolchainReport(generationContext.toolchain));
  }
  console.log(formatProjectionNextSteps(options.dir, projectionPlan));
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirmInit(
  targetDir: string,
  blueprint: ProjectBlueprint,
): Promise<boolean> {
  console.log(formatBlueprintSummary(targetDir, blueprint));
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question("Generate this project? [y/N] ");
    return (
      answer.trim().toLowerCase() === "y" ||
      answer.trim().toLowerCase() === "yes"
    );
  } finally {
    readline.close();
  }
}

function parseAddPackageOptions(args: string[]): AddPackageOptions {
  let preset = "";
  let name = "";
  let packagePath: string | undefined;
  const linkFrom: string[] = [];

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

    if (arg === "--path") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--path requires a value");
      }
      packagePath = value;
      index += 1;
      continue;
    }

    if (arg === "--link-from") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--link-from requires a value");
      }
      linkFrom.push(value);
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

  return { preset, name, path: packagePath, linkFrom };
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

    if (schemaName === "preset-source") {
      printJson(presetSourceManifestJsonSchema);
      return;
    }

    throw new Error("schema requires preset, preset-source, or blueprint");
  }

  if (command === "preset" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) {
      throw new Error("preset validate requires a path");
    }

    const result = validatePresetFile(await readJsonDeclaration(filePath));
    if (!result.ok) {
      throw new Error(
        `Preset file is invalid:\n${formatValidationIssues(result.issues)}`,
      );
    }

    console.log(`Preset file is valid: ${result.value.name}`);
    return;
  }

  if (command === "preset-source" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) {
      throw new Error("preset-source validate requires a path");
    }

    const declaration = await readJsonDeclaration(filePath);
    const sourceName =
      typeof declaration === "object" &&
      declaration !== null &&
      !Array.isArray(declaration) &&
      "name" in declaration &&
      typeof declaration.name === "string"
        ? declaration.name
        : undefined;
    const result =
      sourceName === "built-in"
        ? validateBuiltInPresetSourceManifest(declaration, {
            sourceRoot: path.dirname(filePath),
          })
        : validatePresetSourceManifest(declaration, {
            sourceRoot: path.dirname(filePath),
          });
    if (!result.ok) {
      throw new Error(
        `Preset Source Manifest is invalid:\n${formatValidationIssues(
          result.issues,
        )}`,
      );
    }

    console.log(
      `Preset Source Manifest is valid: ${
        result.value.name
      } (${result.value.presets.map((preset) => preset.name).join(", ")})`,
    );
    return;
  }

  if (command === "blueprint" && args[1] === "validate") {
    const filePath = args[2];
    if (!filePath) {
      throw new Error("blueprint validate requires a path");
    }

    const result = validateProjectBlueprint(
      await readJsonDeclaration(filePath),
    );
    if (!result.ok) {
      throw new Error(
        `Blueprint is invalid:\n${formatValidationIssues(result.issues)}`,
      );
    }

    console.log(`Blueprint is valid: ${result.value.preset}`);
    return;
  }

  if (command === "init") {
    const options = parseInitOptions(args);
    const blueprint = blueprintForInit(options);

    if (options.dryRun) {
      const generationContext = await generationContextForInit(
        options,
        blueprint,
      );
      const projectionPlan = generationContext
        ? projectPresetThroughRegistry(generationContext)
        : undefined;
      if (!projectionPlan) {
        throw new Error(`Missing Preset Projection plan: ${blueprint.preset}`);
      }
      const nextSteps = planNextStepInstructionsForProjection({
        targetDir: options.dir,
        plan: projectionPlan,
      });

      if (options.json) {
        printJson({
          command: "init",
          dryRun: true,
          targetDir: options.dir,
          blueprint,
          toolchain: generationContext
            ? toolchainReport(generationContext.toolchain)
            : undefined,
          nextSteps,
        } satisfies InitJsonOutput);
        return;
      }

      console.log(formatBlueprintSummary(options.dir, blueprint));
      if (generationContext) {
        console.log(formatToolchainReport(generationContext.toolchain));
      }
      console.log(formatProjectionNextSteps(options.dir, projectionPlan));
      return;
    }

    if (!options.yes && (options.json || !isInteractiveTerminal())) {
      throw new Error("Non-interactive init requires --yes");
    }

    if (!options.yes && !(await confirmInit(options.dir, blueprint))) {
      throw new Error("Init cancelled");
    }

    const generationContext = await generationContextForInit(
      options,
      blueprint,
    );
    await generateInitProject(options, generationContext);
    printInitComplete(options, blueprint, generationContext);
    return;
  }

  if (command === "add" && args[1] === "package") {
    const options = parseAddPackageOptions(args);
    await addPackage({
      cwd: process.cwd(),
      preset: options.preset,
      name: options.name,
      path: options.path,
      linkFrom: options.linkFrom,
    });
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
