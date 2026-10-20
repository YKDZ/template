import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type PlanningRoleRoot = {
  readonly entryFile: string;
  readonly packageRoot: string;
  readonly identity: string;
};

export type PlanningEffectViolation = {
  readonly role: string;
  readonly effect:
    | "filesystem"
    | "process-global"
    | "require"
    | "computed-dynamic-import"
    | "data-as-code";
  readonly file: string;
  readonly line: number;
  readonly column: number;
};

type FilesystemBindings = {
  readonly functions: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
};

type ProcessBindings = {
  readonly namespaces: ReadonlySet<ts.Symbol>;
  readonly values: ReadonlySet<ts.Symbol>;
};

type DataResourceBindings = ReadonlySet<ts.Symbol>;

const publicPlanningContracts = [
  {
    module: "@ykdz/template-core/preset-definition",
    names: new Set(["definePreset", "PresetDefinition"]),
    role: "preset" as const,
  },
  {
    module: "@ykdz/template-workspace-authoring/reference-package",
    names: new Set(["defineReferencePackage", "ReferencePackage"]),
    role: "reference" as const,
  },
  {
    module: "@ykdz/template-core/workspace-strategy",
    names: new Set(["WorkspaceStrategy"]),
    role: "workspace strategy" as const,
  },
];

const filesystemModules = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

function effectDescription(effect: PlanningEffectViolation["effect"]): string {
  const descriptions: Record<PlanningEffectViolation["effect"], string> = {
    filesystem: "规划阶段调用所属包文件系统能力",
    "process-global": "规划阶段读取进程全局状态",
    require: "规划阶段使用 require 加载模块",
    "computed-dynamic-import": "规划阶段使用计算式动态导入",
    "data-as-code": "规划阶段直接消费所属包数据资源",
  };
  return descriptions[effect];
}

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

function processBindings(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ProcessBindings {
  const namespaces = new Set<ts.Symbol>();
  const values = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["process", "node:process"].includes(statement.moduleSpecifier.text) ||
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
      if (symbol !== undefined) values.add(symbol);
    }
  }
  return { namespaces, values };
}

function dataResourceBindings(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): DataResourceBindings {
  const bindings = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      path.posix.extname(
        statement.moduleSpecifier.text.split(/[?#]/, 1)[0] ?? "",
      ) !== ".json" ||
      statement.importClause?.isTypeOnly === true
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      const symbol = bindingSymbol(checker, clause.name);
      if (symbol !== undefined) bindings.add(symbol);
    }
    const namedBindings = clause?.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      const symbol = bindingSymbol(checker, namedBindings.name);
      if (symbol !== undefined) bindings.add(symbol);
      continue;
    }
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const symbol = bindingSymbol(checker, element.name);
      if (symbol !== undefined) bindings.add(symbol);
    }
  }
  return bindings;
}

function isDataResourceExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  importedBindings: DataResourceBindings,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return isDataResourceExpression(
      expression.expression,
      checker,
      importedBindings,
      seen,
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return isDataResourceExpression(
      expression.expression,
      checker,
      importedBindings,
      seen,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return isDataResourceExpression(
      expression.expression,
      checker,
      importedBindings,
      seen,
    );
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined) return false;
  if (importedBindings.has(symbol)) return true;
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isDataResourceExpression(
        declaration.initializer,
        checker,
        importedBindings,
        seen,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isTypeQueryReference(identifier: ts.Identifier): boolean {
  return ts.isTypeQueryNode(identifier.parent);
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
      return symbol === undefined
        ? undefined
        : functionFromSymbol(symbol, checker, seen);
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

function projectPropertySymbols(
  symbol: ts.Symbol,
  role: "preset" | "reference" | "workspace strategy",
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly ts.Symbol[] {
  if (role === "workspace strategy") {
    try {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      const project = checker.getPropertyOfType(type, "project");
      return project === undefined ? [] : [project];
    } catch {
      return [];
    }
  }
  const callable = checker.getTypeOfSymbolAtLocation(
    symbol,
    symbol.valueDeclaration ?? sourceFile,
  );
  const properties: ts.Symbol[] = [];
  for (const signature of checker.getSignaturesOfType(
    callable,
    ts.SignatureKind.Call,
  )) {
    const parameter = signature.getParameters()[0];
    if (parameter === undefined) continue;
    const parameterType = checker.getTypeOfSymbolAtLocation(
      parameter,
      parameter.valueDeclaration ?? sourceFile,
    );
    const project = checker.getPropertyOfType(parameterType, "project");
    if (project !== undefined) properties.push(project);
  }
  return properties;
}

function sameDeclarations(left: ts.Symbol, right: ts.Symbol): boolean {
  const declarations = new Set(
    (left.declarations ?? []).map(
      (declaration) =>
        `${absolute(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`,
    ),
  );
  return (right.declarations ?? []).some((declaration) =>
    declarations.has(
      `${absolute(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`,
    ),
  );
}

function roleKind(
  object: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): "preset" | "reference" | "workspace strategy" | undefined {
  const contextualType = checker.getContextualType(object);
  const project =
    contextualType === undefined
      ? undefined
      : checker.getPropertyOfType(contextualType, "project");
  if (project === undefined) return undefined;

  const sourceFile = object.getSourceFile();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    const candidates: { symbol: ts.Symbol; name: string }[] = [];
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const localSymbol = checker.getSymbolAtLocation(binding.name);
        if (localSymbol === undefined) continue;
        try {
          candidates.push({
            symbol: checker.getAliasedSymbol(localSymbol),
            name: binding.propertyName?.text ?? binding.name.text,
          });
        } catch {
          continue;
        }
      }
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      const localSymbol = checker.getSymbolAtLocation(bindings.name);
      if (localSymbol !== undefined) {
        try {
          const moduleSymbol = checker.getAliasedSymbol(localSymbol);
          for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
            candidates.push({ symbol, name: symbol.getName() });
          }
        } catch {
          continue;
        }
      }
    }
    for (const candidate of candidates) {
      const contract = publicPlanningContracts.find(
        (item) =>
          item.module === moduleSpecifier && item.names.has(candidate.name),
      );
      if (contract === undefined) continue;
      let exportedSymbol = candidate.symbol;
      if ((exportedSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
        try {
          exportedSymbol = checker.getAliasedSymbol(exportedSymbol);
        } catch {
          continue;
        }
      }
      const anchors = projectPropertySymbols(
        exportedSymbol,
        contract.role,
        checker,
        sourceFile,
      );
      if (anchors.some((anchor) => sameDeclarations(anchor, project))) {
        return contract.role;
      }
    }
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
  return isFilesystemFunctionExpression(call.expression, checker, bindings);
}

function isProcessRead(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  bindings: ProcessBindings,
  packageRoot: string,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (
    symbol !== undefined &&
    (bindings.namespaces.has(symbol) || bindings.values.has(symbol))
  ) {
    return true;
  }
  const parent = identifier.parent;
  if (
    parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.name === identifier &&
    ts.isIdentifier(parent.expression) &&
    ["global", "globalThis"].includes(parent.expression.text)
  ) {
    return true;
  }
  if (identifier.text !== "process") return false;
  const isValueReference = !(
    parent !== undefined &&
    ((ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
      (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
      (ts.isParameter(parent) && parent.name === identifier))
  );
  if (!isValueReference) return false;
  const declarations = symbol?.declarations ?? [];
  return !declarations.some((declaration) =>
    isWithin(packageRoot, absolute(declaration.getSourceFile().fileName)),
  );
}

function isRequireExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoot: string,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (expression.text === "require") {
    return !(
      symbol?.declarations?.some((declaration) =>
        isWithin(packageRoot, absolute(declaration.getSourceFile().fileName)),
      ) ?? false
    );
  }
  if (symbol === undefined || seen.has(symbol)) return false;
  seen.add(symbol);
  return (symbol.declarations ?? []).some((declaration) => {
    const initializer =
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)
        ? declaration.initializer
        : undefined;
    return (
      initializer !== undefined &&
      isRequireExpression(initializer, checker, packageRoot, seen)
    );
  });
}

function isComputedDynamicImport(call: ts.CallExpression): boolean {
  if (
    call.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    call.arguments.length === 0
  ) {
    return false;
  }
  const specifier = call.arguments[0]!;
  return (
    !ts.isStringLiteral(specifier) &&
    !ts.isNoSubstitutionTemplateLiteral(specifier)
  );
}

function isFilesystemFunctionExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: FilesystemBindings,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol === undefined || seen.has(symbol)) return false;
    if (bindings.functions.has(symbol)) return true;
    seen.add(symbol);
    return (symbol.declarations ?? []).some((declaration) => {
      const initializer =
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration)
          ? declaration.initializer
          : undefined;
      return (
        initializer !== undefined &&
        isFilesystemFunctionExpression(initializer, checker, bindings, seen)
      );
    });
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const receiver = expression.expression;
    if (isFilesystemNamespaceExpression(receiver, checker, bindings)) {
      return true;
    }
  }
  return false;
}

function isFilesystemNamespaceExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: FilesystemBindings,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol === undefined || seen.has(symbol)) return false;
    if (bindings.namespaces.has(symbol)) return true;
    seen.add(symbol);
    return (symbol.declarations ?? []).some((declaration) => {
      const initializer =
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration)
          ? declaration.initializer
          : undefined;
      return (
        initializer !== undefined &&
        isFilesystemNamespaceExpression(initializer, checker, bindings, seen)
      );
    });
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "promises" &&
    isFilesystemNamespaceExpression(
      expression.expression,
      checker,
      bindings,
      seen,
    )
  );
}

function plannerCallbacks(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  root: PlanningRoleRoot,
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
        const kind = roleKind(node, checker);
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
  processesByFile: ReadonlyMap<string, ProcessBindings>,
  dataBindingsByFile: ReadonlyMap<string, DataResourceBindings>,
): PlanningEffectViolation[] {
  const violations: PlanningEffectViolation[] = [];
  const visited = new Set<ts.FunctionLikeDeclaration>();
  const pending = [callback];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const sourceFile = current.getSourceFile();
    const imports = importsByFile.get(absolute(sourceFile.fileName));
    const processes = processesByFile.get(absolute(sourceFile.fileName));
    const dataBindings = dataBindingsByFile.get(absolute(sourceFile.fileName));
    const body = current.body;
    if (
      body === undefined ||
      imports === undefined ||
      processes === undefined ||
      dataBindings === undefined
    ) {
      continue;
    }
    const report = (
      node: ts.Node,
      effect: PlanningEffectViolation["effect"],
    ): void => {
      const start = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        role,
        effect,
        file: absolute(sourceFile.fileName),
        line: start.line + 1,
        column: start.character + 1,
      });
    };
    const scan = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (
        ts.isIdentifier(node) &&
        isProcessRead(node, checker, processes, absolute(root.packageRoot))
      ) {
        report(node, "process-global");
      }
      if (
        ts.isIdentifier(node) &&
        !isTypeQueryReference(node) &&
        isDataResourceExpression(node, checker, dataBindings)
      ) {
        report(node, "data-as-code");
      }
      if (ts.isCallExpression(node)) {
        if (isFilesystemCall(node, checker, imports)) {
          report(node, "filesystem");
        }
        if (
          isRequireExpression(
            node.expression,
            checker,
            absolute(root.packageRoot),
          )
        ) {
          report(node, "require");
        }
        if (isComputedDynamicImport(node)) {
          report(node, "computed-dynamic-import");
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
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          [
            "every",
            "filter",
            "find",
            "flatMap",
            "forEach",
            "map",
            "some",
          ].includes(node.expression.name.text)
        ) {
          for (const argument of node.arguments) {
            if (
              ts.isArrowFunction(argument) ||
              ts.isFunctionExpression(argument)
            ) {
              pending.push(argument);
            }
          }
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(body);
  }
  return violations;
}

function parsedConfiguration(configPath: string): ts.ParsedCommandLine {
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
  return parsed;
}

function compilerOptionsFromConfig(configPath: string): ts.CompilerOptions {
  return parsedConfiguration(configPath).options;
}

function productionSourceFiles(root: PlanningRoleRoot): readonly string[] {
  const manifestPath = path.join(root.packageRoot, "package.json");
  const manifestText = ts.sys.readFile(manifestPath);
  if (manifestText === undefined) return [root.entryFile];
  const manifest = JSON.parse(manifestText) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  const configurations = new Set([
    path.join(root.packageRoot, "tsconfig.template.json"),
    path.join(root.packageRoot, "tsconfig.build.json"),
  ]);
  for (const scriptName of ["build:template", "build"]) {
    const script = manifest.scripts?.[scriptName];
    if (typeof script !== "string") continue;
    for (const match of script.matchAll(/\btsc\s+-p\s+["']?([^"'&;\s]+)/gu)) {
      const config = match[1];
      if (config !== undefined) {
        configurations.add(path.resolve(root.packageRoot, config));
      }
    }
  }

  const files = new Set<string>([root.entryFile]);
  for (const configPath of configurations) {
    if (!ts.sys.fileExists(configPath)) continue;
    const parsed = parsedConfiguration(configPath);
    if (
      !parsed.fileNames.some(
        (fileName) => absolute(fileName) === root.entryFile,
      )
    ) {
      continue;
    }
    for (const fileName of parsed.fileNames) {
      const absoluteFile = absolute(fileName);
      if (isWithin(root.packageRoot, absoluteFile)) files.add(absoluteFile);
    }
  }
  return [...files];
}

export function findPlanningEffectViolations(
  roots: readonly PlanningRoleRoot[],
  configPath: string,
): readonly PlanningEffectViolation[] {
  const normalizedRoots = roots.map((root) => ({
    entryFile: absolute(root.entryFile),
    packageRoot: absolute(root.packageRoot),
    identity: root.identity,
  }));
  const rootNames = new Set<string>();
  for (const root of normalizedRoots) {
    for (const fileName of productionSourceFiles(root)) rootNames.add(fileName);
  }
  const program = ts.createProgram({
    rootNames: [...rootNames],
    options: compilerOptionsFromConfig(absolute(configPath)),
  });
  const checker = program.getTypeChecker();
  const importsByFile = new Map<string, FilesystemBindings>();
  const processesByFile = new Map<string, ProcessBindings>();
  const dataBindingsByFile = new Map<string, DataResourceBindings>();
  for (const sourceFile of program.getSourceFiles()) {
    importsByFile.set(
      absolute(sourceFile.fileName),
      filesystemBindings(sourceFile, checker),
    );
    processesByFile.set(
      absolute(sourceFile.fileName),
      processBindings(sourceFile, checker),
    );
    dataBindingsByFile.set(
      absolute(sourceFile.fileName),
      dataResourceBindings(sourceFile, checker),
    );
  }

  const violations: PlanningEffectViolation[] = [];
  for (const root of normalizedRoots) {
    for (const sourceFile of program.getSourceFiles()) {
      if (!isWithin(root.packageRoot, absolute(sourceFile.fileName))) continue;
      for (const { callback, role } of plannerCallbacks(
        sourceFile,
        checker,
        root,
      )) {
        violations.push(
          ...diagnosticsForRole(
            callback,
            role,
            root,
            checker,
            importsByFile,
            processesByFile,
            dataBindingsByFile,
          ),
        );
      }
    }
  }
  const unique = new Map<string, PlanningEffectViolation>();
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
      // 沿父目录继续查找公开模块所属包清单。
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`公开模块没有所属包清单：${entryFile}`);
    }
    directory = parent;
  }
}

export async function runAuthorPlanningRoleCheck(
  ownerDirectory?: string,
): Promise<void> {
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

  if (ownerDirectory !== undefined) {
    const selectedDirectory = absolute(ownerDirectory);
    const selectedRoots = roots.filter(
      (root) => absolute(root.packageRoot) === selectedDirectory,
    );
    if (selectedRoots.length === 0) {
      throw new Error(`此包未通过公开入口登记规划角色：${selectedDirectory}`);
    }
    roots.splice(0, roots.length, ...selectedRoots);
  }

  const configPath = path.resolve("tsconfig.json");
  const violations = findPlanningEffectViolations(roots, configPath);
  if (violations.length === 0) return;
  for (const violation of violations) {
    const relativeFile = path.relative(
      path.dirname(configPath),
      violation.file,
    );
    process.stderr.write(
      `${effectDescription(violation.effect)}：${violation.role}：${relativeFile}:${violation.line}:${violation.column}\n`,
    );
  }
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  absolute(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const ownerDirectoryIndex = process.argv.indexOf("--owner-directory");
  const ownerDirectory =
    ownerDirectoryIndex === -1
      ? undefined
      : process.argv[ownerDirectoryIndex + 1];
  if (ownerDirectoryIndex !== -1 && ownerDirectory === undefined) {
    throw new Error("--owner-directory 缺少包目录");
  }
  await runAuthorPlanningRoleCheck(ownerDirectory);
}
