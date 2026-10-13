import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";

import {
  deriveDeploymentQualityContractIdentity,
  deriveDeploymentQualityPlanInput,
  executeDeploymentQuality,
  normalizedDeploymentQualityPlan,
} from "../packages/checks/src/fixture-evidence/gates/deployment-quality/index.ts";
import {
  FileFixtureEvidenceStorage,
  runFixtureEvidenceGate,
  type FixtureEvidenceLifecycleEvent,
} from "../packages/checks/src/fixture-evidence/kernel/index.ts";

function deploymentPlan() {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "deployment-gate"),
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    }).manifests.some(
      (manifest) =>
        (manifest.scripts as Record<string, unknown> | undefined)?.[
          "check:deployment"
        ] !== undefined,
    ),
  );
  if (definition === undefined) {
    throw new Error("A deployment Definition is required");
  }
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "deployment-gate"),
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    }),
  });
}

void describe("deployment quality gate", () => {
  void it("owns the normalized Deployment Quality contract and complete executor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-contract-"));
    const plan = deploymentPlan();
    const deployment = deriveDeploymentQualityPlanInput(plan);
    const projectDir = path.join(root, "project");
    const fixtureWorkspace = path.join(root, "workspace");
    try {
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
          command: "pnpm",
          args: ["run", "check:deployment"],
        },
      });
      assert.strictEqual(normalized.executionResources.length, 1);
      assert.strictEqual(normalized.dependencyInstallation.commands.length, 3);
      assert.strictEqual(
        normalized.dependencyInstallation.commands[0]?.args.length,
        4,
      );
      assert.strictEqual(
        normalized.dependencyInstallation.commands[1]?.args.length,
        3,
      );
      assert.strictEqual(
        normalized.dependencyInstallation.commands[2]?.args.length,
        5,
      );
      assert.strictEqual(normalized.generatedDeployment.args.length, 2);
      assert.match(
        await deriveDeploymentQualityContractIdentity(deployment!),
        /^[0-9a-f]{64}$/u,
      );

      const calls: Array<{ command: string; args: readonly string[] }> = [];
      await executeDeploymentQuality({
        deployment: deployment!,
        projectDir,
        fixtureWorkspace,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? {
                stdout: JSON.stringify({
                  tasks: [{ taskId: "//#deployment" }],
                }),
              }
            : {};
        },
      });

      assert.deepStrictEqual(calls, [
        {
          command: "pnpm",
          args: ["exec", "turbo", "run", "deployment", "--dry-run=json"],
        },
        { command: "pnpm", args: ["run", "check:deployment"] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("makes no Deployment Quality claim without a generated entrypoint", () => {
    const planWithoutDeployment = builtInPresetRegistry
      .all()
      .map((definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(
              "generated-repository",
              definition.metadata.name,
            ),
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          }),
        }),
      )
      .find(
        (plan) =>
          !plan.manifests.some(
            (manifest) =>
              typeof (manifest.scripts as Record<string, unknown> | null)?.[
                "check:deployment"
              ] === "string",
          ),
      );
    assert.notStrictEqual(planWithoutDeployment, undefined);
    assert.strictEqual(
      deriveDeploymentQualityPlanInput(planWithoutDeployment!),
      undefined,
    );
  });

  void it("runs the generated deployment gate after task discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-success-"));
    const plan = deploymentPlan();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      await executeDeploymentQuality({
        deployment: deriveDeploymentQualityPlanInput(plan)!,
        projectDir: path.join(root, "project"),
        fixtureWorkspace: root,
        run: async (command, args) => {
          calls.push({ command, args });
          return args.includes("--dry-run=json")
            ? {
                stdout: JSON.stringify({
                  tasks: [{ taskId: "//#deployment" }],
                }),
              }
            : {};
        },
      });

      assert.deepStrictEqual(calls, [
        {
          command: "pnpm",
          args: ["exec", "turbo", "run", "deployment", "--dry-run=json"],
        },
        { command: "pnpm", args: ["run", "check:deployment"] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("issues no Deployment evidence after a partially completed command is cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deployment-cancelled-"));
    const storage = new FileFixtureEvidenceStorage(path.join(root, "evidence"));
    const plan = deploymentPlan();
    const generatedContentIdentity = "c".repeat(40);
    const events: FixtureEvidenceLifecycleEvent[] = [];
    try {
      const rootEvidence = await runFixtureEvidenceGate({
        gate: "generated-root-quality",
        generatedContentIdentity,
        contractIdentity: "d".repeat(64),
        scenario: {
          id: "deployment-cancelled",
          label: "deployment cancelled",
          presetIdentities: ["deployment"],
        },
        producerCommit: "test",
        readEnabled: false,
        writeEnabled: false,
        execute: async () => undefined,
      });
      await assert.rejects(
        runFixtureEvidenceGate({
          gate: "deployment-quality",
          rootEvidence,
          generatedContentIdentity,
          contractIdentity: "e".repeat(64),
          scenario: {
            id: "deployment-cancelled",
            label: "deployment cancelled",
            presetIdentities: ["deployment"],
          },
          producerCommit: "test",
          storage,
          writeEnabled: true,
          recordLifecycle: (event) => {
            events.push(event);
          },
          execute: async () =>
            await executeDeploymentQuality({
              deployment: deriveDeploymentQualityPlanInput(plan)!,
              projectDir: path.join(root, "project"),
              fixtureWorkspace: root,
              run: async (command, args) => {
                if (args.includes("--dry-run=json")) {
                  return {
                    stdout: JSON.stringify({
                      tasks: [{ taskId: "//#deployment" }],
                    }),
                  };
                }
                if (args[0] === "install") return {};
                if (command === "docker") return {};
                throw new Error("deployment command cancelled");
              },
            }),
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("deployment command cancelled"),
      );

      assert.ok(
        events.some(
          (event) =>
            event.type === "execution" &&
            event.gate === "deployment-quality" &&
            event.outcome === "failed",
        ),
      );
      assert.deepStrictEqual(
        events.filter((event) => event.type === "issuance"),
        [],
      );
      await assert.rejects(
        readdir(path.join(root, "evidence", "deployment-quality")),
        (error) => {
          return (
            typeof error === "object" &&
            error !== null &&
            Object.hasOwn(error, "code") &&
            (error as { readonly code?: unknown }).code === "ENOENT"
          );
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
