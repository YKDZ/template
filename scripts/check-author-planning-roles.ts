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
    | "computed-dynamic-import";
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

type PlanningRole = "preset" | "reference" | "composition";

type PlanningRoleContract = {
  readonly module: string;
  readonly names: ReadonlySet<string>;
  readonly role: PlanningRole;
  readonly members: readonly string[];
};

const publicPlanningContracts: readonly PlanningRoleContract[] = [
  {
    module: "@ykdz/template-workspace/reference-package",
    names: new Set(["defineReferencePackage"]),
    role: "reference" as const,
    members: ["transformManifest", "transformDocument"],
  },
  {
    module: "@ykdz/template-core/reference-package",
    names: new Set(["ReferencePackageDefinition"]),
    role: "reference" as const,
    members: ["parseCreationInput", "createDefinition", "evaluate"],
  },
  {
    module: "@ykdz/template-workspace/default-composition",
    names: new Set(["DefaultPresetRootContributionOwner"]),
    role: "preset" as const,
    members: ["compose"],
  },
  {
    module: "@ykdz/template-core/composition",
    names: new Set(["Composition"]),
    role: "composition" as const,
    members: ["resolve", "combine"],
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

function planningPropertySymbols(
  symbol: ts.Symbol,
  contract: PlanningRoleContract,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.Symbol> {
  const properties = new Map<string, ts.Symbol>();
  const addProperties = (type: ts.Type): void => {
    for (const name of contract.members) {
      const property = checker.getPropertyOfType(type, name);
      if (property !== undefined) properties.set(name, property);
    }
  };
  if ((symbol.flags & ts.SymbolFlags.Type) !== 0) {
    try {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      addProperties(type);
    } catch {
      return properties;
    }
    return properties;
  }
  const callable = checker.getTypeOfSymbolAtLocation(
    symbol,
    symbol.valueDeclaration ?? sourceFile,
  );
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
    addProperties(parameterType);
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
  memberName: string,
  checker: ts.TypeChecker,
): PlanningRole | undefined {
  const contextualType = checker.getContextualType(object);
  const member =
    contextualType === undefined
      ? undefined
      : checker.getPropertyOfType(contextualType, memberName);
  if (member === undefined) return undefined;

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
          item.module === moduleSpecifier &&
          item.names.has(candidate.name) &&
          item.members.includes(memberName),
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
      const anchors = planningPropertySymbols(
        exportedSymbol,
        contract,
        checker,
        sourceFile,
      );
      const anchor = anchors.get(memberName);
      if (anchor !== undefined && sameDeclarations(anchor, member)) {
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
      for (const member of node.properties) {
        const memberName =
          member.name === undefined ? undefined : propertyNameText(member.name);
        if (memberName === undefined) continue;
        const kind = roleKind(node, memberName, checker);
        const callback = callbackFunction(member, checker);
        if (kind !== undefined && callback !== undefined) {
          callbacks.push({
            callback,
            role: `${root.identity}:${kind}.${memberName}`,
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
    const body = current.body;
    if (
      body === undefined ||
      imports === undefined ||
      processes === undefined
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
  for (const sourceFile of program.getSourceFiles()) {
    importsByFile.set(
      absolute(sourceFile.fileName),
      filesystemBindings(sourceFile, checker),
    );
    processesByFile.set(
      absolute(sourceFile.fileName),
      processBindings(sourceFile, checker),
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
  const compositionEntry = fileURLToPath(
    import.meta.resolve("@ykdz/template-workspace/default-composition"),
  );
  const compositionPackageRoot = await packageRootFor(compositionEntry);
  roots.push({
    entryFile: compositionEntry,
    packageRoot: compositionPackageRoot,
    identity: "@ykdz/template-workspace#./default-composition",
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

  const configPath = path.resolve("tsconfig.config.json");
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
