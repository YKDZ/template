import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");

function assertNever(value: never): never {
  throw new Error(`unsupported journey mode: ${String(value)}`);
}

type JourneyRunTarget = {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
};

const journeyRunnerUsage = [
  "Usage:",
  "  run-journeys.ts <source|distribution> [source|distribution ...]",
  "  run-journeys.ts packed <bin-path>",
].join("\n");

function invalidArguments(message: string): never {
  throw new Error(`${message}\n${journeyRunnerUsage}`);
}

function parseJourneyRunTargets(
  args: readonly string[],
): readonly JourneyRunTarget[] {
  const first = args[0];
  if (first === undefined) {
    invalidArguments("missing journey mode");
  }

  if (first === "packed") {
    if (args.length === 1) {
      invalidArguments("packed journey mode requires exactly one bin path");
    }
    if (args.length !== 2) {
      invalidArguments(
        "packed journey mode accepts exactly one bin path and cannot be combined with other modes",
      );
    }
    const packedBin = args[1]!;
    if (
      packedBin === "source" ||
      packedBin === "distribution" ||
      packedBin === "packed"
    ) {
      invalidArguments(
        `packed bin path cannot be journey mode ${JSON.stringify(packedBin)}`,
      );
    }
    return [{ mode: "packed", packedBin }];
  }

  const seen = new Set<CliJourneyMode>();
  const targets: JourneyRunTarget[] = [];
  for (const argument of args) {
    switch (argument) {
      case "source":
      case "distribution":
        if (seen.has(argument)) {
          invalidArguments(
            `duplicate journey mode ${JSON.stringify(argument)}; each mode may be specified once`,
          );
        }
        seen.add(argument);
        targets.push({ mode: argument });
        break;
      case "packed":
        invalidArguments(
          "packed journey mode cannot be combined with source or distribution",
        );
      default:
        invalidArguments(
          `unknown journey mode ${JSON.stringify(argument)}; expected source, distribution, or packed`,
        );
    }
  }
  return targets;
}

async function discoverJourneys(): Promise<readonly CliJourney[]> {
  const journeyRoot = path.join(e2eRoot, "journeys");
  const entries = await readdir(journeyRoot, { withFileTypes: true });
  const journeyFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".journey.ts") ||
          entry.name.endsWith(".journey.js")),
    )
    .map((entry) => entry.name)
    .toSorted();
  return await Promise.all(
    journeyFiles.map(async (fileName) => {
      const loaded = (await import(
        pathToFileURL(path.join(journeyRoot, fileName)).href
      )) as { default: CliJourney };
      return loaded.default;
    }),
  );
}

function invocation(
  mode: CliJourneyMode,
  packedBin: string | undefined,
): { readonly executable: string; readonly prefix: readonly string[] } {
  switch (mode) {
    case "source":
      return {
        executable: process.execPath,
        prefix: [
          "--conditions=source",
          path.join(packageRoot, "src", "cli.ts"),
        ],
      };
    case "distribution":
      return {
        executable: process.execPath,
        prefix: [path.join(packageRoot, "dist", "cli.js")],
      };
    case "packed":
      if (packedBin === undefined) {
        throw new Error(
          "packed journey mode requires a package-manager bin path",
        );
      }
      return { executable: packedBin, prefix: [] };
    default:
      return assertNever(mode);
  }
}

async function runCommand(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin: string | undefined;
  readonly command: CliJourneyCommand;
  readonly cwd: string;
}): Promise<CliJourneyResult> {
  const target = invocation(options.mode, options.packedBin);
  return await new Promise((resolve, reject) => {
    const child = spawn(
      target.executable,
      [...target.prefix, ...options.command.args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.command.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        commandName: options.command.name,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
}): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(options.mode)) continue;
    const workDir = await mkdtemp(
      path.join(tmpdir(), `cli-${journey.name}-${options.mode}-`),
    );
    const context = { mode: options.mode, packageRoot, workDir };
    try {
      await journey.setup(context);
      const results: CliJourneyResult[] = [];
      for (const command of journey.commands(context)) {
        results.push(
          await runCommand({
            mode: options.mode,
            packedBin: options.packedBin,
            command,
            cwd: workDir,
          }),
        );
      }
      await journey.assertions({ context, results });
      passed.push(`${options.mode}:${journey.name}:passed`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return passed;
}

async function runJourneyTargets(
  targets: readonly JourneyRunTarget[],
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const target of targets) {
    switch (target.mode) {
      case "source":
      case "distribution":
        passed.push(...(await runJourneys({ mode: target.mode })));
        break;
      case "packed":
        passed.push(
          ...(await runJourneys({
            mode: target.mode,
            ...(target.packedBin === undefined
              ? {}
              : { packedBin: target.packedBin }),
          })),
        );
        break;
      default:
        assertNever(target.mode);
    }
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const passed = await runJourneyTargets(
      parseJourneyRunTargets(process.argv.slice(2)),
    );
    process.stdout.write(`${passed.join("\n")}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
