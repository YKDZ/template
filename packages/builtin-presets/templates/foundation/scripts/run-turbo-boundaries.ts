import { spawn } from "node:child_process";

const turbo = spawn("pnpm", ["exec", "turbo", "boundaries", "--no-color"], {
  stdio: "inherit",
});

turbo.once("error", (error) => {
  process.stderr.write(`无法运行 Turbo boundaries：${error.message}\n`);
  process.exitCode = 1;
});

turbo.once("close", (code, signal) => {
  if (code !== null) {
    process.exitCode = code;
  } else if (signal === "SIGINT") {
    process.exitCode = 130;
  } else if (signal === "SIGTERM") {
    process.exitCode = 143;
  } else {
    process.exitCode = 1;
  }
});
