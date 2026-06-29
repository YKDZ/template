#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { initHonoApiProject } from "./hono-api.js";
import { initRustBinProject } from "./rust-bin.js";
import { initTsLibProject } from "./ts-lib.js";
import { initVueHonoAppProject } from "./vue-hono-app.js";
import { initVueAppProject } from "./vue-app.js";
import {
  blueprintJsonSchema,
  builtInPresets,
  presetFileJsonSchema,
  validatePresetFile,
  validateProjectBlueprint,
  type ValidationIssue
} from "./declarations.js";

type InitOptions = {
  dir: string;
  preset: string;
  yes: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  template init <dir> --preset <name> --yes",
    "  template presets",
    "  template schema preset",
    "  template schema blueprint",
    "  template preset validate <path>",
    "  template blueprint validate <path>",
    "",
    "Options:",
    "  --preset <name>  Project preset to generate",
    "  --yes            Accept defaults for non-interactive generation"
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

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yes" || arg === "-y") {
      yes = true;
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

  return { dir, preset, yes };
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

    if (!options.yes) {
      throw new Error("Non-interactive init requires --yes");
    }

    if (options.preset === "ts-lib") {
      await initTsLibProject(options.dir);
      console.log(`Initialized ts-lib project in ${options.dir}`);
      return;
    }

    if (options.preset === "hono-api") {
      await initHonoApiProject(options.dir);
      console.log(`Initialized hono-api project in ${options.dir}`);
      return;
    }

    if (options.preset === "vue-app") {
      await initVueAppProject(options.dir);
      console.log(`Initialized vue-app project in ${options.dir}`);
      return;
    }

    if (options.preset === "vue-hono-app") {
      await initVueHonoAppProject(options.dir);
      console.log(`Initialized vue-hono-app project in ${options.dir}`);
      return;
    }

    if (options.preset === "rust-bin") {
      await initRustBinProject(options.dir);
      console.log(`Initialized rust-bin project in ${options.dir}`);
      return;
    }

    throw new Error(
      "Only the ts-lib, hono-api, vue-app, vue-hono-app, and rust-bin presets are supported in this version"
    );
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
