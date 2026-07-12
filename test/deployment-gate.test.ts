import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { describe, expect, it } from "vitest";

import { runRequiredDeploymentQualityGate } from "../packages/checks/src/check-generated-registry.ts";

function deploymentPlan() {
  const definition = builtInPresetRegistry.all().find(
    (candidate) =>
      planGeneratedRepositoryInitialization({
        definition: candidate,
        context: createGenerationContext({
          targetDir: path.join("generated-repository", "deployment-gate"),
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        }),
      }).deploymentChecks.length > 0,
  );
  if (definition === undefined) {
    throw new Error("A deployment Definition is required");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "deployment-gate"),
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });
}

describe("deployment quality gate", () => {
  it("fails explicitly when Docker is unavailable instead of reporting a semantic skip", async () => {
    await expect(
      runRequiredDeploymentQualityGate({
        plan: deploymentPlan(),
        projectDir: "/tmp/deployment-quality-gate",
        run: async () => {
          throw new Error("docker socket unavailable");
        },
      }),
    ).rejects.toThrow(/Docker is required.*check:deployment was not executed/u);
  });

  it("runs the generated deployment gate after Docker availability is confirmed", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await runRequiredDeploymentQualityGate({
      plan: deploymentPlan(),
      projectDir: "/tmp/deployment-quality-gate",
      run: async (command, args) => {
        calls.push({ command, args });
      },
    });

    expect(calls).toEqual([
      {
        command: "docker",
        args: ["version", "--format", "{{.Server.Version}}"],
      },
      { command: "pnpm", args: ["run", "check:deployment"] },
    ]);
  });
});
