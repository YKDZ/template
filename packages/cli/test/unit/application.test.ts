import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
      const runtime: ApplicationRuntime = {
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: { confirm: async () => true },
      };
      const output = await runInit(
        {
          dir: "publication-setup-test",
          preset: "ts-cli",
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
            preset: "ts-cli",
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
