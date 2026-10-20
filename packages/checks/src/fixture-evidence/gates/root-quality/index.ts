import { fileURLToPath } from "node:url";

import type { SuccessfulScenarioResult } from "../../../generated-content.ts";
import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  writeGeneratedRepositoryTree,
  type FixtureCommandRunner,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export function generatedRootQualityExecutionResources(
  result: SuccessfulScenarioResult,
  options: { readonly rootGate?: "check" | "check:full" } = {},
): readonly FixtureEvidenceExecutionResource[] {
  if (options.rootGate === "check") return [];
  return result.projection.ownerFacts.environmentNeeds.check.some(
    (need) => need.kind === "playwright-browser-assets",
  )
    ? ["browser"]
    : [];
}

export function normalizedGeneratedRootQualityPlan(
  result: SuccessfulScenarioResult,
  options: {
    readonly rootGate?: "check" | "check:full";
    readonly includeFix?: boolean;
    readonly deploymentContractIdentity?: string;
  } = {},
): unknown {
  return {
    gate: "generated-root-quality",
    ...(options.deploymentContractIdentity === undefined
      ? {}
      : { deploymentContractIdentity: options.deploymentContractIdentity }),
    executionResources: generatedRootQualityExecutionResources(result, options),
    dependencyInstallation: normalizedFixtureDependencyInstallationPlan(),
    developmentContainer: {
      lockfileWrites: false,
      probes: result.projection.ownerFacts.container.probes.map((probe) => ({
        identity: probe.identity,
        command: probe.command,
        args: [...(probe.args ?? [])],
        failureMessage: probe.failureMessage ?? null,
      })),
    },
    normalization:
      options.includeFix === true
        ? {
            command: "node",
            args: ["--conditions=source", "scripts/task-gates.ts", "fix"],
          }
        : null,
    gitSafety:
      options.includeFix === true
        ? { safeDirectory: "generated-container-workspace" }
        : null,
    rootCheck: {
      command: "node",
      args: [
        "--conditions=source",
        "scripts/task-gates.ts",
        options.rootGate ?? "check:full",
      ],
    },
  };
}

export async function deriveGeneratedRootQualityContractIdentity(
  result: SuccessfulScenarioResult,
  options: {
    readonly rootGate?: "check" | "check:full";
    readonly includeFix?: boolean;
    readonly deploymentContractIdentity?: string;
  } = {},
): Promise<string> {
  return await deriveFixtureGateContractIdentity({
    normalizedPlan: normalizedGeneratedRootQualityPlan(result, options),
    sourceProjections: [
      {
        name: "generated-root-quality",
        root: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        name: "fixture-evidence-kernel",
        root: fileURLToPath(new URL("../../kernel/", import.meta.url)),
      },
    ],
  });
}

export async function executeGeneratedRootQuality(options: {
  readonly projectDir: string;
  readonly gitSafeDirectory?: string;
  readonly rootGate?: "check" | "check:full";
  readonly includeFix?: boolean;
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  await options.run(
    "node",
    [
      "--conditions=source",
      "scripts/task-gates.ts",
      options.rootGate ?? "check:full",
    ],
    {
      cwd: options.projectDir,
      stdio: "inherit",
    },
  );
  if (options.includeFix === true) {
    const beforeFix = await writeGeneratedRepositoryTree({
      repositoryRoot: options.projectDir,
      run: options.run,
      ...(options.gitSafeDirectory === undefined
        ? {}
        : { gitSafeDirectory: options.gitSafeDirectory }),
    });
    await options.run(
      "node",
      ["--conditions=source", "scripts/task-gates.ts", "fix"],
      {
        cwd: options.projectDir,
        stdio: "inherit",
      },
    );
    const afterFix = await writeGeneratedRepositoryTree({
      repositoryRoot: options.projectDir,
      run: options.run,
      ...(options.gitSafeDirectory === undefined
        ? {}
        : { gitSafeDirectory: options.gitSafeDirectory }),
    });
    if (afterFix !== beforeFix) {
      throw new Error(
        `Generated Repository Fix Command changed the working-tree identity from ${beforeFix} to ${afterFix}`,
      );
    }
    await options.run(
      "node",
      [
        "--conditions=source",
        "scripts/task-gates.ts",
        options.rootGate ?? "check:full",
      ],
      {
        cwd: options.projectDir,
        stdio: "inherit",
      },
    );
  }
}
