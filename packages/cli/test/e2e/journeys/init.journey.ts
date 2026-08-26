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
    .find(
      (candidate) =>
        candidate.planPackageAddition !== undefined &&
        candidate.initialPrimaryPackage !== undefined,
    );
  if (definition === undefined) {
    throw new Error("init journey requires an addable Preset");
  }
  return definition.metadata.name;
}

function requireFixedTopologyPresetName(): string {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.initialPrimaryPackage === undefined);
  if (definition === undefined) {
    throw new Error("init journey requires a fixed-topology Preset");
  }
  return definition.metadata.name;
}

const addablePresetName = requireAddablePresetName();
const configurableDefinition = builtInPresetRegistry.require(addablePresetName);
const defaultLeafName =
  configurableDefinition.initialPrimaryPackage!.defaultLeafName;
const fixedTopologyPresetName = requireFixedTopologyPresetName();

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
          "--name",
          "runner",
          "--path",
          "tools/release",
          "--dry-run",
          "--json",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "fixed-topology identity override rejection",
        args: [
          "init",
          "fixed-rejected",
          "--preset",
          fixedTopologyPresetName,
          "--name",
          "renamed",
          "--yes",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "non-interactive rejection",
        args: ["init", "rejected", "--preset", addablePresetName],
        env: fallbackEnvironment,
      },
      {
        name: "invalid durable scope rejection",
        args: [
          "init",
          "invalid-scope",
          "--preset",
          addablePresetName,
          "--scope",
          ".bad",
          "--yes",
        ],
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
    assert.deepEqual(preview.resolved, {
      preset: addablePresetName,
      topology: "configurable-primary-package",
      packages: [{ name: "@acme/runner", path: "tools/release" }],
      scope: "acme",
    });
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
      /fixed initial package topology and does not accept --name or --path/u,
    );
    await assert.rejects(stat(path.join(context.workDir, "fixed-rejected")), {
      code: "ENOENT",
    });

    assert.equal(results[2]?.exitCode, 1);
    assert.match(
      results[2]?.stderr ?? "",
      /Non-interactive init requires --yes/u,
    );

    assert.equal(results[3]?.exitCode, 1);
    assert.match(
      results[3]?.stderr ?? "",
      /--scope must be a valid npm scope without whitespace/u,
    );
    await assert.rejects(stat(path.join(context.workDir, "invalid-scope")), {
      code: "ENOENT",
    });

    assert.equal(results[4]?.exitCode, 0);
    assert.deepEqual(JSON.parse(results[4]?.stdout ?? "").followUpDocument, {
      enabled: false,
    });
    assert.match(
      await readFile(
        path.join(
          context.workDir,
          `project/packages/${defaultLeafName}/package.json`,
        ),
        "utf8",
      ),
      new RegExp(`"name": "@acme/${defaultLeafName}"`, "u"),
    );
    await assert.rejects(stat(path.join(context.workDir, "project/TODO.md")), {
      code: "ENOENT",
    });

    assert.equal(results[5]?.exitCode, 1);
    assert.match(results[5]?.stderr ?? "", /Target directory is not empty/u);
  },
};

export default journey;
