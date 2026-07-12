#!/usr/bin/env node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { validatePlanPublicationSources } from "./registry-checks.ts";

/** Packs the Built-in Presets package and verifies plan-referenced source ships. */
export async function checkPresetPublicationSources(): Promise<void> {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const destination = await mkdtemp(
    path.join(tmpdir(), "template-builtin-pack-"),
  );
  try {
    await execa("pnpm", ["pack", "--pack-destination", destination], {
      cwd: packageRoot,
    });
    const archive = (await readdir(destination)).find((file) =>
      file.endsWith(".tgz"),
    );
    if (archive === undefined) {
      throw new Error("Built-in Presets pack produced no tarball");
    }
    const contents = await execa("tar", [
      "-tf",
      path.join(destination, archive),
    ]);
    validatePlanPublicationSources({
      packageRoot,
      packedPaths: contents.stdout.split("\n").filter(Boolean),
    });
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkPresetPublicationSources();
}
