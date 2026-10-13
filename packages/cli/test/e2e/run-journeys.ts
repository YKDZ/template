import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execa } from "execa";

import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");
const defaultJourneyTimeoutMs = 300_000;
const defaultCommandTimeoutMs = 120_000;
const killGracePeriodMs = 2_000;
const processAbortController = new AbortController();

type JourneyRunTarget = {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
};

type JourneyCommandRecord = {
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
};

function getRunTarget(): JourneyRunTarget {
  const mode = process.env.TEMPLATE_CLI_JOURNEY_MODE;
  if (mode !== "source" && mode !== "distribution" && mode !== "packed") {
    throw new Error(
      "TEMPLATE_CLI_JOURNEY_MODE 需设置为 source、distribution 或 packed",
    );
  }

  const packedBin = process.env.TEMPLATE_CLI_PACKED_BIN;
  if (mode === "packed" && packedBin === undefined) {
    throw new Error("packed 模式必须设置 TEMPLATE_CLI_PACKED_BIN");
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
        throw new Error("packed 模式必须设置 TEMPLATE_CLI_PACKED_BIN");
      }
      return { executable: target.packedBin, prefix: [] };
  }
}

function commandInvocation(
  target: JourneyRunTarget,
  command: CliJourneyCommand,
  workDir: string,
): JourneyCommandRecord {
  const cli = invocation(target);
  const cwd = path.resolve(command.cwd ?? workDir);
  return {
    name: command.name,
    executable: command.executable ?? cli.executable,
    args:
      command.executable === undefined
        ? [...cli.prefix, ...command.args]
        : [...command.args],
    cwd: path.relative(workDir, cwd) || ".",
    timeoutMs: command.timeoutMs ?? defaultCommandTimeoutMs,
  };
}

async function runCommand(options: {
  readonly target: JourneyRunTarget;
  readonly command: CliJourneyCommand;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<CliJourneyResult> {
  const target = invocation(options.target);
  const executable = options.command.executable ?? target.executable;
  const args =
    options.command.executable === undefined
      ? [...target.prefix, ...options.command.args]
      : [...options.command.args];
  const env = { ...process.env, ...options.command.env };
  delete env.TEMPLATE_CLI_JOURNEY_MODE;
  delete env.TEMPLATE_CLI_PACKED_BIN;
  const result = await execa(executable, args, {
    cwd: options.command.cwd ?? options.cwd,
    env,
    reject: false,
    stripFinalNewline: false,
    timeout: options.command.timeoutMs ?? defaultCommandTimeoutMs,
    cancelSignal: options.signal,
    killDescendants: true,
    forceKillAfterDelay: killGracePeriodMs,
  });
  if (result.timedOut || result.isCanceled || result.exitCode === undefined) {
    const reason = result.timedOut
      ? "超时"
      : result.isCanceled
        ? "已取消"
        : "未正常完成";
    throw new Error(
      `CLI 旅程命令“${options.command.name}”${reason}，耗时 ${result.durationMs}ms。\n标准输出：\n${result.stdout}\n标准错误：\n${result.stderr}`,
      { cause: result },
    );
  }
  return {
    commandName: options.command.name,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function errorDetails(error: unknown, seen = new Set<unknown>()): unknown {
  if (error instanceof Error) {
    if (seen.has(error)) return { name: error.name, message: "[循环 cause]" };
    seen.add(error);
    const cause = "cause" in error ? error.cause : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...("timedOut" in error ? { timedOut: error.timedOut } : {}),
      ...("isCanceled" in error ? { isCanceled: error.isCanceled } : {}),
      ...("exitCode" in error ? { exitCode: error.exitCode } : {}),
      ...("signal" in error ? { signal: error.signal } : {}),
      ...(cause === undefined ? {} : { cause: errorDetails(cause, seen) }),
    };
  }
  if (typeof error === "string")
    return { name: "ThrownString", message: error };
  try {
    return { name: "ThrownValue", value: JSON.stringify(error) };
  } catch {
    return { name: "ThrownValue", value: String(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function excludedDiagnosticPath(source: string, root: string): boolean {
  const relativePath = path.relative(root, source);
  return relativePath
    .split(path.sep)
    .some((segment) =>
      new Set([
        ".git",
        ".npm",
        ".pnpm-store",
        ".cache",
        ".turbo",
        "node_modules",
        "target",
      ]).has(segment),
    );
}

async function createDiagnosticsDirectory(
  mode: CliJourneyMode,
  journeyName: string,
): Promise<string> {
  const parent = process.env.TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const safeName = journeyName.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  return await mkdtemp(path.join(parent, `template-${mode}-${safeName}-`));
}

async function retainFailure(options: {
  readonly target: JourneyRunTarget;
  readonly journey: CliJourney;
  readonly workDir: string;
  readonly commands: readonly JourneyCommandRecord[];
  readonly results: readonly CliJourneyResult[];
  readonly error: unknown;
}): Promise<{
  readonly directory: string;
  readonly errors: readonly unknown[];
}> {
  const errors: unknown[] = [];
  let directory = options.workDir;
  let workspacePath = options.workDir;
  let copiedWorkspace = false;
  try {
    directory = await createDiagnosticsDirectory(
      options.target.mode,
      options.journey.name,
    );
    const diagnosticWorkspace = path.join(directory, "workspace");
    await cp(options.workDir, diagnosticWorkspace, {
      recursive: true,
      filter(source) {
        return !excludedDiagnosticPath(source, options.workDir);
      },
    });
    workspacePath = diagnosticWorkspace;
    copiedWorkspace = true;
  } catch (error) {
    errors.push(error);
  }

  const report = {
    mode: options.target.mode,
    journey: options.journey.name,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    executable: process.execPath,
    packageRoot,
    workspace: workspacePath,
    copiedWorkspace,
    commands: options.commands,
    results: options.results,
    error: errorDetails(options.error),
    reproduction: {
      source:
        "请在 CLI 包的正式 test:e2e 入口中设置 TEMPLATE_CLI_JOURNEY_MODE=source。",
      distribution:
        "请在 CLI 包的正式 test:e2e 入口中设置 TEMPLATE_CLI_JOURNEY_MODE=distribution。",
      packed:
        "安装保留的打包归档，并将其 node_modules/.bin/template 路径传给 TEMPLATE_CLI_PACKED_BIN。",
    },
    cleanup: {
      retryPath: copiedWorkspace ? workspacePath : options.workDir,
      retry: "修复报告中的文件系统错误后，重新递归删除 retryPath。",
    },
  };
  try {
    await writeFile(
      path.join(directory, "journey-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch (error) {
    errors.push(error);
  }
  return { directory, errors };
}

async function removeWorkspace(workDir: string): Promise<void> {
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

async function runJourney(
  target: JourneyRunTarget,
  journey: CliJourney,
  signal: AbortSignal,
): Promise<void> {
  const workDir = await mkdtemp(
    path.join(tmpdir(), `template-${journey.name}-${target.mode}-`),
  );
  const context = { mode: target.mode, packageRoot, workDir, signal };
  const commands: JourneyCommandRecord[] = [];
  const results: CliJourneyResult[] = [];
  let failed = false;
  let primaryError: unknown;
  try {
    await journey.setup(context);
    for (const command of journey.commands(context)) {
      commands.push(commandInvocation(target, command, workDir));
      await command.prepare?.(context);
      results.push(await runCommand({ target, command, cwd: workDir, signal }));
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
    if (signal.aborted) {
      throw new Error(`CLI 旅程“${journey.name}”已取消。`, {
        cause: signal.reason,
      });
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  if (!failed) {
    try {
      await removeWorkspace(workDir);
      return;
    } catch (error) {
      failed = true;
      primaryError = error;
    }
  }

  const retention = await retainFailure({
    target,
    journey,
    workDir,
    commands,
    results,
    error: primaryError,
  });
  const secondaryErrors = [...retention.errors];
  if (retention.directory !== workDir) {
    try {
      await removeWorkspace(workDir);
    } catch (error) {
      secondaryErrors.push(error);
    }
  }
  const failure = new Error(
    `${errorMessage(primaryError)}\nCLI_JOURNEY_DIAGNOSTICS=${retention.directory}`,
    { cause: primaryError },
  );
  if (secondaryErrors.length > 0) {
    throw new AggregateError(
      [failure, ...secondaryErrors],
      `CLI 旅程“${journey.name}”失败，诊断保留或清理过程还报告了其他错误。\nCLI_JOURNEY_DIAGNOSTICS=${retention.directory}`,
      { cause: primaryError },
    );
  }
  throw failure;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    processAbortController.abort(new Error(`收到 ${signal} 信号`));
  });
}
const workerPidFile = process.env.TEMPLATE_CLI_JOURNEY_WORKER_PID_FILE;
if (workerPidFile !== undefined) {
  await writeFile(workerPidFile, `${process.pid}\n`);
}

const target = getRunTarget();
const discoveredJourneys = await discoverJourneys();
const journeys = discoveredJourneys.filter((journey) =>
  journey.modes.includes(target.mode),
);
if (journeys.length === 0) {
  throw new Error(`模式 ${target.mode} 没有可运行的 CLI 旅程`);
}

for (const journey of journeys) {
  void test(
    `${target.mode}: ${journey.name}`,
    { timeout: journey.timeoutMs ?? defaultJourneyTimeoutMs },
    async (testContext) => {
      const signal = AbortSignal.any([
        testContext.signal,
        processAbortController.signal,
      ]);
      await runJourney(target, journey, signal);
    },
  );
}
