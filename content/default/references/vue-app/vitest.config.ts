import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

export default defineConfig(() =>
  mergeConfig(viteConfig, {
    test: {
      attachmentsDir: ".vitest/attachments",
      exclude: ["test/e2e/**", "node_modules/**", "dist/**"],
      projects: [
        {
          extends: true,
          test: {
            name: "node",
            include: ["test/**/*.node.test.ts"],
            environment: "node",
          },
        },
        {
          extends: true,
          test: {
            name: "browser",
            include: ["test/**/*.browser.test.ts"],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              screenshotFailures: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  }),
);
