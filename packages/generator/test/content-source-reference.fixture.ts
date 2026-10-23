export const referencePackage = {
  alias: "typed-reference",
  instance: "independent",
  externalMarker: "from-reference" as const,
  prepare() {
    return {
      resources: [],
      facts: { phase: "prepared-reference" as const },
    };
  },
  parseCreationInput(value: unknown) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("seed" in value) ||
      typeof value.seed !== "string"
    ) {
      throw new Error("创建输入无效");
    }
    return { seed: value.seed };
  },
  createDefinition() {
    return { id: "typed-reference" };
  },
  evaluate() {
    return { packageDefinitionId: "typed-reference", files: [], facts: {} };
  },
};
