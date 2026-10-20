import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { parseDocument } from "yaml";

import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";
import { assertPublicationWorkflowContract } from "../src/workflow-contract.ts";

void it("拒绝发布工作流语义变更并定位 YAML 字段", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "publication-workflow-"));
  try {
    const scenario = deriveInitializationScenarios(
      sourceGeneratedScenarioRuntime,
    ).find((item) => item.base.metadata.alias === "ts-cli");
    assert.ok(scenario);
    const receipt = await materializeGeneratedScenario({
      runtime: sourceGeneratedScenarioRuntime,
      scenario,
      workspace,
      strategyInput: { defaultPackageScope: "demo" },
    });
    if (receipt.status !== "generated") {
      throw new Error("ts-cli initialization must be applicable");
    }
    const source = await readFile(
      path.join(receipt.projectDir, ".github/workflows/release.yml"),
      "utf8",
    );
    for (const mutate of [
      (workflow: Record<string, unknown>) => {
        const verify = (workflow.jobs as Record<string, unknown>)
          .verify as Record<string, unknown>;
        verify["timeout-minutes"] = 29;
      },
      (workflow: Record<string, unknown>) => {
        (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: unknown[];
          }
        ).steps[1] = {
          ...(
            (workflow.jobs as Record<string, unknown>).verify as {
              steps: Record<string, unknown>[];
            }
          ).steps[1]!,
          with: { ref: "main", "persist-credentials": false, "fetch-depth": 1 },
        };
      },
      (workflow: Record<string, unknown>) => {
        const upload = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[8]!;
        upload.with = {
          ...(upload.with as Record<string, unknown>),
          path: "wrong.tgz",
        };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).publish as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.env = {};
      },
      (workflow: Record<string, unknown>) => {
        const node = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[2]!;
        node.if = "false";
      },
      (workflow: Record<string, unknown>) => {
        const staging = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[5]!;
        staging.run = "true";
      },
      (workflow: Record<string, unknown>) => {
        const fullCheck = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[6]!;
        fullCheck.env = { PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: "wrong" };
      },
      (workflow: Record<string, unknown>) => {
        const fullCheck = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[6]!;
        fullCheck.run = "node --conditions=source scripts/task-gates.ts check";
      },
      (workflow: Record<string, unknown>) => {
        const artifact = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[7]!;
        artifact.env = {
          ...(artifact.env as Record<string, unknown>),
          PUBLICATION_ARTIFACT_REQUIRED: "false",
        };
      },
      (workflow: Record<string, unknown>) => {
        (workflow.jobs as Record<string, unknown>).release = {
          ...((workflow.jobs as Record<string, unknown>).release as Record<
            string,
            unknown
          >),
          needs: "verify",
        };
      },
      (workflow: Record<string, unknown>) => {
        const download = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[2]!;
        download.with = {
          ...(download.with as Record<string, unknown>),
          name: "different-artifact",
        };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "node --conditions=source scripts/task-gates.ts check";
      },
      (workflow: Record<string, unknown>) => {
        const release = (workflow.jobs as Record<string, unknown>)
          .release as Record<string, unknown>;
        release.permissions = { contents: "write", "id-token": "write" };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release create v1.0.1 --draft=false";
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release create v1.0.1 --generate-notes";
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release upload v1.0.1 artifact.tgz --clobber";
      },
      (workflow: Record<string, unknown>) => {
        const release = (workflow.jobs as Record<string, unknown>).release as {
          steps: Record<string, unknown>[];
        };
        release.steps.push({
          name: "Upload assets after public release",
          run: "gh release upload v1.0.1 artifact.tgz",
        });
      },
    ]) {
      const workflow = parseDocument(source).toJS() as Record<string, unknown>;
      mutate(workflow);
      assert.throws(
        () => assertPublicationWorkflowContract(receipt, source, workflow),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          return message.includes("publication workflow");
        },
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
