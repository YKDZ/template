import { parseTOML, type AST } from "toml-eslint-parser";

export type TomlStringProjection = {
  readonly path: readonly (string | number)[];
  readonly value: string;
};

/** 只投影已存在的 TOML 字符串值，保留注释及其余原生格式。 */
export function projectTomlStringValues(
  source: string,
  projections: readonly TomlStringProjection[],
): string {
  const values = new Map<string, AST.TOMLKeyValue>();
  for (const entry of parseTOML(source, { tomlVersion: "1.0" }).body[0].body) {
    const prefix = entry.type === "TOMLTable" ? entry.resolvedKey : [];
    const properties = entry.type === "TOMLTable" ? entry.body : [entry];
    for (const property of properties) {
      const keys = property.key.keys.map((key) =>
        key.type === "TOMLBare" ? key.name : key.value,
      );
      values.set(JSON.stringify([...prefix, ...keys]), property);
    }
  }
  const replacements = projections.flatMap((projection) => {
    const property = values.get(JSON.stringify(projection.path));
    const node = property?.value;
    if (node?.type !== "TOMLValue" || node.kind !== "string") {
      throw new Error(
        `TOML 投影要求已有字符串字段 ${JSON.stringify(projection.path)}`,
      );
    }
    if (node.value === projection.value) return [];
    return [{ range: node.range, text: JSON.stringify(projection.value) }];
  });
  let result = source;
  for (const replacement of replacements.toSorted(
    (left, right) => right.range[0] - left.range[0],
  )) {
    result =
      result.slice(0, replacement.range[0]) +
      replacement.text +
      result.slice(replacement.range[1]);
  }
  return result;
}
