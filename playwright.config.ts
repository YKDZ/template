import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";
import { jointE2eWorkspaceResources } from "@ykdz/template-workspace/joint-e2e";

const { default: configuration } = await import(
  jointE2eWorkspaceResources.configuration.href
);

export default defineConfig({
  ...configuration,
  testDir: fileURLToPath(jointE2eWorkspaceResources.testDirectory),
});
