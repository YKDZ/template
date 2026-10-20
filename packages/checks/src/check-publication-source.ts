import {
  deriveFixtureMatrix,
  forEachGeneratedScenario,
  type GeneratedScenarioRuntime,
} from "./generated-content.ts";
import { validatePlanSources } from "./registry-checks.ts";

/**
 * 验证注入运行时生成的真实操作所引用的已安装模板来源。
 * 调用者必须从正在验收的已安装公开包构造 runtime。
 */
export async function checkPresetPublicationSources(
  runtime: GeneratedScenarioRuntime,
): Promise<{
  readonly scenariosVerified: number;
  readonly resourcesRead: number;
}> {
  const references = new Set<string>();
  let scenariosVerified = 0;
  await forEachGeneratedScenario({
    runtime,
    scenarios: deriveFixtureMatrix(runtime),
    inspect: async (receipt) => {
      const scenarioReferences = await validatePlanSources({
        receipt,
        runtime,
      });
      scenariosVerified += 1;
      for (const reference of scenarioReferences) {
        references.add(reference.sourceFile);
      }
    },
    workspacePrefix: "template-installed-publication-",
  });
  return {
    scenariosVerified,
    resourcesRead: references.size,
  };
}
