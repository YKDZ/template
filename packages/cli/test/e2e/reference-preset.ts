import { templatePresets } from "@ykdz/template-content";

/** 从公开内容集合查找拥有指定参考包的可扩展预设。 */
export function requireReferencePresetName(
  referencePackageName: string,
): string {
  const preset = templatePresets
    .map((member) => member.definition)
    .find(
      (candidate) =>
        candidate.operations.includes("add") &&
        Object.values(candidate.nodes).some(
          ({ reference }) => reference.manifest.name === referencePackageName,
        ),
    );
  if (preset === undefined) {
    throw new Error(
      `没有可新增且拥有指定公开来源的预设：${referencePackageName}`,
    );
  }
  return preset.metadata.alias;
}
