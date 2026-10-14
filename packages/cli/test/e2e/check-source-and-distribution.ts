import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const livePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const liveRepositoryRoot = path.resolve(livePackageRoot, "..", "..");
const workspace = await mkdtemp(
  path.join(tmpdir(), "template-source-condition-"),
);
const repositoryRoot = path.join(workspace, "repository");
const ignoredDirectoryNames = new Set([
  ".git",
  ".fixture-evidence",
  ".fixture-evidence-activity",
  ".fixture-native-cache",
  ".fixture-workspace",
  ".npm",
  ".pnpm-store",
  ".scratch",
  ".turbo",
  ".cache",
  ".cli-journey-diagnostics",
  "node_modules",
  "target",
]);
const timeoutMs = 900_000;
const killGracePeriodMs = 5_000;
const cancellationGracePeriodMs = 10_000;
const cancellationController = new AbortController();
let receivedSignal: NodeJS.Signals | undefined;

type StageRecord = {
  readonly name: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut?: boolean;
  readonly isCanceled?: boolean;
  readonly durationMs?: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly nativeReportPath?: string;
};

const stages: StageRecord[] = [];
const outputs: {
  readonly name: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly native: boolean;
}[] = [];

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function errorDetails(error: unknown, seen = new Set<unknown>()): unknown {
  if (error instanceof Error) {
    if (seen.has(error))
      return { name: error.name, message: "[circular cause]" };
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

function handleSignal(signal: NodeJS.Signals): void {
  if (receivedSignal !== undefined) return;
  receivedSignal = signal;
  cancellationController.abort(new Error(`收到 ${signal} 信号`));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => handleSignal(signal));
}

function recordOutput(
  name: string,
  stdout: string,
  stderr: string,
  native = false,
): void {
  outputs.push({ name, stdout, stderr, native });
}

async function runStage(options: {
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly nativeReport?: boolean;
}): Promise<void> {
  const result = await execa(options.executable, options.args, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    reject: false,
    timeout: timeoutMs,
    cancelSignal: cancellationController.signal,
    killDescendants: true,
    forceKillAfterDelay: killGracePeriodMs,
  });
  recordOutput(
    options.name,
    result.stdout,
    result.stderr,
    options.nativeReport,
  );
  const failed = result.failed;
  if (failed) {
    throw new Error(
      `CLI 阶段 ${options.name} 失败，退出状态为 ${result.exitCode ?? result.signal ?? "unknown"}。`,
      { cause: result },
    );
  }
  stages.push({
    name: options.name,
    command: [options.executable, ...options.args],
    cwd: portablePath(path.relative(repositoryRoot, options.cwd)) || ".",
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    timedOut: result.timedOut,
    isCanceled: result.isCanceled,
    durationMs: result.durationMs,
    stdoutPath: "",
    stderrPath: "",
  });
}

async function runJourneyTests(options: {
  readonly name: "source-journeys" | "distribution-journeys";
  readonly cwd: string;
  readonly mode: "source" | "distribution";
}): Promise<void> {
  const diagnosticsDirectory =
    process.env.TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR ?? tmpdir();
  const workerPidFile = path.join(workspace, `${options.name}.worker.pid`);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TEMPLATE_CLI_JOURNEY_MODE: options.mode,
    TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR: diagnosticsDirectory,
    TEMPLATE_CLI_JOURNEY_WORKER_PID_FILE: workerPidFile,
  };
  delete environment.NODE_TEST_CONTEXT;
  const nodeArgs = [
    ...(options.mode === "source" ? ["--conditions=source"] : []),
    "--test",
    "--test-reporter=tap",
    "test/e2e/run-journeys.ts",
  ];
  const child = execa("node", nodeArgs, {
    cwd: options.cwd,
    env: environment,
    extendEnv: false,
    reject: false,
    killDescendants: false,
    detached: process.platform !== "win32",
  });
  let relayPromise: Promise<void> | undefined;
  let forcedTermination = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const relayCancellation = () => {
    relayPromise ??= (async () => {
      const signal = receivedSignal ?? "SIGTERM";
      forceKillTimer = setTimeout(() => {
        forcedTermination = true;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            ) {
              process.stderr.write(
                `无法结束 ${options.name} 进程组：${String(error)}\n`,
              );
            }
          }
        } else {
          child.kill("SIGKILL");
        }
      }, cancellationGracePeriodMs);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const workerPid = Number(
            (await readFile(workerPidFile, "utf8")).trim(),
          );
          if (Number.isSafeInteger(workerPid) && workerPid > 0) {
            try {
              process.kill(workerPid, signal);
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ESRCH"
                )
              ) {
                throw error;
              }
            }
            return;
          }
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        }
        await delay(25);
      }
      child.kill(signal);
    })();
  };
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    relayCancellation();
  }, timeoutMs);
  if (cancellationController.signal.aborted) {
    relayCancellation();
  } else {
    cancellationController.signal.addEventListener("abort", relayCancellation, {
      once: true,
    });
  }
  try {
    const result = await child;
    await relayPromise;
    recordOutput(options.name, result.stdout, result.stderr, true);
    if (result.failed || receivedSignal !== undefined || timedOut) {
      const reason =
        receivedSignal === undefined
          ? timedOut
            ? `超过 ${timeoutMs}ms 时限`
            : "失败"
          : `收到 ${receivedSignal} 后取消`;
      throw new Error(
        `CLI 阶段 ${options.name}${reason}，退出状态为 ${result.exitCode ?? result.signal ?? "unknown"}${forcedTermination ? "；已强制结束进程组" : ""}。`,
        { cause: result },
      );
    }
    stages.push({
      name: options.name,
      command: ["node", ...nodeArgs],
      cwd: portablePath(path.relative(repositoryRoot, options.cwd)) || ".",
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      timedOut: result.timedOut,
      isCanceled: result.isCanceled,
      durationMs: result.durationMs,
      stdoutPath: "",
      stderrPath: "",
      nativeReportPath: "node-test-report.tap",
    });
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    cancellationController.signal.removeEventListener(
      "abort",
      relayCancellation,
    );
  }
}

async function copyRepositoryDiagnostics(destination: string): Promise<void> {
  await cp(repositoryRoot, destination, {
    recursive: true,
    filter(source) {
      const relativePath = portablePath(path.relative(repositoryRoot, source));
      if (
        relativePath
          .split("/")
          .some((segment) => ignoredDirectoryNames.has(segment))
      ) {
        return false;
      }
      return !/^packages\/[^/]+\/dist(?:\/|$)/u.test(relativePath);
    },
  });
}

async function preserveFailure(error: unknown): Promise<string> {
  const parent = process.env.TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const diagnostics = await mkdtemp(
    path.join(parent, "template-source-distribution-"),
  );
  const snapshotRoot = path.join(diagnostics, "repository");
  let copiedRepository = false;
  const preservationErrors: unknown[] = [];
  try {
    await copyRepositoryDiagnostics(snapshotRoot);
    copiedRepository = true;
  } catch (copyError) {
    preservationErrors.push(copyError);
  }

  const stageRecords: StageRecord[] = [];
  for (const output of outputs) {
    const stdoutName = `${output.name}.stdout.log`;
    const stderrName = `${output.name}.stderr.log`;
    try {
      await writeFile(path.join(diagnostics, stdoutName), output.stdout);
      await writeFile(path.join(diagnostics, stderrName), output.stderr);
      stageRecords.push({
        name: output.name,
        command: [],
        cwd: ".",
        stdoutPath: stdoutName,
        stderrPath: stderrName,
        ...(output.native ? { nativeReportPath: stdoutName } : {}),
      });
      if (output.native) {
        await writeFile(
          path.join(diagnostics, "node-test-report.tap"),
          output.stdout,
        );
      }
    } catch (writeError) {
      preservationErrors.push(writeError);
    }
  }

  try {
    await writeFile(
      path.join(diagnostics, "failure.json"),
      `${JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          repository: copiedRepository ? snapshotRoot : repositoryRoot,
          copiedRepository,
          workspace: repositoryRoot,
          stages: stages.map((stage) => ({
            ...stage,
            stdoutPath: stageRecords.find(
              (record) => record.name === stage.name,
            )?.stdoutPath,
            stderrPath: stageRecords.find(
              (record) => record.name === stage.name,
            )?.stderrPath,
          })),
          reports: stageRecords,
          error: errorDetails(error),
          preservationErrors: preservationErrors.map((error) =>
            errorDetails(error),
          ),
          reproduction: [
            "cd repository",
            "pnpm install --frozen-lockfile",
            "cd packages/cli",
            `TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR=${JSON.stringify(diagnostics)} TEMPLATE_CLI_JOURNEY_MODE=source node --conditions=source --test --test-reporter=tap test/e2e/run-journeys.ts`,
            "cd ../..",
            "TURBO_FORCE=true pnpm run build",
            "cd packages/cli",
            `TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR=${JSON.stringify(diagnostics)} TEMPLATE_CLI_JOURNEY_MODE=distribution node --test --test-reporter=tap test/e2e/run-journeys.ts`,
          ],
          cleanup: {
            originalWorkspace: workspace,
            retryCommand: `rm -rf ${JSON.stringify(workspace)}`,
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (writeError) {
    preservationErrors.push(writeError);
  }
  return diagnostics;
}

async function removeWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

async function main(): Promise<void> {
  await cp(liveRepositoryRoot, repositoryRoot, {
    recursive: true,
    filter(source) {
      const relativePath = portablePath(
        path.relative(liveRepositoryRoot, source),
      );
      if (
        relativePath
          .split("/")
          .some((segment) => ignoredDirectoryNames.has(segment))
      ) {
        return false;
      }
      return !/^packages\/[^/]+\/dist(?:\/|$)/u.test(relativePath);
    },
  });
  const packageRoot = path.join(repositoryRoot, "packages", "cli");
  for (const packageName of ["builtin-presets", "checks", "cli", "core"]) {
    await rm(path.join(repositoryRoot, "packages", packageName, "dist"), {
      recursive: true,
      force: true,
    });
  }

  await runStage({
    name: "pnpm-install",
    executable: "pnpm",
    args: ["install", "--frozen-lockfile"],
    cwd: repositoryRoot,
  });

  await runStage({
    name: "source-resolution-check",
    executable: "node",
    args: ["--conditions=source", "test/e2e/assert-source-resolutions.ts"],
    cwd: packageRoot,
  });

  await runJourneyTests({
    name: "source-journeys",
    cwd: packageRoot,
    mode: "source",
  });

  await runStage({
    name: "turbo-build",
    executable: "pnpm",
    args: [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=!//",
      "--force",
      "--output-logs=errors-only",
    ],
    cwd: repositoryRoot,
  });

  await runJourneyTests({
    name: "distribution-journeys",
    cwd: packageRoot,
    mode: "distribution",
  });
}

try {
  await main();
  await removeWorkspace(workspace);
} catch (error) {
  const diagnostics = await preserveFailure(error);
  process.stderr.write(`\nCLI_E2E_DIAGNOSTICS=${diagnostics}\n`);
  process.stderr.write(
    `CLI 端到端验收失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (receivedSignal !== undefined) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  } else {
    process.exitCode = 1;
  }
}
