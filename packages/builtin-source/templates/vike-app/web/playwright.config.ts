import { defineConfig, devices } from "@playwright/test";

function requiredPort(name: string): number {
  return Number(requiredEnv(name));
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set by scripts/run-playwright.ts`);
  }

  return value;
}

const previewPort = requiredPort("PLAYWRIGHT_WEB_PORT");
const previewUrl = `http://127.0.0.1:${previewPort}`;
const databaseFile = requiredEnv("DATABASE_FILE");

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
    command: `DATABASE_FILE=${shellValue(databaseFile)} pnpm --dir ../../packages/db run db:prepare:test && PORT=${previewPort} node dist/server/index.mjs`,
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
