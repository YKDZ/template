import { defineConfig, devices } from "@playwright/test";

function workspacePortOffset(): number {
  let hash = 0;

  for (const character of process.cwd()) {
    hash = (hash * 31 + character.charCodeAt(0)) % 5_000;
  }

  return hash * 2;
}

const fallbackApiPort = 43_000 + workspacePortOffset();
const fallbackWebPort = fallbackApiPort + 1;
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? fallbackApiPort);
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? fallbackWebPort);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const apiHealthUrl = `${apiBaseUrl}/api/health`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: webBaseUrl,
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: `pnpm --dir ../api run build && PORT=${apiPort} pnpm --dir ../api run start`,
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
