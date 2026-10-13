import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicCliPackageName = ["@ykdz", "template"].join("/");
const publishCommand = `pnpm --filter ${publicCliPackageName} run publish:bundled --no-git-checks --access public --provenance`;

function expectWorkflowUsesVersionedAction(
  workflow: string,
  action: "actions/checkout" | "actions/setup-node",
): void {
  assert.match(workflow, new RegExp(`uses: ${action}@v\\d+`));
}

void describe("npm release workflow", () => {
  void it("keeps the unreleased CLI version in one package manifest field", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
    ) as { readonly version: string; readonly bin: Record<string, string> };
    const result = await execa(process.execPath, [
      "--conditions=source",
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "--version",
    ]);

    assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
    assert.strictEqual(
      result.stdout,
      `${Object.keys(manifest.bin)[0]} ${manifest.version}`,
    );
    assert.strictEqual(result.stderr, "");
  });

  void it("publishes through GitHub Actions OIDC without a long-lived npm token", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    assert.ok(workflow.includes("id-token: write"));
    assert.ok(workflow.includes("contents: read"));
    assert.ok(workflow.includes("needs: check"));
    assert.ok(workflow.includes(publishCommand));
    assert.ok(!workflow.includes("PNPM_CONFIG_NODE_LINKER"));
    assert.ok(!workflow.includes("NPM_TOKEN"));
    assert.ok(!workflow.includes("NODE_AUTH_TOKEN"));
  });

  void it("uses package metadata and pnpm for publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expectWorkflowUsesVersionedAction(workflow, "actions/checkout");
    expectWorkflowUsesVersionedAction(workflow, "actions/setup-node");
    assert.ok(workflow.includes("node-version-file: package.json"));
    assert.ok(workflow.includes("run: corepack enable"));
    assert.ok(workflow.includes("run: pnpm install --frozen-lockfile"));
    assert.ok(workflow.includes(`run: ${publishCommand}`));
    assert.ok(!workflow.includes("node-version:"));
    assert.ok(!workflow.includes("npm install -g"));
    assert.doesNotMatch(workflow, /run:\s+npm publish/);
  });

  void it("reuses the repository check workflow before publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    assert.ok(workflow.includes("uses: ./.github/workflows/check.yml"));
    assert.ok(workflow.includes("needs: check"));
    assert.ok(!workflow.includes("run: pnpm run check\n"));
    assert.ok(!workflow.includes("run: pnpm run check:fixtures"));
  });

  void it("keeps focused generated links as a durable CI gate", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/check.yml"),
      "utf8",
    );

    assert.ok(workflow.includes("run: pnpm run check:focused"));
    assert.ok(workflow.includes("run: pnpm install --frozen-lockfile"));
  });
});
