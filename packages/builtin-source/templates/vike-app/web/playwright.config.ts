import { fileURLToPath } from "node:url";

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
const databaseFile = fileURLToPath(
  new URL("./node_modules/.tmp/e2e.sqlite", import.meta.url),
);

function shellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: `DATABASE_FILE=${shellValue(databaseFile)} pnpm --dir ../../packages/db run db:push && DATABASE_FILE=${shellValue(databaseFile)} PORT=${previewPort} node dist/server/index.mjs`,
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
