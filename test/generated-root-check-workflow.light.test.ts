import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { assertWorkflowContract } from "@ykdz/template-checks/workflow-contract";
import { templatePresets } from "@ykdz/template-content";
import { parse } from "yaml";

import {
  initializePreset,
  type GeneratedPresetReceipt,
} from "../test-support/generated-preset-receipt.ts";

async function renderRootCheckWorkflow(): Promise<{
  readonly source: string;
  readonly receipt: GeneratedPresetReceipt;
}> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-root-check-workflow-"),
  );
  try {
    for (const preset of templatePresets) {
      const generatedRoot = path.join(workspace, preset.metadata.alias);
      const receipt = await initializePreset({
        preset,
        targetRoot: generatedRoot,
        repositoryName: "demo-cli",
      });
      if (
        receipt.result.projection.ownerFacts.requirements.deploymentCheck !==
        undefined
      ) {
        continue;
      }
      const source = await readFile(
        path.join(generatedRoot, ".github/workflows/check.yml"),
        "utf8",
      );
      return { source, receipt };
    }
    throw new Error("Expected a Root Check-only generated preset");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void describe("Generated Root Check workflow", () => {
  void it("runs the Root Check contract through real generated files", async () => {
    const { source, receipt } = await renderRootCheckWorkflow();
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
