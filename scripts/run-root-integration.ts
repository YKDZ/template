import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Signal = "SIGINT" | "SIGTERM";

const packageRoot = process.cwd();
const ownerDirectory = await mkdtemp(
  path.join(tmpdir(), "template-root-integration-owner-"),
);
const signalFile = path.join(ownerDirectory, "signal.txt");
const workerDirectory = path.join(ownerDirectory, "workers");
await writeFile(signalFile, "");
await mkdir(workerDirectory);

const forwardedArguments = process.argv.slice(2);
if (forwardedArguments[0] === "--") forwardedArguments.shift();

const runnerArguments = [
  "--conditions=source",
  "--experimental-strip-types",
  "--import=./test/support/root-installed-integration-signal.ts",
  "--test",
  "--test-concurrency=2",
  "--test-timeout=300000",
  "--test-reporter=spec",
  ...forwardedArguments,
  "test/*.integration.test.ts",
];

const runner = spawn(process.execPath, runnerArguments, {
  cwd: packageRoot,
  env: {
    ...process.env,
    TEMPLATE_ROOT_INTEGRATION_SIGNAL_FILE: signalFile,
    TEMPLATE_ROOT_INTEGRATION_WORKER_DIRECTORY: workerDirectory,
  },
  detached: process.platform !== "win32",
  stdio: "inherit",
});

let receivedSignal: Signal | undefined;
let relay: Promise<void> | undefined;
let relayFailure: unknown;
let forcedTermination = false;
let childClosed = false;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
let runTimer: ReturnType<typeof setTimeout> | undefined;
let timedOut = false;
let keepOwnerDirectory = false;

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function signalWorker(pid: number, signal: Signal): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function stopRunnerGroup(signal: NodeJS.Signals): void {
  if (runner.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-runner.pid, signal);
    else runner.kill(signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function registeredWorkerPids(): Promise<number[]> {
  const names = await readdir(workerDirectory).catch(() => []);
  const pids: number[] = [];
  for (const name of names) {
    if (!name.endsWith(".pid")) continue;
    const file = path.join(workerDirectory, name);
    const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (!Number.isSafeInteger(pid) || pid < 2) continue;
    try {
      process.kill(pid, 0);
      pids.push(pid);
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
      await rm(file, { force: true });
    }
  }
  return pids;
}

async function relaySignal(signal: Signal): Promise<void> {
  const signaled = new Set<number>();
  while (true) {
    if (forcedTermination && childClosed) return;
    if (childClosed) {
      const workers = await registeredWorkerPids();
      if (workers.length === 0) return;
      for (const pid of workers) {
        if (signaled.has(pid)) continue;
        signalWorker(pid, signal);
        signaled.add(pid);
      }
      await delay(25);
      continue;
    }

    for (const pid of await registeredWorkerPids()) {
      if (signaled.has(pid)) continue;
      signalWorker(pid, signal);
      signaled.add(pid);
    }
    await delay(25);
  }
}

function handleSignal(signal: Signal): void {
  if (receivedSignal !== undefined) return;
  receivedSignal = signal;
  relay = writeFile(signalFile, `${signal}\n`)
    .then(() => relaySignal(signal))
    .catch((error: unknown) => {
      relayFailure = error;
      keepOwnerDirectory = true;
      process.stderr.write(`无法转发根集成取消信号：${String(error)}\n`);
    });
  cleanupTimer = setTimeout(() => {
    forcedTermination = true;
    process.stderr.write(
      "根集成测试未在 30 秒内完成取消清理，将结束其原生进程组\n",
    );
    stopRunnerGroup("SIGKILL");
  }, 30_000);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
runTimer = setTimeout(() => {
  timedOut = true;
  handleSignal("SIGTERM");
}, 900_000);

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
  if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  if (timedOut || relayFailure !== undefined || forcedTermination) {
    process.exitCode = 1;
  } else if (receivedSignal !== undefined) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  } else {
    process.exitCode =
      completion.code ?? (completion.signal === "SIGINT" ? 130 : 1);
  }
} catch (error) {
  keepOwnerDirectory = true;
  process.stderr.write(`根集成测试owner失败：${String(error)}\n`);
  stopRunnerGroup("SIGKILL");
  process.exitCode = 1;
} finally {
  if (runTimer !== undefined) clearTimeout(runTimer);
  if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  if (keepOwnerDirectory || forcedTermination || relayFailure !== undefined) {
    process.stderr.write(`保留根集成owner状态：${ownerDirectory}\n`);
  } else {
    try {
      await rm(ownerDirectory, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`无法清理根集成owner状态：${String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
