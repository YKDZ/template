import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { builtInPresetRegistry } from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";

import type { CliJourney } from "../journey.ts";

const snapshotNodeMajor = releaseToolchainSnapshot.nodeVersion.slice(
  0,
  releaseToolchainSnapshot.nodeVersion.indexOf("."),
);

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
        ],
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
        ],
      },
      {
        name: "non-interactive initialization",
        args: ["init", "automatic", "--preset", addablePresetName],
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
        ],
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
          "--no-todo",
        ],
      },
      {
        name: "existing target conflict",
        args: ["init", "project", "--preset", addablePresetName],
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);
    const envelope = JSON.parse(results[0]?.stdout ?? "");
    assert.equal(envelope.command, "init");
    assert.equal(envelope.variant, "planned");
    const preview = envelope.data;
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

    assert.equal(results[1]?.exitCode, 2);
    assert.match(results[1]?.stderr ?? "", /固定拓扑预设/u);
    await assert.rejects(stat(path.join(context.workDir, "fixed-rejected")), {
      code: "ENOENT",
    });

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").variant, "initialized");

    assert.equal(results[3]?.exitCode, 2);
    assert.match(
      results[3]?.stderr ?? "",
      /--scope 必须是不含空白字符的有效 npm scope/u,
    );
    await assert.rejects(stat(path.join(context.workDir, "invalid-scope")), {
      code: "ENOENT",
    });

    assert.equal(results[4]?.exitCode, 0);
    const initialized = JSON.parse(results[4]?.stdout ?? "").data;
    assert.deepEqual(initialized.followUpDocument, { enabled: false });
    assert.deepEqual(initialized.toolchain, {
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    });
    const rootManifest = JSON.parse(
      await readFile(
        path.join(context.workDir, "project/package.json"),
        "utf8",
      ),
    ) as {
      readonly engines: { readonly node: string };
      readonly packageManager: string;
    };
    assert.equal(
      rootManifest.engines.node,
      releaseToolchainSnapshot.nodeVersion,
    );
    assert.equal(
      rootManifest.packageManager,
      releaseToolchainSnapshot.packageManagerPin,
    );
    const generationRecord = JSON.parse(
      await readFile(
        path.join(context.workDir, "project/.template/generation.json"),
        "utf8",
      ),
    ) as { readonly toolchain: Record<string, unknown> };
    assert.deepEqual(generationRecord.toolchain, {
      nodeLtsMajor: snapshotNodeMajor,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
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
    assert.equal(
      JSON.parse(results[5]?.stderr ?? "").variant,
      "operationFailed",
    );
  },
};

export default journey;
