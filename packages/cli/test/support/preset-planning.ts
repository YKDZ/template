import { tmpdir } from "node:os";
import path from "node:path";

import { createGenerator, type TemplatePreset } from "@ykdz/template-content";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { ProjectProjection } from "@ykdz/template-core/project-projection";

const generator = createGenerator();

/** 用正式规划结果读取预设实际选择的包身份，测试不再推断作者默认路径。 */
export async function planPreset(member: TemplatePreset): Promise<{
  readonly packages: readonly PackageDefinition[];
  readonly projection: ProjectProjection;
}> {
  const result = await generator.planInit({
    targetRoot: path.join(
      tmpdir(),
      "template-cli-preset-planning",
      member.identity.packageName.replaceAll("/", "-"),
    ),
    selection: { presets: [{ contentIdentity: member.identity }] },
    conventions: {
      repositoryName: "fixture",
      defaultPackageScope: "acme",
    },
  });
  if (result.status !== "planned") {
    throw new Error(
      `预设 ${member.definition.metadata.alias} 无法完成正式规划：${result.status}`,
    );
  }
  const selection = result.generationRecord.selections.find(
    ({ presetIdentity }) =>
      presetIdentity?.packageName === member.identity.packageName &&
      presetIdentity.exportPath === member.identity.exportPath &&
      presetIdentity.namespace === member.identity.namespace,
  );
  if (selection === undefined) {
    throw new Error(`正式规划没有记录预设 ${member.definition.metadata.alias}`);
  }
  const selectedPackageIds = new Set(Object.values(selection.nodes));
  return {
    packages: result.blueprint.packages.filter(({ packageDefinitionId }) =>
      selectedPackageIds.has(packageDefinitionId),
    ),
    projection: result.projection,
  };
}
