import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const databaseFile = fileURLToPath(
  new URL("../node_modules/.tmp/e2e.sqlite", import.meta.url),
);
const externalBaseUrlName = "PLAYWRIGHT_EXTERNAL_BASE_URL";
const externalReadinessTimeoutMs = 30_000;

function externalBaseUrl(): string | undefined {
  if (!Object.hasOwn(process.env, externalBaseUrlName)) {
    return undefined;
  }

  const value = process.env[externalBaseUrlName]?.trim();
  if (!value) {
    throw new Error(`${externalBaseUrlName} must be a non-empty HTTP(S) URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${externalBaseUrlName} must be a valid HTTP(S) URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${externalBaseUrlName} must use HTTP or HTTPS`);
  }

  return url.toString();
}

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

async function awaitExternalService(baseUrl: string): Promise<void> {
  const deadline = Date.now() + externalReadinessTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The externally managed service may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `External Playwright service at ${baseUrl} was not ready within ${externalReadinessTimeoutMs}ms`,
  );
}

async function localPlaywrightEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    DATABASE_FILE: process.env.DATABASE_FILE ?? databaseFile,
    PLAYWRIGHT_WEB_PORT:
      process.env.PLAYWRIGHT_WEB_PORT ?? (await availablePort()),
  };
}

const externalServiceUrl = externalBaseUrl();
const env = externalServiceUrl
  ? { ...process.env }
  : await localPlaywrightEnv();
const localDatabaseFile = externalServiceUrl ? undefined : env.DATABASE_FILE;
delete env.NO_COLOR;

if (externalServiceUrl) {
  await awaitExternalService(externalServiceUrl);
} else {
  await mkdir(path.dirname(localDatabaseFile!), { recursive: true });
  await rm(localDatabaseFile!, { force: true });
}

const command = process.platform === "win32" ? "playwright.cmd" : "playwright";
const child = spawn(command, ["test", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
const forwardSignal = (signal: NodeJS.Signals): void => {
  child.kill(signal);
};
for (const signal of forwardedSignals) {
  process.once(signal, forwardSignal);
}

try {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    console.error(`Playwright exited with signal ${result.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const signal of forwardedSignals) {
    process.removeListener(signal, forwardSignal);
  }

  if (localDatabaseFile) {
    await rm(localDatabaseFile, { force: true });
  }
}
