import { spawn } from "node:child_process";

type InterruptSignal = "SIGINT" | "SIGTERM";

let interruptedBy: InterruptSignal | undefined;
let spawnFailed = false;

const turbo = spawn("pnpm", ["exec", "turbo", "boundaries", "--no-color"], {
  stdio: "inherit",
  detached: process.platform !== "win32",
});

function forwardSignal(signal: InterruptSignal): void {
  if (turbo.exitCode !== null || turbo.signalCode !== null) return;

  interruptedBy ??= signal;
  try {
    if (process.platform !== "win32" && turbo.pid !== undefined) {
      process.kill(-turbo.pid, signal);
    } else {
      turbo.kill(signal);
    }
  } catch {
    turbo.kill(signal);
  }
}

function forwardInterrupt(): void {
  forwardSignal("SIGINT");
}

function forwardTerminate(): void {
  forwardSignal("SIGTERM");
}

process.on("SIGINT", forwardInterrupt);
process.on("SIGTERM", forwardTerminate);

turbo.once("error", (error) => {
  spawnFailed = true;
  process.stderr.write(`无法运行 Turbo boundaries：${error.message}\n`);
});

turbo.once("close", (code, signal) => {
  process.off("SIGINT", forwardInterrupt);
  process.off("SIGTERM", forwardTerminate);

  if (interruptedBy !== undefined) {
    process.exitCode = interruptedBy === "SIGINT" ? 130 : 143;
  } else if (spawnFailed) {
    process.exitCode = 1;
  } else if (code !== null) {
    process.exitCode = code;
  } else if (signal === "SIGINT") {
    process.exitCode = 130;
  } else if (signal === "SIGTERM") {
    process.exitCode = 143;
  } else {
    process.exitCode = 1;
  }
});
