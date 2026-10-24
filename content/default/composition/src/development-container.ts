import type { DevelopmentContainerToolLayer } from "@ykdz/template-environment/development-container-tool-layer";

import { environmentSources } from "./default-environment-sources.ts";
import { loadTemplateDependencyCatalog } from "./dependency-catalog.ts";

/** 工作区当前 Playwright 事实由工作区持有，再交给环境层构造资源。 */
export function browserTestDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  const playwrightTestVersion =
    loadTemplateDependencyCatalog()["@playwright/test"];
  if (playwrightTestVersion === undefined) {
    throw new Error("模板依赖目录缺少依赖：@playwright/test");
  }
  return {
    identity: "browser-test",
    dockerfile: {
      source: environmentSources.devcontainer,
      from: "browser-test.Dockerfile",
    },
    requires: ["node-pnpm"],
    buildArguments: [
      {
        name: "PLAYWRIGHT_CLI_PACKAGE",
        value: `@playwright/test@${playwrightTestVersion}`,
      },
    ],
    probes: [
      {
        identity: "playwright",
        command: "npx",
        args: [
          "--yes",
          "--package",
          `@playwright/test@${playwrightTestVersion}`,
          "playwright",
          "--version",
        ],
      },
    ],
  };
}
