import { fileURLToPath } from "node:url";

import type { GeneratedRepositoryPlan } from "@ykdz/template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export type DeploymentQualityPlanInput = {
  readonly plan: GeneratedRepositoryPlan & {
    readonly deploymentCheck: NonNullable<
      GeneratedRepositoryPlan["deploymentCheck"]
    >;
  };
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
  return plan.deploymentCheck === undefined
    ? undefined
    : {
        plan: {
          ...plan,
          deploymentCheck: plan.deploymentCheck,
        },
      };
}

export function deploymentQualityExecutionResources(
  deployment: DeploymentQualityPlanInput,
): readonly FixtureEvidenceExecutionResource[] {
  return deployment.plan.deploymentCheck.environmentNeeds.some(
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
      args: ["run", "check:full"],
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
