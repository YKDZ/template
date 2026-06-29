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

function expandOperationPath(relativePath: string, options: RenderProjectOptions): string {
  return expandTemplatePath(relativePath, options.variables ?? {});
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
  multilineArrays: Set<string>,
  rootKeyOrder?: Map<string, number>
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
          multilineArrays,
          rootKeyOrder
        )}`
    );
    return `[\n${items.join(",\n")}\n${" ".repeat(indentation)}]`;
  }

  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    compareJsonKeys(left, right, pathSegments, rootKeyOrder)
  );

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
            multilineArrays,
            rootKeyOrder
          )}`
      )
      .join(",\n") +
    `\n${" ".repeat(indentation)}}`
  );
}

const packageJsonRootKeyOrder = [
  "name",
  "version",
  "private",
  "files",
  "type",
  "exports",
  "scripts",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "packageManager"
];

function compareJsonKeys(
  left: string,
  right: string,
  pathSegments: string[],
  rootKeyOrder?: Map<string, number>
): number {
  if (pathSegments.length === 0 && rootKeyOrder) {
    const leftOrder = rootKeyOrder.get(left) ?? Number.POSITIVE_INFINITY;
    const rightOrder = rootKeyOrder.get(right) ?? Number.POSITIVE_INFINITY;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
  }

  return left.localeCompare(right);
}

function rootKeyOrderForPath(toPath: string): Map<string, number> | undefined {
  if (path.basename(toPath) !== "package.json") {
    return undefined;
  }

  return new Map(packageJsonRootKeyOrder.map((key, index) => [key, index]));
}

function serializeJson(
  value: unknown,
  multilineArrays: string[] = [],
  rootKeyOrder?: Map<string, number>
): string {
  return `${serializeJsonValue(value, 0, [], new Set(multilineArrays), rootKeyOrder)}\n`;
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
  await writeFile(to, serializeJson(value, multilineArrays, rootKeyOrderForPath(toPath)), "utf8");
}

async function renderWriteJson(
  operation: WriteJsonOperation,
  options: RenderProjectOptions
): Promise<void> {
  await writeJsonFile(
    options.targetRoot,
    expandOperationPath(operation.to, options),
    operation.value,
    operation.multilineArrays
  );
}

async function renderMergeJson(
  operation: MergeJsonOperation,
  options: RenderProjectOptions
): Promise<void> {
  const toPath = expandOperationPath(operation.to, options);
  const to = resolveContainedPath(options.targetRoot, toPath);
  let existing: unknown = {};

  try {
    existing = JSON.parse(await readFile(to, "utf8")) as unknown;
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeJsonFile(options.targetRoot, toPath, mergeJsonValue(existing, operation.value));
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
  const normalizedPath = relativePath.split(path.sep).join("/");
  const isRootLevel = !normalizedPath.includes("/");

  if (isRootLevel && foundationTextFiles.has(normalizedPath)) {
    return;
  }

  if (isRootLevel && relativePath.endsWith(".md")) {
    return;
  }

  if (isRootLevel && (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml"))) {
    return;
  }

  if (/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(normalizedPath)) {
    return;
  }

  if (/^\.github\/dependabot\.ya?ml$/.test(normalizedPath)) {
    return;
  }

  throw new Error(`Text output is limited to foundation files: ${relativePath}`);
}

async function renderWriteText(
  operation: WriteTextOperation,
  options: RenderProjectOptions
): Promise<void> {
  const toPath = expandOperationPath(operation.to, options);
  assertFoundationTextPath(toPath);
  const to = resolveContainedPath(options.targetRoot, toPath);

  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, operation.text, "utf8");
}

async function renderSetExecutable(
  operation: SetExecutableOperation,
  options: RenderProjectOptions
): Promise<void> {
  const filePath = resolveContainedPath(
    options.targetRoot,
    expandOperationPath(operation.path, options)
  );
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

type ParsedSourceFile = import("typescript").SourceFile & {
  parseDiagnostics?: readonly import("typescript").Diagnostic[];
};

function parseAnchorComment(commentText: string): string | undefined {
  const singleLine = commentText.match(/^\/\/\s*@template-anchor\s+([A-Za-z][A-Za-z0-9_-]*)\s*$/);
  if (singleLine) {
    return singleLine[1];
  }

  const multiline = commentText.match(
    /^\/\*\s*@template-anchor\s+([A-Za-z][A-Za-z0-9_-]*)\s*\*\/$/
  );
  return multiline?.[1];
}

async function findTypeScriptAnchorRanges(sourceText: string): Promise<AnchorRange[]> {
  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(
    "template-anchor.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const anchors: AnchorRange[] = [];
  const seenRanges = new Set<string>();

  if (((sourceFile as ParsedSourceFile).parseDiagnostics ?? []).length > 0) {
    throw new Error("Checked Transform Anchor requires valid TypeScript source");
  }

  function collectNodeAnchors(node: import("typescript").Node): void {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return;
    }

    const comments = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];

    for (const comment of comments) {
      const name = parseAnchorComment(sourceText.slice(comment.pos, comment.end));
      const rangeKey = `${comment.pos}:${comment.end}`;

      if (name === undefined || seenRanges.has(rangeKey)) {
        continue;
      }

      seenRanges.add(rangeKey);
      anchors.push({
        name,
        start: comment.pos,
        end: comment.end
      });
    }

    ts.forEachChild(node, collectNodeAnchors);
  }

  ts.forEachChild(sourceFile, collectNodeAnchors);
  return anchors;
}

function replaceRanges(sourceText: string, ranges: AnchorRange[], replacements: Record<string, string>) {
  let nextText = sourceText;

  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const replacement = replacements[range.name];
    if (replacement === undefined) {
      continue;
    }

    nextText = `${nextText.slice(0, range.start)}${replacement}${nextText.slice(range.end)}`;
  }

  return nextText;
}

async function renderReplaceAnchors(
  operation: ReplaceAnchorsOperation,
  options: RenderProjectOptions
): Promise<void> {
  if (operation.language !== "typescript") {
    throw new Error("Checked Transform Anchor only supports TypeScript");
  }

  const filePath = resolveContainedPath(
    options.targetRoot,
    expandOperationPath(operation.path, options)
  );
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
