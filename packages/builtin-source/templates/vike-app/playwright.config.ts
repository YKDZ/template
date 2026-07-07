import { defineConfig, devices } from "@playwright/test";

const previewUrl = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "DATABASE_FILE=./node_modules/.tmp/e2e.sqlite pnpm run db:push && DATABASE_FILE=./node_modules/.tmp/e2e.sqlite PORT=4173 node dist/server/index.mjs",
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
