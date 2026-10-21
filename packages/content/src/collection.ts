import { loadContentSource } from "@ykdz/template-generator/content-source";
import type { ContentSourceOptions } from "@ykdz/template-generator/content-source";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

import type { LoadedTemplateContentMember } from "./template-content-types.ts";

/** 使用唯一公开loader装载本次选中的内容成员。 */
export async function loadTemplateContent(options: {
  readonly namespace: string;
  readonly resolve: ContentSourceOptions["resolve"];
  readonly members: readonly string[];
}): Promise<readonly LoadedTemplateContentMember[]> {
  return (await loadContentSource({
    ...options,
    prepareReferenceDefinition(definition) {
      return defineReferencePackage(
        definition as Parameters<typeof defineReferencePackage>[0],
      );
    },
  })) as readonly LoadedTemplateContentMember[];
}

export type {
  ContentKind,
  LoadedTemplateContentMember,
} from "./template-content-types.ts";
