import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { builtInPresetRegistry } from "#template-builtin-presets";

import type { CliJourney } from "../journey.ts";

const fallbackEnvironment = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

function requireAddablePresetName(): string {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.planPackageAddition !== undefined);
  if (definition === undefined) {
    throw new Error("init journey requires an addable Preset");
  }
  return definition.metadata.name;
}

const addablePresetName = requireAddablePresetName();

const journey: CliJourney = {
  name: "init",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands() {
    return [
      {
        name: "dry-run JSON",
        args: [
          "init",
          "preview",
          "--preset",
          addablePresetName,
          "--scope",
          "@acme",
          "--dry-run",
          "--json",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "non-interactive rejection",
        args: ["init", "rejected", "--preset", addablePresetName],
        env: fallbackEnvironment,
      },
      {
        name: "successful JSON without TODO",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
          "--yes",
          "--json",
          "--no-todo",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "existing target conflict",
        args: ["init", "project", "--preset", addablePresetName, "--yes"],
        env: fallbackEnvironment,
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);
    const preview = JSON.parse(results[0]?.stdout ?? "");
    assert.equal(preview.command, "init");
    assert.equal(preview.dryRun, true);
    assert.equal(preview.targetDir, "preview");
    assert.deepEqual(preview.followUpDocument, {
      enabled: true,
      path: "TODO.md",
    });
    await assert.rejects(stat(path.join(context.workDir, "preview")), {
      code: "ENOENT",
    });

    assert.equal(results[1]?.exitCode, 1);
    assert.match(
      results[1]?.stderr ?? "",
      /Non-interactive init requires --yes/u,
    );

    assert.equal(results[2]?.exitCode, 0);
    assert.deepEqual(JSON.parse(results[2]?.stdout ?? "").followUpDocument, {
      enabled: false,
    });
    assert.match(
      await readFile(
        path.join(context.workDir, "project/packages/project/package.json"),
        "utf8",
      ),
      /"name": "@acme\/project"/u,
    );
    await assert.rejects(stat(path.join(context.workDir, "project/TODO.md")), {
      code: "ENOENT",
    });

    assert.equal(results[3]?.exitCode, 1);
    assert.match(results[3]?.stderr ?? "", /Target directory is not empty/u);
  },
};

export default journey;
