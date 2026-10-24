import { defineConfig, devices } from "@playwright/test";

const apiPackageName = "@ykdz/reference-hono-api";
const webPackageName = "@ykdz/reference-vue-hono-web";

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "0";
const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "0";

export default defineConfig({
  testDir: "./test/e2e",
  reporter: [["list"], ["html"]],
  use: {
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: `pnpm --filter ${apiPackageName} --fail-if-no-match run start`,
      env: { PORT: apiPort },
      wait: {
        stdout:
          /Hono API listening on (?<VITE_API_BASE_URL>http:\/\/localhost:\d+)/,
      },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter ${webPackageName} --fail-if-no-match run preview --host 127.0.0.1 --strictPort`,
      env: { PLAYWRIGHT_WEB_PORT: webPort },
      wait: {
        stdout: /Local:\s+(?<PLAYWRIGHT_WEB_URL>http:\/\/127\.0\.0\.1:\d+)/,
      },
      reuseExistingServer: false,
    },
  ],
});
