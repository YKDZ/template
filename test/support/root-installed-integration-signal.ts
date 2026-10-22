import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "node:test";

const controller = new AbortController();
const workerDirectory = process.env.TEMPLATE_ROOT_INTEGRATION_WORKER_DIRECTORY;
const signalFile = process.env.TEMPLATE_ROOT_INTEGRATION_SIGNAL_FILE;

function abortForSignal(signal: NodeJS.Signals): void {
  if (!controller.signal.aborted) {
    controller.abort(
      new Error(`集成验收收到 ${signal}，正在停止当前安装型场景`),
    );
  }
}

if (
  process.env.NODE_TEST_CONTEXT === "child-v8" &&
  workerDirectory !== undefined &&
  signalFile !== undefined
) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abortForSignal(signal));
  }

  const priorSignal = readFileSync(signalFile, "utf8").trim();
  if (priorSignal === "SIGINT" || priorSignal === "SIGTERM") {
    abortForSignal(priorSignal);
  }

  const workerFile = join(workerDirectory, `${process.pid}.pid`);
  writeFileSync(workerFile, `${process.pid}\n`);
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
      if (readFileSync(workerFile, "utf8").trim() === String(process.pid)) {
        unlinkSync(workerFile);
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  });
}

export function rootInstalledIntegrationSignal(
  signal?: AbortSignal,
): AbortSignal {
  return signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal]);
}
