#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { runGeneratedScenarioSet } from "@ykdz/template-core/generated-scenarios";

import { fixtureReplayCacheFromEnv } from "./fixture-replay-cache.ts";

const repoRoot =
  process.env.TEMPLATE_REPOSITORY_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");

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
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
        replayCache: fixtureReplayCacheFromEnv(),
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
