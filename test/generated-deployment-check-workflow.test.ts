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
  readonly name: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type DeploymentWorkflow = {
  readonly jobs: {
    readonly check: {
      readonly name: "${{ matrix.job_name }}";
      readonly "runs-on": "ubuntu-latest";
      readonly "timeout-minutes": "${{ matrix.timeout_minutes }}";
      readonly strategy: {
        readonly "fail-fast": false;
        readonly matrix: {
          readonly include: readonly {
            readonly capability: "root" | "deployment";
            readonly job_name: "Root Check" | "Deployment Check";
            readonly task_entrypoint:
              | "pnpm run check"
              | "pnpm run check:deployment";
            readonly timeout_minutes: 30 | 45;
            readonly requires_docker: boolean;
          }[];
        };
      };
      readonly steps: readonly WorkflowStep[];
    };
  };
};

async function renderDeploymentWorkflow(): Promise<DeploymentWorkflow> {
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
          scope: "demo",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        }),
      });
      return (
        candidatePlan.deploymentEnvironmentNeeds.some(
          (need) => need.kind === "docker-engine",
        ) &&
        candidatePlan.manifests.some((manifest) => {
          const scripts = manifest.scripts;
          return (
            typeof scripts === "object" &&
            scripts !== null &&
            typeof (scripts as Record<string, unknown>).deployment === "string"
          );
        })
      );
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
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    await renderNewProject({ targetRoot, operations: [...plan.operations] });
    return parse(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
    ) as DeploymentWorkflow;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Generated Deployment Check workflow", () => {
  it("runs Root and Deployment Checks as self-contained bounded matrix legs", async () => {
    const workflow = await renderDeploymentWorkflow();
    const job = workflow.jobs.check;

    expect(job).toMatchObject({
      name: "${{ matrix.job_name }}",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": "${{ matrix.timeout_minutes }}",
      strategy: {
        "fail-fast": false,
        matrix: {
          include: [
            {
              capability: "root",
              job_name: "Root Check",
              task_entrypoint: "pnpm run check",
              timeout_minutes: 30,
              requires_docker: false,
            },
            {
              capability: "deployment",
              job_name: "Deployment Check",
              task_entrypoint: "pnpm run check:deployment",
              timeout_minutes: 45,
              requires_docker: true,
            },
          ],
        },
      },
    });
    expect(job.steps.map((step) => step.name)).toEqual([
      "Checkout source",
      "Set up Node.js",
      "Set up pnpm",
      "Set up Docker Buildx",
      "Install dependencies",
      "Run selected Check",
      "Stage Root Check diagnostics",
      "Upload Root Check diagnostics",
    ]);
    expect(
      job.steps.find((step) => step.name === "Set up Docker Buildx"),
    ).toMatchObject({
      if: "matrix.requires_docker",
    });
    expect(
      job.steps.find((step) => step.name === "Run selected Check"),
    ).toMatchObject({
      run: "${{ matrix.task_entrypoint }}",
    });
    expect(
      job.steps.find((step) => step.name === "Stage Root Check diagnostics"),
    ).toMatchObject({
      if: "failure() && matrix.capability == 'root'",
      env: { DIAGNOSTIC_OWNER_PATHS: "apps/web" },
      run: expect.stringContaining(
        "for diagnostic_directory in test-results playwright-report; do",
      ),
    });
    expect(
      job.steps.find((step) => step.name === "Upload Root Check diagnostics"),
    ).toMatchObject({
      if: "failure() && matrix.capability == 'root'",
      uses: "actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808",
      with: {
        name: "root-check-diagnostics",
        path: ".template-ci-diagnostics",
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
  });
});
