import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { diff3Merge } from "node-diff3";

import { renderProject, type RenderOperation } from "./renderer.ts";

export type ProjectProjectionEntry = {
  readonly path: string;
  readonly kind: "file";
  readonly content: Uint8Array;
  /** Only executable bits are relevant to generated-file reconciliation. */
  readonly mode: number;
};

export type CurrentProjectProjectionEntry =
  | ProjectProjectionEntry
  | {
      readonly path: string;
      readonly kind: "directory" | "symbolic-link" | "other";
    };

export type StructuredIdentitySetPolicy = {
  readonly location: string;
  readonly identity:
    | { readonly kind: "self" }
    | {
        readonly kind: "fields";
        readonly fields: readonly string[];
      }
    | {
        readonly kind: "projection";
        readonly members: readonly {
          readonly identity: string;
          readonly match: Readonly<
            Record<string, string | number | boolean | null>
          >;
        }[];
        readonly fallback: {
          readonly fields: readonly string[];
        };
      };
};

export type ProjectProjectionMirrorSlotLocation =
  | {
      readonly kind: "json-pointer";
      readonly pointer: string;
    }
  | {
      readonly kind: "text-anchor";
      readonly name: string;
    };

export type ProjectProjectionMirrorSlot = {
  readonly id: string;
  readonly location: ProjectProjectionMirrorSlotLocation;
};

export type ProjectProjectionReconciliation =
  | {
      readonly path: string;
      readonly driver: "structured";
      readonly identitySets?: readonly StructuredIdentitySetPolicy[];
      /** planner 拥有的根声明位置，在三向合并之前归一。 */
      readonly mirrorSlots?: readonly ProjectProjectionMirrorSlot[];
    }
  | {
      readonly path: string;
      readonly driver: "text";
      readonly mirrorSlots?: readonly ProjectProjectionMirrorSlot[];
    }
  | {
      readonly path: string;
      readonly driver: "canonical";
    };

export type ProjectProjection = {
  readonly entries: readonly ProjectProjectionEntry[];
  readonly reconciliation: readonly ProjectProjectionReconciliation[];
};

export type ProjectProjectionPathPrecondition = {
  readonly path: string;
  readonly kind: "must-not-exist";
  readonly reason: string;
};

export type ProjectProjectionConflictDriver =
  | ProjectProjectionReconciliation["driver"]
  | "precondition";

export type ProjectProjectionConflict = {
  readonly path: string;
  readonly driver: ProjectProjectionConflictDriver;
  readonly location?: string;
  readonly attribute?: "file-kind" | "binary-content" | "executable-mode";
  readonly region?: {
    readonly before: { readonly startLine: number; readonly lineCount: number };
    readonly current: {
      readonly startLine: number;
      readonly lineCount: number;
    };
    readonly after: { readonly startLine: number; readonly lineCount: number };
  };
  readonly reason: string;
  readonly before: string;
  readonly current: string;
  readonly after: string;
};

class ProjectProjectionPathPreconditionError extends Error {
  readonly conflicts: readonly ProjectProjectionConflict[];

  constructor(conflicts: readonly ProjectProjectionConflict[]) {
    super("Project Projection Path Preconditions changed before commit");
    this.conflicts = conflicts;
  }
}

export type ProjectProjectionReconciliationResult =
  | {
      readonly ok: true;
      readonly mutations: readonly ProjectProjectionEntry[];
    }
  | {
      readonly ok: false;
      readonly conflicts: readonly ProjectProjectionConflict[];
    };

export type ProjectProjectionAction = {
  readonly path: string;
  readonly driver: ProjectProjectionReconciliation["driver"];
  readonly action: "create" | "update";
};

export type MaterializeProjectProjectionOptions = {
  readonly operations: readonly RenderOperation[];
  readonly reconciliation?: readonly ProjectProjectionReconciliation[];
};

function normalizedOutputPath(operation: RenderOperation): string {
  const operationPath =
    operation.kind === "setExecutable" || operation.kind === "replaceAnchors"
      ? operation.path
      : operation.to;
  if (path.isAbsolute(operationPath)) {
    throw new Error(
      `Project Projection paths must be relative: ${operationPath}`,
    );
  }
  const normalized = path.posix.normalize(
    operationPath.split(path.sep).join("/"),
  );
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      `Project Projection path escapes its root: ${operationPath}`,
    );
  }
  return normalized;
}

function operationDriver(
  operation: RenderOperation,
): ProjectProjectionReconciliation["driver"] | undefined {
  switch (operation.kind) {
    case "mergeJson":
    case "mergeJsonTemplate":
    case "writeJson":
      return "structured";
    case "copyFile":
    case "writeText":
    case "writeTextFromFragments":
    case "writeTextTemplate":
      return "text";
    case "replaceAnchors":
      return "text";
    case "setExecutable":
      return undefined;
  }
}

/** Pure structural preflight for a renderer-facing Project Projection plan. */
export function validateProjectProjectionPlan(
  options: MaterializeProjectProjectionOptions,
): readonly string[] {
  const diagnostics: string[] = [];
  const contentKindByPath = new Map<string, RenderOperation["kind"]>();
  const contentTypeByPath = new Map<string, "json" | "text" | "unknown">();
  const transformationKindByPath = new Map<
    string,
    "replaceAnchors" | "setExecutable"
  >();
  const finalPaths = new Set<string>();
  for (const operation of options.operations) {
    let outputPath: string;
    try {
      outputPath = normalizedOutputPath(operation);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    finalPaths.add(outputPath);
    const precedingKind = contentKindByPath.get(outputPath);
    if (
      operation.kind === "setExecutable" ||
      operation.kind === "replaceAnchors"
    ) {
      if (precedingKind === undefined) {
        diagnostics.push(
          `Project Projection ${operation.kind} requires a preceding content-producing operation: ${outputPath}`,
        );
      }
      const hasCompatibleContent =
        operation.kind !== "replaceAnchors" ||
        contentTypeByPath.get(outputPath) !== "json";
      if (!hasCompatibleContent) {
        diagnostics.push(
          `Project Projection replaceAnchors requires text-compatible content: ${outputPath} follows ${precedingKind}`,
        );
      }
      if (precedingKind !== undefined && hasCompatibleContent) {
        if (operation.kind === "replaceAnchors") {
          contentTypeByPath.set(outputPath, "text");
        }
        transformationKindByPath.set(outputPath, operation.kind);
      }
      continue;
    }
    if (
      operation.kind === "mergeJson" ||
      operation.kind === "mergeJsonTemplate"
    ) {
      const transformationKind = transformationKindByPath.get(outputPath);
      if (transformationKind !== undefined) {
        diagnostics.push(
          `Project Projection ${operation.kind} may not overwrite content after ${transformationKind}: ${outputPath}`,
        );
      }
      if (contentTypeByPath.get(outputPath) === "text") {
        diagnostics.push(
          `Project Projection ${operation.kind} requires JSON-compatible content: ${outputPath} follows ${precedingKind}`,
        );
      }
      if (precedingKind === undefined) {
        contentKindByPath.set(outputPath, operation.kind);
      }
      contentTypeByPath.set(outputPath, "json");
      transformationKindByPath.delete(outputPath);
      continue;
    }
    const overwrite = "overwrite" in operation && operation.overwrite;
    const transformationKind = transformationKindByPath.get(outputPath);
    if (overwrite && transformationKind !== undefined) {
      diagnostics.push(
        `Project Projection ${operation.kind} may not overwrite content after ${transformationKind}: ${outputPath}`,
      );
    }
    if (precedingKind !== undefined && !overwrite) {
      diagnostics.push(
        `Project Projection collision at ${outputPath}: ${operation.kind} follows ${precedingKind} without overwrite`,
      );
    }
    contentKindByPath.set(outputPath, operation.kind);
    if (operation.kind === "writeJson") {
      contentTypeByPath.set(outputPath, "json");
    } else if (operation.kind === "writeText") {
      try {
        JSON.parse(operation.text);
        contentTypeByPath.set(outputPath, "json");
      } catch {
        contentTypeByPath.set(outputPath, "text");
      }
    } else {
      contentTypeByPath.set(outputPath, "unknown");
    }
    transformationKindByPath.delete(outputPath);
  }

  const orderedPaths = [...finalPaths].toSorted();
  for (const candidate of orderedPaths) {
    const ancestor = orderedPaths.find(
      (other) => other !== candidate && candidate.startsWith(`${other}/`),
    );
    if (ancestor !== undefined) {
      diagnostics.push(
        `Project Projection path collision: file ${ancestor} is an ancestor of ${candidate}`,
      );
    }
  }

  const reconciliationPaths = new Set<string>();
  for (const reconciliation of options.reconciliation ?? []) {
    if (reconciliationPaths.has(reconciliation.path)) {
      diagnostics.push(
        `Project Projection reconciliation paths must be unique: ${reconciliation.path}`,
      );
    } else if (!finalPaths.has(reconciliation.path)) {
      diagnostics.push(
        `Project Projection reconciliation references an unknown path: ${reconciliation.path}`,
      );
    }
    reconciliationPaths.add(reconciliation.path);
  }
  return diagnostics;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function entriesEqual(
  left: CurrentProjectProjectionEntry | undefined,
  right: CurrentProjectProjectionEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== "file" || right.kind !== "file") {
    return left.kind === right.kind;
  }
  return left.mode === right.mode && bytesEqual(left.content, right.content);
}

function decodeText(content: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function describeEntry(
  entry: CurrentProjectProjectionEntry | undefined,
): string {
  if (entry === undefined) return "<missing>";
  if (entry.kind !== "file") return entry.kind;
  const text = decodeText(entry.content);
  return (
    text ??
    `<${entry.content.byteLength} binary bytes; sha256=${createHash("sha256").update(entry.content).digest("hex")}>`
  );
}

function reconcileMode(
  before: ProjectProjectionEntry,
  current: ProjectProjectionEntry,
  after: ProjectProjectionEntry,
): ProjectProjectionEntry["mode"] | undefined {
  if (current.mode === before.mode) return after.mode;
  if (after.mode === before.mode || current.mode === after.mode) {
    return current.mode;
  }
  return undefined;
}

function describeExecutableMode(entry: ProjectProjectionEntry): string {
  return entry.mode.toString(8).padStart(3, "0");
}

type TextMirrorMarker =
  | { readonly kind: "start"; readonly name: string }
  | { readonly kind: "end" }
  | { readonly kind: "content" };

/**
 * 识别已接受设计中有限的成对锚点词表。
 * 剥掉注释标点只是为了读出标记本身，这里不解释文件格式、关键字或版本。
 */
function textMirrorMarker(line: string): TextMirrorMarker {
  const stripped = line
    .trim()
    .replace(/^[#;%*/-]+/u, "")
    .trim();
  if (stripped === "@end-template-mirror") return { kind: "end" };
  const start = /^@template-mirror\s+(\S+)$/u.exec(stripped);
  if (start?.[1] !== undefined) return { kind: "start", name: start[1] };
  return { kind: "content" };
}

type TextMirrorRegion = {
  readonly contentStart: number;
  readonly contentEnd: number;
};

/** 定位唯一被拥有的那一行；任何不可用形态都返回 `undefined`。 */
function locateTextMirrorRegion(
  lines: readonly string[],
  name: string,
): TextMirrorRegion | undefined {
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = textMirrorMarker(line);
    if (marker.kind === "start" && marker.name === name) starts.push(index);
  }
  if (starts.length !== 1) return undefined;
  const start = starts[0]!;
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = textMirrorMarker(lines[index]!);
    if (marker.kind === "start") return undefined;
    if (marker.kind !== "end") continue;
    return index - start === 2
      ? { contentStart: start + 1, contentEnd: index }
      : undefined;
  }
  return undefined;
}

/** Before 是否出现过该名的开始标记：区分槽位真缺席与标记不可解释。 */
function hasTextMirrorStartMarker(
  lines: readonly string[],
  name: string,
): boolean {
  for (const line of lines) {
    const marker = textMirrorMarker(line);
    if (marker.kind === "start" && marker.name === name) return true;
  }
  return false;
}

function escapeRegExpToken(value: string): string {
  return value.replaceAll(/[.$()*?[\]{}+/|^\\]/gu, String.raw`\$&`);
}

/** 有界的承载检查：文件是否仍在赋值或引用这个名称？ */
function textUsesMirrorSlotName(text: string, name: string): boolean {
  const token = escapeRegExpToken(name);
  return (
    new RegExp(`(?:^|[^\\w$])${token}\\s*=`, "u").test(text) ||
    new RegExp(String.raw`\$\{\s*${token}\s*\}`, "u").test(text)
  );
}

function reconcileTextEntry(options: {
  readonly before: ProjectProjectionEntry;
  readonly current: ProjectProjectionEntry;
  readonly after: ProjectProjectionEntry;
  readonly mirrorSlots: readonly ProjectProjectionMirrorSlot[];
}):
  | { readonly ok: true; readonly entry: ProjectProjectionEntry }
  | {
      readonly ok: false;
      readonly conflicts?: readonly Omit<
        ProjectProjectionConflict,
        "path" | "driver"
      >[];
    } {
  const mode = reconcileMode(options.before, options.current, options.after);
  if (mode === undefined) return { ok: false };
  const beforeText = decodeText(options.before.content);
  const currentText = decodeText(options.current.content);
  const afterText = decodeText(options.after.content);
  if (
    beforeText === undefined ||
    currentText === undefined ||
    afterText === undefined
  ) {
    return {
      ok: false,
      conflicts: [
        {
          attribute: "binary-content",
          reason: "Current and After contain incompatible binary changes",
          before: describeEntry(options.before),
          current: describeEntry(options.current),
          after: describeEntry(options.after),
        },
      ],
    };
  }
  const slotConflict = (slot: ProjectProjectionMirrorSlot, reason: string) =>
    ({
      ok: false,
      conflicts: [
        {
          ...(slot.location.kind === "text-anchor"
            ? { location: slot.location.name }
            : {}),
          reason,
          before: describeEntry(options.before),
          current: describeEntry(options.current),
          after: describeEntry(options.after),
        },
      ],
    }) as const;
  const beforeLines = textLines(beforeText);
  let currentLines = textLines(currentText);
  for (const slot of options.mirrorSlots) {
    if (slot.location.kind !== "text-anchor") continue;
    const name = slot.location.name;
    const currentRegion = locateTextMirrorRegion(currentLines, name);
    if (currentRegion === undefined) {
      if (textUsesMirrorSlotName(currentText, name)) {
        return slotConflict(
          slot,
          `Declared mirror slot ${JSON.stringify(slot.id)} anchor could not be located while the ${JSON.stringify(name)} carrier or reference remains`,
        );
      }
      continue;
    }
    const beforeRegion = locateTextMirrorRegion(beforeLines, name);
    if (beforeRegion === undefined) {
      if (hasTextMirrorStartMarker(beforeLines, name)) {
        return slotConflict(
          slot,
          `Declared mirror slot ${JSON.stringify(slot.id)} anchor in Before could not be located while its markers remain`,
        );
      }
      // 模板拥有完整镜像块，标记行也属于该块，因此移除整块后再交既有 diff3。
      currentLines = [
        ...currentLines.slice(0, currentRegion.contentStart - 1),
        ...currentLines.slice(currentRegion.contentEnd + 1),
      ];
      continue;
    }
    currentLines = [
      ...currentLines.slice(0, currentRegion.contentStart),
      ...beforeLines.slice(beforeRegion.contentStart, beforeRegion.contentEnd),
      ...currentLines.slice(currentRegion.contentEnd),
    ];
  }
  const regions = diff3Merge(currentLines, beforeLines, textLines(afterText), {
    excludeFalseConflicts: true,
  });
  const conflicts = regions.flatMap((region) => {
    const conflict = region.conflict;
    if (conflict === undefined) return [];
    return [
      {
        region: {
          before: {
            startLine: conflict.oIndex + 1,
            lineCount: conflict.o.length,
          },
          current: {
            startLine: conflict.aIndex + 1,
            lineCount: conflict.a.length,
          },
          after: {
            startLine: conflict.bIndex + 1,
            lineCount: conflict.b.length,
          },
        },
        reason: "Current and After contain incompatible text changes",
        before: conflict.o.join(""),
        current: conflict.a.join(""),
        after: conflict.b.join(""),
      },
    ];
  });
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  return {
    ok: true,
    entry: {
      ...options.after,
      content: new TextEncoder().encode(
        regions.flatMap((region) => region.ok ?? []).join(""),
      ),
      mode,
    },
  };
}

const missingStructuredValue = Symbol("missing-structured-value");
type MissingStructuredValue = typeof missingStructuredValue;
type StructuredValue =
  | null
  | boolean
  | number
  | string
  | StructuredObject
  | StructuredValue[];
type StructuredObject = { readonly [key: string]: StructuredValue };
type StructuredConflict = {
  readonly location: string;
  readonly reason: string;
  readonly before: string;
  readonly current: string;
  readonly after: string;
};
type StructuredValueResult =
  | {
      readonly ok: true;
      readonly value: StructuredValue | MissingStructuredValue;
    }
  | { readonly ok: false; readonly conflict: StructuredConflict };

function isStructuredObject(value: unknown): value is StructuredObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredValuesEqual(
  left: StructuredValue | MissingStructuredValue,
  right: StructuredValue | MissingStructuredValue,
): boolean {
  if (left === missingStructuredValue || right === missingStructuredValue) {
    return left === right;
  }
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => structuredValuesEqual(value, right[index]!))
    );
  }
  if (isStructuredObject(left) && isStructuredObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          structuredValuesEqual(left[key]!, right[key]!),
      )
    );
  }
  return false;
}

function reconcileStructuredValue(
  before: StructuredValue | MissingStructuredValue,
  current: StructuredValue | MissingStructuredValue,
  after: StructuredValue | MissingStructuredValue,
  pathSegments: readonly string[] = [],
  identitySets: readonly StructuredIdentitySetPolicy[] = [],
): StructuredValueResult {
  if (structuredValuesEqual(current, before)) {
    return { ok: true, value: after };
  }
  if (
    structuredValuesEqual(after, before) ||
    structuredValuesEqual(current, after)
  ) {
    return { ok: true, value: current };
  }
  if (current === missingStructuredValue || after === missingStructuredValue) {
    return {
      ok: false,
      conflict: structuredConflict(
        pathSegments,
        "Current and After contain incompatible changes",
        before,
        current,
        after,
      ),
    };
  }
  if (Array.isArray(current) && Array.isArray(after)) {
    const identitySet = identitySets.find(
      (policy) => policy.location === structuredLocation(pathSegments),
    );
    if (
      identitySet !== undefined &&
      (before === missingStructuredValue || Array.isArray(before))
    ) {
      return reconcileIdentitySet(
        before === missingStructuredValue ? [] : before,
        current,
        after,
        pathSegments,
        identitySet,
        identitySets,
      );
    }
  }
  if (
    isStructuredObject(current) &&
    isStructuredObject(after) &&
    (before === missingStructuredValue || isStructuredObject(before))
  ) {
    const base = before === missingStructuredValue ? {} : before;
    const result: Record<string, StructuredValue> = {};
    const keys = [
      ...Object.keys(current),
      ...Object.keys(after).filter((key) => !Object.hasOwn(current, key)),
      ...Object.keys(base).filter(
        (key) => !Object.hasOwn(current, key) && !Object.hasOwn(after, key),
      ),
    ];
    for (const key of keys) {
      const reconciled = reconcileStructuredValue(
        Object.hasOwn(base, key) ? base[key]! : missingStructuredValue,
        Object.hasOwn(current, key) ? current[key]! : missingStructuredValue,
        Object.hasOwn(after, key) ? after[key]! : missingStructuredValue,
        [...pathSegments, key],
        identitySets,
      );
      if (!reconciled.ok) return reconciled;
      if (reconciled.value !== missingStructuredValue) {
        result[key] = reconciled.value;
      }
    }
    return { ok: true, value: result };
  }
  const reason =
    Array.isArray(current) && Array.isArray(after)
      ? "Current and After contain incompatible atomic array changes"
      : !Array.isArray(current) &&
          !Array.isArray(after) &&
          !isStructuredObject(current) &&
          !isStructuredObject(after)
        ? "Current and After contain incompatible scalar changes"
        : "Current and After contain incompatible changes";
  return {
    ok: false,
    conflict: structuredConflict(pathSegments, reason, before, current, after),
  };
}

function scalarIdentity(value: StructuredValue): string | undefined {
  if (Array.isArray(value) || isStructuredObject(value)) return undefined;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function memberIdentity(
  member: StructuredValue,
  policy: StructuredIdentitySetPolicy,
): string | undefined {
  if (policy.identity.kind === "self") return scalarIdentity(member);
  if (!isStructuredObject(member)) return undefined;
  if (policy.identity.kind === "projection") {
    const matches = policy.identity.members.filter(({ match }) =>
      Object.entries(match).every(
        ([field, value]) =>
          Object.hasOwn(member, field) &&
          structuredValuesEqual(member[field]!, value),
      ),
    );
    const matchingIdentities = new Set(matches.map(({ identity }) => identity));
    if (matchingIdentities.size > 1) return undefined;
    const [matchingIdentity] = matchingIdentities;
    if (matchingIdentity !== undefined) {
      return `projection:${JSON.stringify(matchingIdentity)}`;
    }
    const fallbackFields = policy.identity.fallback.fields.map((field) =>
      Object.hasOwn(member, field) ? scalarIdentity(member[field]!) : undefined,
    );
    return fallbackFields.every((field) => field !== undefined)
      ? `fallback:${JSON.stringify(fallbackFields)}`
      : undefined;
  }
  const fields = policy.identity.fields.map((field) =>
    Object.hasOwn(member, field) ? scalarIdentity(member[field]!) : undefined,
  );
  return fields.every((field) => field !== undefined)
    ? JSON.stringify(fields)
    : undefined;
}

function reconcileIdentitySet(
  before: StructuredValue[],
  current: StructuredValue[],
  after: StructuredValue[],
  pathSegments: readonly string[],
  policy: StructuredIdentitySetPolicy,
  identitySets: readonly StructuredIdentitySetPolicy[],
): StructuredValueResult {
  const indexMembers = (
    members: StructuredValue[],
    side: "Before" | "Current" | "After",
  ):
    | { readonly ok: true; readonly index: Map<string, StructuredValue> }
    | { readonly ok: false; readonly reason: string } => {
    const index = new Map<string, StructuredValue>();
    for (const member of members) {
      const identity = memberIdentity(member, policy);
      if (identity === undefined) {
        return {
          ok: false,
          reason: `${side} is missing its identity`,
        };
      }
      if (index.has(identity)) {
        return {
          ok: false,
          reason: `${side} identities must be unique`,
        };
      }
      index.set(identity, member);
    }
    return { ok: true, index };
  };
  const beforeIndex = indexMembers(before, "Before");
  const currentIndex = indexMembers(current, "Current");
  const afterIndex = indexMembers(after, "After");
  const invalidIdentityResult = (reason: string): StructuredValueResult => ({
    ok: false,
    conflict: structuredConflict(pathSegments, reason, before, current, after),
  });
  if (!beforeIndex.ok) return invalidIdentityResult(beforeIndex.reason);
  if (!currentIndex.ok) return invalidIdentityResult(currentIndex.reason);
  if (!afterIndex.ok) return invalidIdentityResult(afterIndex.reason);
  const beforeByIdentity = beforeIndex.index;
  const currentByIdentity = currentIndex.index;
  const afterByIdentity = afterIndex.index;
  const result: StructuredValue[] = [];
  for (const [currentIndex, currentMember] of current.entries()) {
    const identity = memberIdentity(currentMember, policy)!;
    const beforeMember = beforeByIdentity.get(identity);
    const afterMember = afterByIdentity.get(identity);
    if (afterMember === undefined) {
      result.push(currentMember);
      continue;
    }
    const reconciled = reconcileStructuredValue(
      beforeMember ?? missingStructuredValue,
      currentMember,
      afterMember,
      [...pathSegments, String(currentIndex)],
      identitySets,
    );
    if (!reconciled.ok) return reconciled;
    if (reconciled.value !== missingStructuredValue) {
      result.push(reconciled.value);
    }
  }
  for (const member of after) {
    const identity = memberIdentity(member, policy)!;
    if (!beforeByIdentity.has(identity) && !currentByIdentity.has(identity)) {
      result.push(member);
    }
  }
  return { ok: true, value: result };
}

function structuredLocation(pathSegments: readonly string[]): string {
  return pathSegments
    .map((segment) => `/${escapeJsonPointerToken(segment)}`)
    .join("");
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function parseJsonPointer(location: string): readonly string[] {
  if (typeof location !== "string") {
    throw new Error("JSON Pointer must be a string");
  }
  if (location === "") return [];
  if (!location.startsWith("/")) {
    throw new Error("JSON Pointer must be empty or start with '/'");
  }
  return location
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/u.test(token)) {
        throw new Error(
          "JSON Pointer tokens may only use '~0' and '~1' escapes",
        );
      }
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function describeStructuredValue(
  value: StructuredValue | MissingStructuredValue,
): string {
  return value === missingStructuredValue ? "<missing>" : JSON.stringify(value);
}

function structuredConflict(
  pathSegments: readonly string[],
  reason: string,
  before: StructuredValue | MissingStructuredValue,
  current: StructuredValue | MissingStructuredValue,
  after: StructuredValue | MissingStructuredValue,
): StructuredConflict {
  return {
    location: structuredLocation(pathSegments),
    reason,
    before: describeStructuredValue(before),
    current: describeStructuredValue(current),
    after: describeStructuredValue(after),
  };
}

type ParsedStructuredEntry =
  | { readonly ok: true; readonly value: StructuredValue }
  | { readonly ok: false; readonly message: string };

function parseStructuredEntry(
  entry: ProjectProjectionEntry,
): ParsedStructuredEntry {
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(entry.content),
      ) as StructuredValue,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function describeStructuredValueAt(
  value: StructuredValue | MissingStructuredValue,
): string {
  return describeStructuredValue(value);
}

type MirrorSlotParentResult =
  | { readonly found: true; readonly parent: StructuredValue }
  | { readonly found: false };

function mirrorSlotParent(
  root: StructuredValue,
  segments: readonly string[],
): MirrorSlotParentResult {
  if (segments.length === 0) return { found: false };
  let value = root;
  for (const segment of segments.slice(0, -1)) {
    if (isStructuredObject(value) && Object.hasOwn(value, segment)) {
      value = value[segment]!;
      continue;
    }
    if (
      Array.isArray(value) &&
      /^(?:0|[1-9][0-9]*)$/u.test(segment) &&
      Number.isSafeInteger(Number(segment)) &&
      Object.hasOwn(value, Number(segment))
    ) {
      value = value[Number(segment)]!;
      continue;
    }
    return { found: false };
  }
  return { found: true, parent: value };
}

function mirrorSlotValue(
  root: StructuredValue,
  segments: readonly string[],
): StructuredValue | MissingStructuredValue {
  const parent = mirrorSlotParent(root, segments);
  if (!parent.found) return missingStructuredValue;
  const key = segments[segments.length - 1]!;
  if (isStructuredObject(parent.parent)) {
    return Object.hasOwn(parent.parent, key)
      ? parent.parent[key]!
      : missingStructuredValue;
  }
  if (
    Array.isArray(parent.parent) &&
    /^(?:0|[1-9][0-9]*)$/u.test(key) &&
    Object.hasOwn(parent.parent, Number(key))
  ) {
    return parent.parent[Number(key)]!;
  }
  return missingStructuredValue;
}

export type ProjectedMirrorSlotScalar =
  | { readonly ok: true; readonly scalar: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 有限的槽位读取：把一个 plan 声明的镜像位置在真实投影里解析成恰好一条标量字符串。
 * Core 只认识通用位置与值形态（合法 JSON、位置存在、值为字符串、锚点区域恰一行），
 * 不认识具体生成路径、Node/Rust 语义或 ARG 写法；承载行的解释留给 Checks 层。
 */
export function readProjectedMirrorSlotScalar(
  entry: ProjectProjectionEntry,
  location: ProjectProjectionMirrorSlotLocation,
): ProjectedMirrorSlotScalar {
  if (location.kind === "json-pointer") {
    const parsed = parseStructuredEntry(entry);
    if (!parsed.ok) {
      return { ok: false, reason: `槽位文件不是合法 JSON：${parsed.message}` };
    }
    let segments: readonly string[];
    try {
      segments = parseJsonPointer(location.pointer);
    } catch (error) {
      return {
        ok: false,
        reason: `JSON Pointer 非法：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (segments.length === 0) {
      return { ok: false, reason: "镜像槽位不能定位到文档根本身" };
    }
    const value = mirrorSlotValue(parsed.value, segments);
    if (value === missingStructuredValue) {
      return {
        ok: false,
        reason: `声明位置在真实投影中不存在：${location.pointer}`,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        reason: `镜像槽位的值必须是字符串标量：${location.pointer}`,
      };
    }
    return { ok: true, scalar: value };
  }
  const decoded = decodeText(entry.content);
  if (decoded === undefined) {
    return { ok: false, reason: "文本锚点所在文件不是合法 UTF-8 文本" };
  }
  const lines = textLines(decoded);
  const region = locateTextMirrorRegion(lines, location.name);
  if (region === undefined) {
    return {
      ok: false,
      reason: `锚点区域缺失、重复、不成对或含额外正文：${location.name}`,
    };
  }
  // locateTextMirrorRegion 已保证区域内恰好一条承载行。
  return { ok: true, scalar: lines[region.contentStart]! };
}

function withoutMirrorSlot(
  root: StructuredValue,
  segments: readonly string[],
): StructuredValue {
  if (segments.length === 0) return root;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (!isStructuredObject(root) || !Object.hasOwn(root, head!)) return root;
    const kept: Record<string, StructuredValue> = {};
    for (const [key, value] of Object.entries(root)) {
      if (key !== head) kept[key] = value;
    }
    return kept;
  }
  if (isStructuredObject(root) && Object.hasOwn(root, head!)) {
    return {
      ...root,
      [head!]: withoutMirrorSlot(root[head!]!, rest),
    };
  }
  if (
    Array.isArray(root) &&
    /^(?:0|[1-9][0-9]*)$/u.test(head!) &&
    Object.hasOwn(root, Number(head))
  ) {
    return root.map((member, index) =>
      index === Number(head) ? withoutMirrorSlot(member, rest) : member,
    );
  }
  return root;
}

function withMirrorSlot(
  root: StructuredValue,
  segments: readonly string[],
  value: StructuredValue,
): StructuredValue {
  if (segments.length === 0) return root;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (isStructuredObject(root) && Object.hasOwn(root, head!)) {
      return { ...root, [head!]: value };
    }
    if (
      Array.isArray(root) &&
      /^(?:0|[1-9][0-9]*)$/u.test(head!) &&
      Object.hasOwn(root, Number(head))
    ) {
      return root.map((member, index) =>
        index === Number(head) ? value : member,
      );
    }
    return root;
  }
  if (isStructuredObject(root) && Object.hasOwn(root, head!)) {
    return {
      ...root,
      [head!]: withMirrorSlot(root[head!]!, rest, value),
    };
  }
  if (
    Array.isArray(root) &&
    /^(?:0|[1-9][0-9]*)$/u.test(head!) &&
    Object.hasOwn(root, Number(head))
  ) {
    return root.map((member, index) =>
      index === Number(head) ? withMirrorSlot(member, rest, value) : member,
    );
  }
  return root;
}

type NormalizedCurrentResult =
  | { readonly ok: true; readonly value: StructuredValue }
  | { readonly ok: false; readonly conflict: StructuredConflict };

/**
 * 把 Current 中每个由 planner 声明的位置改写回 Before。
 * 归一只改写已存在的位置，绝不新建，所以消费者删掉的槽位在既有合并法则下保持缺席。
 */
function normalizeCurrentMirrorSlots(options: {
  readonly before: StructuredValue;
  readonly current: StructuredValue;
  readonly after: StructuredValue;
  readonly slots: readonly {
    readonly slot: ProjectProjectionMirrorSlot;
    readonly segments: readonly string[];
  }[];
}): NormalizedCurrentResult {
  let normalized = options.current;
  for (const { slot, segments } of options.slots) {
    const location = structuredLocation(segments);
    const currentValue = mirrorSlotValue(normalized, segments);
    if (currentValue === missingStructuredValue) continue;
    const beforeValue = mirrorSlotValue(options.before, segments);
    const afterValue = mirrorSlotValue(options.after, segments);
    const unusable = (side: string) =>
      ({
        ok: false,
        conflict: {
          location,
          reason: `Declared mirror slot ${JSON.stringify(slot.id)} holds a non-string ${side} value`,
          before: describeStructuredValueAt(beforeValue),
          current: describeStructuredValueAt(currentValue),
          after: describeStructuredValueAt(afterValue),
        },
      }) as const;
    if (typeof currentValue !== "string") return unusable("Current");
    if (beforeValue === missingStructuredValue) {
      normalized = withoutMirrorSlot(normalized, segments);
      continue;
    }
    if (typeof beforeValue !== "string") return unusable("Before");
    normalized = withMirrorSlot(normalized, segments, beforeValue);
  }
  return { ok: true, value: normalized };
}

function reconcileStructuredEntry(options: {
  readonly before: ProjectProjectionEntry;
  readonly current: ProjectProjectionEntry;
  readonly after: ProjectProjectionEntry;
  readonly identitySets: readonly StructuredIdentitySetPolicy[];
  readonly mirrorSlots: readonly ProjectProjectionMirrorSlot[];
}):
  | { readonly ok: true; readonly entry: ProjectProjectionEntry }
  | { readonly ok: true; readonly skip: true }
  | { readonly ok: false; readonly conflict?: StructuredConflict } {
  const mode = reconcileMode(options.before, options.current, options.after);
  if (mode === undefined) return { ok: false };
  const before = parseStructuredEntry(options.before);
  const current = parseStructuredEntry(options.current);
  const after = parseStructuredEntry(options.after);
  const parseConflict = (
    side: "Before" | "Current" | "After",
    message: string,
  ) =>
    ({
      ok: false,
      conflict: {
        location: "",
        reason: `${side} structured content is not valid JSON: ${message}`,
        before: describeEntry(options.before),
        current: describeEntry(options.current),
        after: describeEntry(options.after),
      },
    }) as const;
  if (!before.ok) return parseConflict("Before", before.message);
  if (!current.ok) return parseConflict("Current", current.message);
  if (!after.ok) return parseConflict("After", after.message);
  const slotLocations = options.mirrorSlots.map((slot) => ({
    slot,
    segments:
      slot.location.kind === "json-pointer"
        ? parseJsonPointer(slot.location.pointer)
        : [],
  }));
  const normalized = normalizeCurrentMirrorSlots({
    before: before.value,
    current: current.value,
    after: after.value,
    slots: slotLocations,
  });
  if (!normalized.ok) return normalized;
  const reconciled = reconcileStructuredValue(
    before.value,
    normalized.value,
    after.value,
    [],
    options.identitySets,
  );
  if (!reconciled.ok) return reconciled;
  if (reconciled.value === missingStructuredValue) {
    return { ok: false };
  }
  if (
    options.mirrorSlots.length > 0 &&
    structuredValuesEqual(current.value, reconciled.value) &&
    options.current.mode === mode
  ) {
    return { ok: true, skip: true };
  }
  let content: Uint8Array;
  try {
    content = new TextEncoder().encode(
      `${JSON.stringify(reconciled.value, null, 2)}\n`,
    );
  } catch (error) {
    return {
      ok: false,
      conflict: {
        location: "",
        reason: `Reconciled structured content could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
        before: describeEntry(options.before),
        current: describeEntry(options.current),
        after: describeEntry(options.after),
      },
    };
  }
  return {
    ok: true,
    entry: {
      ...options.after,
      content,
      mode,
    },
  };
}

function assertNormalizedSafeRelativePath(
  projectionPath: string,
  member: "entry" | "reconciliation",
): void {
  const normalized = path.posix.normalize(projectionPath);
  if (
    projectionPath.length === 0 ||
    projectionPath.includes("\0") ||
    projectionPath.includes("\\") ||
    path.posix.isAbsolute(projectionPath) ||
    path.win32.parse(projectionPath).root.length > 0 ||
    projectionPath.endsWith("/") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== projectionPath
  ) {
    throw new Error(
      `Project Projection ${member} path must be a normalized safe relative path: ${projectionPath || "<empty>"}`,
    );
  }
}

function assertMirrorSlots(
  entry: ProjectProjectionEntry,
  reconciliation: Exclude<
    ProjectProjectionReconciliation,
    { readonly driver: "canonical" }
  >,
): void {
  const slots = reconciliation.mirrorSlots ?? [];
  const ids = new Set<string>();
  for (const slot of slots) {
    if (slot.id.length === 0 || ids.has(slot.id)) {
      throw new Error(
        `Project Projection mirror slot ids must be unique and non-empty: ${entry.path} ${JSON.stringify(slot.id)}`,
      );
    }
    ids.add(slot.id);
    if (reconciliation.driver === "structured") {
      if (slot.location.kind !== "json-pointer") {
        throw new Error(
          `Project Projection structured mirror slots require a JSON Pointer location: ${entry.path} ${slot.id}`,
        );
      }
      try {
        parseJsonPointer(slot.location.pointer);
      } catch (error) {
        throw new Error(
          `Project Projection mirror slot location must be an RFC 6901 JSON Pointer: ${entry.path} ${slot.id} (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      continue;
    }
    if (slot.location.kind !== "text-anchor") {
      throw new Error(
        `Project Projection text mirror slots require a named text anchor: ${entry.path} ${slot.id}`,
      );
    }
    if (!/^\S+$/u.test(slot.location.name)) {
      throw new Error(
        `Project Projection text mirror slot names must be single non-empty tokens: ${entry.path} ${slot.id}`,
      );
    }
  }
}

function assertProjectionContract(
  projection: ProjectProjection,
): ReadonlyMap<string, ProjectProjectionReconciliation> {
  const paths = new Set<string>();
  for (const entry of projection.entries) {
    assertNormalizedSafeRelativePath(entry.path, "entry");
    if (
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      (entry.mode & ~0o111) !== 0
    ) {
      throw new Error(
        `Project Projection entry mode must contain only executable bits: ${entry.path} ${entry.mode}`,
      );
    }
    if (paths.has(entry.path)) {
      throw new Error(`Project Projection paths must be unique: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  const policies = new Map<string, ProjectProjectionReconciliation>();
  for (const reconciliation of projection.reconciliation) {
    assertNormalizedSafeRelativePath(reconciliation.path, "reconciliation");
    if (policies.has(reconciliation.path)) {
      throw new Error(
        `Project Projection reconciliation paths must be unique: ${reconciliation.path}`,
      );
    }
    if (!paths.has(reconciliation.path)) {
      throw new Error(
        `Project Projection reconciliation references an unknown path: ${reconciliation.path}`,
      );
    }
    if (
      reconciliation.driver === "structured" &&
      reconciliation.identitySets !== undefined
    ) {
      assertIdentitySetPolicies(
        projection.entries.find((entry) => entry.path === reconciliation.path)!,
        reconciliation,
      );
    }
    if (reconciliation.driver !== "canonical") {
      assertMirrorSlots(
        projection.entries.find((entry) => entry.path === reconciliation.path)!,
        reconciliation,
      );
    }
    policies.set(reconciliation.path, reconciliation);
  }
  for (const projectionPath of paths) {
    if (!policies.has(projectionPath)) {
      throw new Error(
        `Project Projection requires one reconciliation driver: ${projectionPath}`,
      );
    }
  }
  return policies;
}

/**
 * 槽位声明沿既有通用合并接缝只允许单调新增：Before 的每个槽位必须按原序出现在 After 前缀，
 * After 可追加消费者新增能力所对应的位置。删除、重排或改写既有槽位仍判为策略不兼容。
 * Core 不理解具体文件名或工具链，只在槽位列表结构上判定。
 */
function mirrorSlotsExtendMonotonically(
  before: readonly ProjectProjectionMirrorSlot[] | undefined,
  after: readonly ProjectProjectionMirrorSlot[] | undefined,
): boolean {
  const prior = before ?? [];
  const next = after ?? [];
  if (prior.length > next.length) return false;
  for (let index = 0; index < prior.length; index += 1) {
    if (
      JSON.stringify(prior[index] ?? null) !==
      JSON.stringify(next[index] ?? null)
    ) {
      return false;
    }
  }

  return true;
}

function reconciliationPoliciesCompatible(
  left: ProjectProjectionReconciliation,
  right: ProjectProjectionReconciliation,
): boolean {
  if (
    left.path !== right.path ||
    left.driver !== right.driver ||
    left.driver !== "structured" ||
    right.driver !== "structured"
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  const leftIdentitySets = left.identitySets ?? [];
  const rightIdentitySets = right.identitySets ?? [];
  if (leftIdentitySets.length !== rightIdentitySets.length) return false;
  if (!mirrorSlotsExtendMonotonically(left.mirrorSlots, right.mirrorSlots)) {
    return false;
  }

  return leftIdentitySets.every((leftPolicy, index) => {
    const rightPolicy = rightIdentitySets[index];
    if (
      rightPolicy === undefined ||
      leftPolicy.location !== rightPolicy.location ||
      leftPolicy.identity.kind !== rightPolicy.identity.kind
    ) {
      return false;
    }
    if (
      leftPolicy.identity.kind !== "projection" ||
      rightPolicy.identity.kind !== "projection"
    ) {
      return JSON.stringify(leftPolicy) === JSON.stringify(rightPolicy);
    }
    return (
      JSON.stringify(leftPolicy.identity.fallback) ===
      JSON.stringify(rightPolicy.identity.fallback)
    );
  });
}

function combinedIdentitySets(
  before: ProjectProjectionReconciliation | undefined,
  after: ProjectProjectionReconciliation | undefined,
): readonly StructuredIdentitySetPolicy[] {
  const beforeIdentitySets =
    before?.driver === "structured" ? (before.identitySets ?? []) : [];
  const afterIdentitySets =
    after?.driver === "structured" ? (after.identitySets ?? []) : [];

  return afterIdentitySets.map((afterPolicy, index) => {
    const beforePolicy = beforeIdentitySets[index];
    if (
      beforePolicy?.identity.kind !== "projection" ||
      afterPolicy.identity.kind !== "projection"
    ) {
      return afterPolicy;
    }
    return {
      ...afterPolicy,
      identity: {
        ...afterPolicy.identity,
        members: [
          ...beforePolicy.identity.members,
          ...afterPolicy.identity.members,
        ],
      },
    };
  });
}

function structuredValueAtLocation(
  root: StructuredValue,
  pathSegments: readonly string[],
): StructuredValue | undefined {
  let value = root;
  for (const segment of pathSegments) {
    if (isStructuredObject(value) && Object.hasOwn(value, segment)) {
      value = value[segment]!;
      continue;
    }
    if (
      Array.isArray(value) &&
      /^(?:0|[1-9][0-9]*)$/u.test(segment) &&
      Number.isSafeInteger(Number(segment)) &&
      Object.hasOwn(value, Number(segment))
    ) {
      value = value[Number(segment)]!;
      continue;
    }
    return undefined;
  }
  return value;
}

function assertIdentitySetPolicies(
  entry: ProjectProjectionEntry,
  reconciliation: Extract<
    ProjectProjectionReconciliation,
    { readonly driver: "structured" }
  >,
): void {
  const identitySets = reconciliation.identitySets ?? [];
  const locations = new Set<string>();
  const parsed = parseStructuredEntry(entry);
  if (!parsed.ok) {
    throw new Error(
      `Project Projection identity-set policy requires valid structured content: ${entry.path}`,
    );
  }
  for (const policy of identitySets) {
    let pathSegments: readonly string[];
    try {
      pathSegments = parseJsonPointer(policy.location);
    } catch (error) {
      throw new Error(
        `Project Projection identity-set location must be an RFC 6901 JSON Pointer: ${entry.path} ${JSON.stringify(policy.location)} (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    const location = structuredLocation(pathSegments);
    const locationKey = JSON.stringify(pathSegments);
    if (locations.has(locationKey)) {
      throw new Error(
        `Project Projection identity-set locations must be unique: ${entry.path} ${location}`,
      );
    }
    locations.add(locationKey);
    if (
      policy.identity.kind === "fields" &&
      (policy.identity.fields.length === 0 ||
        new Set(policy.identity.fields).size !==
          policy.identity.fields.length ||
        policy.identity.fields.some((field) => field.length === 0))
    ) {
      throw new Error(
        `Project Projection identity-set fields must be unique non-empty names: ${entry.path} ${location}`,
      );
    }
    if (policy.identity.kind === "projection") {
      const fallbackFields = policy.identity.fallback.fields;
      if (
        fallbackFields.length === 0 ||
        new Set(fallbackFields).size !== fallbackFields.length ||
        fallbackFields.some((field) => field.length === 0)
      ) {
        throw new Error(
          `Project Projection identity-set projection fallback fields must be unique non-empty names: ${entry.path} ${location}`,
        );
      }
      const memberIdentities = policy.identity.members.map(
        (member) => member.identity,
      );
      if (
        memberIdentities.some((identity) => identity.length === 0) ||
        new Set(memberIdentities).size !== memberIdentities.length ||
        policy.identity.members.some(
          (member) =>
            Object.keys(member.match).length === 0 ||
            Object.values(member.match).some(
              (value) =>
                value !== null &&
                typeof value !== "string" &&
                typeof value !== "number" &&
                typeof value !== "boolean",
            ),
        )
      ) {
        throw new Error(
          `Project Projection identity-set projection members require unique non-empty identities and non-empty scalar matches: ${entry.path} ${location}`,
        );
      }
    }
    const value = structuredValueAtLocation(parsed.value, pathSegments);
    if (!Array.isArray(value)) {
      throw new Error(
        `Project Projection identity-set location must reference an array: ${entry.path} ${location}`,
      );
    }
    const identities = value.map((member) => memberIdentity(member, policy));
    if (identities.some((identity) => identity === undefined)) {
      throw new Error(
        `Project Projection identity-set member is missing its identity: ${entry.path} ${location}`,
      );
    }
    if (new Set(identities).size !== identities.length) {
      throw new Error(
        `Project Projection identity-set member identities must be unique: ${entry.path} ${location}`,
      );
    }
  }
}

function declaredMirrorSlots(
  policy: ProjectProjectionReconciliation | undefined,
): readonly ProjectProjectionMirrorSlot[] {
  if (policy === undefined || policy.driver === "canonical") return [];
  return policy.mirrorSlots ?? [];
}

export async function reconcileProjectProjections(options: {
  readonly before: ProjectProjection;
  readonly after: ProjectProjection;
  readonly readCurrent: (
    path: string,
  ) => Promise<CurrentProjectProjectionEntry | undefined>;
}): Promise<ProjectProjectionReconciliationResult> {
  const beforePolicies = assertProjectionContract(options.before);
  const afterPolicies = assertProjectionContract(options.after);
  const beforeByPath = new Map(
    options.before.entries.map((entry) => [entry.path, entry]),
  );
  const afterByPath = new Map(
    options.after.entries.map((entry) => [entry.path, entry]),
  );
  for (const projectionPath of beforeByPath.keys()) {
    const beforePolicy = beforePolicies.get(projectionPath);
    const afterPolicy = afterPolicies.get(projectionPath);
    if (!afterByPath.has(projectionPath)) {
      throw new Error(
        `Package Addition projection may not delete path: ${projectionPath}`,
      );
    }
    if (
      afterPolicy !== undefined &&
      beforePolicy !== undefined &&
      !reconciliationPoliciesCompatible(beforePolicy, afterPolicy)
    ) {
      throw new Error(
        `Project Projection reconciliation policy changed for ${projectionPath}`,
      );
    }
  }
  const deltaPathSet = new Set(
    [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
      .filter(
        (projectionPath) =>
          !entriesEqual(
            beforeByPath.get(projectionPath),
            afterByPath.get(projectionPath),
          ),
      )
      .toSorted(),
  );
  const declaredMirrorPaths = new Set<string>();
  for (const [projectionPath, policy] of afterPolicies) {
    if (declaredMirrorSlots(policy).length > 0) {
      declaredMirrorPaths.add(projectionPath);
    }
  }
  for (const [projectionPath, policy] of beforePolicies) {
    if (declaredMirrorSlots(policy).length > 0) {
      declaredMirrorPaths.add(projectionPath);
    }
  }
  const reconcilePaths = [
    ...new Set([...deltaPathSet, ...declaredMirrorPaths]),
  ].toSorted();
  const mutations: ProjectProjectionEntry[] = [];
  const conflicts: ProjectProjectionConflict[] = [];

  for (const projectionPath of reconcilePaths) {
    const before = beforeByPath.get(projectionPath);
    const after = afterByPath.get(projectionPath)!;
    const beforePolicy = beforePolicies.get(projectionPath);
    const afterPolicy = afterPolicies.get(projectionPath);
    const policy = afterPolicy ?? beforePolicy!;
    const driver = policy.driver;
    const mirrorSlots = declaredMirrorSlots(policy);
    const isDeltaPath = deltaPathSet.has(projectionPath);
    const current = await options.readCurrent(projectionPath);
    if (entriesEqual(current, after)) continue;
    if (entriesEqual(current, before)) {
      mutations.push(after);
      continue;
    }
    if (driver === "canonical") {
      conflicts.push({
        path: projectionPath,
        driver,
        reason: "Current tool-owned state is stale",
        before: describeEntry(before),
        current: describeEntry(current),
        after: describeEntry(after),
      });
      continue;
    }
    if (before === undefined || current === undefined) {
      if (!isDeltaPath && mirrorSlots.length > 0) continue;
      conflicts.push({
        path: projectionPath,
        driver,
        ...(driver === "structured" ? { location: "" } : {}),
        reason: "Path presence changed concurrently",
        before: describeEntry(before),
        current: describeEntry(current),
        after: describeEntry(after),
      });
      continue;
    }
    if (current.kind !== "file") {
      if (!isDeltaPath && mirrorSlots.length > 0) continue;
      conflicts.push({
        path: projectionPath,
        driver,
        attribute: "file-kind",
        reason: "Current file kind is incompatible with Package Addition",
        before: before.kind,
        current: current.kind,
        after: after.kind,
      });
      continue;
    }
    if (reconcileMode(before, current, after) === undefined) {
      conflicts.push({
        path: projectionPath,
        driver,
        attribute: "executable-mode",
        reason:
          "Current and After contain incompatible executable-mode changes",
        before: describeExecutableMode(before),
        current: describeExecutableMode(current),
        after: describeExecutableMode(after),
      });
      continue;
    }
    const structured =
      driver === "structured"
        ? reconcileStructuredEntry({
            before,
            current,
            after,
            identitySets: combinedIdentitySets(beforePolicy, afterPolicy),
            mirrorSlots,
          })
        : undefined;
    const text =
      driver === "text"
        ? reconcileTextEntry({ before, current, after, mirrorSlots })
        : undefined;
    if (structured?.ok === true && "skip" in structured) continue;
    const reconciled =
      driver === "text"
        ? text?.ok
          ? text.entry
          : undefined
        : structured?.ok && "entry" in structured
          ? structured.entry
          : undefined;
    if (reconciled === undefined) {
      if (text?.ok === false && text.conflicts !== undefined) {
        conflicts.push(
          ...text.conflicts.map((conflict) => ({
            path: projectionPath,
            driver,
            ...conflict,
          })),
        );
        continue;
      }
      conflicts.push({
        path: projectionPath,
        driver,
        ...(structured?.ok === false && structured.conflict !== undefined
          ? structured.conflict
          : {
              ...(driver === "structured" ? { location: "" } : {}),
              reason: "Current and After contain incompatible changes",
              before: describeEntry(before),
              current: describeEntry(current),
              after: describeEntry(after),
            }),
      });
      continue;
    }
    if (!entriesEqual(current, reconciled)) mutations.push(reconciled);
  }

  return conflicts.length === 0
    ? { ok: true, mutations }
    : { ok: false, conflicts };
}

async function readCurrentProjectionEntry(
  targetRoot: string,
  projectionPath: string,
): Promise<CurrentProjectProjectionEntry | undefined> {
  const filePath = path.join(targetRoot, projectionPath);
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile()) {
      return {
        path: projectionPath,
        kind: fileStat.isDirectory()
          ? "directory"
          : fileStat.isSymbolicLink()
            ? "symbolic-link"
            : "other",
      };
    }
    const mode: ProjectProjectionEntry["mode"] = fileStat.mode & 0o111;
    return {
      path: projectionPath,
      kind: "file",
      content: new Uint8Array(await readFile(filePath)),
      mode,
    };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

type CurrentPathKind = CurrentProjectProjectionEntry["kind"];

async function readCurrentPathKind(
  targetRoot: string,
  relativePath: string,
): Promise<CurrentPathKind | undefined> {
  try {
    const fileStat = await lstat(path.join(targetRoot, relativePath));
    return fileStat.isFile()
      ? "file"
      : fileStat.isDirectory()
        ? "directory"
        : fileStat.isSymbolicLink()
          ? "symbolic-link"
          : "other";
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return undefined;
      if (error.code === "ENOTDIR") return "other";
    }
    throw error;
  }
}

function pathPreconditionConflict(
  precondition: ProjectProjectionPathPrecondition,
  current: CurrentPathKind | "existing path",
): ProjectProjectionConflict {
  return {
    path: precondition.path,
    driver: "precondition",
    reason: `${precondition.reason}; found ${
      current === "existing path" ? current : `existing ${current}`
    }`,
    before: "missing",
    current,
    after: "reserved for transaction",
  };
}

async function evaluatePathPreconditions(options: {
  readonly targetRoot: string;
  readonly preconditions: readonly ProjectProjectionPathPrecondition[];
}): Promise<readonly ProjectProjectionConflict[]> {
  const paths = new Set<string>();
  const conflicts: ProjectProjectionConflict[] = [];
  for (const precondition of options.preconditions) {
    assertNormalizedSafeRelativePath(precondition.path, "entry");
    if (paths.has(precondition.path)) {
      throw new Error(
        `Project Projection Path Precondition paths must be unique: ${precondition.path}`,
      );
    }
    paths.add(precondition.path);
    const current = await readCurrentPathKind(
      options.targetRoot,
      precondition.path,
    );
    if (current === undefined) continue;
    conflicts.push(pathPreconditionConflict(precondition, current));
  }
  return conflicts;
}

type AcquiredPathReservation = {
  readonly path: string;
  readonly firstCreatedPath: string;
};

async function releasePathReservations(options: {
  readonly targetRoot: string;
  readonly reservations: readonly AcquiredPathReservation[];
}): Promise<void> {
  for (const reservation of options.reservations.toReversed()) {
    const reservationPath = path.join(options.targetRoot, reservation.path);
    await rm(reservationPath, { recursive: true, force: true });
    const firstCreatedPath = path.resolve(reservation.firstCreatedPath);
    for (
      let createdParent = path.dirname(reservationPath);
      createdParent !== path.dirname(firstCreatedPath);
      createdParent = path.dirname(createdParent)
    ) {
      try {
        await rmdir(createdParent);
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTEMPTY")
        ) {
          break;
        }
        throw error;
      }
    }
  }
}

async function acquirePathReservations(options: {
  readonly targetRoot: string;
  readonly preconditions: readonly ProjectProjectionPathPrecondition[];
}): Promise<readonly AcquiredPathReservation[]> {
  const conflicts = await evaluatePathPreconditions(options);
  if (conflicts.length > 0) {
    throw new ProjectProjectionPathPreconditionError(conflicts);
  }
  const reservations: AcquiredPathReservation[] = [];
  try {
    for (const precondition of options.preconditions) {
      const reservationPath = path.join(
        path.resolve(options.targetRoot),
        precondition.path,
      );
      let firstCreatedPath: string | undefined;
      try {
        firstCreatedPath = await mkdir(reservationPath, { recursive: true });
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "EEXIST" && error.code !== "ENOTDIR")
        ) {
          throw error;
        }
      }
      if (firstCreatedPath === undefined) {
        throw new ProjectProjectionPathPreconditionError([
          pathPreconditionConflict(precondition, "existing path"),
        ]);
      }
      reservations.push({
        path: precondition.path,
        firstCreatedPath,
      });
    }
    return reservations;
  } catch (error) {
    await releasePathReservations({
      targetRoot: options.targetRoot,
      reservations,
    });
    throw error;
  }
}

async function applyProjectionMutationsAtomically(options: {
  readonly targetRoot: string;
  readonly mutations: readonly ProjectProjectionEntry[];
  readonly preconditions: readonly ProjectProjectionPathPrecondition[];
  readonly beforeCommit?: () => Promise<void>;
  readonly commitMutation?: (
    options: ProjectProjectionMutationCommitOptions,
  ) => Promise<void>;
}): Promise<void> {
  if (options.mutations.length === 0) return;
  const mutationPaths = new Set<string>();
  for (const mutation of options.mutations) {
    assertNormalizedSafeRelativePath(mutation.path, "entry");
    if (mutationPaths.has(mutation.path)) {
      throw new Error(
        `Project Projection mutation paths must be unique: ${mutation.path}`,
      );
    }
    mutationPaths.add(mutation.path);
  }
  const targetRoot = path.resolve(options.targetRoot);
  const parent = path.dirname(targetRoot);
  const prefix = `.${path.basename(targetRoot)}.template-projection-`;
  const stagingRoot = await mkdtemp(path.join(parent, `${prefix}stage-`));
  const backupRoot = await mkdtemp(path.join(parent, `${prefix}backup-`));
  const backedUpPaths = new Set<string>();
  const committedPaths: string[] = [];
  let reservations: readonly AcquiredPathReservation[] = [];
  try {
    for (const mutation of options.mutations) {
      const stagedPath = path.join(stagingRoot, mutation.path);
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, mutation.content);
      await chmod(stagedPath, 0o644 | mutation.mode);

      const targetPath = path.join(targetRoot, mutation.path);
      try {
        const backupPath = path.join(backupRoot, mutation.path);
        await mkdir(path.dirname(backupPath), { recursive: true });
        await copyFile(targetPath, backupPath);
        backedUpPaths.add(mutation.path);
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }

    try {
      await options.beforeCommit?.();
      reservations = await acquirePathReservations({
        targetRoot,
        preconditions: options.preconditions,
      });
      for (const mutation of options.mutations) {
        const targetPath = path.join(targetRoot, mutation.path);
        await mkdir(path.dirname(targetPath), { recursive: true });
        committedPaths.push(mutation.path);
        const commit = async (): Promise<void> => {
          await copyFile(path.join(stagingRoot, mutation.path), targetPath);
        };
        if (options.commitMutation === undefined) {
          await commit();
        } else {
          await options.commitMutation({
            relativePath: mutation.path,
            stagingRoot,
            targetRoot,
            commit,
          });
        }
      }
      reservations = [];
    } catch (error) {
      for (const committedPath of committedPaths.toReversed()) {
        const targetPath = path.join(targetRoot, committedPath);
        if (backedUpPaths.has(committedPath)) {
          await copyFile(path.join(backupRoot, committedPath), targetPath);
        } else {
          await rm(targetPath, { force: true });
        }
      }
      await releasePathReservations({
        targetRoot,
        reservations,
      });
      throw error;
    }
  } finally {
    await Promise.all([
      rm(stagingRoot, { recursive: true, force: true }),
      rm(backupRoot, { recursive: true, force: true }),
    ]);
  }
}

export type ProjectProjectionMutationCommitOptions = {
  readonly relativePath: string;
  readonly stagingRoot: string;
  readonly targetRoot: string;
  readonly commit: () => Promise<void>;
};

export type ProjectProjectionReconcilerDependencies = {
  readonly beforeCommit?: () => Promise<void>;
  readonly commitMutation?: (
    options: ProjectProjectionMutationCommitOptions,
  ) => Promise<void>;
};

type ReconcileAndApplyProjectProjectionsOptions = {
  readonly targetRoot: string;
  readonly before: MaterializeProjectProjectionOptions;
  readonly after: MaterializeProjectProjectionOptions;
  readonly preconditions?: readonly ProjectProjectionPathPrecondition[];
  readonly dryRun?: boolean;
};

type ReconcileAndApplyProjectProjectionsResult =
  | {
      readonly ok: true;
      readonly changedPaths: readonly string[];
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly ok: false;
      readonly conflicts: readonly ProjectProjectionConflict[];
    };

export function createProjectProjectionReconciler(
  dependencies: ProjectProjectionReconcilerDependencies = {},
): (
  options: ReconcileAndApplyProjectProjectionsOptions,
) => Promise<ReconcileAndApplyProjectProjectionsResult> {
  return async (
    options: ReconcileAndApplyProjectProjectionsOptions,
  ): Promise<ReconcileAndApplyProjectProjectionsResult> => {
    const preconditionConflicts = await evaluatePathPreconditions({
      targetRoot: options.targetRoot,
      preconditions: options.preconditions ?? [],
    });
    if (preconditionConflicts.length > 0) {
      return { ok: false, conflicts: preconditionConflicts };
    }
    const [before, after] = await Promise.all([
      materializeProjectProjection(options.before),
      materializeProjectProjection(options.after),
    ]);
    const reconciliation = await reconcileProjectProjections({
      before,
      after,
      readCurrent: async (projectionPath) =>
        readCurrentProjectionEntry(options.targetRoot, projectionPath),
    });
    if (!reconciliation.ok) return reconciliation;
    const beforePaths = new Set(before.entries.map((entry) => entry.path));
    const drivers = new Map(
      after.reconciliation.map((policy) => [policy.path, policy.driver]),
    );
    const actions = reconciliation.mutations.map((mutation) => ({
      path: mutation.path,
      driver: drivers.get(mutation.path)!,
      action: beforePaths.has(mutation.path)
        ? ("update" as const)
        : ("create" as const),
    }));
    if (!options.dryRun) {
      try {
        await applyProjectionMutationsAtomically({
          targetRoot: options.targetRoot,
          mutations: reconciliation.mutations,
          preconditions: options.preconditions ?? [],
          ...(dependencies.beforeCommit === undefined
            ? {}
            : { beforeCommit: dependencies.beforeCommit }),
          ...(dependencies.commitMutation === undefined
            ? {}
            : { commitMutation: dependencies.commitMutation }),
        });
      } catch (error: unknown) {
        if (error instanceof ProjectProjectionPathPreconditionError) {
          return { ok: false, conflicts: error.conflicts };
        }
        throw error;
      }
    }
    return {
      ok: true,
      changedPaths: reconciliation.mutations.map((mutation) => mutation.path),
      actions,
    };
  };
}

export const reconcileAndApplyProjectProjections =
  createProjectProjectionReconciler();

export async function materializeProjectProjection(
  options: MaterializeProjectProjectionOptions,
): Promise<ProjectProjection> {
  const planDiagnostics = validateProjectProjectionPlan(options);
  if (planDiagnostics.length > 0) {
    throw new Error(planDiagnostics.join("\n"));
  }
  const finalPaths = new Set<string>();
  const contentPaths = new Set<string>();
  const policies = new Map<string, ProjectProjectionReconciliation>();
  for (const operation of options.operations) {
    const outputPath = normalizedOutputPath(operation);
    finalPaths.add(outputPath);
    if (operation.kind === "setExecutable") {
      if (!contentPaths.has(outputPath)) {
        throw new Error(
          `Project Projection setExecutable requires a preceding content-producing operation: ${outputPath}`,
        );
      }
    } else if (operation.kind !== "replaceAnchors") {
      contentPaths.add(outputPath);
    }
    const driver = operationDriver(operation);
    if (driver !== undefined) {
      policies.set(outputPath, { path: outputPath, driver });
    }
  }
  const declaredReconciliationPaths = new Set<string>();
  for (const reconciliation of options.reconciliation ?? []) {
    assertNormalizedSafeRelativePath(reconciliation.path, "reconciliation");
    if (declaredReconciliationPaths.has(reconciliation.path)) {
      throw new Error(
        `Project Projection reconciliation paths must be unique: ${reconciliation.path}`,
      );
    }
    if (!finalPaths.has(reconciliation.path)) {
      throw new Error(
        `Project Projection reconciliation references an unknown path: ${reconciliation.path}`,
      );
    }
    declaredReconciliationPaths.add(reconciliation.path);
    policies.set(reconciliation.path, reconciliation);
  }

  const targetRoot = await mkdtemp(
    path.join(tmpdir(), "template-project-projection-"),
  );
  try {
    await renderProject({
      targetRoot,
      operations: [...options.operations],
    });
    const entries = await Promise.all(
      [...finalPaths].toSorted().map(async (relativePath) => {
        const filePath = path.join(targetRoot, relativePath);
        const fileStat = await lstat(filePath);
        if (!fileStat.isFile()) {
          throw new Error(
            `Project Projection output must be a file: ${relativePath}`,
          );
        }
        const mode: ProjectProjectionEntry["mode"] = fileStat.mode & 0o111;
        return {
          path: relativePath,
          kind: "file" as const,
          content: new Uint8Array(await readFile(filePath)),
          mode,
        };
      }),
    );
    return {
      entries,
      reconciliation: [...policies.values()].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    };
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
}
