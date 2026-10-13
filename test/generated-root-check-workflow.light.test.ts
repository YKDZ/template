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
import { parse } from "yaml";

async function renderRootCheckWorkflow(): Promise<{
  readonly source: string;
  readonly plan: GeneratedRepositoryPlan;
}> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-root-check-workflow-"),
  );
  const targetRoot = path.join(workspace, "demo-cli");
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
          },
        }),
      });
      return candidatePlan.deploymentCheck === undefined;
    });
    if (definition === undefined) {
      throw new Error("Expected a Root Check-only Built-in Preset Definition");
    }
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: targetRoot,
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    await renderNewProject({
      targetRoot,
      operations: [...plan.operations],
    });
    const source = await readFile(
      path.join(targetRoot, ".github/workflows/check.yml"),
      "utf8",
    );
    return { source, plan };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void describe("Generated Root Check workflow", () => {
  void it("keeps raw diagnostic declarations out of the generated repository plan", () => {
    const definition = builtInPresetRegistry.all()[0];
    if (definition === undefined) {
      throw new Error("Expected at least one Built-in Preset Definition");
    }
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: path.join(tmpdir(), "template-root-check-plan"),
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    assert.ok(!Object.hasOwn(plan, "ciDiagnosticArtifactDeclarations"));
  });

  void it("runs the Root Check contract through real generated files", async () => {
    const { source, plan } = await renderRootCheckWorkflow();
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
