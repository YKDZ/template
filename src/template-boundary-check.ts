import { readFile } from "node:fs/promises";

import ts from "typescript";

import type { PresetProjectionPlan } from "./preset-projection.js";
import type { RenderOperation } from "./renderer.js";

export type TemplateBoundaryDebt = {
  readonly preset: string;
  readonly generatedPath: string;
  readonly owningFunction: string;
  readonly reason: string;
};

export type TemplateBoundaryViolation = {
  readonly preset: string;
  readonly generatedPath: string;
  readonly owningFunction: string;
  readonly operationKind: RenderOperation["kind"];
  readonly sourceFilePath: string;
  readonly allowlistReason?: string;
};

export type TemplateBoundaryCheckProjection = {
  readonly name: string;
  readonly sourceFilePath: string;
  readonly plan: PresetProjectionPlan;
};

export type TemplateBoundaryCheckResult = {
  readonly ok: boolean;
  readonly violations: readonly TemplateBoundaryViolation[];
  readonly allowlistedDebt: readonly TemplateBoundaryViolation[];
  readonly unusedAllowlistEntries: readonly TemplateBoundaryDebt[];
};

export type CheckTemplateSourceBoundaryOptions = {
  readonly projections: readonly TemplateBoundaryCheckProjection[];
  readonly allowlist?: readonly TemplateBoundaryDebt[];
};

type InlineProtectedOperation = Extract<
  RenderOperation,
  { kind: "writeText" | "writeJson" | "mergeJson" }
>;

const inlineOperationKinds = new Set<RenderOperation["kind"]>([
  "writeText",
  "writeJson",
  "mergeJson",
]);

const protectedInlineDebtPaths = [
  "turbo.json",
  "tsconfig.config.json",
  ".devcontainer/devcontainer.json",
  ".devcontainer/Dockerfile",
  ".vscode/extensions.json",
  ".vscode/settings.json",
  ".github/workflows/check.yml",
  ".github/dependabot.yml",
] as const;

const currentTemplateSourceBoundaryDebtReason =
  "current protected Generated Repository output awaiting template-source migration";

function currentDebt(
  preset: string,
  owningFunction: string,
  generatedPaths: readonly string[],
): readonly TemplateBoundaryDebt[] {
  return generatedPaths.map((generatedPath) => ({
    preset,
    owningFunction,
    generatedPath,
    reason: currentTemplateSourceBoundaryDebtReason,
  }));
}

export const templateBoundaryDebtAllowlist: readonly TemplateBoundaryDebt[] = [
  ...currentDebt(
    "ts-lib",
    "operationsForTsLib",
    protectedInlineDebtPaths.filter(
      (generatedPath) => generatedPath !== ".devcontainer/Dockerfile",
    ),
  ),
  ...currentDebt("hono-api", "operationsForHonoApi", protectedInlineDebtPaths),
  ...currentDebt(
    "vue-app",
    "operationsForVueApp",
    protectedInlineDebtPaths.filter(
      (generatedPath) => generatedPath !== ".devcontainer/Dockerfile",
    ),
  ),
  ...currentDebt(
    "vue-hono-app",
    "operationsForVueHonoApp",
    protectedInlineDebtPaths.filter(
      (generatedPath) => generatedPath !== ".devcontainer/Dockerfile",
    ),
  ),
  ...currentDebt("rust-bin", "operationsForRustBin", [
    "turbo.json",
    "packages/demo-rust-bin/rustfmt.toml",
    "rust-toolchain.toml",
    ".devcontainer/devcontainer.json",
    ".vscode/extensions.json",
    ".vscode/settings.json",
    ".github/workflows/check.yml",
    ".github/dependabot.yml",
  ]),
];

function operationTarget(operation: RenderOperation): string | undefined {
  if ("to" in operation) {
    return operation.to;
  }

  return undefined;
}

function isInlineProtectedOperation(
  operation: RenderOperation,
): operation is InlineProtectedOperation {
  const generatedPath = operationTarget(operation);

  return (
    generatedPath !== undefined &&
    inlineOperationKinds.has(operation.kind) &&
    isProtectedGeneratedPath(generatedPath)
  );
}

export function isProtectedGeneratedPath(generatedPath: string): boolean {
  const normalizedPath = generatedPath.split("\\").join("/");
  const fileName = normalizedPath.split("/").at(-1);

  return (
    normalizedPath === ".devcontainer/Dockerfile" ||
    normalizedPath === ".devcontainer/devcontainer.json" ||
    normalizedPath === ".github/dependabot.yml" ||
    normalizedPath.startsWith(".github/workflows/") ||
    normalizedPath.startsWith(".vscode/") ||
    fileName === "oxfmt.config.ts" ||
    fileName === "oxlint.config.ts" ||
    fileName === "playwright.config.ts" ||
    fileName === "rustfmt.toml" ||
    fileName === "rust-toolchain.toml" ||
    fileName === "turbo.json" ||
    fileName === "tsconfig.config.json" ||
    fileName === "vite.config.ts" ||
    fileName === "vitest.config.ts"
  );
}

function propertyStringValue(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): string | undefined {
  const initializer = propertyInitializer(objectLiteral, name);

  if (!initializer) {
    return undefined;
  }

  if (ts.isStringLiteralLike(initializer)) {
    return initializer.text;
  }

  if (
    ts.isNoSubstitutionTemplateLiteral(initializer) ||
    ts.isTemplateExpression(initializer)
  ) {
    return initializer.getText();
  }

  return undefined;
}

function propertyInitializer(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = objectLiteral.properties.find((candidate) => {
    return (
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
    );
  });

  if (!property || !ts.isPropertyAssignment(property)) {
    return undefined;
  }

  return property.initializer;
}

function propertyPathMatches(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  expectedPath: string,
): boolean {
  const initializer = propertyInitializer(objectLiteral, name);

  if (!initializer) {
    return false;
  }

  if (ts.isStringLiteralLike(initializer)) {
    return initializer.text === expectedPath;
  }

  if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.text === expectedPath;
  }

  if (ts.isTemplateExpression(initializer)) {
    const literalParts = [
      initializer.head.text,
      ...initializer.templateSpans.map((span) => span.literal.text),
    ].filter((part) => part.length > 0);

    let searchStart = 0;

    return literalParts.every((part, index) => {
      const foundAt = expectedPath.indexOf(part, searchStart);

      if (foundAt === -1) {
        return false;
      }

      const isFirst = index === 0;
      const isLast = index === literalParts.length - 1;

      if (isFirst && initializer.head.text.length > 0 && foundAt !== 0) {
        return false;
      }

      if (isLast && !expectedPath.endsWith(part)) {
        return false;
      }

      searchStart = foundAt + part.length;

      return true;
    });
  }

  return false;
}

function owningFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;

  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }

    if (
      ts.isPropertyAssignment(current) &&
      (ts.isFunctionExpression(current.initializer) ||
        ts.isArrowFunction(current.initializer))
    ) {
      return current.name.getText();
    }

    current = current.parent;
  }

  return "<module>";
}

function findOwningFunctionsForOperation(
  sourceFile: ts.SourceFile,
  operation: InlineProtectedOperation,
): readonly string[] {
  const exactOwners = new Set<string>();
  const candidateOwners = new Set<string>();

  function visit(node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (
      propertyStringValue(node, "kind") === operation.kind &&
      propertyPathMatches(node, "to", operation.to)
    ) {
      const owner = owningFunctionName(node);

      candidateOwners.add(owner);

      if (
        operation.kind === "writeText" &&
        propertyStringValue(node, "text") === operation.text
      ) {
        exactOwners.add(owner);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (exactOwners.size > 0) {
    return [...exactOwners];
  }

  if (candidateOwners.size > 0) {
    return [...candidateOwners];
  }

  return ["<unknown>"];
}

function allowlistKey(
  preset: string,
  generatedPath: string,
  owningFunction: string,
): string {
  return `${preset}\0${owningFunction}\0${generatedPath}`;
}

export async function checkTemplateSourceBoundary({
  projections,
  allowlist = [],
}: CheckTemplateSourceBoundaryOptions): Promise<TemplateBoundaryCheckResult> {
  const allowed = new Map(
    allowlist.map((entry) => [
      allowlistKey(entry.preset, entry.generatedPath, entry.owningFunction),
      entry.reason,
    ]),
  );
  const checkedPresets = new Set(
    projections.map((projection) => projection.name),
  );
  const usedAllowlistKeys = new Set<string>();
  const violations: TemplateBoundaryViolation[] = [];
  const allowlistedDebt: TemplateBoundaryViolation[] = [];

  for (const projection of projections) {
    const sourceText = await readFile(projection.sourceFilePath, "utf8");
    const sourceFile = ts.createSourceFile(
      projection.sourceFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    for (const operation of projection.plan.operations) {
      if (!isInlineProtectedOperation(operation)) {
        continue;
      }

      const owningFunctions = findOwningFunctionsForOperation(
        sourceFile,
        operation,
      );

      for (const owningFunction of owningFunctions) {
        const diagnostic: TemplateBoundaryViolation = {
          preset: projection.name,
          generatedPath: operation.to,
          owningFunction,
          operationKind: operation.kind,
          sourceFilePath: projection.sourceFilePath,
        };

        const allowlistReason = allowed.get(
          allowlistKey(projection.name, operation.to, owningFunction),
        );

        if (allowlistReason) {
          usedAllowlistKeys.add(
            allowlistKey(projection.name, operation.to, owningFunction),
          );
          allowlistedDebt.push({ ...diagnostic, allowlistReason });
          continue;
        }

        violations.push(diagnostic);
      }
    }
  }

  const unusedAllowlistEntries = allowlist.filter((entry) => {
    if (!checkedPresets.has(entry.preset)) {
      return false;
    }

    return !usedAllowlistKeys.has(
      allowlistKey(entry.preset, entry.generatedPath, entry.owningFunction),
    );
  });

  return {
    ok: violations.length === 0 && unusedAllowlistEntries.length === 0,
    violations,
    allowlistedDebt,
    unusedAllowlistEntries,
  };
}
