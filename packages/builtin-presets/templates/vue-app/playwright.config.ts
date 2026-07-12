import { defineConfig, devices } from "@playwright/test";

function requiredPort(name: string): number {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set by scripts/run-playwright.ts`);
  }

  return Number(value);
}

const previewPort = requiredPort("PLAYWRIGHT_WEB_PORT");
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
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
