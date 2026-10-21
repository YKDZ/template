#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { projectTomlStringValues } from "@ykdz/template-core/toml";
import ts from "typescript";

import { repositoryDevelopmentEnvironment } from "./repository-environment.ts";
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
  readonly before: string | undefined;
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

function projectCli(file: string, contents: string, value: string): string {
  const source = ts.parseJsonText(file, contents);
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
    throw new Error(`${file}: 无法识别 engines`);
  return replaceStrings(source, initializer, { node: value });
}

async function replaceFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.repository-config-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 同步与只读检查消费同一完整计划；输入预检期间不改写目标。 */
export async function planRepositoryConfiguration(
  repositoryRoot: string,
): Promise<readonly Target[]> {
  const declarations = await readTemplateToolchainDeclarations(repositoryRoot);
  const derived = deriveTemplateToolchain(declarations);
  if (derived.diagnostics.length > 0)
    throw new Error(derived.diagnostics.join("\n"));
  const partialFiles = [
    "packages/cli/package.json",
    "references/ts-cli/package.json",
    "references/rust-bin/template/rust-toolchain.toml",
  ];
  const contents = await Promise.all(
    partialFiles.map((file) =>
      readFile(path.join(repositoryRoot, file), "utf8"),
    ),
  );
  const partialOutputs = [
    ...partialFiles
      .slice(0, 2)
      .map((file, index) =>
        projectCli(file, contents[index]!, derived.cliNodeEngine),
      ),
    projectTomlStringValues(contents[2]!, [
      {
        path: ["toolchain", "channel"],
        value: declarations.rustToolchainChannel.trim(),
      },
    ]),
  ];
  const environment = await repositoryDevelopmentEnvironment(declarations);
  const targets: Target[] = partialFiles.map((file, index) => ({
    file,
    before: contents[index]!,
    after: partialOutputs[index]!,
  }));
  for (const [file, after] of Object.entries(environment.files)) {
    const before = await readFile(
      path.join(repositoryRoot, file),
      "utf8",
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    targets.push({ file, before, after });
  }
  return targets;
}

export async function checkRepositoryConfiguration(
  repositoryRoot: string,
): Promise<readonly string[]> {
  return (await planRepositoryConfiguration(repositoryRoot))
    .filter(({ before, after }) => before !== after)
    .map(
      ({ file, before }) =>
        `${file} ${before === undefined ? "缺失受管投影" : "配置投影漂移"}；请运行 pnpm run sync`,
    );
}

/** 写入替身仅用于系统边界故障验收。 */
export async function syncRepositoryConfiguration(
  repositoryRoot: string,
  replace: (file: string, contents: string) => Promise<void> = replaceFile,
): Promise<string[]> {
  const targets = await planRepositoryConfiguration(repositoryRoot);
  const updated: string[] = [];
  try {
    for (const target of targets) {
      if (target.before === target.after) continue;
      await mkdir(path.dirname(path.join(repositoryRoot, target.file)), {
        recursive: true,
      });
      await replace(path.join(repositoryRoot, target.file), target.after);
      updated.push(target.file);
    }
  } catch (error) {
    throw new Error(
      `仓库配置同步写入失败；已更新文件：${updated.length === 0 ? "无" : updated.join("、")}；修复环境后重新运行 sync:repository`,
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
    if (process.argv.includes("--check")) {
      const diagnostics = await checkRepositoryConfiguration(
        path.resolve(root),
      );
      if (diagnostics.length > 0) {
        console.error(diagnostics.join("\n"));
        process.exitCode = 1;
      } else console.log("仓库配置静态投影一致");
    } else {
      const updated = await syncRepositoryConfiguration(path.resolve(root));
      console.log(
        updated.length === 0
          ? "仓库配置静态投影一致，无需修改"
          : `已同步仓库配置：${updated.join("、")}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
