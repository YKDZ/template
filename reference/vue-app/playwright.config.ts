import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(webRoot, "node_modules/.tmp/playwright-port");

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

async function sharedPort(envName: string): Promise<string> {
  const envPort = process.env[envName];
  if (envPort !== undefined) {
    return envPort;
  }
  try {
    return await readFile(stateFile, "utf8");
  } catch {
    const port = await availablePort();
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, port, "utf8");
    return port;
  }
}

const previewPort = await sharedPort("PLAYWRIGHT_WEB_PORT");
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html"]],
  webServer: {
    command: `pnpm run preview --host 127.0.0.1 --port ${previewPort}`,
    reuseExistingServer: !process.env.CI,
    url: previewUrl,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
