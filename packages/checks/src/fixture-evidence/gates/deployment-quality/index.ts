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
    generatedDeployment: {
      command: "node",
      args: ["--conditions=source", "scripts/task-gates.ts", "check:full"],
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
