import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { assertWorkflowContract } from "@ykdz/template-checks/workflow-contract";
import { templatePresets } from "@ykdz/template-content";
import { parse } from "yaml";

import { initializePreset } from "../test-support/generated-preset-receipt.ts";

async function renderDeploymentWorkflow(): Promise<{
  readonly source: string;
  readonly receipt: Parameters<typeof assertWorkflowContract>[0];
}> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-deployment-check-workflow-"),
  );
  try {
    for (const preset of templatePresets) {
      const targetRoot = path.join(workspace, preset.alias);
      const receipt = await initializePreset({
        preset,
        targetRoot,
        repositoryName: "demo-app",
      });
      if (
        !receipt.result.projection.ownerFacts.environmentNeeds.deployment.some(
          (need) => need.kind === "docker-engine",
        )
      ) {
        continue;
      }
      const source = await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      );
      return { source, receipt };
    }
    throw new Error("Expected a deployment-capable generated preset");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void describe("Generated Deployment Check workflow", () => {
  void it("runs the Deployment Check contract through real generated files", async () => {
    const { source, receipt } = await renderDeploymentWorkflow();
    assert.doesNotThrow(() =>
      assertWorkflowContract(
        receipt,
        ".github/workflows/check.yml",
        source,
        parse(source),
      ),
    );
  });
});
