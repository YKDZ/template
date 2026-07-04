import { spawn } from "node:child_process";

const env: NodeJS.ProcessEnv = { ...process.env };
delete env.NO_COLOR;

const command = process.platform === "win32" ? "playwright.cmd" : "playwright";
const child = spawn(command, ["test", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

child.once("error", (error: Error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  if (signal) {
    console.error(`Playwright exited with signal ${signal}`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
