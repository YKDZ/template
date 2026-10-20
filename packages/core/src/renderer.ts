import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { generatedJsonPrintWidth } from "./renderer-policy-snapshot.ts";

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
  replacements?: Record<string, string>;
  multilineArrays?: string[];
  keyOrder?: readonly string[];
  nestedKeyOrder?: readonly string[];
  provenance?: RenderOperationProvenance;
};

export type WriteTextOperation = {
  kind: "writeText";
  to: string;
  text: string;
  mode?: number;
  overwrite?: boolean;
  templateSource?: {
    readonly handle: TemplateSourceHandle;
    readonly path: string;
  };
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

export type RenderOperation =
  | CopyFileOperation
  | WriteJsonOperation
  | MergeJsonOperation
  | MergeJsonTemplateOperation
  | WriteTextOperation
  | WriteTextFromFragmentsOperation
  | WriteTextTemplateOperation
  | SetExecutableOperation;

export type RenderProjectOptions = {
  targetRoot: string;
  operations: RenderOperation[];
};

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

async function renderCopyFile(
  operation: CopyFileOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const from = resolveTemplateSource(operation.source, operation.from);
  const to = resolveContainedPath(options.targetRoot, operation.to);
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
  currentColumn = indentation,
  trailingComma = false,
): string {
  if (Array.isArray(value)) {
    const compact = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    const shouldCompact =
      value.every(isScalarJsonValue) &&
      !multilineArrays.has(pathSegments.join(".")) &&
      currentColumn + compact.length + (trailingComma ? 1 : 0) <=
        generatedJsonPrintWidth;

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
          indentation + 2,
          index < value.length - 1,
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
        ([key, entryValue], index) =>
          `${" ".repeat(indentation + 2)}${JSON.stringify(key)}: ${serializeJsonValue(
            entryValue,
            indentation + 2,
            [...pathSegments, key],
            multilineArrays,
            rootKeyOrder,
            nestedKeyOrder,
            indentation + 2 + JSON.stringify(key).length + 2,
            index < entries.length - 1,
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
    operation.to,
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
    toPath: operation.to,
    multilineArrays: operation.multilineArrays,
    keyOrder: operation.keyOrder,
    nestedKeyOrder: operation.nestedKeyOrder,
  });
}

async function renderMergeJsonTemplate(
  operation: MergeJsonTemplateOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const sourcePath = resolveTemplateSource(operation.source, operation.from);
  const sourceText = await readFile(sourcePath, "utf8");
  let patch: unknown;
  try {
    patch = JSON.parse(sourceText) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON Template Source ${operation.from}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (operation.replacements !== undefined) {
    patch = replaceJsonTemplateVariables(patch, operation.replacements);
  }
  await mergeJsonIntoFile({
    options,
    patch,
    toPath: operation.to,
    multilineArrays: operation.multilineArrays,
    keyOrder: operation.keyOrder,
    nestedKeyOrder: operation.nestedKeyOrder,
  });
}

function replaceJsonTemplateVariables(
  value: unknown,
  replacements: Record<string, string>,
): unknown {
  const used = new Set<string>();
  const replaceString = (source: string): string =>
    source.replaceAll(
      /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
      (_placeholder, name: string) => {
        const replacement = replacements[name];
        if (replacement === undefined) {
          throw new Error(`JSON 模板缺少变量：${name}`);
        }
        used.add(name);
        return replacement;
      },
    );
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") {
      return replaceString(current);
    }
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    if (typeof current === "object" && current !== null) {
      const entries = Object.entries(current).map(
        ([key, nestedValue]) =>
          [replaceString(key), visit(nestedValue)] as const,
      );
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw new Error("JSON 模板变量替换后产生重复对象键");
      }
      return Object.fromEntries(entries);
    }
    return current;
  };

  const rendered = visit(value);
  for (const name of Object.keys(replacements)) {
    if (!used.has(name)) {
      throw new Error(`JSON 模板替换项未被使用：${name}`);
    }
  }
  return rendered;
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
  const to = resolveContainedPath(options.targetRoot, operation.to);

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(to, operation.text, operation.overwrite ?? false);
  if (operation.mode !== undefined) {
    await chmod(to, operation.mode & 0o777);
  }
}

type LoadedTextFragment = {
  readonly from: string;
  readonly text: string;
};

async function loadTextFragments(
  operation: WriteTextFromFragmentsOperation,
): Promise<readonly LoadedTextFragment[]> {
  return Promise.all(
    operation.fragments.map(async (fragment) => {
      const from = resolveTemplateSource(fragment.source, fragment.from);

      return { from: fragment.from, text: await readFile(from, "utf8") };
    }),
  );
}

async function renderWriteTextFromFragments(
  operation: WriteTextFromFragmentsOperation,
  options: RenderProjectOptions,
): Promise<void> {
  const to = resolveContainedPath(options.targetRoot, operation.to);
  const fragments = await loadTextFragments(operation);

  await mkdir(path.dirname(to), { recursive: true });
  await writeGeneratedFile(
    to,
    fragments.map(({ text }) => text.trimEnd()).join("\n\n") + "\n",
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
  const from = resolveTemplateSource(operation.source, operation.from);
  const to = resolveContainedPath(options.targetRoot, operation.to);
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
  const filePath = resolveContainedPath(options.targetRoot, operation.path);
  const currentMode = (await stat(filePath)).mode;
  const executeBits = 0o111;
  const mode = operation.executable
    ? currentMode | executeBits
    : currentMode & ~executeBits;

  await chmod(filePath, mode & 0o777);
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

    throw new Error(
      `Unsupported renderer operation: ${(operation as { kind: string }).kind}`,
    );
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
