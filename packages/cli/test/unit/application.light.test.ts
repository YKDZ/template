import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { templatePresets } from "@ykdz/template-content";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import { runInit, type ApplicationRuntime } from "../../src/application.ts";

const snapshotNodeMajor = releaseToolchainSnapshot.nodeVersion.slice(
  0,
  releaseToolchainSnapshot.nodeVersion.indexOf("."),
);

function createRuntime(workspace: string): ApplicationRuntime {
  return {
    cwd: workspace,
    env: {},
  };
}

void describe("init publication setup handoff", () => {
  void it("renders the one-time setup command only in the init terminal result", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-init-"));
    try {
      const publicationSetupPreset = templatePresets
        .map((member) => member.definition)
        .find((preset) =>
          Object.values(preset.nodes).some(
            ({ reference }) =>
              reference.manifest.name === "@ykdz/reference-ts-cli",
          ),
        );
      if (publicationSetupPreset === undefined)
        throw new Error("Expected a Built-in Preset with publication setup");
      const runtime = createRuntime(workspace);
      const output = await runInit(
        {
          dir: "publication-setup-test",
          preset: publicationSetupPreset.metadata.alias,
          dryRun: false,
          todo: true,
        },
        runtime,
      );

      assert.equal(output.status, "success");
      if (output.status !== "success") throw new Error("Expected init success");
      assert.deepEqual(output.publicationSetup, {
        command: "./scripts/npm-publication-setup/setup.sh",
      });
      const preview = await runInit(
        {
          dir: "preview",
          preset: publicationSetupPreset.metadata.alias,
          dryRun: true,
          todo: false,
        },
        runtime,
      );
      assert.equal(preview.status, "success");
      if (preview.status !== "success")
        throw new Error("Expected preview success");
      assert.deepEqual(preview.publicationSetup, {
        command: "./scripts/npm-publication-setup/setup.sh",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

void describe("init toolchain snapshot consumption", () => {
  void it("writes the exact snapshot Node and pnpm to the private root", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-snapshot-init-"),
    );
    try {
      // 本业务需要一个共享库角色的初始包，从唯一内容集合中选取 Preset。
      const snapshotInitPreset = templatePresets
        .map((member) => member.definition)
        .find((preset) =>
          Object.values(preset.nodes).some(
            ({ reference }) => reference.role === "shared-library",
          ),
        );
      if (snapshotInitPreset === undefined)
        throw new Error(
          "Expected a Built-in Preset with a shared-library initial Package",
        );
      const output = await runInit(
        {
          dir: "project",
          preset: snapshotInitPreset.metadata.alias,
          dryRun: false,
          todo: false,
          scope: "acme",
        },
        createRuntime(workspace),
      );

      assert.equal(output.status, "success");
      if (output.status !== "success") throw new Error("Expected init success");
      assert.deepEqual(output.toolchain, {
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      });

      const rootManifest = JSON.parse(
        await readFile(path.join(workspace, "project/package.json"), "utf8"),
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
          path.join(workspace, "project/.template/generation.json"),
          "utf8",
        ),
      ) as {
        readonly schemaVersion: number;
        readonly strategyState: {
          readonly toolchain: Record<string, unknown>;
        };
      };
      assert.equal(generationRecord.schemaVersion, 1);
      assert.deepEqual(generationRecord.strategyState.toolchain, {
        nodeLtsMajor: snapshotNodeMajor,
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
