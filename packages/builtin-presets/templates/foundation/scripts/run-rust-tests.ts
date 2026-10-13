import { spawn } from "node:child_process";

const testSummary =
  /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; \d+ ignored;/u;
const ansiEscape = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);
const zeroTestDiagnostic =
  "Cargo 未执行任何业务测试用例；请检查测试内容与 ignored 标记";
type InterruptSignal = "SIGINT" | "SIGTERM";

let executedTests = 0;
let stdoutRemainder = "";
let stderrRemainder = "";
let interruptedBy: InterruptSignal | undefined;

function countSummaryLine(line: string): void {
  const match = testSummary.exec(line.replace(ansiEscape, ""));
  if (match !== null) {
    executedTests += Number(match[1]) + Number(match[2]);
  }
}

function forwardSignal(signal: InterruptSignal): void {
  if (cargo.exitCode === null && cargo.signalCode === null) {
    interruptedBy = signal;
    try {
      if (process.platform !== "win32" && cargo.pid !== undefined) {
        process.kill(-cargo.pid, signal);
      } else {
        cargo.kill(signal);
      }
    } catch {
      cargo.kill(signal);
    }
  }
}

function forwardInterrupt(): void {
  forwardSignal("SIGINT");
}

function forwardTerminate(): void {
  forwardSignal("SIGTERM");
}

function consumeOutput(
  chunk: Buffer,
  stream: NodeJS.WriteStream,
  remainder: string,
  saveRemainder: (value: string) => void,
): void {
  stream.write(chunk);
  const lines = `${remainder}${chunk.toString("utf8")}`.split(/\r?\n/u);
  const lastLine = lines.pop();
  for (const line of lines) countSummaryLine(line);
  saveRemainder(lastLine ?? "");
}

const cargo = spawn("cargo", ["test", "--workspace"], {
  stdio: ["inherit", "pipe", "pipe"],
  detached: process.platform !== "win32",
});

process.on("SIGINT", forwardInterrupt);
process.on("SIGTERM", forwardTerminate);

cargo.stdout.on("data", (chunk: Buffer) =>
  consumeOutput(chunk, process.stdout, stdoutRemainder, (value) => {
    stdoutRemainder = value;
  }),
);
cargo.stderr.on("data", (chunk: Buffer) =>
  consumeOutput(chunk, process.stderr, stderrRemainder, (value) => {
    stderrRemainder = value;
  }),
);
cargo.once("error", (error) => {
  process.stderr.write(`无法启动 Cargo 测试：${error.message}\n`);
  process.exitCode = 1;
});
cargo.once("close", (code, signal) => {
  process.off("SIGINT", forwardInterrupt);
  process.off("SIGTERM", forwardTerminate);
  countSummaryLine(stdoutRemainder);
  countSummaryLine(stderrRemainder);

  if (interruptedBy !== undefined) {
    process.exitCode = interruptedBy === "SIGINT" ? 130 : 143;
  } else if (code !== null && code !== 0) {
    process.exitCode = code;
  } else if (signal !== null) {
    process.exitCode =
      signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
  } else if (executedTests === 0) {
    process.stderr.write(`${zeroTestDiagnostic}\n`);
    process.exitCode = 1;
  }
});
