/** 从唯一内容序列派生预设成员和打包所需参考包成员。 */
export function deriveTemplateMembers<Content extends readonly unknown[]>(
  content: Content,
): {
  readonly presets: readonly Extract<
    Content[number],
    { readonly kind: "preset" }
  >[];
  readonly referencePackages: readonly Extract<
    Content[number],
    { readonly kind: "reference" }
  >[];
} {
  const presets: Extract<Content[number], { readonly kind: "preset" }>[] = [];
  const referencePackages: Extract<
    Content[number],
    { readonly kind: "reference" }
  >[] = [];
  for (const member of content) {
    if (typeof member !== "object" || member === null) continue;
    if ("kind" in member && member.kind === "preset") {
      presets.push(
        member as Extract<Content[number], { readonly kind: "preset" }>,
      );
    }
    if ("kind" in member && member.kind === "reference") {
      referencePackages.push(
        member as Extract<Content[number], { readonly kind: "reference" }>,
      );
    }
  }
  return { presets, referencePackages };
}
