import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "pnpm/action-setup@d9184bf108216479bc5a137cc391f4d7b14c870b",
    ]);
    expect(source).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    );
    expect(source).toContain(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
    );
    expect(source).toContain(
      "pnpm/action-setup@d9184bf108216479bc5a137cc391f4d7b14c870b # v6.1.0",
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
