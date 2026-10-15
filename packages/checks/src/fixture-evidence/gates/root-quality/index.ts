import { fileURLToPath } from "node:url";

import type { GeneratedRepositoryPlan } from "@ykdz/template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  writeGeneratedRepositoryTree,
  type FixtureCommandRunner,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export function generatedRootQualityExecutionResources(
  plan: GeneratedRepositoryPlan,
): readonly FixtureEvidenceExecutionResource[] {
  return plan.environmentNeeds.some(
    (need) => need.kind === "playwright-browser-assets",
  )
    ? ["browser"]
    : [];
}

export function normalizedGeneratedRootQualityPlan(
  plan: GeneratedRepositoryPlan,
  options: {
    readonly includeFix?: boolean;
    readonly deploymentContractIdentity?: string;
  } = {},
): unknown {
  return {
    gate: "generated-root-quality",
    ...(options.deploymentContractIdentity === undefined
      ? {}
      : { deploymentContractIdentity: options.deploymentContractIdentity }),
    executionResources: generatedRootQualityExecutionResources(plan),
    dependencyInstallation: normalizedFixtureDependencyInstallationPlan(),
    developmentContainer: {
      lockfileWrites: false,
      probes: plan.developmentContainer.probes.map((probe) => ({
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
      args: ["--conditions=source", "scripts/task-gates.ts", "check:full"],
    },
  };
}

export async function deriveGeneratedRootQualityContractIdentity(
  plan: GeneratedRepositoryPlan,
  options: {
    readonly includeFix?: boolean;
    readonly deploymentContractIdentity?: string;
  } = {},
): Promise<string> {
  return await deriveFixtureGateContractIdentity({
    normalizedPlan: normalizedGeneratedRootQualityPlan(plan, options),
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
  readonly includeFix?: boolean;
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  await options.run(
    "node",
    ["--conditions=source", "scripts/task-gates.ts", "check:full"],
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
      ["--conditions=source", "scripts/task-gates.ts", "check:full"],
      {
        cwd: options.projectDir,
        stdio: "inherit",
      },
    );
  }
}
