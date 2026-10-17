import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type InterruptSignal = "SIGINT" | "SIGTERM";

type ChildCompletion = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

const maxRunDurationMs = 900_000;
const workerStartTimeoutMs = 10_000;
const cleanupGraceMs = 60_000;
const forcedCleanupTimeoutMs = 10_000;

const testArguments = [
  "--test",
  "--test-concurrency=1",
  "--test-timeout=1200000",
  "--test-reporter=spec",
  "--test-reporter=@ykdz/reference-typescript-config/reporter",
  "--test-reporter-destination=stdout",
  "--test-reporter-destination=stderr",
  "scripts/packed-publication/*.integration.test.ts",
];

function exitStatus(
  completion: ChildCompletion,
  interruptedBy: InterruptSignal | undefined,
  timedOut: boolean,
  spawnFailed: boolean,
  cleanupFailed: boolean,
): number {
  if (interruptedBy === "SIGINT") return 130;
  if (interruptedBy === "SIGTERM") return 143;
  if (timedOut || cleanupFailed || spawnFailed) return 1;
  if (completion.code !== null) return completion.code;
  if (completion.signal === "SIGINT") return 130;
  if (completion.signal === "SIGTERM") return 143;
  return 1;
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function workerPid(
  child: ChildProcess,
  completion: Promise<ChildCompletion>,
  pidFile: string,
): Promise<number | undefined> {
  const deadline = Date.now() + workerStartTimeoutMs;
  while (Date.now() < deadline && isRunning(child)) {
    const content = await readFile(pidFile, "utf8").catch(() => undefined);
    const pid = Number(content?.trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    const completed = await Promise.race([
      completion.then(() => true),
      delay(25).then(() => false),
    ]);
    if (completed) return undefined;
  }
  return undefined;
}

function sendSignalToWorker(pid: number, signal: InterruptSignal): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function sendSignalToProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (isMissingProcess(error)) return;
    child.kill(signal);
  }
}

async function waitForCompletion(
  completion: Promise<ChildCompletion>,
  timeoutMs: number,
): Promise<ChildCompletion | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopPackedWorker(
  child: ChildProcess,
  completion: Promise<ChildCompletion>,
  pidFile: string,
  signal: InterruptSignal,
): Promise<void> {
  const pid = await workerPid(child, completion, pidFile);
  if (pid !== undefined) {
    sendSignalToWorker(pid, signal);
  } else if (isRunning(child)) {
    process.stderr.write(
      "未在限定时间内取得 packed publication worker PID，将终止其原生测试进程组\n",
    );
    sendSignalToProcessGroup(child, signal);
  }

  if ((await waitForCompletion(completion, cleanupGraceMs)) !== undefined) {
    return;
  }

  process.stderr.write(
    "packed publication worker 未在清理时限内退出，将强制回收原生测试进程组\n",
  );
  sendSignalToProcessGroup(child, "SIGKILL");
  if (
    (await waitForCompletion(completion, forcedCleanupTimeoutMs)) === undefined
  ) {
    throw new Error("强制回收后原生测试进程仍未退出");
  }
}

async function run(): Promise<number> {
  let workspace: string | undefined;
  let child: ChildProcess | undefined;
  let completion: Promise<ChildCompletion> | undefined;
  let stopRequest: Promise<void> | undefined;
  let interruptedBy: InterruptSignal | undefined;
  let timedOut = false;
  let spawnFailed = false;
  let cleanupFailed = false;
  let status = 1;
  let pidFile: string | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const requestStop = (signal: InterruptSignal): Promise<void> => {
    if (
      child === undefined ||
      completion === undefined ||
      pidFile === undefined
    ) {
      return Promise.resolve();
    }
    stopRequest ??= stopPackedWorker(child, completion, pidFile, signal).catch(
      (error: unknown) => {
        cleanupFailed = true;
        process.stderr.write(
          `无法完整清理 packed publication 原生测试进程：${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (child !== undefined) {
          sendSignalToProcessGroup(child, "SIGKILL");
        }
      },
    );
    return stopRequest;
  };

  const forwardSignal = (signal: InterruptSignal): void => {
    interruptedBy ??= signal;
    void requestStop(interruptedBy);
  };
  const forwardInterrupt = (): void => forwardSignal("SIGINT");
  const forwardTerminate = (): void => forwardSignal("SIGTERM");

  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);

  try {
    workspace = await mkdtemp(join(tmpdir(), "template-packed-publication-"));
    pidFile = join(workspace, "test-worker.pid");
    if (interruptedBy !== undefined) {
      status = interruptedBy === "SIGINT" ? 130 : 143;
    } else {
      child = spawn(process.execPath, testArguments, {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-global-search-paths"]
            .filter(Boolean)
            .join(" "),
          TEMPLATE_ROOT_TEST_WORKER_PID_FILE: pidFile,
        },
        stdio: "inherit",
      });
      completion = new Promise<ChildCompletion>((resolveCompletion) => {
        child?.once("error", (error) => {
          spawnFailed = true;
          process.stderr.write(
            `无法启动 packed publication 原生测试：${error.message}\n`,
          );
        });
        child?.once("close", (code, signal) => {
          resolveCompletion({ code, signal });
        });
      });

      timeout = setTimeout(() => {
        timedOut = true;
        process.stderr.write("packed publication 原生测试超过总时限\n");
        void requestStop("SIGTERM");
      }, maxRunDurationMs);

      if (interruptedBy !== undefined) {
        void requestStop(interruptedBy);
      }

      const completed = await waitForCompletion(completion, maxRunDurationMs);
      if (completed === undefined) {
        timedOut = true;
        process.stderr.write("packed publication 原生测试超过总时限\n");
        await requestStop("SIGTERM");
      }
      const finalCompletion = await waitForCompletion(
        completion,
        cleanupGraceMs + workerStartTimeoutMs + forcedCleanupTimeoutMs,
      );
      if (finalCompletion === undefined) {
        cleanupFailed = true;
        sendSignalToProcessGroup(child, "SIGKILL");
        throw new Error("原生测试进程没有在有界清理期限内退出");
      }
      await stopRequest;
      status = exitStatus(
        finalCompletion,
        interruptedBy,
        timedOut,
        spawnFailed,
        cleanupFailed,
      );
    }
  } catch (error) {
    process.stderr.write(
      `packed publication 执行器失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    cleanupFailed = true;
    status =
      interruptedBy === "SIGINT" ? 130 : interruptedBy === "SIGTERM" ? 143 : 1;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTerminate);
    if (workspace !== undefined) {
      await rm(workspace, { force: true, recursive: true }).catch(
        (error: unknown) => {
          process.stderr.write(
            `无法清理 packed publication 临时目录：${error instanceof Error ? error.message : String(error)}\n`,
          );
          cleanupFailed = true;
        },
      );
    }
  }

  if (cleanupFailed && status === 0) return 1;
  return status;
}

process.exitCode = await run();
