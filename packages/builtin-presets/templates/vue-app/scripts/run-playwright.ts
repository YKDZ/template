import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function availablePort(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address !== "object" || address === null) {
        server.close(() => {
          reject(new Error("Could not allocate a Playwright web port"));
        });
        return;
      }

      const port = String(address.port);
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function playwrightEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    PLAYWRIGHT_WEB_PORT:
      process.env.PLAYWRIGHT_WEB_PORT ?? (await availablePort()),
  };
}

const env = await playwrightEnv();
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
