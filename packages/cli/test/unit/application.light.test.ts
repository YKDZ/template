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
        readonly packages: readonly Record<string, unknown>[];
        readonly strategyState: {
          readonly toolchain: Record<string, unknown>;
        };
      };
      assert.equal(generationRecord.schemaVersion, 4);
      assert.deepEqual(generationRecord, output.generationRecord);
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
