/** 投影结构化配置中的精确包身份、公开子路径和 Turbo 任务身份。 */
export function mapPackageNamesInJson(
  value: unknown,
  names: ReadonlyMap<string, string>,
): unknown {
  const rename = (text: string): string => {
    for (const [source, target] of names) {
      if (
        text === source ||
        text.startsWith(`${source}/`) ||
        text.startsWith(`${source}#`)
      )
        return target + text.slice(source.length);
    }
    return text;
  };
  if (typeof value === "string") return rename(value);
  if (Array.isArray(value))
    return value.map((entry) => mapPackageNamesInJson(entry, names));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        rename(key),
        mapPackageNamesInJson(entry, names),
      ]),
    );
  return value;
}
