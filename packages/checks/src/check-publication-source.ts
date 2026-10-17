import { readFile } from "node:fs/promises";

import {
  deriveVerificationPlans,
  planSourceReferences,
  type VerificationRuntime,
} from "./registry-checks.ts";

export type PublicationSourceRuntime = VerificationRuntime & {
  readonly builtin: VerificationRuntime["builtin"] &
    Pick<
      typeof import("@ykdz/template-builtin-presets"),
      "referencePackagePublicationContexts" | "resolveBuiltInTemplateSource"
    >;
};

/**
 * 由正式发布验收传入同一已安装制品的公开模块。实际读取默认描述的公开资产，
 * 并回放完整初始化与加包计划；源码包不参与制品句柄的解析或渲染。
 */
export async function checkPresetPublicationSources(
  runtime: PublicationSourceRuntime,
): Promise<{
  readonly plansVerified: number;
  readonly resourcesRead: number;
}> {
  const resources = new Set<string>();
  const readResource = async (file: string, owner: string): Promise<void> => {
    if (resources.has(file)) return;
    try {
      await readFile(file);
    } catch (cause) {
      throw new Error(`${owner}: 发布制品中的公开资源不可读取：${file}`, {
        cause,
      });
    }
    resources.add(file);
  };

  for (const context of runtime.builtin.referencePackagePublicationContexts()) {
    for (const [source, target] of context.assets) {
      await readResource(source, `${context.name} 生成 ${target}`);
    }
  }
  const plans = await deriveVerificationPlans(runtime);
  for (const { definition, plan } of plans) {
    const references = planSourceReferences({
      definition,
      plan,
      resolveSource: runtime.builtin.resolveBuiltInTemplateSource,
    });
    for (const reference of references) {
      await readResource(
        reference.sourceFile,
        `${reference.definitionName} 生成 ${reference.generatedPath}`,
      );
    }
  }
  return { plansVerified: plans.length, resourcesRead: resources.size };
}
