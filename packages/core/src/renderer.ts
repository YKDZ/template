import { constants } from "node:fs";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type RenderVariables = Record<string, string>;

export type RenderOperationProvenance = {
  readonly definitionName: string;
  readonly plannerSourceFile: string;
  readonly planningContribution: string;
  readonly ownershipRule: string;
};

/**
 * An opaque, owned Template Source reference.  A renderer operation carries
 * this directly instead of selecting a root from a string-keyed side map.
 */
const templateSourceHandleBrand: unique symbol = Symbol("template-source");

export type TemplateSourceHandle = {
  readonly [templateSourceHandleBrand]: true;
};

const templateSourceRoots = new WeakMap<object, string>();

export function createTemplateSourceHandle(root: string): TemplateSourceHandle {
  const handle = Object.freeze({
    [templateSourceHandleBrand]: true as const,
  });
  templateSourceRoots.set(handle, path.resolve(root));
  return handle;
}

/** Resolves a handle-owned source path while enforcing containment. */
export function resolveTemplateSource(
  source: TemplateSourceHandle,
  relativePath: string,
): string {
  const root =
    typeof source === "object" && source !== null
      ? templateSourceRoots.get(source)
      : undefined;
  if (root === undefined) {
    throw new Error("Renderer received an unknown Template Source handle");
  }
  return resolveContainedPath(root, relativePath);
}

export type CopyFileOperation = {
  kind: "copyFile";
  from: string;
  to: string;
  source: TemplateSourceHandle;
  overwrite?: boolean;
  provenance?: RenderOperationProvenance;
};

export type WriteJsonOperation = {
  kind: "writeJson";
  to: string;
  value: unknown;
  multilineArrays?: string[];
  keyOrder?: readonly string[];
  nestedKeyOrder?: readonly string[];
  overwrite?: boolean;
  provenance?: RenderOperationProvenance;
};

export type MergeJsonOperation = {
  kind: "mergeJson";
  to: string;
  value: unknown;
  multilineArrays?: string[];
  keyOrder?: readonly string[];
  nestedKeyOrder?: readonly string[];
  provenance?: RenderOperationProvenance;
};

export type MergeJsonTemplateOperation = {
  kind: "mergeJsonTemplate";
  from: string;
  to: string;
  source: TemplateSourceHandle;
  multilineArrays?: string[];
  keyOrder?: readonly string[];
  nestedKeyOrder?: readonly string[];
  provenance?: RenderOperationProvenance;
};

export type WriteTextOperation = {
  kind: "writeText";
  to: string;
  text: string;
  provenance?: RenderOperationProvenance;
};

export type WriteTextFromFragmentsOperation = {
  kind: "writeTextFromFragments";
  to: string;
  fragments: readonly {
    from: string;
    source: TemplateSourceHandle;
  }[];
  overwrite?: boolean;
  provenance?: RenderOperationProvenance;
};

export type WriteTextTemplateOperation = {
  kind: "writeTextTemplate";
  from: string;
  to: string;
  source: TemplateSourceHandle;
  replacements: Record<string, string>;
  /** Follow-up plans may refresh a coordinated template-owned file. */
  overwrite?: boolean;
  provenance?: RenderOperationProvenance;
};

export type SetExecutableOperation = {
  kind: "setExecutable";
  path: string;
  executable: boolean;
  provenance?: RenderOperationProvenance;
};

export type ReplaceAnchorsOperation = {
  kind: "replaceAnchors";
  path: string;
  language: "typescript";
  replacements: Record<string, string>;
  provenance?: RenderOperationProvenance;
};

export type RenderOperation =
  | CopyFileOperation
  | WriteJsonOperation
  | MergeJsonOperation
  | MergeJsonTemplateOperation
  | WriteTextOperation
  | WriteTextFromFragmentsOperation
  | WriteTextTemplateOperation
  | SetExecutableOperation
  | ReplaceAnchorsOperation;

export type RenderProjectOptions = {
  targetRoot: string;
  variables?: RenderVariables | undefined;
  operations: RenderOperation[];
};

function expandTemplatePath(
  templatePath: string,
  variables: RenderVariables,
): string {
  return templatePath.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_, name: string) => {
      const value = variables[name];

      if (!value) {
        throw new Error(`Missing renderer variable: ${name}`);
      }

      if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error(
          `Renderer variable ${name} is not safe for a path segment`,
        );
      }

      return value;
    },
  );
}

function resolveContainedPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Renderer paths must be relative: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`Renderer path escapes its root: ${relativePath}`);
  }

  return resolvedPath;
}

function expandOperationPath(
  relativePath: string,
  options: RenderProjectOptions,
): string {
  return expandTemplatePath(relativePath, options.variables ?? {});
}

async function renderCopyFile(
  operation: CopyFileOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const variables = options.variables ?? {};
  const from = resolveTemplateSource(
    operation.source,
    expandTemplatePath(operation.from, variables),
  );
  const to = resolveContainedPath(
    options.targetRoot,
    expandTemplatePath(operation.to, variables),
  );
  const sourceMode = (await stat(from)).mode;

  await mkdir(path.dirname(to), { recursive: true });
  await copyGeneratedFile(from, to, operation.overwrite ?? false);
  await chmod(to, sourceMode & 0o777);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalarJsonValue(value: unknown): boolean {
  return (
    value === null || ["boolean", "number", "string"].includes(typeof value)
  );
}

function serializeJsonValue(
  value: unknown,
  indentation: number,
  pathSegments: string[],
  multilineArrays: Set<string>,
  rootKeyOrder?: Map<string, number>,
  nestedKeyOrder?: Map<string, number>,
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
          rootKeyOrder,
          nestedKeyOrder,
        )}`,
    );
    return `[\n${items.join(",\n")}\n${" ".repeat(indentation)}]`;
  }

  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value).toSorted(([left], [right]) =>
    compareJsonKeys(left, right, pathSegments, rootKeyOrder, nestedKeyOrder),
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
            rootKeyOrder,
            nestedKeyOrder,
          )}`,
      )
      .join(",\n") +
    `\n${" ".repeat(indentation)}}`
  );
}

function compareJsonKeys(
  left: string,
  right: string,
  pathSegments: string[],
  rootKeyOrder?: Map<string, number>,
  nestedKeyOrder?: Map<string, number>,
): number {
  const keyOrder = pathSegments.length === 0 ? rootKeyOrder : nestedKeyOrder;
  if (keyOrder) {
    const leftOrder = keyOrder.get(left) ?? Number.POSITIVE_INFINITY;
    const rightOrder = keyOrder.get(right) ?? Number.POSITIVE_INFINITY;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
  }

  return left.localeCompare(right);
}

function serializeJson(
  value: unknown,
  multilineArrays: string[] = [],
  rootKeyOrder?: Map<string, number>,
  nestedKeyOrder?: Map<string, number>,
): string {
  return `${serializeJsonValue(
    value,
    0,
    [],
    new Set(multilineArrays),
    rootKeyOrder,
    nestedKeyOrder,
  )}\n`;
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
  multilineArrays?: string[],
  keyOrder?: readonly string[],
  nestedKeyOrder?: readonly string[],
  overwrite = false,
): Promise<void> {
  const to = resolveContainedPath(targetRoot, toPath);

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(
    to,
    serializeJson(
      value,
      multilineArrays,
      keyOrder === undefined
        ? undefined
        : new Map(keyOrder.map((key, index) => [key, index])),
      nestedKeyOrder === undefined
        ? undefined
        : new Map(nestedKeyOrder.map((key, index) => [key, index])),
    ),
    overwrite,
  );
}

async function renderWriteJson(
  operation: WriteJsonOperation,
  options: RenderProjectOptions,
): Promise<void> {
  await writeJsonFile(
    options.targetRoot,
    expandOperationPath(operation.to, options),
    operation.value,
    operation.multilineArrays,
    operation.keyOrder,
    operation.nestedKeyOrder,
    operation.overwrite,
  );
}

async function renderMergeJson(
  operation: MergeJsonOperation,
  options: RenderProjectOptions,
): Promise<void> {
  await mergeJsonIntoFile({
    options,
    patch: operation.value,
    toPath: expandOperationPath(operation.to, options),
    multilineArrays: operation.multilineArrays,
    keyOrder: operation.keyOrder,
    nestedKeyOrder: operation.nestedKeyOrder,
  });
}

async function renderMergeJsonTemplate(
  operation: MergeJsonTemplateOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const variables = options.variables ?? {};
  const sourcePath = resolveTemplateSource(
    operation.source,
    expandTemplatePath(operation.from, variables),
  );
  let patch: unknown;
  try {
    patch = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON Template Source ${operation.from}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  await mergeJsonIntoFile({
    options,
    patch,
    toPath: expandOperationPath(operation.to, options),
    multilineArrays: operation.multilineArrays,
    keyOrder: operation.keyOrder,
    nestedKeyOrder: operation.nestedKeyOrder,
  });
}

async function mergeJsonIntoFile(options: {
  readonly options: RenderProjectOptions;
  readonly patch: unknown;
  readonly toPath: string;
  readonly multilineArrays: string[] | undefined;
  readonly keyOrder: readonly string[] | undefined;
  readonly nestedKeyOrder: readonly string[] | undefined;
}): Promise<void> {
  const to = resolveContainedPath(options.options.targetRoot, options.toPath);
  let existing: unknown = {};

  try {
    existing = JSON.parse(await readFile(to, "utf8")) as unknown;
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeJsonFile(
    options.options.targetRoot,
    options.toPath,
    mergeJsonValue(existing, options.patch),
    options.multilineArrays,
    options.keyOrder,
    options.nestedKeyOrder,
    true,
  );
}

async function renderWriteText(
  operation: WriteTextOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const toPath = expandOperationPath(operation.to, options);
  const to = resolveContainedPath(options.targetRoot, toPath);

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(to, operation.text);
}

async function renderWriteTextFromFragments(
  operation: WriteTextFromFragmentsOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const toPath = expandOperationPath(operation.to, options);
  const to = resolveContainedPath(options.targetRoot, toPath);
  const texts = await Promise.all(
    operation.fragments.map(async (fragment) => {
      const fromPath = expandTemplatePath(
        fragment.from,
        options.variables ?? {},
      );
      const from = resolveTemplateSource(fragment.source, fromPath);

      return readFile(from, "utf8");
    }),
  );

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(
    to,
    texts.map((text) => text.trimEnd()).join("\n\n") + "\n",
    operation.overwrite ?? false,
  );
}

function replaceTextTemplateVariables(
  sourceText: string,
  replacements: Record<string, string>,
): string {
  const used = new Set<string>();
  const rendered = sourceText.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_placeholder, name: string) => {
      const replacement = replacements[name];

      if (replacement === undefined) {
        throw new Error(`Missing text template variable: ${name}`);
      }

      used.add(name);
      return replacement;
    },
  );

  for (const name of Object.keys(replacements)) {
    if (!used.has(name)) {
      throw new Error(`Unused text template variable: ${name}`);
    }
  }

  return rendered;
}

async function renderWriteTextTemplate(
  operation: WriteTextTemplateOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const toPath = expandOperationPath(operation.to, options);
  const from = resolveTemplateSource(
    operation.source,
    expandTemplatePath(operation.from, options.variables ?? {}),
  );
  const to = resolveContainedPath(options.targetRoot, toPath);
  const sourceText = await readFile(from, "utf8");

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(
    to,
    replaceTextTemplateVariables(sourceText, operation.replacements),
    operation.overwrite,
  );
}

async function renderSetExecutable(
  operation: SetExecutableOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const filePath = resolveContainedPath(
    options.targetRoot,
    expandOperationPath(operation.path, options),
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
  const singleLine = commentText.match(
    /^\/\/\s*@template-anchor\s+([A-Za-z][A-Za-z0-9_-]*)\s*$/,
  );
  if (singleLine) {
    return singleLine[1];
  }

  const multiline = commentText.match(
    /^\/\*\s*@template-anchor\s+([A-Za-z][A-Za-z0-9_-]*)\s*\*\/$/,
  );
  return multiline?.[1];
}

async function findTypeScriptAnchorRanges(
  sourceText: string,
): Promise<AnchorRange[]> {
  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(
    "template-anchor.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const anchors: AnchorRange[] = [];
  const seenRanges = new Set<string>();

  if (((sourceFile as ParsedSourceFile).parseDiagnostics ?? []).length > 0) {
    throw new Error(
      "Checked Transform Anchor requires valid TypeScript source",
    );
  }

  function collectNodeAnchors(node: import("typescript").Node): void {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return;
    }

    const comments =
      ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];

    for (const comment of comments) {
      const name = parseAnchorComment(
        sourceText.slice(comment.pos, comment.end),
      );
      const rangeKey = `${comment.pos}:${comment.end}`;

      if (name === undefined || seenRanges.has(rangeKey)) {
        continue;
      }

      seenRanges.add(rangeKey);
      anchors.push({
        name,
        start: comment.pos,
        end: comment.end,
      });
    }

    ts.forEachChild(node, collectNodeAnchors);
  }

  ts.forEachChild(sourceFile, collectNodeAnchors);
  return anchors;
}

function replaceRanges(
  sourceText: string,
  ranges: AnchorRange[],
  replacements: Record<string, string>,
) {
  let nextText = sourceText;

  for (const range of ranges.toSorted((a, b) => b.start - a.start)) {
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
  options: RenderProjectOptions,
): Promise<void> {
  if (operation.language !== "typescript") {
    throw new Error("Checked Transform Anchor only supports TypeScript");
  }

  const filePath = resolveContainedPath(
    options.targetRoot,
    expandOperationPath(operation.path, options),
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

  await writeFile(
    filePath,
    replaceRanges(sourceText, ranges, operation.replacements),
    "utf8",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

type TargetDirectoryStatus = "missing" | "empty";

async function targetDirectoryStatus(
  targetRoot: string,
): Promise<TargetDirectoryStatus> {
  try {
    const targetStat = await stat(targetRoot);

    if (!targetStat.isDirectory()) {
      throw new Error(`Target path is not a directory: ${targetRoot}`);
    }
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }

    throw error;
  }

  const entries = await readdir(targetRoot);
  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${targetRoot}`);
  }

  return "empty";
}

async function copyGeneratedFile(
  from: string,
  to: string,
  overwrite = false,
): Promise<void> {
  try {
    await copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${to}`, {
        cause: error,
      });
    }

    throw error;
  }
}

async function writeGeneratedFile(
  to: string,
  text: string,
  overwrite = false,
): Promise<void> {
  try {
    await writeFile(to, text, {
      encoding: "utf8",
      flag: overwrite ? "w" : "wx",
    });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${to}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function renderProject(
  options: RenderProjectOptions,
): Promise<void> {
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

    if (operation.kind === "mergeJsonTemplate") {
      await renderMergeJsonTemplate(operation, options);
      continue;
    }

    if (operation.kind === "writeText") {
      await renderWriteText(operation, options);
      continue;
    }

    if (operation.kind === "writeTextFromFragments") {
      await renderWriteTextFromFragments(operation, options);
      continue;
    }

    if (operation.kind === "writeTextTemplate") {
      await renderWriteTextTemplate(operation, options);
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

    throw new Error(
      `Unsupported renderer operation: ${(operation as { kind: string }).kind}`,
    );
  }
}

export type AtomicPathCommitOptions = {
  readonly relativePath: string;
  readonly stagingRoot: string;
  readonly targetRoot: string;
  readonly commit: () => Promise<void>;
};

export type AtomicProjectRendererDependencies = {
  readonly commitPath?: (options: AtomicPathCommitOptions) => Promise<void>;
};

/**
 * Creates a renderer that applies a follow-up plan in a sibling staging
 * directory. Metadata updates cannot become visible when a later source
 * operation fails.
 */
export function createAtomicProjectRenderer(
  dependencies: AtomicProjectRendererDependencies = {},
): (options: RenderProjectOptions) => Promise<void> {
  const commitPath =
    dependencies.commitPath ??
    (async (options: AtomicPathCommitOptions) => options.commit());

  return async (options: RenderProjectOptions): Promise<void> => {
    const targetRoot = path.resolve(options.targetRoot);
    await stat(targetRoot);
    const parent = path.dirname(targetRoot);
    const stagingRoot = await mkdtemp(
      path.join(parent, `.${path.basename(targetRoot)}.template-update-`),
    );
    const backupRoot = await mkdtemp(
      path.join(parent, `.${path.basename(targetRoot)}.template-backup-`),
    );
    const changedPaths = changedOutputPaths(options.operations);
    let committed = false;
    try {
      await stageInstalledWorkspace(targetRoot, stagingRoot);
      await renderProject({ ...options, targetRoot: stagingRoot });

      // Commit only the files changed by the staged plan.  In particular, do
      // not rename the target directory: callers commonly run `template add`
      // from that directory, and renaming it leaves their shell on a deleted
      // inode.  Each path has a rollback copy before it is made visible.
      for (const changedPath of changedPaths) {
        const current = path.join(targetRoot, changedPath);
        try {
          const backup = path.join(backupRoot, changedPath);
          await mkdir(path.dirname(backup), { recursive: true });
          await cp(current, backup, {
            recursive: true,
            filter: createGeneratedDependencyTreeCopyFilter(current),
          });
        } catch (error: unknown) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      }

      try {
        for (const changedPath of changedPaths) {
          const target = path.join(targetRoot, changedPath);
          const staged = path.join(stagingRoot, changedPath);
          await mkdir(path.dirname(target), { recursive: true });
          await commitPath({
            relativePath: changedPath,
            stagingRoot,
            targetRoot,
            commit: async () =>
              cp(staged, target, {
                recursive: true,
                force: true,
                filter: createGeneratedDependencyTreeCopyFilter(staged),
              }),
          });
        }
        committed = true;
      } catch (error) {
        await rollbackStagedPaths({ targetRoot, backupRoot, changedPaths });
        throw error;
      }
    } finally {
      if (!committed) await rm(stagingRoot, { recursive: true, force: true });
      await rm(backupRoot, { recursive: true, force: true });
      if (committed) await rm(stagingRoot, { recursive: true, force: true });
    }
  };
}

export const renderProjectAtomically = createAtomicProjectRenderer();

function changedOutputPaths(
  operations: readonly RenderOperation[],
): readonly string[] {
  const changedPaths = new Set<string>();
  for (const operation of operations) {
    const outputPath =
      operation.kind === "setExecutable" || operation.kind === "replaceAnchors"
        ? operation.path
        : operation.to;
    if (outputPath.length > 0) changedPaths.add(path.normalize(outputPath));
  }
  return [...changedPaths];
}

const stagedDependencyTreeDirectoryNames = new Set([
  ".pnpm-store",
  "node_modules",
]);

function createGeneratedDependencyTreeCopyFilter(
  sourceRoot: string,
): (source: string) => boolean {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  return (source: string) =>
    !path
      .relative(resolvedSourceRoot, source)
      .split(path.sep)
      .some((part) => stagedDependencyTreeDirectoryNames.has(part));
}

async function stageInstalledWorkspace(
  targetRoot: string,
  stagingRoot: string,
): Promise<void> {
  await cp(targetRoot, stagingRoot, {
    recursive: true,
    filter: createGeneratedDependencyTreeCopyFilter(targetRoot),
  });
  await linkInstalledDependencyTrees(targetRoot, stagingRoot);
}

async function linkInstalledDependencyTrees(
  sourceDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name);
    const staged = path.join(stagingDirectory, entry.name);

    if (entry.name === ".pnpm-store") {
      continue;
    }

    if (entry.name === "node_modules") {
      await symlink(
        source,
        staged,
        process.platform === "win32" ? "junction" : "dir",
      );
      continue;
    }

    if (entry.isDirectory()) {
      await linkInstalledDependencyTrees(source, staged);
    }
  }
}

async function rollbackStagedPaths(options: {
  readonly targetRoot: string;
  readonly backupRoot: string;
  readonly changedPaths: readonly string[];
}): Promise<void> {
  for (const changedPath of options.changedPaths) {
    const target = path.join(options.targetRoot, changedPath);
    const backup = path.join(options.backupRoot, changedPath);
    await rm(target, { recursive: true, force: true });
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(backup, target, {
        recursive: true,
        filter: createGeneratedDependencyTreeCopyFilter(backup),
      });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

async function commitStagedProject(
  stagingRoot: string,
  targetRoot: string,
): Promise<void> {
  const targetStatus = await targetDirectoryStatus(targetRoot);

  if (targetStatus === "empty") {
    try {
      await rmdir(targetRoot);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        // The target disappeared between the emptiness check and commit.
      } else if (isNodeError(error) && error.code === "ENOTEMPTY") {
        throw new Error(`Target directory is not empty: ${targetRoot}`, {
          cause: error,
        });
      } else {
        throw error;
      }
    }
  }

  try {
    await rename(stagingRoot, targetRoot);
  } catch (error: unknown) {
    if (
      isNodeError(error) &&
      ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code ?? "")
    ) {
      throw new Error(`Refusing to overwrite existing target: ${targetRoot}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function renderNewProject(
  options: RenderProjectOptions,
): Promise<void> {
  const targetRoot = path.resolve(options.targetRoot);
  await targetDirectoryStatus(targetRoot);
  await mkdir(path.dirname(targetRoot), { recursive: true });

  const stagingRoot = await mkdtemp(
    path.join(
      path.dirname(targetRoot),
      `.${path.basename(targetRoot)}.template-stage-`,
    ),
  );
  let committed = false;

  try {
    await renderProject({ ...options, targetRoot: stagingRoot });
    await commitStagedProject(stagingRoot, targetRoot);
    committed = true;
  } finally {
    if (!committed) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}
