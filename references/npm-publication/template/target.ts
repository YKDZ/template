import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";

export type PublicationConfiguration = { readonly publication: boolean };

/** 发布意图只由所属实例的现行配置表达。 */
export function normalizePublicationConfiguration(
  input: unknown,
): PublicationConfiguration {
  if (input === undefined) return { publication: false };
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("publication" in input) ||
    typeof input.publication !== "boolean" ||
    Object.keys(input).some((key) => key !== "publication")
  ) {
    throw new Error("发布配置必须是仅包含 publication 布尔值的对象。");
  }
  return { publication: input.publication };
}

export function isPublicationEnabled(
  input: unknown,
): input is PublicationConfiguration {
  return (
    typeof input === "object" &&
    input !== null &&
    "publication" in input &&
    input.publication === true
  );
}

/** Changesets 根据包的原生 private 字段识别发布目标。 */
export function projectPublicationTarget(options: {
  readonly contribution: PackageContribution;
  readonly configuration: unknown;
}): PackageContribution {
  return {
    ...options.contribution,
    manifest: {
      ...options.contribution.manifest,
      private: !isPublicationEnabled(options.configuration),
    },
  };
}
