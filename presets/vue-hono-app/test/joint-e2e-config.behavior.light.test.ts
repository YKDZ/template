import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlaywrightTestConfig } from "@playwright/test";

import configuration from "../resources/joint-e2e/playwright.config.ts";

void describe("Vue-Hono 联合浏览器验收配置", () => {
  void it("用实际包身份启动 web/API 并保留浏览器失败诊断", () => {
    const config: PlaywrightTestConfig = configuration;
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
  });
});
