#!/usr/bin/env node
import {
  deriveVerificationPlans,
  discoverPresetLocalBehaviorTests,
  validatePlanDependencyCatalog,
  validatePlanSources,
} from "./registry-checks.ts";

/** Registry-only checks; Definition planners are the only catalog input. */
export async function checkPresetRegistryContract(): Promise<void> {
  await discoverPresetLocalBehaviorTests();
  for (const { definition, plan } of deriveVerificationPlans()) {
    await validatePlanSources({ definition, plan });
    validatePlanDependencyCatalog(plan);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkPresetRegistryContract();
}
