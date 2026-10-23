import { fileURLToPath } from "node:url";

import type { SuccessfulScenarioResult } from "../../../generated-content.ts";
import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export type DeploymentQualityPlanInput = {
  readonly scenarioId: string;
  readonly executionResources: readonly FixtureEvidenceExecutionResource[];
};

export function deriveDeploymentQualityPlanInput(
  result: SuccessfulScenarioResult,
  scenarioId: string,
): DeploymentQualityPlanInput | undefined {
  const executionResources: FixtureEvidenceExecutionResource[] =
    result.ownerFacts.environmentNeeds.deployment.some(
      (need) => need.kind === "docker-engine",
    )
      ? ["docker"]
      : [];
  return executionResources.length === 0
    ? undefined
    : {
        scenarioId,
        executionResources,
      };
}

export function deploymentQualityExecutionResources(
  deployment: DeploymentQualityPlanInput,
): readonly FixtureEvidenceExecutionResource[] {
  return deployment.executionResources;
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
