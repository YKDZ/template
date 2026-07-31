import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import { renderNewProject } from "#template-core/renderer";

type WorkflowStep = {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type CheckWorkflow = {
  readonly name: string;
  readonly on: {
    readonly pull_request: Record<string, never> | null;
    readonly push: { readonly branches: readonly string[] };
  };
  readonly permissions: { readonly contents: "read" };
  readonly concurrency: {
    readonly group: "${{ github.workflow }}-${{ github.ref }}";
    readonly "cancel-in-progress": true;
  };
  readonly jobs: {
    readonly check: {
      readonly name: string;
      readonly "runs-on": string;
      readonly "timeout-minutes": number;
      readonly steps: readonly WorkflowStep[];
    };
  };
};

async function renderRootCheckWorkflow(): Promise<{
  readonly source: string;
  readonly workflow: CheckWorkflow;
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
          scope: "demo",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        }),
      });
      return !candidatePlan.manifests.some((manifest) => {
        const scripts = manifest.scripts;
        return (
          typeof scripts === "object" &&
          scripts !== null &&
          typeof (scripts as Record<string, unknown>).deployment === "string"
        );
      });
    });
    if (definition === undefined) {
      throw new Error("Expected a Root Check-only Built-in Preset Definition");
    }
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir: targetRoot,
        scope: "demo",
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
    return { source, workflow: parse(source) as CheckWorkflow };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Generated Root Check workflow", () => {
  it("keeps raw diagnostic declarations out of the generated repository plan", () => {
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

    expect(plan).not.toHaveProperty("ciDiagnosticArtifactDeclarations");
  });

  it("runs the hardened Root Check through its one quality entrypoint", async () => {
    const { source, workflow } = await renderRootCheckWorkflow();
    const job = workflow.jobs.check;

    expect(workflow.name).toBe("Check");
    expect(workflow.on).toEqual({
      pull_request: null,
      push: { branches: ["main"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    });
    expect(job).toMatchObject({
      name: "Root Check",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
    });

    const actionSteps = job.steps.filter(
      (step): step is WorkflowStep & { readonly uses: string } =>
        step.uses !== undefined,
    );
    expect(actionSteps.map((step) => step.name)).toEqual([
      "Checkout source",
      "Set up Node.js",
      "Set up pnpm",
    ]);
    expect(actionSteps.map((step) => step.uses)).toEqual([
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
      "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
    ]);
    expect(source).toContain(
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5",
    );
    expect(source).toContain(
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5",
    );
    expect(source).toContain(
      "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0",
    );
    expect(actionSteps[0]?.with).toEqual({
      "persist-credentials": false,
      "fetch-depth": 1,
    });
    expect(actionSteps[1]?.with).toEqual({
      "node-version-file": "package.json",
    });
    expect(actionSteps[2]?.with).toEqual({ cache: true });

    expect(job.steps.map((step) => step.run).filter(Boolean)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run check",
    ]);
    expect(job.steps.map((step) => step.name)).toEqual([
      "Checkout source",
      "Set up Node.js",
      "Set up pnpm",
      "Install dependencies",
      "Run Root Check",
    ]);
  });
});
