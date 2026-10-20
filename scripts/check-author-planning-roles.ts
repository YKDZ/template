import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type PlanningRoleRoot = {
  readonly entryFile: string;
  readonly packageRoot: string;
  readonly identity: string;
};

export type PlanningIoViolation = {
  readonly role: string;
  readonly effect: "filesystem";
  readonly file: string;
  readonly line: number;
  readonly column: number;
};

type FilesystemBindings = {
  readonly functions: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
};

const filesystemModules = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

function absolute(file: string): string {
  return path.resolve(file);
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function bindingSymbol(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(identifier);
}

function filesystemBindings(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): FilesystemBindings {
  const functions = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !filesystemModules.has(statement.moduleSpecifier.text) ||
      statement.importClause?.isTypeOnly === true
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      const symbol = bindingSymbol(checker, clause.name);
      if (symbol !== undefined) namespaces.add(symbol);
    }
    const bindings = clause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      const symbol = bindingSymbol(checker, bindings.name);
      if (symbol !== undefined) namespaces.add(symbol);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const symbol = bindingSymbol(checker, element.name);
      if (symbol === undefined) continue;
      if (
        element.propertyName?.text === "promises" ||
        element.name.text === "promises"
      ) {
        namespaces.add(symbol);
      } else {
        functions.add(symbol);
      }
    }
  }
  return { functions, namespaces };
}

function functionFromDeclaration(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.FunctionLikeDeclaration | undefined {
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)) &&
    declaration.body !== undefined
  ) {
    return declaration;
  }
  const initializer =
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration)
      ? declaration.initializer
      : undefined;
  if (initializer !== undefined) {
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) {
      return initializer;
    }
    if (ts.isIdentifier(initializer)) {
      const symbol = checker.getSymbolAtLocation(initializer);
      if (symbol === undefined || seen.has(symbol)) return undefined;
      seen.add(symbol);
      return functionFromSymbol(symbol, checker, seen);
    }
  }
  return undefined;
}

function functionFromSymbol(
  original: ts.Symbol,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.FunctionLikeDeclaration | undefined {
  let symbol = original;
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  for (const declaration of symbol.declarations ?? []) {
    const result = functionFromDeclaration(declaration, checker, seen);
    if (result !== undefined) return result;
  }
  return undefined;
}

function callbackFunction(
  member: ts.ObjectLiteralElementLike,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(member)) {
    return member.body === undefined ? undefined : member;
  }
  if (!ts.isPropertyAssignment(member)) return undefined;
  const value = member.initializer;
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  const symbol = checker.getSymbolAtLocation(value);
  return symbol === undefined ? undefined : functionFromSymbol(symbol, checker);
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function roleKind(
  object: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  contractsRoot: string,
): "preset" | "reference" | "workspace strategy" | undefined {
  const contextualType = checker.getContextualType(object);
  const project =
    contextualType === undefined
      ? undefined
      : checker.getPropertyOfType(contextualType, "project");
  const declaration = project?.declarations?.[0];
  if (declaration === undefined) return undefined;
  const contractFile = absolute(declaration.getSourceFile().fileName);
  if (
    contractFile ===
    path.join(contractsRoot, "packages/core/src/preset-definition.ts")
  ) {
    return "preset";
  }
  if (
    contractFile ===
    path.join(
      contractsRoot,
      "packages/workspace-authoring/src/reference-package.ts",
    )
  ) {
    return "reference";
  }
  if (
    contractFile ===
    path.join(contractsRoot, "packages/core/src/workspace-strategy.ts")
  ) {
    return "workspace strategy";
  }
  return undefined;
}

function functionTargets(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly ts.FunctionLikeDeclaration[] {
  const symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol === undefined) return [];
  const target = functionFromSymbol(symbol, checker);
  return target === undefined ? [] : [target];
}

function isFilesystemCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  bindings: FilesystemBindings,
): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol !== undefined && bindings.functions.has(symbol);
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const receiver = expression.expression;
    if (!ts.isIdentifier(receiver)) return false;
    const symbol = checker.getSymbolAtLocation(receiver);
    return symbol !== undefined && bindings.namespaces.has(symbol);
  }
  return false;
}

function plannerCallbacks(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  root: PlanningRoleRoot,
  contractsRoot: string,
): readonly {
  readonly callback: ts.FunctionLikeDeclaration;
  readonly role: string;
}[] {
  const callbacks: { callback: ts.FunctionLikeDeclaration; role: string }[] =
    [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const projectMember = node.properties.find(
        (member) =>
          member.name !== undefined &&
          propertyNameText(member.name) === "project",
      );
      if (projectMember !== undefined) {
        const kind = roleKind(node, checker, contractsRoot);
        const callback = callbackFunction(projectMember, checker);
        if (kind !== undefined && callback !== undefined) {
          callbacks.push({
            callback,
            role: `${root.identity}:${kind}.project`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callbacks;
}

function diagnosticsForRole(
  callback: ts.FunctionLikeDeclaration,
  role: string,
  root: PlanningRoleRoot,
  checker: ts.TypeChecker,
  importsByFile: ReadonlyMap<string, FilesystemBindings>,
): PlanningIoViolation[] {
  const violations: PlanningIoViolation[] = [];
  const visited = new Set<ts.FunctionLikeDeclaration>();
  const pending = [callback];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const sourceFile = current.getSourceFile();
    const imports = importsByFile.get(absolute(sourceFile.fileName));
    const body = current.body;
    if (body === undefined || imports === undefined) continue;
    const scan = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        if (isFilesystemCall(node, checker, imports)) {
          const start = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          violations.push({
            role,
            effect: "filesystem",
            file: absolute(sourceFile.fileName),
            line: start.line + 1,
            column: start.character + 1,
          });
        }
        for (const target of functionTargets(node, checker)) {
          if (
            isWithin(
              absolute(root.packageRoot),
              absolute(target.getSourceFile().fileName),
            )
          ) {
            pending.push(target);
          }
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(body);
  }
  return violations;
}

function compilerOptionsFromConfig(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (configFile.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    { noEmit: true },
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  return parsed.options;
}

export function findPlanningIoViolations(
  roots: readonly PlanningRoleRoot[],
  configPath: string,
): readonly PlanningIoViolation[] {
  const normalizedRoots = roots.map((root) => ({
    entryFile: absolute(root.entryFile),
    packageRoot: absolute(root.packageRoot),
    identity: root.identity,
  }));
  const program = ts.createProgram({
    rootNames: normalizedRoots.map((root) => root.entryFile),
    options: compilerOptionsFromConfig(absolute(configPath)),
  });
  const checker = program.getTypeChecker();
  const contractsRoot = path.dirname(absolute(configPath));
  const importsByFile = new Map<string, FilesystemBindings>();
  for (const sourceFile of program.getSourceFiles()) {
    importsByFile.set(
      absolute(sourceFile.fileName),
      filesystemBindings(sourceFile, checker),
    );
  }

  const violations: PlanningIoViolation[] = [];
  for (const root of normalizedRoots) {
    for (const sourceFile of program.getSourceFiles()) {
      if (!isWithin(root.packageRoot, absolute(sourceFile.fileName))) continue;
      for (const { callback, role } of plannerCallbacks(
        sourceFile,
        checker,
        root,
        contractsRoot,
      )) {
        violations.push(
          ...diagnosticsForRole(callback, role, root, checker, importsByFile),
        );
      }
    }
  }
  const unique = new Map<string, PlanningIoViolation>();
  for (const violation of violations) {
    const key = `${violation.role}\u0000${violation.file}\u0000${violation.line}\u0000${violation.column}\u0000${violation.effect}`;
    unique.set(key, violation);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.role.localeCompare(right.role),
  );
}

async function packageRootFor(entryFile: string): Promise<string> {
  let directory = path.dirname(entryFile);
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ) as { readonly name?: unknown };
      if (typeof manifest.name === "string") return directory;
    } catch {
      // Continue to the next parent while resolving a public module owner.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`公开模块没有所属包清单：${entryFile}`);
    }
    directory = parent;
  }
}

export async function runAuthorPlanningRoleCheck(): Promise<void> {
  const { templateContent } = await import("@ykdz/template-content");
  const roots: PlanningRoleRoot[] = await Promise.all(
    templateContent.map(async (member) => ({
      entryFile: fileURLToPath(member.source.moduleURL),
      packageRoot: path.dirname(fileURLToPath(member.source.manifestURL)),
      identity: `${member.identity.namespace}:${member.identity.packageName}#${member.identity.exportPath}`,
    })),
  );
  const strategyEntry = fileURLToPath(
    import.meta.resolve("@ykdz/template-workspace/default-workspace-strategy"),
  );
  const strategyPackageRoot = await packageRootFor(strategyEntry);
  roots.push({
    entryFile: strategyEntry,
    packageRoot: strategyPackageRoot,
    identity: "@ykdz/template-workspace#./default-workspace-strategy",
  });

  const configPath = path.resolve("tsconfig.json");
  const violations = findPlanningIoViolations(roots, configPath);
  if (violations.length === 0) return;
  for (const violation of violations) {
    const relativeFile = path.relative(
      path.dirname(configPath),
      violation.file,
    );
    process.stderr.write(
      `规划角色 ${violation.role} 调用了所属包文件系统能力：${relativeFile}:${violation.line}:${violation.column}\n`,
    );
  }
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  absolute(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runAuthorPlanningRoleCheck();
}
