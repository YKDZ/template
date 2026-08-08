import { loadTemplateDependencyCatalog } from "#template-core/dependency-catalog";
import type { DevelopmentContainerToolLayer } from "#template-core/development-container-tool-layer";

import { templateSources } from "../template-sources.ts";

export function githubCliDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  return {
    identity: "github-cli",
    dockerfile: {
      source: templateSources.sharedDevcontainer,
      from: "github-cli.Dockerfile",
    },
    requires: ["node-pnpm"],
    probes: [
      {
        identity: "github-cli",
        command: "gh",
        args: ["--version"],
      },
    ],
  };
}

export function browserTestDevelopmentContainerToolLayer(): DevelopmentContainerToolLayer {
  const playwrightTestVersion =
    loadTemplateDependencyCatalog()["@playwright/test"];
  if (playwrightTestVersion === undefined) {
    throw new Error(
      "Template Dependency Catalog is missing dependency: @playwright/test",
    );
  }

  return {
    identity: "browser-test",
    dockerfile: {
      source: templateSources.sharedDevcontainer,
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
