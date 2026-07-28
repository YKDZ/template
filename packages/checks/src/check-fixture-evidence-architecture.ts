#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export type FixtureEvidenceArchitectureFinding = {
  readonly rule:
    | "cross-gate-runtime-import"
    | "gate-runtime-import-outside-contract"
    | "kernel-runtime-import-outside-kernel"
    | "production-test-source"
    | "hidden-root-quality-command"
    | "hidden-focused-package-link-command"
    | "hidden-deployment-quality-command"
    | "unassigned-orchestrator-command";
  readonly file: string;
  readonly detail: string;
};

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (/\.[cm]?tsx?$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  await visit(root);
  return files.sort();
}

type RuntimeModuleReference = {
  readonly specifier?: string;
  readonly syntax: "dynamic import" | "import" | "export" | "require";
};

type ModuleLoaderKind = "create-require" | "require";

function importedCreateRequireBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:module"
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === "createRequire") {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function moduleLoaderKind(
  expression: ts.Expression,
  bindings: StaticBindings,
  createRequireBindings: ReadonlySet<string>,
  resolving: ReadonlySet<string> = new Set(),
): ModuleLoaderKind | undefined {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    if (value.text === "require") return "require";
    if (createRequireBindings.has(value.text)) return "create-require";
    if (resolving.has(value.text)) return undefined;
    const initializer = bindings.get(value.text);
    if (initializer === undefined) return undefined;
    return moduleLoaderKind(
      initializer,
      bindings,
      createRequireBindings,
      new Set([...resolving, value.text]),
    );
  }
  if (ts.isCallExpression(value)) {
    return moduleLoaderKind(
      value.expression,
      bindings,
      createRequireBindings,
      resolving,
    ) === "create-require"
      ? "require"
      : undefined;
  }
  if (
    ts.isPropertyAccessExpression(value) &&
    value.name.text === "require" &&
    moduleLoaderKind(
      value.expression,
      bindings,
      createRequireBindings,
      resolving,
    ) === "require"
  ) {
    return "require";
  }
  return undefined;
}

function runtimeModuleReferences(
  sourceFile: ts.SourceFile,
): readonly RuntimeModuleReference[] {
  const references: RuntimeModuleReference[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const namedImports =
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings
          : undefined;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          namedImports !== undefined &&
          namedImports.elements.every((element) => element.isTypeOnly));
      if (!typeOnly && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        references.push({
          specifier: statement.moduleSpecifier.text,
          syntax: "import",
        });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      references.push({
        specifier: statement.moduleSpecifier.text,
        syntax: "export",
      });
    }
  }
  const bindings = staticBindings(sourceFile);
  const createRequireBindings = importedCreateRequireBindings(sourceFile);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      const specifier =
        argument === undefined ? undefined : staticString(argument, bindings);
      references.push({
        ...(specifier === undefined ? {} : { specifier }),
        syntax: "dynamic import",
      });
    } else if (
      ts.isCallExpression(node) &&
      moduleLoaderKind(node.expression, bindings, createRequireBindings) ===
        "require"
    ) {
      const argument = node.arguments[0];
      const specifier =
        argument === undefined ? undefined : staticString(argument, bindings);
      references.push({
        ...(specifier === undefined ? {} : { specifier }),
        syntax: "require",
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

function isRepositoryInternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("#") ||
    specifier === "@ykdz/template" ||
    specifier.startsWith("@ykdz/template-")
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

type StaticBindings = ReadonlyMap<string, ts.Expression>;

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function staticString(
  expression: ts.Expression,
  bindings: StaticBindings,
  resolving: ReadonlySet<string> = new Set(),
): string | undefined {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(value.left, bindings, resolving);
    const right = staticString(value.right, bindings, resolving);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`;
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text;
    for (const span of value.templateSpans) {
      const member = staticString(span.expression, bindings, resolving);
      if (member === undefined) return undefined;
      result += member + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(value) && !resolving.has(value.text)) {
    const initializer = bindings.get(value.text);
    if (initializer === undefined) return undefined;
    return staticString(
      initializer,
      bindings,
      new Set([...resolving, value.text]),
    );
  }
  return undefined;
}

function staticStringArray(
  expression: ts.Expression,
  bindings: StaticBindings,
  resolving: ReadonlySet<string> = new Set(),
): readonly string[] | undefined {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value) && !resolving.has(value.text)) {
    const initializer = bindings.get(value.text);
    if (initializer === undefined) return undefined;
    return staticStringArray(
      initializer,
      bindings,
      new Set([...resolving, value.text]),
    );
  }
  if (!ts.isArrayLiteralExpression(value)) return undefined;
  const result: string[] = [];
  for (const element of value.elements) {
    if (ts.isSpreadElement(element)) {
      const members = staticStringArray(
        element.expression,
        bindings,
        resolving,
      );
      if (members === undefined) return undefined;
      result.push(...members);
      continue;
    }
    const member = staticString(element, bindings, resolving);
    if (member === undefined) return undefined;
    result.push(member);
  }
  return result;
}

function staticBindings(sourceFile: ts.SourceFile): StaticBindings {
  const candidates = new Map<string, ts.Expression | undefined>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      candidates.set(
        node.name.text,
        candidates.has(node.name.text) ? undefined : node.initializer,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return new Map(
    [...candidates].flatMap(([name, expression]) =>
      expression === undefined ? [] : [[name, expression] as const],
    ),
  );
}

type OwnedCommand =
  | {
      readonly owner: "root" | "focused" | "deployment";
      readonly command: string;
      readonly args: readonly string[];
      readonly call: ts.CallExpression;
    }
  | {
      readonly owner: "unassigned";
      readonly command?: string;
      readonly args?: readonly string[];
      readonly call: ts.CallExpression;
    };

function isGeneratedCommandRunnerType(type: ts.TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "GeneratedCommandRunner"
  );
}

function typeOwnsGeneratedCommandRunner(
  type: ts.TypeNode | undefined,
): boolean {
  if (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "GeneratedScenarioRunOptions"
  ) {
    return true;
  }
  if (type === undefined || !ts.isTypeLiteralNode(type)) return false;
  return type.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name !== undefined &&
      ((ts.isIdentifier(member.name) && member.name.text === "run") ||
        (ts.isStringLiteralLike(member.name) && member.name.text === "run")) &&
      isGeneratedCommandRunnerType(member.type),
  );
}

function explicitCommandRunnerBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const runners = new Set<string>();
  const runnerOwners = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "run" ||
        node.name.text.endsWith("Runner") ||
        isGeneratedCommandRunnerType(node.type))
    ) {
      runners.add(node.name.text);
    }
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      typeOwnsGeneratedCommandRunner(node.type)
    ) {
      runnerOwners.add(node.name.text);
    }
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === "execa"
    ) {
      runners.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  function visitAliases(node: ts.Node): void {
    const initializer =
      ts.isVariableDeclaration(node) && node.initializer !== undefined
        ? unwrapExpression(node.initializer)
        : undefined;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      initializer !== undefined &&
      ts.isIdentifier(initializer) &&
      runnerOwners.has(initializer.text)
    ) {
      for (const element of node.name.elements) {
        const propertyName = element.propertyName ?? element.name;
        if (
          ((ts.isIdentifier(propertyName) && propertyName.text === "run") ||
            (ts.isStringLiteralLike(propertyName) &&
              propertyName.text === "run")) &&
          ts.isIdentifier(element.name)
        ) {
          runners.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visitAliases);
  }
  visitAliases(sourceFile);
  runners.add("execa");
  return runners;
}

function isCommandRunnerExpression(
  expression: ts.Expression,
  bindings: StaticBindings,
  explicitRunners: ReadonlySet<string>,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    if (
      explicitRunners.has(value.text) ||
      value.text === "run" ||
      value.text.endsWith("Runner")
    ) {
      return true;
    }
    if (resolving.has(value.text)) return false;
    const initializer = bindings.get(value.text);
    return (
      initializer !== undefined &&
      isCommandRunnerExpression(
        initializer,
        bindings,
        explicitRunners,
        new Set([...resolving, value.text]),
      )
    );
  }
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    const owner = unwrapExpression(value.expression);
    const name = ts.isPropertyAccessExpression(value)
      ? value.name.text
      : value.argumentExpression === undefined
        ? undefined
        : staticString(value.argumentExpression, bindings);
    return ts.isIdentifier(owner) && owner.text === "options" && name === "run";
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      isCommandRunnerExpression(
        value.left,
        bindings,
        explicitRunners,
        resolving,
      ) ||
      isCommandRunnerExpression(
        value.right,
        bindings,
        explicitRunners,
        resolving,
      )
    );
  }
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    let wrapsRunner = false;
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        isCommandRunnerExpression(
          node.expression,
          bindings,
          explicitRunners,
          resolving,
        )
      ) {
        wrapsRunner = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(value.body);
    return wrapsRunner;
  }
  return false;
}

function isForwardingCommandRunnerCall(
  call: ts.CallExpression,
  bindings: StaticBindings,
  explicitRunners: ReadonlySet<string>,
): boolean {
  let current: ts.Node | undefined = call.parent;
  while (current !== undefined && !ts.isFunctionLike(current)) {
    current = current.parent;
  }
  if (current === undefined || !ts.isFunctionLike(current)) return false;
  const ownsCommandRunner =
    ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      isCommandRunnerExpression(current, bindings, explicitRunners)) ||
    (ts.isFunctionDeclaration(current) &&
      current.name !== undefined &&
      explicitRunners.has(current.name.text));
  if (!ownsCommandRunner) return false;
  const commandParameter = current.parameters[0]?.name;
  const argsParameter = current.parameters[1]?.name;
  if (
    commandParameter === undefined ||
    argsParameter === undefined ||
    !ts.isIdentifier(commandParameter) ||
    !ts.isIdentifier(argsParameter)
  ) {
    return false;
  }
  const command = call.arguments[0];
  const args = call.arguments[1];
  const unwrappedCommand =
    command === undefined ? undefined : unwrapExpression(command);
  if (
    unwrappedCommand === undefined ||
    args === undefined ||
    !ts.isIdentifier(unwrappedCommand) ||
    unwrappedCommand.text !== commandParameter.text
  ) {
    return false;
  }
  const unwrappedArgs = unwrapExpression(args);
  if (ts.isIdentifier(unwrappedArgs)) {
    return unwrappedArgs.text === argsParameter.text;
  }
  const spreadExpression =
    ts.isArrayLiteralExpression(unwrappedArgs) &&
    unwrappedArgs.elements.length === 1 &&
    ts.isSpreadElement(unwrappedArgs.elements[0]!)
      ? unwrapExpression(unwrappedArgs.elements[0]!.expression)
      : undefined;
  return (
    spreadExpression !== undefined &&
    ts.isIdentifier(spreadExpression) &&
    spreadExpression.text === argsParameter.text
  );
}

function rootQualityCommand(command: string, args: readonly string[]): boolean {
  if (command !== "pnpm") return false;
  if (args[0] === "install") return true;
  if (args[0] === "run" && (args[1] === "check" || args[1] === "fix")) {
    return true;
  }
  const qualityTasks = new Set([
    "boundaries",
    "format:check",
    "format:write",
    "lint",
    "lint:fix",
    "typecheck",
    "build",
    "test",
    "test:e2e",
  ]);
  return (
    args[0] === "exec" &&
    args[1] === "turbo" &&
    args[2] === "run" &&
    args.slice(3).some((argument) => qualityTasks.has(argument))
  );
}

function focusedPackageLinkCommand(
  command: string,
  args: readonly string[],
): boolean {
  if (command === "node") {
    return args.includes("--conditions=source");
  }
  return (
    command === "pnpm" &&
    args[0] === "exec" &&
    args[1] === "turbo" &&
    args[2] === "run" &&
    args[3] === "build" &&
    args.includes("--force") &&
    args.filter((argument) => argument.startsWith("--filter=")).length >= 2
  );
}

function deploymentQualityCommand(
  command: string,
  args: readonly string[],
): boolean {
  if (command === "docker") return true;
  if (command !== "pnpm") return false;
  if (args[0] === "run" && args[1] === "check:deployment") return true;
  return (
    args[0] === "exec" &&
    args[1] === "turbo" &&
    args[2] === "run" &&
    args[3] === "deployment"
  );
}

function ownedCommands(sourceFile: ts.SourceFile): readonly OwnedCommand[] {
  const commands: OwnedCommand[] = [];
  const bindings = staticBindings(sourceFile);
  const explicitRunners = explicitCommandRunnerBindings(sourceFile);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      isCommandRunnerExpression(node.expression, bindings, explicitRunners)
    ) {
      const command =
        node.arguments[0] === undefined
          ? undefined
          : staticString(node.arguments[0], bindings);
      const args =
        node.arguments[1] === undefined
          ? undefined
          : staticStringArray(node.arguments[1], bindings);
      if (command !== undefined && args !== undefined) {
        if (rootQualityCommand(command, args)) {
          commands.push({ owner: "root", command, args, call: node });
        } else if (focusedPackageLinkCommand(command, args)) {
          commands.push({ owner: "focused", command, args, call: node });
        } else if (deploymentQualityCommand(command, args)) {
          commands.push({ owner: "deployment", command, args, call: node });
        }
      } else if (
        !isForwardingCommandRunnerCall(node, bindings, explicitRunners)
      ) {
        commands.push({
          owner: "unassigned",
          ...(command === undefined ? {} : { command }),
          ...(args === undefined ? {} : { args }),
          call: node,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return commands;
}

export async function findFixtureEvidenceArchitectureFindings(
  repositoryRoot: string = defaultRepositoryRoot,
): Promise<readonly FixtureEvidenceArchitectureFinding[]> {
  const findings: FixtureEvidenceArchitectureFinding[] = [];
  const evidenceRoot = path.join(
    repositoryRoot,
    "packages/checks/src/fixture-evidence",
  );
  const gatesRoot = path.join(evidenceRoot, "gates");
  const kernelRoot = path.join(evidenceRoot, "kernel");
  const productionFiles = await sourceFiles(evidenceRoot);

  for (const file of productionFiles) {
    const relativeFile = path
      .relative(repositoryRoot, file)
      .split(path.sep)
      .join("/");
    if (/(?:^|\/)[^/]+\.test\.[cm]?tsx?$/u.test(relativeFile)) {
      findings.push({
        rule: "production-test-source",
        file: relativeFile,
        detail: "test source is inside a production contract projection",
      });
    }
    if (isInside(kernelRoot, file)) {
      const source = await readFile(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const { specifier, syntax } of runtimeModuleReferences(sourceFile)) {
        if (specifier === undefined) {
          findings.push({
            rule: "kernel-runtime-import-outside-kernel",
            file: relativeFile,
            detail: `kernel ${syntax} target cannot be assigned to its contract projection`,
          });
          continue;
        }
        if (!specifier.startsWith(".")) {
          if (isRepositoryInternalSpecifier(specifier)) {
            findings.push({
              rule: "kernel-runtime-import-outside-kernel",
              file: relativeFile,
              detail: `kernel runtime import ${specifier} leaves its contract projection`,
            });
          }
          continue;
        }
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isInside(kernelRoot, resolved)) {
          findings.push({
            rule: "kernel-runtime-import-outside-kernel",
            file: relativeFile,
            detail: `kernel runtime import ${specifier} leaves its contract projection`,
          });
        }
      }
      continue;
    }
    if (!isInside(gatesRoot, file)) {
      continue;
    }
    const relativeToGates = path.relative(gatesRoot, file);
    const owner = relativeToGates.split(path.sep)[0];
    if (owner === undefined) continue;
    const ownerRoot = path.join(gatesRoot, owner);
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const { specifier, syntax } of runtimeModuleReferences(sourceFile)) {
      if (specifier === undefined) {
        findings.push({
          rule: "gate-runtime-import-outside-contract",
          file: relativeFile,
          detail: `${owner} ${syntax} target cannot be assigned to its gate or kernel`,
        });
        continue;
      }
      if (!specifier.startsWith(".")) {
        if (isRepositoryInternalSpecifier(specifier)) {
          findings.push({
            rule: "gate-runtime-import-outside-contract",
            file: relativeFile,
            detail: `${owner} runtime import ${specifier} is outside its gate and kernel`,
          });
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (isInside(ownerRoot, resolved) || isInside(kernelRoot, resolved)) {
        continue;
      }
      if (isInside(gatesRoot, resolved)) {
        const targetOwner =
          path.relative(gatesRoot, resolved).split(path.sep)[0] ?? "unknown";
        findings.push({
          rule: "cross-gate-runtime-import",
          file: relativeFile,
          detail: `${owner} imports the ${targetOwner} gate`,
        });
      } else {
        findings.push({
          rule: "gate-runtime-import-outside-contract",
          file: relativeFile,
          detail: `${owner} runtime import ${specifier} is outside its gate and kernel`,
        });
      }
    }
  }

  const orchestrator = path.join(
    repositoryRoot,
    "packages/checks/src/check-generated-registry.ts",
  );
  try {
    const source = await readFile(orchestrator, "utf8");
    const sourceFile = ts.createSourceFile(
      orchestrator,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const command of ownedCommands(sourceFile)) {
      const position = sourceFile.getLineAndCharacterOfPosition(
        command.call.getStart(sourceFile),
      );
      if (command.owner === "unassigned") {
        findings.push({
          rule: "unassigned-orchestrator-command",
          file: path
            .relative(repositoryRoot, orchestrator)
            .split(path.sep)
            .join("/"),
          detail: `scenario orchestrator invokes a command runner with a command or argument list that cannot be assigned to a semantic gate at ${position.line + 1}:${position.character + 1}`,
        });
        continue;
      }
      findings.push({
        rule:
          command.owner === "root"
            ? "hidden-root-quality-command"
            : command.owner === "focused"
              ? "hidden-focused-package-link-command"
              : "hidden-deployment-quality-command",
        file: path
          .relative(repositoryRoot, orchestrator)
          .split(path.sep)
          .join("/"),
        detail: `scenario orchestrator owns ${command.owner === "root" ? "Root Quality" : command.owner === "focused" ? "Focused Package Link" : "Deployment Quality"} command ${JSON.stringify([command.command, ...command.args])} at ${position.line + 1}:${position.character + 1}`,
      });
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  return findings;
}

export async function checkFixtureEvidenceArchitecture(
  repositoryRoot: string = defaultRepositoryRoot,
): Promise<void> {
  const findings =
    await findFixtureEvidenceArchitectureFindings(repositoryRoot);
  if (findings.length > 0) {
    throw new Error(
      findings
        .map(
          (finding) => `[${finding.rule}] ${finding.file}: ${finding.detail}`,
        )
        .join("\n"),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkFixtureEvidenceArchitecture();
}
