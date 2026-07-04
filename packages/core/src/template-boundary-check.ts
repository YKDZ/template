import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

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
  readonly plan: {
    readonly sourceRoot: string;
    readonly sourceRoots?: Record<string, string> | undefined;
    readonly operations: readonly RenderOperation[];
  };
};

export type TemplateBoundaryCheckResult = {
  readonly ok: boolean;
  readonly violations: readonly TemplateBoundaryViolation[];
  readonly allowlistedDebt: readonly TemplateBoundaryViolation[];
  readonly unusedAllowlistEntries: readonly TemplateBoundaryDebt[];
};

export type CheckTemplateSourceBoundaryOptions = {
  readonly projections: readonly TemplateBoundaryCheckProjection[];
  readonly manifestReferencedSourceFiles?: readonly string[];
  readonly allowlist?: readonly TemplateBoundaryDebt[];
};

type InlineProtectedOperation = Extract<
  RenderOperation,
  { kind: "writeText" | "writeJson" | "mergeJson" }
>;
type SourceBackedOperation = Extract<
  RenderOperation,
  { kind: "copyFile" | "writeTextTemplate" | "writeTextFromFragments" }
>;

const inlineOperationKinds = new Set<RenderOperation["kind"]>([
  "writeText",
  "writeJson",
  "mergeJson",
]);

export const templateBoundaryDebtAllowlist: readonly TemplateBoundaryDebt[] =
  [];

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

function isProtectedSourceBackedOperation(
  operation: RenderOperation,
): operation is SourceBackedOperation {
  const generatedPath = operationTarget(operation);

  return (
    generatedPath !== undefined &&
    (operation.kind === "copyFile" ||
      operation.kind === "writeTextTemplate" ||
      operation.kind === "writeTextFromFragments") &&
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

function expressionStringValue(expression: ts.Expression): string | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return expressionStringValue(expression.expression);
  }

  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }

  if (
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    return expression.getText();
  }

  return undefined;
}

function propertyStringValue(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): string | undefined {
  const initializer = propertyInitializer(objectLiteral, name);

  return initializer === undefined
    ? undefined
    : expressionStringValue(initializer);
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

type OperationAstMatch = {
  readonly node: ts.ObjectLiteralExpression;
  readonly owningFunction: string;
};

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function expressionLiteralJsonValue(
  expression: ts.Expression,
):
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false } {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionLiteralJsonValue(expression.expression);
  }

  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return expressionLiteralJsonValue(expression.expression);
  }

  if (ts.isStringLiteralLike(expression)) {
    return { known: true, value: expression.text };
  }

  if (ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { known: true, value: expression.text };
  }

  if (ts.isNumericLiteral(expression)) {
    return { known: true, value: Number(expression.text) };
  }

  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return { known: true, value: true };
  }

  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { known: true, value: false };
  }

  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return { known: true, value: null };
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = expressionLiteralJsonValue(expression.operand);

    if (!operand.known || typeof operand.value !== "number") {
      return { known: false };
    }

    if (expression.operator === ts.SyntaxKind.MinusToken) {
      return { known: true, value: -operand.value };
    }

    if (expression.operator === ts.SyntaxKind.PlusToken) {
      return { known: true, value: operand.value };
    }

    return { known: false };
  }

  if (ts.isArrayLiteralExpression(expression)) {
    const values: unknown[] = [];

    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        return { known: false };
      }

      const value = expressionLiteralJsonValue(element);

      if (!value.known) {
        return { known: false };
      }

      values.push(value.value);
    }

    return { known: true, value: values };
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return { known: false };
      }

      const name = propertyNameText(property.name);

      if (name === undefined) {
        return { known: false };
      }

      const initializer = expressionLiteralJsonValue(property.initializer);

      if (!initializer.known) {
        return { known: false };
      }

      value[name] = initializer.value;
    }

    return { known: true, value };
  }

  return { known: false };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonValuesEqual(entry, right[index]))
    );
  }

  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  const rightValues = new Map(rightEntries);

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => {
      return (
        rightValues.has(key) && jsonValuesEqual(value, rightValues.get(key))
      );
    })
  );
}

function expressionMatchesJsonValue(
  expression: ts.Expression,
  expectedValue: unknown,
): boolean {
  const literalValue = expressionLiteralJsonValue(expression);

  return (
    literalValue.known && jsonValuesEqual(literalValue.value, expectedValue)
  );
}

function isExactOperationAstMatch(
  node: ts.ObjectLiteralExpression,
  operation: InlineProtectedOperation,
): boolean {
  if (operation.kind === "writeText") {
    return propertyStringValue(node, "text") === operation.text;
  }

  const value = propertyInitializer(node, "value");

  return (
    value !== undefined && expressionMatchesJsonValue(value, operation.value)
  );
}

function findAstMatchesForOperation(
  sourceFile: ts.SourceFile,
  operation: InlineProtectedOperation,
): readonly OperationAstMatch[] {
  const exactMatches: OperationAstMatch[] = [];
  const candidateMatches: OperationAstMatch[] = [];

  function visit(node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (
      propertyStringValue(node, "kind") === operation.kind &&
      propertyPathMatches(node, "to", operation.to)
    ) {
      const match = {
        node,
        owningFunction: owningFunctionName(node),
      };

      candidateMatches.push(match);

      if (isExactOperationAstMatch(node, operation)) {
        exactMatches.push(match);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return candidateMatches;
}

function findOwningFunctionsForOperation(
  sourceFile: ts.SourceFile,
  operation: InlineProtectedOperation,
): readonly string[] {
  const owners = new Set(
    findAstMatchesForOperation(sourceFile, operation).map(
      (match) => match.owningFunction,
    ),
  );

  if (owners.size > 0) {
    return [...owners];
  }

  return ["<unknown>"];
}

function findOwningFunctionsForProtectedOperation(
  sourceFile: ts.SourceFile,
  operation: SourceBackedOperation,
): readonly string[] {
  const generatedPath = operationTarget(operation);
  if (generatedPath === undefined) {
    return ["<unknown>"];
  }

  const targetPath = generatedPath;
  const owners = new Set<string>();

  function visit(node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (
      propertyStringValue(node, "kind") === operation.kind &&
      propertyPathMatches(node, "to", targetPath)
    ) {
      owners.add(owningFunctionName(node));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (owners.size > 0) {
    return [...owners];
  }

  return ["<unknown>"];
}

function isPropertyAccess(
  expression: ts.Expression,
  objectName: string,
  propertyName: string,
): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === objectName &&
    expression.name.text === propertyName
  );
}

function isEditorExtensionsProjectionValue(expression: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(expression)) {
    return false;
  }

  const [property] = expression.properties;

  return (
    expression.properties.length === 1 &&
    property !== undefined &&
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === "recommendations" &&
    isPropertyAccess(property.initializer, "editorCustomization", "extensions")
  );
}

function isStructuredEditorCustomizationOperation(
  sourceFile: ts.SourceFile,
  operation: InlineProtectedOperation,
): boolean {
  if (operation.kind !== "writeJson") {
    return false;
  }

  if (
    operation.to !== ".vscode/extensions.json" &&
    operation.to !== ".vscode/settings.json"
  ) {
    return false;
  }

  const matches = findAstMatchesForOperation(sourceFile, operation);

  if (matches.length === 0) {
    return false;
  }

  return matches.every((match) => {
    const value = propertyInitializer(match.node, "value");

    return (
      value !== undefined &&
      (operation.to === ".vscode/settings.json"
        ? isPropertyAccess(value, "editorCustomization", "settings")
        : isEditorExtensionsProjectionValue(value))
    );
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const expectedKeySet = new Set(expectedKeys);

  return (
    keys.length === expectedKeySet.size &&
    keys.every((key) => expectedKeySet.has(key))
  );
}

function isStructuralTurboValue(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tasks"]) ||
    !isRecord(value.tasks)
  ) {
    return false;
  }

  return Object.values(value.tasks).every((task) => {
    if (!isRecord(task)) {
      return false;
    }

    return Object.entries(task).every(([key, entryValue]) => {
      if (key === "dependsOn" || key === "outputs") {
        return isStringArray(entryValue);
      }

      if (key === "cache" || key === "persistent") {
        return typeof entryValue === "boolean";
      }

      return false;
    });
  });
}

const rootTsconfigConfigCompilerOptions = {
  module: "nodenext",
  moduleResolution: "nodenext",
  noEmitOnError: true,
  skipLibCheck: false,
  strict: true,
  target: "es2023",
} as const;

const rootTsconfigConfigIncludes = new Set([
  "oxlint.config.ts",
  "oxfmt.config.ts",
  "playwright.config.ts",
  "vite.config.ts",
  "vitest.config.ts",
]);

function isStructuralTsconfigConfigValue(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["compilerOptions", "include"]) ||
    !isRecord(value.compilerOptions) ||
    !isStringArray(value.include)
  ) {
    return false;
  }

  return (
    jsonValuesEqual(value.compilerOptions, rootTsconfigConfigCompilerOptions) &&
    value.include.every((entry) => rootTsconfigConfigIncludes.has(entry))
  );
}

function isDevelopmentContainerPlanValue(expression: ts.Expression): boolean {
  return isPropertyAccess(expression, "developmentContainer", "devcontainer");
}

function isAllowedStructuralMachineDeclaration(
  sourceFile: ts.SourceFile,
  operation: InlineProtectedOperation,
): boolean {
  if (operation.kind !== "writeJson") {
    return false;
  }

  if (operation.to === "turbo.json") {
    return isStructuralTurboValue(operation.value);
  }

  if (operation.to === "tsconfig.config.json") {
    return isStructuralTsconfigConfigValue(operation.value);
  }

  if (operation.to !== ".devcontainer/devcontainer.json") {
    return false;
  }

  const matches = findAstMatchesForOperation(sourceFile, operation);

  return (
    matches.length > 0 &&
    matches.every((match) => {
      const value = propertyInitializer(match.node, "value");

      return value !== undefined && isDevelopmentContainerPlanValue(value);
    })
  );
}

function allowlistKey(
  preset: string,
  generatedPath: string,
  owningFunction: string,
): string {
  return `${preset}\0${owningFunction}\0${generatedPath}`;
}

function resolveOperationSourceRoot(
  projection: TemplateBoundaryCheckProjection,
  sourceRootName: string | undefined,
): string | undefined {
  if (sourceRootName === undefined) {
    return projection.plan.sourceRoot;
  }

  return projection.plan.sourceRoots?.[sourceRootName];
}

function sourceBackedOperationSourceFiles(
  projection: TemplateBoundaryCheckProjection,
  operation: SourceBackedOperation,
): readonly string[] {
  if (operation.kind === "writeTextFromFragments") {
    return operation.fragments.map((fragment) => {
      const root = resolveOperationSourceRoot(projection, fragment.sourceRoot);

      return root === undefined
        ? `missing-source-root:${fragment.sourceRoot}`
        : path.resolve(root, fragment.from);
    });
  }

  const root = resolveOperationSourceRoot(projection, operation.sourceRoot);

  return [
    root === undefined
      ? `missing-source-root:${operation.sourceRoot}`
      : path.resolve(root, operation.from),
  ];
}

function operationUsesManifestReferencedSource(
  projection: TemplateBoundaryCheckProjection,
  operation: SourceBackedOperation,
  manifestReferencedSourceFiles: ReadonlySet<string>,
): boolean {
  return sourceBackedOperationSourceFiles(projection, operation).every(
    (sourceFile) => manifestReferencedSourceFiles.has(sourceFile),
  );
}

function pushSourceBackedOperationViolations(options: {
  readonly projection: TemplateBoundaryCheckProjection;
  readonly sourceFile: ts.SourceFile;
  readonly operation: SourceBackedOperation;
  readonly violations: TemplateBoundaryViolation[];
}): void {
  const generatedPath = operationTarget(options.operation);
  if (generatedPath === undefined) {
    return;
  }

  const owningFunctions = findOwningFunctionsForProtectedOperation(
    options.sourceFile,
    options.operation,
  );

  for (const owningFunction of owningFunctions) {
    options.violations.push({
      preset: options.projection.name,
      generatedPath,
      owningFunction,
      operationKind: options.operation.kind,
      sourceFilePath: options.projection.sourceFilePath,
    });
  }
}

export async function checkTemplateSourceBoundary({
  projections,
  manifestReferencedSourceFiles = [],
  allowlist = [],
}: CheckTemplateSourceBoundaryOptions): Promise<TemplateBoundaryCheckResult> {
  const manifestReferencedSourceFileSet = new Set(
    manifestReferencedSourceFiles.map((sourceFile) => path.resolve(sourceFile)),
  );
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
      if (isProtectedSourceBackedOperation(operation)) {
        if (
          !operationUsesManifestReferencedSource(
            projection,
            operation,
            manifestReferencedSourceFileSet,
          )
        ) {
          pushSourceBackedOperationViolations({
            projection,
            sourceFile,
            operation,
            violations,
          });
        }

        continue;
      }

      if (!isInlineProtectedOperation(operation)) {
        continue;
      }

      if (isStructuredEditorCustomizationOperation(sourceFile, operation)) {
        continue;
      }

      if (isAllowedStructuralMachineDeclaration(sourceFile, operation)) {
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
