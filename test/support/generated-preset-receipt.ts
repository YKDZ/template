import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import type { assertWorkflowContract } from "@ykdz/template-checks/workflow-contract";
import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import {
  createDefaultWorkspaceStrategy,
  type DefaultWorkspaceCreationInput,
} from "@ykdz/template-workspace/default-workspace-strategy";

export type GeneratedPresetReceipt = Parameters<
  typeof assertWorkflowContract
>[0];
export type GeneratedPreset = Extract<
  (typeof templateContent)[number],
  { readonly kind: "preset" }
>;
type CreationInput = DefaultWorkspaceCreationInput<TsCliCreationInput>;

/** 用同一次公开生成调用返回的收据检查正式投影。 */
export async function initializePreset(options: {
  readonly preset: GeneratedPreset;
  readonly targetRoot: string;
  readonly repositoryName: string;
  readonly defaultPackageScope?: string;
}): Promise<GeneratedPresetReceipt> {
  const generator = createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<CreationInput>(),
  });
  const result = await generator.init({
    targetRoot: options.targetRoot,
    selection: { roots: [{ preset: options.preset.identity }] },
    strategyInput: {
      repositoryName: options.repositoryName,
      defaultPackageScope: options.defaultPackageScope ?? "demo",
    },
  });
  if (
    result.status !== "success" ||
    result.projection === null ||
    result.projection.blueprint === undefined ||
    result.projection.ownerFacts === undefined
  ) {
    throw new Error(
      `${options.preset.definition.metadata.alias}: 公开生成器未返回成功收据：${JSON.stringify(result)}`,
    );
  }
  const receiptResult = result as GeneratedPresetReceipt["result"];
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
