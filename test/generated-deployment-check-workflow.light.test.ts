import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { assertWorkflowContract } from "@ykdz/template-checks/workflow-contract";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { parse } from "yaml";

async function renderDeploymentWorkflow(): Promise<{
  readonly source: string;
  readonly plan: GeneratedRepositoryPlan;
}> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-deployment-check-workflow-"),
  );
  const targetRoot = path.join(workspace, "demo-app");
  try {
    const definition = builtInPresetRegistry.all().find((candidate) => {
      const candidatePlan = planGeneratedRepositoryInitialization({
        definition: candidate,
        context: createGenerationContext({
          targetDir: targetRoot,
          defaultPackageScope: "demo",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        }),
      });
      return candidatePlan.deploymentCheck !== undefined;
    });
    if (definition === undefined) {
      throw new Error(
        "Expected a deployment-capable Built-in Preset Definition",
      );
    }
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: targetRoot,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    });
    await renderNewProject({ targetRoot, operations: [...plan.operations] });
    const source = await readFile(
      path.join(targetRoot, ".github/workflows/check.yml"),
      "utf8",
    );
    return { source, plan };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void describe("Generated Deployment Check workflow", () => {
  void it("runs the Deployment Check contract through real generated files", async () => {
    const { source, plan } = await renderDeploymentWorkflow();
    assert.doesNotThrow(() =>
      assertWorkflowContract(
        plan,
        ".github/workflows/check.yml",
        source,
        parse(source),
      ),
    );
  });
});
