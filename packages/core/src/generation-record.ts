import * as v from "valibot";

import type {
  GenerationRecord,
  PackageCreationInput,
} from "./workspace-strategy.ts";

/** schema1 的结构声明；策略状态和内容创建输入由各自 owner 解释。 */
export const generationRecordSchema = v.looseObject({
  schemaVersion: v.literal(1),
  strategyIdentity: v.string(),
  strategyState: v.unknown(),
  packages: v.array(
    v.looseObject({
      contentIdentity: v.string(),
      createdBy: v.picklist([
        "initialization",
        "addition",
        "shared-dependency",
      ]),
      definition: v.looseObject({
        packageDefinitionId: v.string(),
        name: v.string(),
        path: v.string(),
        role: v.string(),
      }),
      creationInput: v.optional(v.unknown()),
      bindings: v.record(v.string(), v.string()),
    }),
  ),
  nodeInstances: v.record(v.string(), v.string()),
  presetSelections: v.array(
    v.looseObject({
      packageName: v.string(),
      exportPath: v.string(),
    }),
  ),
});

/** 按公开 schema1 结构解析；策略语义由 generator/workspace owner 继续校验。 */
export function parseGenerationRecordStructure<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(value: unknown): GenerationRecord<CreationInput> {
  const parsed = v.safeParse(generationRecordSchema, value);
  if (!parsed.success) {
    throw new Error("生成记录不符合 schema1 结构");
  }
  return parsed.output as GenerationRecord<CreationInput>;
}
