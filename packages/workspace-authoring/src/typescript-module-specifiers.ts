import ts from "typescript";

/** 在作者侧把原生 TypeScript/JavaScript 的静态包引用映射为生成身份。 */
export function mapTypeScriptModuleSpecifiers(
  sourceText: string,
  names: ReadonlyMap<string, string>,
  fileName = "template.ts",
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const replacements = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    ) {
      return [];
    }
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return [];
    const prefix = [...names].find(([name]) =>
      specifier.text.startsWith(`${name}/`),
    );
    const replacement =
      names.get(specifier.text) ??
      (prefix === undefined
        ? undefined
        : prefix[1] + specifier.text.slice(prefix[0].length));
    return replacement === undefined
      ? []
      : [
          {
            start: specifier.getStart(sourceFile),
            end: specifier.end,
            text: JSON.stringify(replacement),
          },
        ];
  });
  let mapped = sourceText;
  for (const replacement of replacements.toReversed()) {
    mapped =
      mapped.slice(0, replacement.start) +
      replacement.text +
      mapped.slice(replacement.end);
  }
  return mapped;
}
