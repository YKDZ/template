import { defineConfig, devices } from "@playwright/test";

function requiredPort(name: string): number {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set by scripts/run-playwright.ts`);
  }

  return Number(value);
}

const apiPort = requiredPort("PLAYWRIGHT_API_PORT");
const webPort = requiredPort("PLAYWRIGHT_WEB_PORT");
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
      command: `pnpm --dir ../api run build:run && PORT=${apiPort} pnpm --dir ../api run start`,
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
