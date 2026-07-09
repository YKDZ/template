import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const databaseFile = fileURLToPath(
  new URL("../node_modules/.tmp/e2e.sqlite", import.meta.url),
);

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
    DATABASE_FILE: process.env.DATABASE_FILE ?? databaseFile,
    PLAYWRIGHT_WEB_PORT:
      process.env.PLAYWRIGHT_WEB_PORT ?? (await availablePort()),
  };
}

const env = await playwrightEnv();
delete env.NO_COLOR;
await rm(env.DATABASE_FILE!, { force: true });

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
  void rm(env.DATABASE_FILE!, { force: true }).finally(() => {
    if (signal) {
      console.error(`Playwright exited with signal ${signal}`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = code ?? 1;
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    child.kill(signal);
    void rm(env.DATABASE_FILE!, { force: true }).finally(() => {
      process.exitCode = 1;
    });
  });
}
