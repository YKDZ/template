import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  prepareGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { describe, expect, it } from "vitest";

import { runInit, type ApplicationRuntime } from "../../src/application.ts";

const snapshotNodeMajor = releaseToolchainSnapshot.nodeVersion.slice(
  0,
  releaseToolchainSnapshot.nodeVersion.indexOf("."),
);

function createRuntime(workspace: string): ApplicationRuntime {
  return {
    cwd: workspace,
    env: {},
    tty: { stdin: true, stdout: true, stderr: true },
    confirmation: { confirm: async () => true },
  };
}

describe("init publication setup handoff", () => {
  it("renders the one-time setup command only in the init terminal result", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-init-"));
    try {
      const publicationSetupPreset = builtInPresetRegistry
        .all()
        .find((definition) => {
          const preparation = prepareGeneratedRepositoryInitialization({
            definition,
            targetDir: path.join(workspace, "publication-setup-test"),
          });
          return (
            preparation.status === "ready" &&
            preparation.publicationSetup !== null
          );
        });
      if (publicationSetupPreset === undefined)
        throw new Error("Expected a Built-in Preset with publication setup");
      const runtime = createRuntime(workspace);
      const output = await runInit(
        {
          dir: "publication-setup-test",
          preset: publicationSetupPreset.metadata.name,
          yes: true,
          dryRun: false,
          json: false,
          todo: true,
        },
        runtime,
      );

      expect(output.status).toBe("success");
      if (output.status !== "success") throw new Error("Expected init success");
      expect(output.publicationSetup).toEqual({
        command: "./scripts/npm-publication-setup/setup.sh",
      });
      const preview = await runInit(
        {
          dir: "preview",
          preset: publicationSetupPreset.metadata.name,
          yes: true,
          dryRun: true,
          json: true,
          todo: false,
        },
        runtime,
      );
      expect(preview.status).toBe("success");
      if (preview.status !== "success")
        throw new Error("Expected preview success");
      expect(preview.publicationSetup).toEqual({
        command: "./scripts/npm-publication-setup/setup.sh",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("init toolchain snapshot consumption", () => {
  it("writes the exact snapshot Node and pnpm to the private root", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-snapshot-init-"),
    );
    try {
      // 本业务需要一个共享库角色的初始包，从公开 registry 的既有能力选取 Preset。
      const snapshotInitPreset = builtInPresetRegistry
        .all()
        .find(
          (definition) =>
            definition.initialPrimaryPackage?.role === "shared-library",
        );
      if (snapshotInitPreset === undefined)
        throw new Error(
          "Expected a Built-in Preset with a shared-library initial Package",
        );
      const output = await runInit(
        {
          dir: "project",
          preset: snapshotInitPreset.metadata.name,
          yes: true,
          dryRun: false,
          json: true,
          todo: false,
          scope: "acme",
        },
        createRuntime(workspace),
      );

      expect(output.status).toBe("success");
      if (output.status !== "success") throw new Error("Expected init success");
      expect(output.toolchain).toEqual({
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      });

      const rootManifest = JSON.parse(
        await readFile(path.join(workspace, "project/package.json"), "utf8"),
      ) as {
        readonly engines: { readonly node: string };
        readonly packageManager: string;
      };
      expect(rootManifest.engines.node).toBe(
        releaseToolchainSnapshot.nodeVersion,
      );
      expect(rootManifest.packageManager).toBe(
        releaseToolchainSnapshot.packageManagerPin,
      );

      const generationRecord = JSON.parse(
        await readFile(
          path.join(workspace, "project/.template/generation.json"),
          "utf8",
        ),
      ) as { readonly toolchain: Record<string, unknown> };
      expect(generationRecord.toolchain).toEqual({
        nodeLtsMajor: snapshotNodeMajor,
        packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
