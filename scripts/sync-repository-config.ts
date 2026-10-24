#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
  readonly label: string;
  readonly before: string | undefined;
  readonly after: string;
  write(contents: string): Promise<void>;
};
type PreparedOwnerTarget = {
  readonly label: string;
  readonly before: string;
  write(contents: string): Promise<void>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPreparedOwnerTarget(value: unknown): value is PreparedOwnerTarget {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.before === "string" &&
    typeof value.write === "function"
  );
}

async function prepareOwnerTarget(
  resolve: ReturnType<typeof createRequire>,
  specifier: string,
): Promise<PreparedOwnerTarget> {
  const entry = resolve.resolve(specifier);
  const ownerModule: unknown = await import(pathToFileURL(entry).href);
  if (!isRecord(ownerModule))
    throw new Error(`${specifier}: 无法读取维护公开入口`);
  const prepare = ownerModule.prepareRepositoryConfigurationTarget;
  if (typeof prepare !== "function")
    throw new Error(`${specifier}: 缺少维护目标准备能力`);
  const target: unknown = await prepare();
  if (!isPreparedOwnerTarget(target))
    throw new Error(`${specifier}: 维护目标不符合宿主合同`);
  return target;
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
  const resolve = createRequire(path.join(repositoryRoot, "package.json"));
  const ownerTargets = await Promise.all([
    prepareOwnerTarget(resolve, "@ykdz/template/repository-configuration"),
    prepareOwnerTarget(
      resolve,
      "@ykdz/reference-ts-cli/repository-configuration",
    ),
    prepareOwnerTarget(
      resolve,
      "@ykdz/reference-rust-bin/repository-configuration",
    ),
  ]);
  const partialOutputs = [
    ...ownerTargets
      .slice(0, 2)
      .map((target) =>
        projectCli(target.label, target.before, derived.cliNodeEngine),
      ),
    projectTomlStringValues(ownerTargets[2]!.before, [
      {
        path: ["toolchain", "channel"],
        value: declarations.rustToolchainChannel.trim(),
      },
    ]),
  ];
  const environment = await repositoryDevelopmentEnvironment(declarations);
  const targets: Target[] = ownerTargets.map((target, index) => ({
    label: target.label,
    before: target.before,
    after: partialOutputs[index]!,
    write: target.write,
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
    targets.push({
      label: file,
      before,
      after,
      write: async (contents) => {
        const destination = path.join(repositoryRoot, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await replaceFile(destination, contents);
      },
    });
  }
  return targets;
}

export async function checkRepositoryConfiguration(
  repositoryRoot: string,
): Promise<readonly string[]> {
  return (await planRepositoryConfiguration(repositoryRoot))
    .filter(({ before, after }) => before !== after)
    .map(
      ({ label, before }) =>
        `${label} ${before === undefined ? "缺失受管投影" : "配置投影漂移"}；请运行 pnpm run sync`,
    );
}

/** 写入替身仅用于系统边界故障验收。 */
export async function syncRepositoryConfiguration(
  repositoryRoot: string,
  replace: (
    label: string,
    write: () => Promise<void>,
  ) => Promise<void> = (_label, write) => write(),
): Promise<string[]> {
  const targets = await planRepositoryConfiguration(repositoryRoot);
  const updated: string[] = [];
  try {
    for (const target of targets) {
      if (target.before === target.after) continue;
      await replace(target.label, () => target.write(target.after));
      updated.push(target.label);
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
