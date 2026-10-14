import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const packageRoot = process.cwd();
const ownerDirectory = await mkdtemp(
  path.join(tmpdir(), "template-builtin-presets-integration-owner-"),
);
const signalFile = path.join(ownerDirectory, "signal.txt");
const workerPidFile = path.join(ownerDirectory, "worker.pid");
await writeFile(signalFile, "");
const forwardedArguments = process.argv.slice(2);
if (forwardedArguments[0] === "--") forwardedArguments.shift();

const runnerArguments = [
  "--conditions=source",
  "--experimental-strip-types",
  "--import=./test-support/setup.ts",
  "--test",
  "--test-concurrency=1",
  "--test-timeout=300000",
  "--test-reporter=spec",
  "--test-reporter=@ykdz/template-builtin-presets/node-test-count-reporter",
  "--test-reporter-destination=stdout",
  "--test-reporter-destination=stderr",
  ...forwardedArguments,
  "src/**/*.integration.test.ts",
];
const runner = spawn(process.execPath, runnerArguments, {
  cwd: packageRoot,
  env: {
    ...process.env,
    TEMPLATE_BUILTIN_PRESETS_INTEGRATION_SIGNAL_FILE: signalFile,
    TEMPLATE_BUILTIN_PRESETS_INTEGRATION_WORKER_PID_FILE: workerPidFile,
  },
  detached: process.platform !== "win32",
  stdio: "inherit",
});

type Signal = "SIGINT" | "SIGTERM";
let receivedSignal: Signal | undefined;
let relay: Promise<void> | undefined;
let relayFailure: unknown;
let forcedTermination = false;
let childClosed = false;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

async function readWorkerPid(): Promise<number | undefined> {
  const candidate = Number(
    (await readFile(workerPidFile, "utf8").catch(() => "")).trim(),
  );
  if (!Number.isSafeInteger(candidate) || candidate < 2) return undefined;
  try {
    process.kill(candidate, 0);
    return candidate;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return undefined;
    throw error;
  }
}

async function relaySignal(signal: Signal): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (childClosed) return;
    const workerPid = await readWorkerPid();
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, signal);
        return;
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error;
      }
    }
    await delay(25);
  }
  throw new Error("未能在 5 秒内取得当前原生测试文件的 worker PID");
}

function stopRunnerGroup(signal: NodeJS.Signals): void {
  if (runner.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-runner.pid, signal);
    else runner.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

function handleSignal(signal: Signal): void {
  if (receivedSignal !== undefined) return;
  receivedSignal = signal;
  relay = writeFile(signalFile, `${signal}\n`)
    .then(() => relaySignal(signal))
    .catch((error: unknown) => {
      relayFailure = error;
      process.stderr.write(`无法转发集成取消信号：${String(error)}\n`);
    });
  forceKillTimer = setTimeout(() => {
    forcedTermination = true;
    process.stderr.write(
      "集成测试未在 30 秒内完成取消清理，将结束其原生进程组。\n",
    );
    stopRunnerGroup("SIGKILL");
  }, 30_000);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

try {
  const completion = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    runner.once("error", reject);
    runner.once("close", (code, signal) => {
      childClosed = true;
      resolve({ code, signal });
    });
  });
  await relay;
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  if (receivedSignal !== undefined) {
    process.exitCode =
      relayFailure !== undefined || forcedTermination
        ? 1
        : receivedSignal === "SIGINT"
          ? 130
          : 143;
  } else {
    process.exitCode =
      completion.code ?? (completion.signal === "SIGINT" ? 130 : 1);
  }
} catch (error) {
  process.stderr.write(
    `builtin-presets 原生集成测试 owner 失败：${String(error)}\n`,
  );
  stopRunnerGroup("SIGKILL");
  process.exitCode = 1;
} finally {
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  try {
    await rm(ownerDirectory, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`无法清理集成测试 owner 状态：${String(error)}\n`);
    process.exitCode = 1;
  }
}
