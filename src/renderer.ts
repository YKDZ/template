import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type RenderVariables = Record<string, string>;

export type CopyFileOperation = {
  kind: "copyFile";
  from: string;
  to: string;
};

export type WriteJsonOperation = {
  kind: "writeJson";
  to: string;
  value: unknown;
  multilineArrays?: string[];
};

export type MergeJsonOperation = {
  kind: "mergeJson";
  to: string;
  value: unknown;
};

export type WriteTextOperation = {
  kind: "writeText";
  to: string;
  text: string;
};

export type SetExecutableOperation = {
  kind: "setExecutable";
  path: string;
  executable: boolean;
};

export type ReplaceAnchorsOperation = {
  kind: "replaceAnchors";
  path: string;
  language: "typescript";
  replacements: Record<string, string>;
};

export type RenderOperation =
  | CopyFileOperation
  | WriteJsonOperation
  | MergeJsonOperation
  | WriteTextOperation
  | SetExecutableOperation
  | ReplaceAnchorsOperation;

export type RenderProjectOptions = {
  sourceRoot: string;
  targetRoot: string;
  variables?: RenderVariables;
  operations: RenderOperation[];
};

function expandTemplatePath(templatePath: string, variables: RenderVariables): string {
  return templatePath.replaceAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    const value = variables[name];

    if (!value) {
      throw new Error(`Missing renderer variable: ${name}`);
    }

    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`Renderer variable ${name} is not safe for a path segment`);
    }

    return value;
  });
}

function resolveContainedPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Renderer paths must be relative: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insideRoot =
    resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`Renderer path escapes its root: ${relativePath}`);
  }

  return resolvedPath;
}

async function renderCopyFile(
  operation: CopyFileOperation,
  options: RenderProjectOptions
): Promise<void> {
  const variables = options.variables ?? {};
  const from = resolveContainedPath(
    options.sourceRoot,
    expandTemplatePath(operation.from, variables)
  );
  const to = resolveContainedPath(options.targetRoot, expandTemplatePath(operation.to, variables));
  const sourceMode = (await stat(from)).mode;

  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  await chmod(to, sourceMode & 0o777);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalarJsonValue(value: unknown): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function serializeJsonValue(
  value: unknown,
  indentation: number,
  pathSegments: string[],
  multilineArrays: Set<string>
): string {
  if (Array.isArray(value)) {
    const compact = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    const shouldCompact =
      value.every(isScalarJsonValue) &&
      !multilineArrays.has(pathSegments.join(".")) &&
      indentation + compact.length <= 100;

    if (shouldCompact) {
      return compact;
    }

    const items = value.map(
      (item, index) =>
        `${" ".repeat(indentation + 2)}${serializeJsonValue(
          item,
          indentation + 2,
          [...pathSegments, String(index)],
          multilineArrays
        )}`
    );
    return `[\n${items.join(",\n")}\n${" ".repeat(indentation)}]`;
  }

  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value);

  if (entries.length === 0) {
    return "{}";
  }

  return (
    "{\n" +
    entries
      .map(
        ([key, entryValue]) =>
          `${" ".repeat(indentation + 2)}${JSON.stringify(key)}: ${serializeJsonValue(
            entryValue,
            indentation + 2,
            [...pathSegments, key],
            multilineArrays
          )}`
      )
      .join(",\n") +
    `\n${" ".repeat(indentation)}}`
  );
}

function serializeJson(value: unknown, multilineArrays: string[] = []): string {
  return `${serializeJsonValue(value, 0, [], new Set(multilineArrays))}\n`;
}

function mergeJsonValue(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in result ? mergeJsonValue(result[key], value) : value;
  }

  return result;
}

async function writeJsonFile(
  targetRoot: string,
  toPath: string,
  value: unknown,
  multilineArrays?: string[]
): Promise<void> {
  const to = resolveContainedPath(targetRoot, toPath);

  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, serializeJson(value, multilineArrays), "utf8");
}

async function renderWriteJson(
  operation: WriteJsonOperation,
  options: RenderProjectOptions
): Promise<void> {
  await writeJsonFile(
    options.targetRoot,
    operation.to,
    operation.value,
    operation.multilineArrays
  );
}

async function renderMergeJson(
  operation: MergeJsonOperation,
  options: RenderProjectOptions
): Promise<void> {
  const to = resolveContainedPath(options.targetRoot, operation.to);
  let existing: unknown = {};

  try {
    existing = JSON.parse(await readFile(to, "utf8")) as unknown;
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeJsonFile(options.targetRoot, operation.to, mergeJsonValue(existing, operation.value));
}

const foundationTextFiles = new Set([
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".npmignore",
  ".npmrc",
  "README",
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
]);

function assertFoundationTextPath(relativePath: string): void {
  const basename = path.basename(relativePath);

  if (foundationTextFiles.has(basename)) {
    return;
  }

  if (relativePath.endsWith(".md") && !relativePath.includes(`${path.sep}src${path.sep}`)) {
    return;
  }

  if (
    (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")) &&
    !relativePath.includes(`${path.sep}src${path.sep}`)
  ) {
    return;
  }

  throw new Error(`Text output is limited to foundation files: ${relativePath}`);
}

async function renderWriteText(
  operation: WriteTextOperation,
  options: RenderProjectOptions
): Promise<void> {
  assertFoundationTextPath(operation.to);
  const to = resolveContainedPath(options.targetRoot, operation.to);

  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, operation.text, "utf8");
}

async function renderSetExecutable(
  operation: SetExecutableOperation,
  options: RenderProjectOptions
): Promise<void> {
  const filePath = resolveContainedPath(options.targetRoot, operation.path);
  const currentMode = (await stat(filePath)).mode;
  const executeBits = 0o111;
  const mode = operation.executable
    ? currentMode | executeBits
    : currentMode & ~executeBits;

  await chmod(filePath, mode & 0o777);
}

type AnchorRange = {
  name: string;
  start: number;
  end: number;
};

async function findTypeScriptAnchorRanges(sourceText: string): Promise<AnchorRange[]> {
  const ts = await import("typescript");
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText
  );
  const anchors: AnchorRange[] = [];

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const token = scanner.getToken();

    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }

    const text = scanner.getTokenText();
    const match = text.match(/@template-anchor\s+([A-Za-z][A-Za-z0-9_-]*)/);

    if (match) {
      anchors.push({
        name: match[1],
        start: scanner.getTokenStart(),
        end: scanner.getTextPos()
      });
    }
  }

  return anchors;
}

function replaceRanges(sourceText: string, ranges: AnchorRange[], replacements: Record<string, string>) {
  let nextText = sourceText;

  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const replacement = replacements[range.name];
    nextText = `${nextText.slice(0, range.start)}${replacement}${nextText.slice(range.end)}`;
  }

  return nextText;
}

async function renderReplaceAnchors(
  operation: ReplaceAnchorsOperation,
  options: RenderProjectOptions
): Promise<void> {
  const filePath = resolveContainedPath(options.targetRoot, operation.path);
  const sourceText = await readFile(filePath, "utf8");
  const ranges = await findTypeScriptAnchorRanges(sourceText);

  for (const anchorName of Object.keys(operation.replacements)) {
    const matches = ranges.filter((range) => range.name === anchorName);

    if (matches.length === 0) {
      throw new Error(`Missing Checked Transform Anchor: ${anchorName}`);
    }

    if (matches.length > 1) {
      throw new Error(`Duplicate Checked Transform Anchor: ${anchorName}`);
    }
  }

  await writeFile(filePath, replaceRanges(sourceText, ranges, operation.replacements), "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function renderProject(options: RenderProjectOptions): Promise<void> {
  for (const operation of options.operations) {
    if (operation.kind === "copyFile") {
      await renderCopyFile(operation, options);
      continue;
    }

    if (operation.kind === "writeJson") {
      await renderWriteJson(operation, options);
      continue;
    }

    if (operation.kind === "mergeJson") {
      await renderMergeJson(operation, options);
      continue;
    }

    if (operation.kind === "writeText") {
      await renderWriteText(operation, options);
      continue;
    }

    if (operation.kind === "setExecutable") {
      await renderSetExecutable(operation, options);
      continue;
    }

    if (operation.kind === "replaceAnchors") {
      await renderReplaceAnchors(operation, options);
      continue;
    }

    throw new Error(`Unsupported renderer operation: ${(operation as { kind: string }).kind}`);
  }
}
