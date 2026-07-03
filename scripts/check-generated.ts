#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGeneratedScenarioSet } from "../src/generated-scenarios.js";
import { loadBuiltInPresetSourceManifest } from "../src/preset-source.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "src/cli.ts");

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-generated-"));
  let shouldRemoveWorkspace = false;

  try {
    await runGeneratedScenarioSet(
      loadBuiltInPresetSourceManifest(),
      "init",
      workspace,
      {
        repoRoot,
        cliPath,
      },
    );

    shouldRemoveWorkspace = true;
  } finally {
    if (shouldRemoveWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      console.error(
        `Generated check workspace preserved for debugging: ${workspace}`,
      );
    }
  }
}

await main();
