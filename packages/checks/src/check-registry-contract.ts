#!/usr/bin/env node
import {
  deriveFixtureMatrix,
  forEachGeneratedScenario,
} from "./generated-content.ts";
import { validateGeneratedScenarioReceipt } from "./registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "./source-generated-runtime.ts";

/** 检查唯一内容集合的真实 init/add 投影与工作区原生约束。 */
export async function checkPresetRegistryContract(): Promise<void> {
  await forEachGeneratedScenario({
    runtime: sourceGeneratedScenarioRuntime,
    scenarios: deriveFixtureMatrix(sourceGeneratedScenarioRuntime),
    inspect: async (receipt) => {
      await validateGeneratedScenarioReceipt({
        receipt,
        runtime: sourceGeneratedScenarioRuntime,
      });
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkPresetRegistryContract();
}
