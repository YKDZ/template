import { defineConfig, devices } from "@playwright/test";

const previewUrl = "http://127.0.0.1:{{VUE_PREVIEW_PORT}}";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm run preview --host 127.0.0.1 --port {{VUE_PREVIEW_PORT}}",
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
