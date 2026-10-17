#!/usr/bin/env node
import {
  deriveVerificationPlans,
  validatePlanDependencyCatalog,
  validatePlanSources,
  validateRegistryMirrorSlotProjections,
} from "./registry-checks.ts";

/** Registry-only checks; Definition planners are the only catalog input. */
export async function checkPresetRegistryContract(): Promise<void> {
  const plans = await deriveVerificationPlans();
  for (const { definition, plan } of plans) {
    await validatePlanSources({ definition, plan });
    await validatePlanDependencyCatalog(plan);
  }
  await validateRegistryMirrorSlotProjections(plans);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkPresetRegistryContract();
}
