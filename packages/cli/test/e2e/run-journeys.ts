import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
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

function getRunTarget(): JourneyRunTarget {
  const mode = process.env.TEMPLATE_CLI_JOURNEY_MODE;
  if (mode !== "source" && mode !== "distribution" && mode !== "packed") {
    throw new Error(
      "TEMPLATE_CLI_JOURNEY_MODE must be source, distribution, or packed",
    );
  }

  const packedBin = process.env.TEMPLATE_CLI_PACKED_BIN;
  if (mode === "packed" && packedBin === undefined) {
    throw new Error("TEMPLATE_CLI_PACKED_BIN is required for packed journeys");
  }
  return { mode, ...(packedBin === undefined ? {} : { packedBin }) };
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

function invocation(target: JourneyRunTarget): {
  readonly executable: string;
  readonly prefix: readonly string[];
} {
  switch (target.mode) {
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
      if (target.packedBin === undefined) {
        throw new Error(
          "TEMPLATE_CLI_PACKED_BIN is required for packed journeys",
        );
      }
      return { executable: target.packedBin, prefix: [] };
  }
}

async function runCommand(options: {
  readonly target: JourneyRunTarget;
  readonly command: CliJourneyCommand;
  readonly cwd: string;
}): Promise<CliJourneyResult> {
  const target = invocation(options.target);
  const env = { ...process.env, ...options.command.env };
  delete env.TEMPLATE_CLI_JOURNEY_MODE;
  delete env.TEMPLATE_CLI_PACKED_BIN;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      options.command.executable ?? target.executable,
      options.command.executable === undefined
        ? [...target.prefix, ...options.command.args]
        : options.command.args,
      {
        cwd: options.command.cwd ?? options.cwd,
        env,
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

async function runJourney(
  target: JourneyRunTarget,
  journey: CliJourney,
): Promise<void> {
  const workDir = await mkdtemp(
    path.join(tmpdir(), `template-${journey.name}-${target.mode}-`),
  );
  const context = { mode: target.mode, packageRoot, workDir };
  try {
    await journey.setup(context);
    const results: CliJourneyResult[] = [];
    for (const command of journey.commands(context)) {
      await command.prepare?.(context);
      results.push(await runCommand({ target, command, cwd: workDir }));
    }
    try {
      await journey.assertions({ context, results });
    } catch (error) {
      const commandSummary = results
        .map(
          (result) =>
            `${result.commandName}: exit=${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        )
        .join("\n\n");
      throw new Error(`旅程 ${journey.name} 验证失败。\n${commandSummary}`, {
        cause: error,
      });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const target = getRunTarget();
const journeys = await discoverJourneys();
for (const journey of journeys) {
  if (!journey.modes.includes(target.mode)) continue;
  void test(`${target.mode}: ${journey.name}`, async () => {
    await runJourney(target, journey);
  });
}
