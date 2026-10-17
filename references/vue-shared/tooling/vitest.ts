import { playwright } from "@vitest/browser-playwright";
import type { ConfigEnv, UserConfig, UserConfigExport } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";

function resolveViteConfig(
  config: UserConfigExport,
  configEnv: ConfigEnv,
): UserConfig | Promise<UserConfig> {
  return typeof config === "function" ? config(configEnv) : config;
}

export function defineVueTests(viteConfig: UserConfigExport) {
  return defineConfig(async (configEnv) => {
    const baseConfig = await resolveViteConfig(viteConfig, configEnv);

    return mergeConfig(
      baseConfig,
      defineConfig({
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
  });
}
