import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import { assertWorkflowContract } from "@ykdz/template-checks/workflow-contract";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { describe, expect, it } from "vitest";
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

describe("Generated Deployment Check workflow", () => {
  it("runs the Deployment Check contract through real generated files", async () => {
    const { source, plan } = await renderDeploymentWorkflow();
    expect(() =>
      assertWorkflowContract(
        plan,
        ".github/workflows/check.yml",
        source,
        parse(source),
      ),
    ).not.toThrow();
  });
});
