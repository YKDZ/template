export type TsCliCreationVariant = "private" | "public-candidate";

export type TsCliPublicCandidateCreationInput = {
  readonly variant: "public-candidate";
};

export const tsCliPublicCandidateCreationInput = {
  variant: "public-candidate",
} as const satisfies TsCliPublicCandidateCreationInput;

/** CLI 模板所有者声明用于初始化发布候选的持久输入。 */
export function isTsCliPublicCandidateCreationInput(
  value: unknown,
): value is TsCliPublicCandidateCreationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>).variant ===
      tsCliPublicCandidateCreationInput.variant
  );
}
