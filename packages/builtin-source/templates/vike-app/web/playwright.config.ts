import { defineConfig, devices } from "@playwright/test";

const externalBaseUrlName = "PLAYWRIGHT_EXTERNAL_BASE_URL";

function externalBaseUrl(): string | undefined {
  if (!Object.hasOwn(process.env, externalBaseUrlName)) {
    return undefined;
  }

  const value = process.env[externalBaseUrlName]?.trim();
  if (!value) {
    throw new Error(`${externalBaseUrlName} must be a non-empty HTTP(S) URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${externalBaseUrlName} must be a valid HTTP(S) URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${externalBaseUrlName} must use HTTP or HTTPS`);
  }

  return url.toString();
}

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

const externalServiceUrl = externalBaseUrl();
const previewPort = externalServiceUrl
  ? undefined
  : requiredPort("PLAYWRIGHT_WEB_PORT");
const previewUrl = externalServiceUrl ?? `http://127.0.0.1:${previewPort}`;
const databaseFile = externalServiceUrl
  ? undefined
  : requiredEnv("DATABASE_FILE");

function shellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
  },
  ...(externalServiceUrl
    ? {}
    : {
        webServer: {
          command: `DATABASE_FILE=${shellValue(databaseFile!)} pnpm --dir ../../packages/db-migrations run db:prepare:test && PORT=${previewPort} node dist/server/index.mjs`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          url: previewUrl,
        },
      }),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
