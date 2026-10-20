import { templateContent, templatePresets } from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";

/** 从公开内容集合查找拥有指定参考包的可扩展预设。 */
export function requireReferencePresetName(
  referencePackageName: string,
): string {
  const contentIndex = createContentIndex(templateContent);
  const preset = templatePresets.find((candidate) => {
    if (!candidate.definition.operations.includes("add")) return false;
    return Object.values(candidate.definition.nodes).some(({ reference }) => {
      const owner = contentIndex.fromDefinition(reference, "reference", {
        namespace: candidate.identity.namespace,
      });
      return owner.identity.packageName === referencePackageName;
    });
  });
  if (preset === undefined) {
    throw new Error(
      `没有可新增且拥有指定公开来源的预设：${referencePackageName}`,
    );
  }
  return preset.alias;
}
