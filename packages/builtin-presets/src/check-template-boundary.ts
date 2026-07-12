#!/usr/bin/env node
import {
  checkTemplateSourceBoundary,
  checkTemplateSourceContexts,
} from "@ykdz/template-core/template-boundary-check";

import {
  builtInPresetTemplateSourceContexts,
  type GeneratedRepositoryPlan,
} from "./foundation.ts";
import { deriveVerificationPlans } from "./registry-checks.ts";

/** Checks every real registry initialization and Package Addition plan. */
export async function checkBuiltInPresetTemplateBoundary(): Promise<void> {
  const result = await checkTemplateSourceBoundary({
    templateSourceContexts: await checkTemplateSourceContexts(
      builtInPresetTemplateSourceContexts(),
    ),
    projections: deriveVerificationPlans().flatMap(({ definition, plan }) => {
      const operationsByPlanner = new Map<
        string,
        GeneratedRepositoryPlan["operations"][number][]
      >();
      for (const operation of plan.operations) {
        const planner =
          operation.provenance?.plannerSourceFile ?? plan.plannerSourceFile;
        const operations = operationsByPlanner.get(planner) ?? [];
        operations.push(operation);
        operationsByPlanner.set(planner, operations);
      }
      return [...operationsByPlanner].map(([sourceFilePath, operations]) => ({
        name: `${definition.metadata.name}:${plan.planningContribution}:${sourceFilePath}`,
        definitionName: definition.metadata.name,
        planningContribution: plan.planningContribution,
        sourceFilePath,
        plan: { operations },
      }));
    }),
  });
  if (!result.ok) {
    throw new Error(
      [
        "Template Source Boundary violations:",
        ...result.violations.map(
          (violation) =>
            `- ${violation.owningFunction} generated ${violation.generatedPath} from ${violation.sourceFilePath}`,
        ),
      ].join("\n"),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetTemplateBoundary();
}
