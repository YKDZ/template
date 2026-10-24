import type { assertWorkflowContract } from "@ykdz/default-content-verification/workflow-contract";
import { templateContent } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

export type GeneratedPresetReceipt = Parameters<
  typeof assertWorkflowContract
>[0];
export type GeneratedPreset = Extract<
  (typeof templateContent)[number],
  { readonly kind: "preset" }
>;
/** 用同一次公开生成调用返回的收据检查正式投影。 */
export async function initializePreset(options: {
  readonly preset: GeneratedPreset;
  readonly targetRoot: string;
  readonly repositoryName: string;
  readonly defaultPackageScope?: string;
}): Promise<GeneratedPresetReceipt> {
  const generator = createDefaultGenerator({ content: templateContent });
  const result = await generator.init({
    targetRoot: options.targetRoot,
    selection: {
      presets: [{ contentIdentity: options.preset.identity }],
    },
    conventions: {
      repositoryName: options.repositoryName,
      defaultPackageScope: options.defaultPackageScope ?? "demo",
    },
  });
  if (result.status !== "success") {
    throw new Error(
      `${options.preset.definition.metadata.alias}: 公开生成器未返回成功收据：${JSON.stringify(result)}`,
    );
  }
  const receiptResult: GeneratedPresetReceipt["result"] = result;
  return {
    status: "generated",
    scenario: {
      id: options.preset.definition.metadata.alias,
      label: `initialize ${options.preset.definition.metadata.alias}`,
      base: options.preset,
    },
    projectDir: options.targetRoot,
    initialization: receiptResult,
    result: receiptResult,
    linkFrom: [],
  };
}
