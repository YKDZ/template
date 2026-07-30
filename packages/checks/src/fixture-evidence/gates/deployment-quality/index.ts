import { fileURLToPath } from "node:url";

import type { GeneratedRepositoryPlan } from "#template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  type FixtureCommandRunner,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export type DeploymentQualityPlanInput = {
  readonly plan: GeneratedRepositoryPlan;
};

function expectedDeploymentTaskIds(
  plan: GeneratedRepositoryPlan,
): readonly string[] {
  return plan.manifests.flatMap((manifest) => {
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.scripts !== "object" ||
      manifest.scripts === null ||
      typeof (manifest.scripts as Record<string, unknown>).deployment !==
        "string"
    ) {
      return [];
    }
    return [
      `${manifest.name.startsWith("@") ? manifest.name : "//"}#deployment`,
    ];
  });
}

export function deriveDeploymentQualityPlanInput(
  plan: GeneratedRepositoryPlan,
): DeploymentQualityPlanInput | undefined {
  const hasDeploymentEntrypoint = plan.manifests.some(
    (manifest) =>
      typeof manifest.scripts === "object" &&
      manifest.scripts !== null &&
      typeof (manifest.scripts as Record<string, unknown>)[
        "check:deployment"
      ] === "string",
  );
  return hasDeploymentEntrypoint ? { plan } : undefined;
}

export function deploymentQualityExecutionResources(
  deployment: DeploymentQualityPlanInput,
): readonly FixtureEvidenceExecutionResource[] {
  return deployment.plan.deploymentEnvironmentNeeds.some(
    (need) => need.kind === "docker-engine",
  )
    ? ["docker"]
    : [];
}

export function normalizedDeploymentQualityPlan(
  deployment: DeploymentQualityPlanInput,
): unknown {
  return {
    gate: "deployment-quality",
    executionResources: deploymentQualityExecutionResources(deployment),
    dependencyInstallation: normalizedFixtureDependencyInstallationPlan(),
    taskDiscovery: {
      command: "pnpm",
      args: ["exec", "turbo", "run", "deployment", "--dry-run=json"],
      expectedTaskIds: [...expectedDeploymentTaskIds(deployment.plan)].sort(),
    },
    generatedDeployment: {
      command: "pnpm",
      args: ["run", "check:deployment"],
    },
  };
}

export async function deriveDeploymentQualityContractIdentity(
  deployment: DeploymentQualityPlanInput,
): Promise<string> {
  return await deriveFixtureGateContractIdentity({
    normalizedPlan: normalizedDeploymentQualityPlan(deployment),
    sourceProjections: [
      {
        name: "deployment-quality",
        root: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        name: "fixture-evidence-kernel",
        root: fileURLToPath(new URL("../../kernel/", import.meta.url)),
      },
    ],
  });
}

function commandStdout(result: unknown): string {
  return typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
    ? result.stdout
    : "";
}

async function assertDeploymentTaskDiscovery(options: {
  readonly deployment: DeploymentQualityPlanInput;
  readonly projectDir: string;
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  const result = await options.run(
    "pnpm",
    ["exec", "turbo", "run", "deployment", "--dry-run=json"],
    { cwd: options.projectDir },
  );
  let taskIds: Set<string>;
  try {
    const dryRun = JSON.parse(commandStdout(result)) as {
      readonly tasks?: readonly { readonly taskId?: unknown }[];
    };
    if (!Array.isArray(dryRun.tasks)) throw new Error("tasks is missing");
    taskIds = new Set(
      dryRun.tasks.flatMap((task) =>
        typeof task.taskId === "string" ? [task.taskId] : [],
      ),
    );
  } catch (error) {
    throw new Error(
      `Turbo dry-run did not return a Deployment task graph: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const missing = expectedDeploymentTaskIds(options.deployment.plan).filter(
    (taskId) => !taskIds.has(taskId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Turbo dry-run omitted generated Deployment task(s): ${missing.join(", ")}`,
    );
  }
}

export async function executeDeploymentQuality(options: {
  readonly deployment: DeploymentQualityPlanInput;
  readonly projectDir: string;
  readonly fixtureWorkspace: string;
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  const run = options.run;
  await assertDeploymentTaskDiscovery({
    deployment: options.deployment,
    projectDir: options.projectDir,
    run,
  });
  await run("pnpm", ["run", "check:deployment"], {
    cwd: options.projectDir,
    stdio: "inherit",
  });
}
