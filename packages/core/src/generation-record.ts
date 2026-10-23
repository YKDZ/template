import * as v from "valibot";

import {
  assertContentIdentity,
  type ContentIdentity,
} from "./content-identity.ts";
import { assertJsonValue } from "./json.ts";
import type {
  PackageDefinitionId,
  ProjectBlueprint,
} from "./project-blueprint.ts";

export type GenerationRecordPackage<CreationInput = unknown> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly contentIdentity: ContentIdentity;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly creationInput: CreationInput | null;
  readonly dependencyBindings: Readonly<Record<string, PackageDefinitionId>>;
};

export type GenerationRecordSelection = {
  readonly selectionId: string;
  readonly presetIdentity: ContentIdentity | null;
  readonly nodes: Readonly<Record<string, PackageDefinitionId>>;
};

export type GenerationRecord<Conventions = unknown, CreationInput = unknown> = {
  readonly schemaVersion: 6;
  readonly composition: {
    readonly identity: ContentIdentity;
    readonly conventions: Conventions;
  };
  readonly packages: readonly GenerationRecordPackage<CreationInput>[];
  readonly selections: readonly GenerationRecordSelection[];
};

const contentIdentitySchema = v.strictObject({
  namespace: v.string(),
  packageName: v.string(),
  exportPath: v.string(),
});

const packageRecordSchema = v.strictObject({
  packageDefinitionId: v.pipe(v.string(), v.regex(/^package-[a-f0-9]{64}$/)),
  contentIdentity: contentIdentitySchema,
  createdBy: v.picklist(["initialization", "addition", "shared-dependency"]),
  creationInput: v.nullable(v.unknown()),
  dependencyBindings: v.record(v.string(), v.string()),
});

const selectionSchema = v.strictObject({
  selectionId: v.pipe(v.string(), v.minLength(1)),
  presetIdentity: v.nullable(contentIdentitySchema),
  nodes: v.record(v.string(), v.string()),
});

export const generationRecordSchema = v.strictObject({
  schemaVersion: v.literal(6),
  composition: v.strictObject({
    identity: contentIdentitySchema,
    conventions: v.unknown(),
  }),
  packages: v.array(packageRecordSchema),
  selections: v.array(selectionSchema),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failStructure(): never {
  throw new Error("生成记录不符合 schema6 结构");
}

/** 严格解析 schema6 的通用结构；内容拥有者继续验证自己的持久事实。 */
export function parseGenerationRecordStructure<
  Conventions = unknown,
  CreationInput = unknown,
>(value: unknown): GenerationRecord<Conventions, CreationInput> {
  if (isRecord(value) && value.schemaVersion !== 6) {
    throw new Error(
      `不支持的生成记录 schema ${String(value.schemaVersion)}；当前只支持 schema6`,
    );
  }
  const parsed = v.safeParse(generationRecordSchema, value);
  if (!parsed.success) failStructure();

  const record = parsed.output;
  assertContentIdentity(record.composition.identity);
  assertJsonValue(record.composition.conventions, "生成记录组合约定");
  for (const item of record.packages) {
    assertContentIdentity(item.contentIdentity);
    if (item.creationInput !== null) {
      assertJsonValue(item.creationInput, "生成记录包创建输入");
    }
    for (const [key, packageId] of Object.entries(item.dependencyBindings)) {
      if (key.length === 0 || !/^package-[a-f0-9]{64}$/u.test(packageId)) {
        throw new Error("生成记录 dependencyBindings 无效");
      }
    }
  }
  const seenSelections = new Set<string>();
  for (const selection of record.selections) {
    if (seenSelections.has(selection.selectionId)) {
      throw new Error("生成记录 selectionId 必须唯一");
    }
    seenSelections.add(selection.selectionId);
    if (selection.presetIdentity !== null) {
      assertContentIdentity(selection.presetIdentity);
    }
    if (Object.keys(selection.nodes).length === 0) {
      throw new Error("生成记录 selection 至少包含一个节点");
    }
    for (const [node, packageId] of Object.entries(selection.nodes)) {
      if (node.length === 0 || !/^package-[a-f0-9]{64}$/u.test(packageId)) {
        throw new Error("生成记录 selection 节点映射无效");
      }
    }
  }
  return record as GenerationRecord<Conventions, CreationInput>;
}

/** 验证记录与蓝图通过持续包实例身份一一对应。 */
export function assertGenerationRecordMatchesBlueprint(
  recordValue: unknown,
  blueprint: ProjectBlueprint,
): GenerationRecord {
  const record = parseGenerationRecordStructure(recordValue);
  const blueprintPackages = new Map(
    blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition,
    ]),
  );
  const recordsById = new Map<PackageDefinitionId, GenerationRecordPackage>(
    record.packages.map((item) => [item.packageDefinitionId, item]),
  );
  if (recordsById.size !== record.packages.length) {
    throw new Error("生成记录包含重复包实例");
  }
  if (blueprintPackages.size !== recordsById.size) {
    throw new Error("生成记录与项目蓝图的包实例集合不一致");
  }
  for (const [id, packageRecord] of recordsById) {
    const definition = blueprintPackages.get(id);
    if (definition === undefined) {
      throw new Error(`项目蓝图缺少生成记录中的包实例：${id}`);
    }
    if (
      Object.entries(packageRecord.dependencyBindings).some(
        ([key, providerId]) =>
          key.trim().length === 0 || !recordsById.has(providerId),
      )
    ) {
      throw new Error(`生成记录包含无效依赖绑定：${id}`);
    }
  }
  for (const id of blueprintPackages.keys()) {
    if (!recordsById.has(id)) {
      throw new Error(`生成记录缺少项目蓝图中的包实例：${id}`);
    }
  }
  for (const selection of record.selections) {
    for (const id of Object.values(selection.nodes)) {
      if (!recordsById.has(id)) {
        throw new Error(`生成记录选择引用了未知包实例：${id}`);
      }
    }
  }
  return record;
}
