import { resolveTemplateSource } from "@ykdz/template-core/renderer";

import { referencePackages } from "../reference-composition.ts";

/** 发布检查只接收已公开资产的精确路径映射，不暴露参考包目录。 */
export function referencePackagePublicationContexts(): readonly {
  readonly name: string;
  readonly assets: ReadonlyMap<string, string>;
}[] {
  return referencePackages.map((referencePackage) => ({
    name: referencePackage.manifest.name,
    assets: new Map(
      referencePackage
        .operations("")
        .map((operation) => [
          resolveTemplateSource(operation.source, operation.from),
          operation.to,
        ]),
    ),
  }));
}
