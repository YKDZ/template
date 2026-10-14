import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { beforeEach } from "node:test";

const controller = new AbortController();
const pidFile =
  process.env.TEMPLATE_BUILTIN_PRESETS_INTEGRATION_WORKER_PID_FILE;
const signalFile = process.env.TEMPLATE_BUILTIN_PRESETS_INTEGRATION_SIGNAL_FILE;

function signalError(signal: NodeJS.Signals): Error {
  return new Error(`集成验收收到 ${signal}，正在停止当前安装型场景`);
}

function abortForSignal(signal: NodeJS.Signals): void {
  if (!controller.signal.aborted) controller.abort(signalError(signal));
}

if (
  process.env.NODE_TEST_CONTEXT === "child-v8" &&
  pidFile !== undefined &&
  signalFile !== undefined
) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => abortForSignal(signal));

  const priorSignal = readFileSync(signalFile, "utf8").trim();
  if (priorSignal === "SIGINT" || priorSignal === "SIGTERM")
    abortForSignal(priorSignal);

  writeFileSync(pidFile, `${process.pid}\n`);
  beforeEach((testContext) => {
    if (controller.signal.aborted && "skip" in testContext) {
      const reason = controller.signal.reason;
      testContext.skip(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  });
  process.once("exit", () => {
    try {
      if (readFileSync(pidFile, "utf8").trim() === String(process.pid))
        unlinkSync(pidFile);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  });
}

export function installedIntegrationSignal(signal?: AbortSignal): AbortSignal {
  return signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal]);
}

export function throwIfInstalledIntegrationWasCancelled(): void {
  if (controller.signal.aborted) throw controller.signal.reason;
}
