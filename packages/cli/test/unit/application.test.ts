import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  prepareGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import { resolveToolchainVersions } from "#template-core/toolchain-resolution";

import {
  formatPresetCatalog,
  runInit,
  type ApplicationRuntime,
} from "../../src/application.ts";

describe("template CLI business rules", () => {
  it("renders the registry-owned Preset Catalog deterministically", () => {
    const catalog = formatPresetCatalog();

    expect(catalog).toContain("Built-in presets");
    expect(catalog).toContain("ts-lib:");
    expect(catalog).toContain("ts-cli:");
  });
});

describe("init publication setup handoff", () => {
  it("renders the one-time setup command only in the init terminal result", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-init-"));
    try {
      const toolchain = await resolveToolchainVersions({
        source: "bundled-fallback",
      });
      const publicationSetupPreset = builtInPresetRegistry.all().find(
        (definition) =>
          prepareGeneratedRepositoryInitialization({
            definition,
            targetDir: path.join(workspace, "publication-setup-test"),
            toolchain: {
              nodeLtsMajor: toolchain.nodeLtsMajor.value,
              packageManagerPin: toolchain.packageManagerPin.value,
            },
          }).publicationSetup !== null,
      );
      if (publicationSetupPreset === undefined)
        throw new Error("Expected a Built-in Preset with publication setup");
      const runtime: ApplicationRuntime = {
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: { confirm: async () => true },
      };
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

      expect(output).toContain("One-time npm publication setup");
      expect(output).toContain("./scripts/npm-publication-setup/setup.sh");
      const preview = JSON.parse(
        await runInit(
          {
            dir: "preview",
            preset: publicationSetupPreset.metadata.name,
            yes: true,
            dryRun: true,
            json: true,
            todo: false,
          },
          runtime,
        ),
      );
      expect(preview.publicationSetup).toEqual({
        command: "./scripts/npm-publication-setup/setup.sh",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
