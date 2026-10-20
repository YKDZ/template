import * as v from "valibot";

const contentIdentitySchema = v.strictObject({
  namespace: v.string(),
  packageName: v.string(),
  exportPath: v.string(),
});

import type {
  GenerationRecord,
  PackageCreationInput,
} from "./workspace-strategy.ts";

/** schema3 只保存后续操作所需的事实；蓝图仍是包定义的唯一来源。 */
export const generationRecordSchema = v.strictObject({
  schemaVersion: v.literal(3),
  strategyIdentity: v.pipe(v.string(), v.minLength(1)),
  strategyState: v.unknown(),
  packages: v.array(
    v.strictObject({
      contentIdentity: contentIdentitySchema,
      createdBy: v.picklist([
        "initialization",
        "addition",
        "shared-dependency",
      ]),
      packageDefinitionId: v.pipe(
        v.string(),
        v.regex(/^package-[a-f0-9]{64}$/u),
      ),
      creationInput: v.nullable(v.unknown()),
      bindings: v.record(v.string(), v.string()),
    }),
  ),
  nodeInstances: v.record(v.string(), v.string()),
  presetSelections: v.array(contentIdentitySchema),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按公开 schema3 结构解析；策略状态由 workspace owner 继续校验。 */
export function parseGenerationRecordStructure<
  CreationInput extends PackageCreationInput = PackageCreationInput,
>(value: unknown): GenerationRecord<CreationInput> {
  if (isRecord(value) && value.schemaVersion !== 3) {
    throw new Error(
      `不支持的生成记录 schema ${String(value.schemaVersion)}；当前只支持 schema3`,
    );
  }
  const parsed = v.safeParse(generationRecordSchema, value);
  if (!parsed.success) {
    throw new Error("生成记录不符合 schema3 结构");
  }
  return parsed.output as GenerationRecord<CreationInput>;
}
