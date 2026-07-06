import { defineConfig, devices } from "@playwright/test";

const apiPort = 48787;
const webPort = 44173;
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
