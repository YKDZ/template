#!/usr/bin/env node
import { initTsLibProject } from "./ts-lib.js";

type InitOptions = {
  dir: string;
  preset: string;
  yes: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  template init <dir> --preset ts-lib --yes",
    "",
    "Options:",
    "  --preset <name>  Project preset to generate",
    "  --yes            Accept defaults for non-interactive generation"
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

  if (command === "init") {
    const options = parseInitOptions(args);

    if (!options.yes) {
      throw new Error("Non-interactive init requires --yes");
    }

    if (options.preset !== "ts-lib") {
      throw new Error("Only the ts-lib preset is supported in this version");
    }

    await initTsLibProject(options.dir);
    console.log(`Initialized ts-lib project in ${options.dir}`);
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
