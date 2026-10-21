import { fileURLToPath } from "node:url";

import type { DeploymentCheckRequirement } from "@ykdz/template-workspace/project-requirements";

import type { SuccessfulScenarioResult } from "../../../generated-content.ts";
import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

export type DeploymentQualityPlanInput = {
  readonly scenarioId: string;
  readonly requirement: DeploymentCheckRequirement;
};

export function deriveDeploymentQualityPlanInput(
  result: SuccessfulScenarioResult,
  scenarioId: string,
): DeploymentQualityPlanInput | undefined {
  const requirement = result.projection.ownerFacts.requirements.deploymentCheck;
  return requirement === undefined
    ? undefined
    : {
        scenarioId,
        requirement,
      };
}

export function deploymentQualityExecutionResources(
  deployment: DeploymentQualityPlanInput,
): readonly FixtureEvidenceExecutionResource[] {
  return deployment.requirement.environmentNeeds.some(
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
