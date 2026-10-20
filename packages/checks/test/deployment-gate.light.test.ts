import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
  normalizedDeploymentQualityPlan,
} from "../src/fixture-evidence/gates/deployment-quality/index.ts";
import {
  FileFixtureEvidenceStorage,
  runFixtureEvidenceGate,
  type FixtureEvidenceLifecycleEvent,
} from "../src/fixture-evidence/kernel/index.ts";
import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

async function generatedScenario(alias: string, workspace: string) {
  const scenario = deriveInitializationScenarios(
    sourceGeneratedScenarioRuntime,
  ).find((candidate) => candidate.base.metadata.alias === alias);
  if (scenario === undefined) throw new Error(`Missing ${alias} initializer`);
  const receipt = await materializeGeneratedScenario({
    runtime: sourceGeneratedScenarioRuntime,
    scenario,
    workspace,
  });
  if (receipt.status !== "generated")
    throw new Error(`${alias} is inapplicable`);
  return receipt;
}

void describe("deployment quality gate", () => {
  void it("owns the normalized Deployment contract covered by Root full quality", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "deployment-contract-"),
    );
    try {
      const receipt = await generatedScenario("vike-app", workspace);
      const deployment = deriveDeploymentQualityPlanInput(
        receipt.result,
        receipt.scenario.id,
      );
      assert.notStrictEqual(deployment, undefined);
      const normalized = normalizedDeploymentQualityPlan(deployment!) as {
        readonly executionResources: readonly unknown[];
        readonly dependencyInstallation: {
          readonly commands: readonly {
            readonly args: readonly unknown[];
          }[];
        };
        readonly generatedDeployment: { readonly args: readonly unknown[] };
      };
      assert.partialDeepStrictEqual(normalized, {
        gate: "deployment-quality",
        executionResources: ["docker"],
        dependencyInstallation: {
          storeDir: "/pnpm/store",
          commands: [
            {
              command: "pnpm",
              args: [
                "install",
                "--lockfile-only",
                "--store-dir",
                "/pnpm/store",
              ],
            },
            {
              command: "pnpm",
              args: ["fetch", "--store-dir", "/pnpm/store"],
            },
            {
              command: "pnpm",
              args: [
                "install",
                "--offline",
                "--frozen-lockfile",
                "--store-dir",
                "/pnpm/store",
              ],
            },
          ],
        },
        generatedDeployment: {
          command: "node",
          args: ["--conditions=source", "scripts/task-gates.ts", "check:full"],
        },
      });
      assert.strictEqual(normalized.executionResources.length, 1);
      assert.strictEqual(normalized.dependencyInstallation.commands.length, 3);
      assert.strictEqual(normalized.generatedDeployment.args.length, 3);
      assert.match(
        await deriveDeploymentQualityContractIdentity(deployment!),
        /^[0-9a-f]{64}$/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("makes no Deployment Quality claim without a generated requirement", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "no-deployment-"));
    try {
      const receipt = await generatedScenario("ts-lib", workspace);
      assert.strictEqual(
        deriveDeploymentQualityPlanInput(receipt.result, receipt.scenario.id),
        undefined,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("issues no evidence when Root full is cancelled before Deployment derivation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-cancelled-"));
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    const generatedContentIdentity = "c".repeat(40);
    const deploymentContractIdentity = "e".repeat(64);
    const cancel = new AbortController();
    const events: FixtureEvidenceLifecycleEvent[] = [];
    try {
      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity,
          contractIdentity: "d".repeat(64),
          coversDeploymentContractIdentity: deploymentContractIdentity,
          scenario: {
            id: "deployment-cancelled",
            label: "deployment cancelled",
            presetIdentities: ["deployment"],
          },
          producerCommit: "test",
          storage,
          writeEnabled: true,
          cancelSignal: cancel.signal,
          recordLifecycle: (event) => {
            events.push(event);
          },
          execute: async () => {
            cancel.abort(new Error("Root full command cancelled"));
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message === "Root full command cancelled",
      );

      assert.ok(
        events.some(
          (event) =>
            event.type === "execution" &&
            event.gate === "generated-root-quality" &&
            event.outcome === "failed",
        ),
      );
      assert.deepStrictEqual(
        events.filter((event) => event.type === "issuance"),
        [],
      );
      assert.deepStrictEqual(
        events.filter((event) => event.type === "derivation"),
        [],
      );
      await assert.rejects(
        readdir(path.join(root, "evidence", "generated-root-quality")),
        (error) =>
          typeof error === "object" &&
          error !== null &&
          Object.hasOwn(error, "code") &&
          (error as { readonly code?: unknown }).code === "ENOENT",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
