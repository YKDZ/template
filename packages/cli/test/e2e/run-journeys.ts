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

type JourneyRunTarget = {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
};

function invalidArguments(message: string): never {
  throw new Error(
    `${message}\nUsage: run-journeys.ts <source|distribution> [...modes] | packed <bin-path>`,
  );
}

function parseTargets(args: readonly string[]): readonly JourneyRunTarget[] {
  const first = args[0];
  if (first === undefined) invalidArguments("missing journey mode");
  if (first === "packed") {
    if (args.length !== 2) {
      invalidArguments("packed journey mode requires exactly one bin path");
    }
    return [{ mode: "packed", packedBin: args[1]! }];
  }

  const targets: JourneyRunTarget[] = [];
  const seen = new Set<CliJourneyMode>();
  for (const argument of args) {
    if (argument !== "source" && argument !== "distribution") {
      invalidArguments(`unknown journey mode ${JSON.stringify(argument)}`);
    }
    if (seen.has(argument)) {
      invalidArguments(`duplicate journey mode ${JSON.stringify(argument)}`);
    }
    seen.add(argument);
    targets.push({ mode: argument });
  }
  return targets;
}

async function discoverJourneys(): Promise<readonly CliJourney[]> {
  const journeyRoot = path.join(e2eRoot, "journeys");
  const entries = await readdir(journeyRoot, { withFileTypes: true });
  return await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".journey.ts") ||
            entry.name.endsWith(".journey.js")),
      )
      .map((entry) => entry.name)
      .toSorted()
      .map(async (fileName) => {
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
        prefix: ["--conditions=source", path.join(packageRoot, "src/cli.ts")],
      };
    case "distribution":
      return {
        executable: process.execPath,
        prefix: [path.join(packageRoot, "dist/cli.js")],
      };
    case "packed":
      if (packedBin === undefined) {
        throw new Error("packed journey mode requires a bin path");
      }
      return { executable: packedBin, prefix: [] };
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
      options.command.executable ?? target.executable,
      options.command.executable === undefined
        ? [...target.prefix, ...options.command.args]
        : options.command.args,
      {
        cwd: options.command.cwd ?? options.cwd,
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

async function runJourneys(
  target: JourneyRunTarget,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(target.mode)) continue;
    const workDir = await mkdtemp(
      path.join(tmpdir(), `template-${journey.name}-${target.mode}-`),
    );
    const context = { mode: target.mode, packageRoot, workDir };
    try {
      await journey.setup(context);
      const results: CliJourneyResult[] = [];
      for (const command of journey.commands(context)) {
        await command.prepare?.(context);
        results.push(
          await runCommand({
            mode: target.mode,
            packedBin: target.packedBin,
            command,
            cwd: workDir,
          }),
        );
      }
      await journey.assertions({ context, results });
      passed.push(`${target.mode}:${journey.name}:passed`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const passed: string[] = [];
    for (const target of parseTargets(process.argv.slice(2))) {
      passed.push(...(await runJourneys(target)));
    }
    process.stdout.write(`${passed.join("\n")}\n`);
  } catch (error) {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
