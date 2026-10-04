#!/usr/bin/env node

import type { GeneratedRepositoryPlan } from "@ykdz/template-builtin-presets";
import {
  checkTemplateSourceBoundary,
  checkTemplateSourceContexts,
} from "@ykdz/template-core/template-boundary-check";

import {
  builtInPresetTemplateSourceContexts,
  deriveVerificationPlans,
  validateRegistryMirrorSlotProjections,
} from "./registry-checks.ts";

/** Checks every real registry initialization and Package Addition plan. */
export async function checkBuiltInPresetTemplateBoundary(): Promise<void> {
  const verificationPlans = await deriveVerificationPlans();
  const result = await checkTemplateSourceBoundary({
    templateSourceContexts: await checkTemplateSourceContexts([
      ...builtInPresetTemplateSourceContexts(),
    ]),
    protectedWorkflowPlans: verificationPlans.map(
      ({ definition, diagnosticArtifactDeclarations, plan }) => ({
        name: `${definition.metadata.name}:${plan.planningContribution}`,
        definitionName: definition.metadata.name,
        planningContribution: plan.planningContribution,
        sourceFilePath: plan.plannerSourceFile,
        generatedPath: ".github/workflows/check.yml" as const,
        blueprint: plan.blueprint,
        diagnosticArtifactDeclarations,
        operations: plan.operations,
      }),
    ),
    projections: verificationPlans.flatMap(({ definition, plan }) => {
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
  // 镜像槽位自检与既有 source-body 边界门是两条独立职责：新门失败不关闭上面的检查。
  await validateRegistryMirrorSlotProjections(verificationPlans);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkBuiltInPresetTemplateBoundary();
}
