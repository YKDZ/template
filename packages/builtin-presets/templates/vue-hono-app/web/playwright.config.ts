import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(webRoot, "node_modules/.tmp/playwright-ports");

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

async function sharedPorts(): Promise<{
  readonly api: string;
  readonly web: string;
}> {
  const envApi = process.env.PLAYWRIGHT_API_PORT;
  const envWeb = process.env.PLAYWRIGHT_WEB_PORT;
  if (envApi !== undefined && envWeb !== undefined) {
    return { api: envApi, web: envWeb };
  }
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as {
      readonly api: string;
      readonly web: string;
    };
    return parsed;
  } catch {
    const ports = {
      api: envApi ?? (await availablePort()),
      web: envWeb ?? (await availablePort()),
    };
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(ports), "utf8");
    return ports;
  }
}

const { api: apiPort, web: webPort } = await sharedPorts();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const apiHealthUrl = `${apiBaseUrl}/api/health`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: webBaseUrl,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  reporter: [["list"], ["html"]],
  webServer: [
    {
      command: `PORT=${apiPort} pnpm --dir ../api run start`,
      url: apiHealthUrl,
      reuseExistingServer: false,
    },
    {
      command: `VITE_API_BASE_URL=${apiBaseUrl} pnpm run preview --host 127.0.0.1 --port ${webPort}`,
      url: webBaseUrl,
      reuseExistingServer: false,
    },
  ],
});
