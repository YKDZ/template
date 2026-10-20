import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { templatePresets } from "@ykdz/template-content";
import { renderGeneratedPnpmWorkspaceYaml } from "@ykdz/template-workspace/dependency-catalog";
import { execa } from "execa";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function generateNodeOnlyProject(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(workspace, "demo-lib");
  const nodeOnlyPreset = templatePresets.find(
    (preset) => preset.owner?.packageName === "@ykdz/preset-ts-lib",
  );
  if (nodeOnlyPreset === undefined) {
    throw new Error("内容集合缺少 TypeScript 库预设");
  }

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      nodeOnlyPreset.metadata.alias,
    ],
    { cwd: repoRoot },
  );
  return projectDir;
}

void describe("pnpm Workspace Policy", () => {
  void it("renders only explicitly requested dependency overrides", () => {
    const workspace = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      overrides: { "example>peer": "-" },
    });

    assert.ok(workspace.includes('"example>peer": "-"'));
    assert.ok(
      workspace.includes('minimumReleaseAgeExclude:\n  - "@ykdz/template"'),
    );
    assert.ok(workspace.includes("injectWorkspacePackages: false"));
    assert.ok(!workspace.includes("valibot>typescript"));
    assert.ok(!workspace.includes("pnpmfile"));
  });

  void it("keeps the template CLI out of generated repository maturity delays", async () => {
    const projectDir = await generateNodeOnlyProject("pnpm-template-cli-age-");
    const workspace = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    assert.ok(
      workspace.includes('minimumReleaseAgeExclude:\n  - "@ykdz/template"'),
    );
    assert.ok(workspace.includes("preferSymlinkedExecutables: true"));
  });
});
