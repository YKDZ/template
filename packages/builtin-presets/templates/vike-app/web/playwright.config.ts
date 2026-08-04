import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const externalBaseUrlName = "PLAYWRIGHT_EXTERNAL_BASE_URL";
const externalReadinessTimeoutMs = 30_000;
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const migrationsRoot = path.resolve(webRoot, "../../packages/db-migrations");
const databaseFile = path.join(webRoot, "node_modules/.tmp/e2e.sqlite");
const stateFile = path.join(webRoot, "node_modules/.tmp/playwright-port");

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

async function sharedPort(envName: string): Promise<{
  readonly port: string;
  readonly prepared: boolean;
}> {
  const envPort = process.env[envName];
  if (envPort !== undefined) {
    return { port: envPort, prepared: false };
  }
  try {
    return { port: await readFile(stateFile, "utf8"), prepared: false };
  } catch {
    const port = await availablePort();
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, port, "utf8");
    return { port, prepared: true };
  }
}

function prepareLocalDatabase(): void {
  rmSync(databaseFile, { force: true });
  execFileSync("pnpm", ["run", "db:push"], {
    cwd: migrationsRoot,
    env: { ...process.env, DATABASE_FILE: databaseFile },
    stdio: "inherit",
  });
}

const externalServiceUrl = externalBaseUrl();
let previewUrl: string;

if (externalServiceUrl === undefined) {
  const { port, prepared } = await sharedPort("PLAYWRIGHT_WEB_PORT");
  previewUrl = `http://127.0.0.1:${port}`;
  process.env.DATABASE_FILE = databaseFile;
  process.env.PORT = port;
  if (prepared) {
    prepareLocalDatabase();
  }
} else {
  previewUrl = externalServiceUrl;
  await awaitExternalService(externalServiceUrl);
}

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html"]],
  globalTeardown: "./test/playwright-teardown.ts",
  ...(externalServiceUrl === undefined
    ? {
        webServer: {
          command: "node dist/server/index.mjs",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          url: previewUrl,
        },
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
