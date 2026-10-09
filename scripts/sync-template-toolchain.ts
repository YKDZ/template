#!/usr/bin/env node
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import {
  deriveTemplateToolchain,
  readTemplateToolchainDeclarations,
} from "./template-toolchain-declarations.ts";

type Replacement = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};
type Target = {
  readonly file: string;
  readonly before: string;
  readonly after: string;
};

function replaceStrings(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  values: Readonly<Record<string, string>>,
): string {
  const edits: Replacement[] = [];
  for (const [name, value] of Object.entries(values)) {
    const properties = object.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name,
    );
    const property = properties[0];
    if (
      properties.length !== 1 ||
      property === undefined ||
      !ts.isStringLiteral(property.initializer)
    )
      throw new Error(`${source.fileName}: 无法识别唯一字符串字段 ${name}`);
    edits.push({
      start: property.initializer.getStart(source),
      end: property.initializer.end,
      value: JSON.stringify(value),
    });
  }
  let contents = source.text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    contents =
      contents.slice(0, edit.start) + edit.value + contents.slice(edit.end);
  return contents;
}

function projectCli(contents: string, value: string): string {
  const source = ts.parseJsonText("packages/cli/package.json", contents);
  JSON.parse(contents);
  const statement = source.statements[0];
  const object =
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    ts.isObjectLiteralExpression(statement.expression)
      ? statement.expression
      : undefined;
  const engines = object?.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === "engines",
  );
  const initializer = engines?.[0]?.initializer;
  if (
    engines?.length !== 1 ||
    initializer === undefined ||
    !ts.isObjectLiteralExpression(initializer)
  )
    throw new Error("packages/cli/package.json: 无法识别 engines");
  return replaceStrings(source, initializer, { node: value });
}

function projectSnapshot(
  contents: string,
  values: Readonly<Record<string, string>>,
): string {
  const diagnostics =
    ts.transpileModule(contents, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest },
    }).diagnostics ?? [];
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new Error(
      "packages/core/src/release-toolchain-snapshot.ts: 无法解析静态快照语法",
    );
  const source = ts.createSourceFile(
    "packages/core/src/release-toolchain-snapshot.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "releaseToolchainSnapshot"
        )
          declarations.push(declaration);
  const initializer = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    initializer === undefined ||
    !ts.isCallExpression(initializer) ||
    initializer.expression.getText(source) !== "Object.freeze" ||
    initializer.arguments.length !== 1
  )
    throw new Error(`${source.fileName}: 无法识别静态 Object.freeze 快照`);
  const argument = initializer.arguments[0]!;
  const object = ts.isAsExpression(argument) ? argument.expression : argument;
  if (!ts.isObjectLiteralExpression(object))
    throw new Error(`${source.fileName}: 无法识别静态快照字段`);
  return replaceStrings(source, object, values);
}

async function replaceFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.toolchain-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 维护入口：全部预检完成后逐文件完整替换；写入替身仅用于系统边界故障验收。 */
export async function syncTemplateToolchain(
  repositoryRoot: string,
  replace: (file: string, contents: string) => Promise<void> = replaceFile,
): Promise<string[]> {
  const declarations = await readTemplateToolchainDeclarations(repositoryRoot);
  const derived = deriveTemplateToolchain(declarations);
  if (derived.diagnostics.length > 0)
    throw new Error(derived.diagnostics.join("\n"));
  const files = [
    "packages/cli/package.json",
    ".devcontainer/Dockerfile",
    "packages/core/src/release-toolchain-snapshot.ts",
  ];
  const contents = await Promise.all(
    files.map((file) => readFile(path.join(repositoryRoot, file), "utf8")),
  );
  const docker = contents[1]!;
  const images = [
    ...docker.matchAll(/^(\s*FROM\s+node:)([^\s-]+)(-\S+)(.*)$/gimu),
  ];
  if (images.length !== 1)
    throw new Error(".devcontainer/Dockerfile: 无法识别唯一 node 基础镜像");
  const outputs = [
    projectCli(contents[0]!, derived.cliNodeEngine),
    docker.replace(
      /^(\s*FROM\s+node:)([^\s-]+)(-\S+)(.*)$/gimu,
      `$1${declarations.rootNodeEngine.trim()}$3$4`,
    ),
    projectSnapshot(contents[2]!, {
      nodeVersion: declarations.rootNodeEngine.trim(),
      packageManagerPin: declarations.packageManagerDeclaration.trim(),
      rustVersion: declarations.rustToolchainChannel.trim(),
    }),
  ];
  const targets: Target[] = files.map((file, index) => ({
    file,
    before: contents[index]!,
    after: outputs[index]!,
  }));
  const updated: string[] = [];
  try {
    for (const target of targets)
      if (target.before !== target.after) {
        await replace(path.join(repositoryRoot, target.file), target.after);
        updated.push(target.file);
      }
  } catch (error) {
    throw new Error(
      `工具链同步写入失败；已更新文件：${updated.length === 0 ? "无" : updated.join("、")}；修复环境后重新运行 sync:toolchain`,
      { cause: error },
    );
  }
  return updated;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const index = process.argv.indexOf("--repository-root");
    const root =
      index === -1
        ? path.resolve(import.meta.dirname, "..")
        : process.argv[index + 1];
    if (root === undefined) throw new Error("--repository-root 缺少路径");
    const updated = await syncTemplateToolchain(path.resolve(root));
    console.log(
      updated.length === 0
        ? "工具链静态投影一致，无需修改"
        : `已同步工具链：${updated.join("、")}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
