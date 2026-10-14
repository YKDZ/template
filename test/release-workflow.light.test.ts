import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { parse } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publishCommand =
  'npm publish "$archive_path" --access public --provenance --ignore-scripts';

type ReleaseStep = {
  readonly run?: string;
};

type ReleaseWorkflow = {
  readonly jobs: {
    readonly publish: {
      readonly steps: readonly ReleaseStep[];
    };
  };
};

function getVerifiedPublicationScript(workflow: string): string {
  const release = parse(workflow) as ReleaseWorkflow;
  const publishSteps = release.jobs.publish.steps.filter(
    ({ run }) =>
      run
        ?.split("\n")
        .some((line) => line.trimStart().startsWith("npm publish ")) ?? false,
  );
  assert.strictEqual(publishSteps.length, 1);
  const publishStep = publishSteps[0];
  assert.ok(publishStep?.run !== undefined);
  return publishStep.run;
}

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

  void it("publishes the checked packed candidate through OIDC", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    assert.ok(workflow.includes("id-token: write"));
    assert.ok(workflow.includes("contents: read"));
    assert.ok(workflow.includes("needs: check"));
    assert.ok(workflow.includes("publish_verified_candidate: true"));
    assert.ok(workflow.includes("actions/download-artifact@v8"));
    assert.ok(
      getVerifiedPublicationScript(workflow).includes(
        "sha512sum --check --strict SHA512SUMS",
      ),
    );
    assert.ok(!workflow.includes("PNPM_CONFIG_NODE_LINKER"));
    assert.ok(!workflow.includes("NPM_TOKEN"));
    assert.ok(!workflow.includes("NODE_AUTH_TOKEN"));
  });

  void it("publishes one exact checksummed tarball without running lifecycle scripts", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    const publishScript = getVerifiedPublicationScript(workflow);

    expectWorkflowUsesVersionedAction(workflow, "actions/checkout");
    expectWorkflowUsesVersionedAction(workflow, "actions/setup-node");
    assert.ok(workflow.includes("node-version-file: package.json"));
    assert.ok(publishScript.includes('test "${#archive_paths[@]}" -eq 1'));
    assert.ok(
      publishScript.includes(
        'test "$(wc -l < "$artifact_directory/SHA512SUMS")" -eq 1',
      ),
    );
    assert.ok(publishScript.split("\n").includes(publishCommand));
    assert.ok(publishScript.includes("--ignore-scripts"));
    assert.ok(
      workflow.includes(
        "verified-packed-publication-${{ github.run_id }}-${{ github.run_attempt }}",
      ),
    );
    assert.ok(!workflow.includes("node-version:"));
    assert.ok(!workflow.includes("npm install -g"));
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

  void it("keeps the public heavy quality gate in reusable CI", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/check.yml"),
      "utf8",
    );

    assert.ok(workflow.includes("run: pnpm run check:heavy"));
    assert.ok(workflow.includes("run: pnpm install --frozen-lockfile"));
  });
});
