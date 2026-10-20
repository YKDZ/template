import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

export const requiredCapabilityProbeIdentities = new Set([
  "cargo",
  "github-cli",
  "playwright",
  "shellcheck",
]);

/** 汇总真实初始化投影中 default owner 提供的能力探针。 */
export async function registryCapabilityProbes(root: string) {
  const workspace = await mkdtemp(
    path.join(tmpdir(), `template-probes-${path.basename(root)}-`),
  );
  try {
    const probes = [];
    for (const scenario of deriveInitializationScenarios(
      sourceGeneratedScenarioRuntime,
    )) {
      const receipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario,
        workspace,
      });
      if (receipt.status === "not-applicable") continue;
      probes.push(...receipt.result.projection.ownerFacts.container.probes);
    }
    return probes.filter((probe) =>
      requiredCapabilityProbeIdentities.has(probe.identity),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
