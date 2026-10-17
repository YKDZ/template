import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";
import configuration from "@ykdz/template-workspace/assets/joint-e2e/playwright.config.ts";

export default defineConfig({
  ...configuration,
  testDir: fileURLToPath(
    import.meta.resolve("@ykdz/template-workspace/assets/joint-e2e/test/e2e"),
  ),
});
