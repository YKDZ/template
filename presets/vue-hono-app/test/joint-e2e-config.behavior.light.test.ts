import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlaywrightTestConfig } from "@playwright/test";

const configurationUrl = new URL(
  "../resources/joint-e2e/playwright.config.ts",
  import.meta.url,
);

async function loadConfiguration(
  caseName: string,
): Promise<{ default: PlaywrightTestConfig }> {
  return import(`${configurationUrl.href}?case=${caseName}`) as Promise<{
    default: PlaywrightTestConfig;
  }>;
}

void describe("Vue-Hono 联合浏览器验收配置", () => {
  void it("用实际包身份启动 web/API 并保留浏览器失败诊断", async () => {
    const previousEnvironment = {
      api: process.env.PLAYWRIGHT_API_PACKAGE_NAME,
      web: process.env.PLAYWRIGHT_WEB_PACKAGE_NAME,
    };
    process.env.PLAYWRIGHT_API_PACKAGE_NAME = "@ykdz/reference-hono-api";
    process.env.PLAYWRIGHT_WEB_PACKAGE_NAME = "@ykdz/reference-vue-hono-web";

    try {
      const { default: config } = await loadConfiguration("with-identities");
      const webServers = config.webServer;
      assert.ok(Array.isArray(webServers));

      assert.deepStrictEqual(
        webServers.map((server: { command: string }) => server.command),
        [
          "pnpm --filter @ykdz/reference-hono-api --fail-if-no-match run start",
          "pnpm --filter @ykdz/reference-vue-hono-web --fail-if-no-match run preview --host 127.0.0.1 --strictPort",
        ],
      );
      assert.strictEqual(config.use?.trace, "retain-on-failure");
      const reporters = config.reporter;
      assert.ok(Array.isArray(reporters));
      assert.deepStrictEqual(
        reporters.map((reporter) =>
          Array.isArray(reporter) ? reporter[0] : reporter,
        ),
        ["list", "html"],
      );
    } finally {
      if (previousEnvironment.api === undefined) {
        delete process.env.PLAYWRIGHT_API_PACKAGE_NAME;
      } else {
        process.env.PLAYWRIGHT_API_PACKAGE_NAME = previousEnvironment.api;
      }
      if (previousEnvironment.web === undefined) {
        delete process.env.PLAYWRIGHT_WEB_PACKAGE_NAME;
      } else {
        process.env.PLAYWRIGHT_WEB_PACKAGE_NAME = previousEnvironment.web;
      }
    }
  });

  void it("缺少实际 API/web 包身份时拒绝加载", async () => {
    const previousEnvironment = {
      api: process.env.PLAYWRIGHT_API_PACKAGE_NAME,
      web: process.env.PLAYWRIGHT_WEB_PACKAGE_NAME,
    };
    delete process.env.PLAYWRIGHT_API_PACKAGE_NAME;
    delete process.env.PLAYWRIGHT_WEB_PACKAGE_NAME;

    try {
      await assert.rejects(loadConfiguration("without-identities"), {
        message: "Vue-Hono Playwright 配置缺少实际 API 与 web 包身份",
      });
    } finally {
      if (previousEnvironment.api === undefined) {
        delete process.env.PLAYWRIGHT_API_PACKAGE_NAME;
      } else {
        process.env.PLAYWRIGHT_API_PACKAGE_NAME = previousEnvironment.api;
      }
      if (previousEnvironment.web === undefined) {
        delete process.env.PLAYWRIGHT_WEB_PACKAGE_NAME;
      } else {
        process.env.PLAYWRIGHT_WEB_PACKAGE_NAME = previousEnvironment.web;
      }
    }
  });
});
