#!/usr/bin/env node
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import ts from "typescript";

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** One precise, independently fixable remnant of the retired architecture. */
export type LegacyArchitectureFinding = {
  readonly rule: string;
  readonly file: string;
  readonly detail: string;
};

const retiredPathParts = [
  "builtin-source",
  "preset-source",
  "preset-projection",
  "projection-capabilities",
  "package-addition-support",
] as const;

const retiredPaths = [
  "packages/builtin-source",
  "packages/core/src/preset-source.ts",
  "packages/core/src/preset-projection.ts",
  "packages/core/src/projection-capabilities.ts",
  "packages/core/src/package-addition-support.ts",
  "packages/core/src/declarations.ts",
  "packages/core/src/generation-context.ts",
  "packages/core/src/generated-scenarios.ts",
  "packages/core/src/package-addition.ts",
  "packages/core/src/package-linking.ts",
  "packages/core/src/runtime-paths.ts",
  "packages/checks/src/check-fixtures.ts",
  "packages/checks/src/check-generated.ts",
  "packages/checks/src/fixture-replay-cache.ts",
] as const;

const retiredSymbols = new Set([
  "PresetSource",
  "PresetFile",
  "PresetProjection",
  "ProjectionDeclaration",
  "ProjectionCapability",
  "PackageSourcePreset",
  "GenerationState",
  "SupportedChoice",
  "PresetFeature",
  "SupportedProjectKind",
  "SupportedPackageManager",
  "ProjectBlueprintV1",
  "BlueprintV1",
]);

const retiredText = [
  "@ykdz/template-builtin-source",
  "Preset Source",
  "Preset File",
  "Projection Declaration",
  "Projection Capability",
  "Package Source Preset",
] as const;

const concretePresetNames = new Set([
  "ts-lib",
  "rust-bin",
  "vue-app",
  "vue-hono-app",
  "vike-app",
  "hono-api",
]);
const frameworkNames = new Set(["vue", "vike", "hono", "rust"]);
const publicCliPackageName = ["@ykdz", "template"].join("/");

const ignoredDirectories = new Set([
  ".git",
  ".agents",
  ".scratch",
  ".turbo",
  ".template-boundary-check",
  "node_modules",
]);

function isTextFile(relativePath: string): boolean {
  if (relativePath.includes("/dist/")) return false;
  return /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md)$/u.test(relativePath);
}

function isTypeScript(relativePath: string): boolean {
  return /\.[cm]?[jt]sx?$/u.test(relativePath);
}

function isRemovalRule(relativePath: string): boolean {
  return relativePath.endsWith("check-legacy-architecture-removal.ts");
}

function isHistoricalAdr(relativePath: string): boolean {
  return relativePath.startsWith("docs/adr/");
}

function isGenericSurface(relativePath: string): boolean {
  return (
    relativePath.startsWith("packages/core/") ||
    relativePath.startsWith("packages/shared/") ||
    relativePath.startsWith("packages/cli/") ||
    relativePath.startsWith("packages/checks/") ||
    relativePath.startsWith("test/")
  );
}

function isBuiltInShared(relativePath: string): boolean {
  return relativePath.startsWith("packages/builtin-presets/src/shared/");
}

async function filesUnder(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await filesUnder(root, child)));
      }
    } else if (entry.isFile() && isTextFile(child)) {
      files.push(child);
    }
  }
  return files;
}

function finding(
  rule: string,
  file: string,
  detail: string,
): LegacyArchitectureFinding {
  return { rule, file, detail };
}

function nodeLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${line + 1}:${character + 1}`;
}

function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Identifier,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function evaluatedString(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression)
  ) {
    return evaluatedString(checker, expression.expression, seen);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluatedString(checker, expression.left, seen);
    const right = evaluatedString(checker, expression.right, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    const substitutions = expression.templateSpans.map((span) =>
      evaluatedString(checker, span.expression, seen),
    );
    if (substitutions.some((value) => value === undefined)) return undefined;
    return (
      expression.head.text +
      expression.templateSpans
        .map((span, index) => `${substitutions[index]!}${span.literal.text}`)
        .join("")
    );
  }
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression);
    if (symbol === undefined || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      return evaluatedString(checker, declaration.initializer, seen);
    }
  }
  return undefined;
}

function containsIdentity(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string | undefined {
  let identity: string | undefined;
  const inspect = (node: ts.Node): void => {
    if (identity !== undefined) return;
    if (ts.isExpression(node)) {
      const value = evaluatedString(checker, node);
      if (value !== undefined && concretePresetNames.has(value))
        identity = value;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(expression);
  return identity;
}

function collectTypeScriptFindings(
  relativePath: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): LegacyArchitectureFinding[] {
  if (!isTypeScript(relativePath) || isRemovalRule(relativePath)) return [];
  const findings: LegacyArchitectureFinding[] = [];
  const generic = isGenericSurface(relativePath);
  const shared = isBuiltInShared(relativePath);

  const inspect = (node: ts.Node): void => {
    const location = nodeLocation(sourceFile, node);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (
        moduleSpecifier !== undefined &&
        ts.isStringLiteral(moduleSpecifier)
      ) {
        const specifier = moduleSpecifier.text;
        if (retiredPathParts.some((part) => specifier.includes(part))) {
          findings.push(
            finding(
              "legacy-import-export",
              relativePath,
              `${location} imports or exports ${specifier}`,
            ),
          );
        }
        if (
          shared &&
          /\.\.\/(?:ts-lib|rust-bin|vue-app|vue-hono-app|vike-app)\//u.test(
            specifier,
          )
        ) {
          findings.push(
            finding(
              "shared-sibling-import",
              relativePath,
              `${location} imports outside the Built-in Presets shared area: ${specifier}`,
            ),
          );
        }
      }
    }
    if (ts.isIdentifier(node) && retiredSymbols.has(node.text)) {
      findings.push(
        finding(
          "retired-symbol",
          relativePath,
          `${location} references ${node.text}`,
        ),
      );
    }
    if (generic && ts.isStringLiteral(node)) {
      if (concretePresetNames.has(node.text)) {
        findings.push(
          finding(
            "generic-preset-identity",
            relativePath,
            `${location} hard-codes Preset identity ${node.text}`,
          ),
        );
      }
      if (
        frameworkNames.has(node.text) &&
        node.text !== "rust" &&
        ts.isBinaryExpression(node.parent) &&
        (node.parent.operatorToken.kind ===
          ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
      ) {
        findings.push(
          finding(
            "generic-framework-branch",
            relativePath,
            `${location} hard-codes built-in framework ${node.text}`,
          ),
        );
      }
    }
    if (
      generic &&
      ts.isUnionTypeNode(node) &&
      node.types.some(
        (type) =>
          ts.isLiteralTypeNode(type) &&
          ts.isStringLiteral(type.literal) &&
          concretePresetNames.has(type.literal.text),
      )
    ) {
      findings.push(
        finding(
          "closed-preset-union",
          relativePath,
          `${location} declares a string-literal union in generic code`,
        ),
      );
    }
    if (shared && ts.isIfStatement(node)) {
      const identity = containsIdentity(checker, node.expression);
      if (identity !== undefined) {
        findings.push(
          finding(
            "shared-preset-branch",
            relativePath,
            `${location} branches on a Preset identity`,
          ),
        );
      }
    }
    if (
      generic &&
      (ts.isIfStatement(node) || ts.isConditionalExpression(node))
    ) {
      const condition = ts.isIfStatement(node)
        ? node.expression
        : node.condition;
      const identity = containsIdentity(checker, condition);
      if (identity !== undefined) {
        findings.push(
          finding(
            "identity-branch",
            relativePath,
            `${location} branches on Preset identity ${identity}`,
          ),
        );
      }
    }
    if (generic && ts.isSwitchStatement(node)) {
      const identity = containsIdentity(checker, node.expression);
      const hasIdentityCase = node.caseBlock.clauses.some(
        (clause) =>
          ts.isCaseClause(clause) &&
          containsIdentity(checker, clause.expression) !== undefined,
      );
      if (identity !== undefined || hasIdentityCase) {
        findings.push(
          finding(
            "identity-branch",
            relativePath,
            `${location} switches on a closed Preset identity branch`,
          ),
        );
      }
    }
    if (
      generic &&
      (ts.isArrayLiteralExpression(node) ||
        (ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Set"))
    ) {
      const values = ts.isArrayLiteralExpression(node)
        ? node.elements
        : (node.arguments?.flatMap((argument) =>
            ts.isArrayLiteralExpression(argument)
              ? argument.elements
              : [argument],
          ) ?? []);
      if (
        values.some(
          (value) =>
            ts.isExpression(value) &&
            containsIdentity(checker, value) !== undefined,
        )
      ) {
        findings.push(
          finding(
            "closed-identity-catalog",
            relativePath,
            `${location} constructs a finite catalog of Preset identities`,
          ),
        );
      }
    }
    if (
      relativePath.startsWith("packages/cli/") &&
      ts.isVariableDeclaration(node) &&
      node.initializer
    ) {
      const value = evaluatedString(checker, node.initializer);
      if (
        value !== undefined &&
        /(?:schema\s+preset|preset\s+validate|preset-source)/iu.test(value)
      ) {
        findings.push(
          finding(
            "retired-cli-command",
            relativePath,
            `${location} composes a retired Preset protocol command`,
          ),
        );
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return findings;
}

function collectTextFindings(
  relativePath: string,
  source: string,
): LegacyArchitectureFinding[] {
  if (isRemovalRule(relativePath)) return [];
  if (isHistoricalAdr(relativePath)) {
    if (relativePath.endsWith("0093-trusted-built-in-preset-definitions.md")) {
      return [];
    }
    if (
      retiredText.some((term) => source.includes(term)) &&
      !/superseded(?:\s+in\s+part)?\s+by\s+ADR-0093/iu.test(source)
    ) {
      return [
        finding(
          "historical-adr-status",
          relativePath,
          "contains retired vocabulary without an explicit ADR-0093 supersession note",
        ),
      ];
    }
    return [];
  }
  const findings: LegacyArchitectureFinding[] = [];
  for (const term of retiredText) {
    if (new RegExp(term, "iu").test(source)) {
      findings.push(
        finding("retired-vocabulary", relativePath, `contains ${term}`),
      );
    }
  }
  if (
    /(?:shadow-(?:registry|runtime|check|comparison)|migration-(?:check|harness|parity))/iu.test(
      source,
    )
  ) {
    findings.push(
      finding(
        "transitional-harness",
        relativePath,
        "contains a transitional shadow or migration harness name",
      ),
    );
  }
  if (
    relativePath.startsWith("packages/cli/") &&
    /(?:schema\s+preset|preset\s+validate|preset-source)/iu.test(source)
  ) {
    findings.push(
      finding(
        "retired-cli-command",
        relativePath,
        "removes a retired Preset protocol command from help and dispatch",
      ),
    );
  }
  return findings;
}

function createAuditProgram(
  repositoryRoot: string,
  files: readonly string[],
): ts.Program {
  return ts.createProgram({
    rootNames: files
      .filter(isTypeScript)
      .map((file) => path.join(repositoryRoot, file)),
    options: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  });
}

async function collectPathFindings(
  repositoryRoot: string,
): Promise<LegacyArchitectureFinding[]> {
  const findings: LegacyArchitectureFinding[] = [];
  for (const relativePath of retiredPaths) {
    try {
      await access(path.join(repositoryRoot, relativePath));
      findings.push(
        finding(
          "retired-path",
          relativePath,
          "remove this retired architecture path",
        ),
      );
    } catch {
      // Absence is the required state.
    }
  }
  return findings;
}

function manifestFindings(
  relativePath: string,
  source: string,
): LegacyArchitectureFinding[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return [finding("package-manifest", relativePath, "contains invalid JSON")];
  }
  const serialized = JSON.stringify({
    exports: manifest.exports,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  });
  const findings: LegacyArchitectureFinding[] = [];
  if (/registry-checks|(?:^|[/-])check-[\w-]*/iu.test(serialized)) {
    findings.push(
      finding(
        "package-manifest-export",
        relativePath,
        "exports or depends on a repository-check-only module",
      ),
    );
  }
  if (retiredPathParts.some((part) => serialized.includes(part))) {
    findings.push(
      finding(
        "package-manifest-legacy-dependency",
        relativePath,
        "exports or depends on a retired architecture package or path",
      ),
    );
  }
  return findings;
}

/** Audits built JavaScript, declarations, and package manifests after build. */
export async function findLegacyArchitectureDistributionFindings(
  repositoryRoot = defaultRepositoryRoot,
): Promise<readonly LegacyArchitectureFinding[]> {
  const findings: LegacyArchitectureFinding[] = [];
  const packageRoots = [
    "packages/cli",
    "packages/builtin-presets",
    "packages/core",
  ];
  const hasDistribution = await Promise.all(
    packageRoots.map(async (packageRoot) => {
      try {
        await access(path.join(repositoryRoot, packageRoot, "dist"));
        return true;
      } catch {
        return false;
      }
    }),
  );
  if (!hasDistribution.some(Boolean)) return findings;
  for (const [index, packageRoot] of packageRoots.entries()) {
    if (!hasDistribution[index]) continue;
    const manifestPath = `${packageRoot}/package.json`;
    try {
      findings.push(
        ...manifestFindings(
          manifestPath,
          await readFile(path.join(repositoryRoot, manifestPath), "utf8"),
        ),
      );
    } catch {
      findings.push(finding("package-manifest", manifestPath, "is missing"));
    }
    const distRoot = path.join(repositoryRoot, packageRoot, "dist");
    try {
      for (const relativePath of await filesUnder(distRoot)) {
        const source = await readFile(
          path.join(distRoot, relativePath),
          "utf8",
        );
        const displayPath = `${packageRoot}/dist/${relativePath}`;
        if (
          retiredPathParts.some((part) => displayPath.includes(part)) ||
          /(?:registry-checks|check-[\w-]+)\.(?:[cm]?js|d\.ts)$/u.test(
            displayPath,
          )
        ) {
          findings.push(
            finding(
              "built-artifact",
              displayPath,
              "contains a retired or repository-check-only runtime module",
            ),
          );
        }
        if (retiredText.some((term) => new RegExp(term, "iu").test(source))) {
          findings.push(
            finding(
              "built-artifact-vocabulary",
              displayPath,
              "contains retired architecture vocabulary",
            ),
          );
        }
      }
    } catch {
      findings.push(
        finding("built-artifact", `${packageRoot}/dist`, "is missing"),
      );
    }
  }
  return findings;
}

/** Audit a packed public artifact without needing to unpack it. */
export function findLegacyArchitectureTarballFindings(
  packedPaths: readonly string[],
): readonly LegacyArchitectureFinding[] {
  return packedPaths.flatMap((packedPath) => {
    const normalized = packedPath.replace(/^package\//u, "");
    if (
      retiredPathParts.some((part) => normalized.includes(part)) ||
      /(?:behavior\.test|\.template-boundary-check|\.turbo)/u.test(
        normalized,
      ) ||
      /@ykdz\/template-builtin-presets\/dist\/src\/(?:check-|registry-checks)/u.test(
        normalized,
      ) ||
      normalized.startsWith("packages/") ||
      (normalized.startsWith("node_modules/@ykdz/template-") &&
        !normalized.startsWith("node_modules/@ykdz/template-core/") &&
        !normalized.startsWith("node_modules/@ykdz/template-builtin-presets/"))
    ) {
      return [
        finding(
          "packed-artifact",
          packedPath,
          "remove retired runtime, test, or generated-check artifact from the public tarball",
        ),
      ];
    }
    return [];
  });
}

/** Pack the public CLI and audit its actual publication file list. */
export async function checkPackedPublicArtifact(
  repositoryRoot = defaultRepositoryRoot,
): Promise<void> {
  const destination = await mkdtemp(
    path.join(tmpdir(), "template-public-artifact-"),
  );
  try {
    await execa(
      "pnpm",
      [
        "--config.node-linker=hoisted",
        "--filter",
        publicCliPackageName,
        "pack",
        "--pack-destination",
        destination,
      ],
      {
        cwd: repositoryRoot,
      },
    );
    const archive = (await readdir(destination)).find((entry) =>
      entry.endsWith(".tgz"),
    );
    if (archive === undefined) {
      throw new Error("Public CLI pack produced no tarball");
    }
    const archivePath = path.join(destination, archive);
    const packed = await execa("tar", ["-tf", archivePath]);
    const findings = findLegacyArchitectureTarballFindings(
      packed.stdout.split("\n").filter(Boolean),
    );
    if (findings.length > 0) {
      throw new Error(
        `Legacy Architecture Removal Check found packed-artifact finding(s):\n${findings
          .map(({ file, detail }) => `- [packed-artifact] ${file}: ${detail}`)
          .join("\n")}`,
      );
    }
    const manifest = await execa("tar", [
      "-xOf",
      archivePath,
      "package/package.json",
    ]);
    const manifestIssues = manifestFindings(
      "package/package.json",
      manifest.stdout,
    );
    if (manifestIssues.length > 0) {
      throw new Error(
        `Legacy Architecture Removal Check found packed package-manifest finding(s):\n${manifestIssues
          .map(({ rule, file, detail }) => `- [${rule}] ${file}: ${detail}`)
          .join("\n")}`,
      );
    }
    const unpacked = path.join(destination, "unpacked");
    await mkdir(unpacked);
    await execa("tar", ["-xf", archivePath, "-C", unpacked]);
    const packedRoot = path.join(unpacked, "package");
    for (const args of [
      ["dist/cli.js", "--help"],
      ["dist/cli.js", "presets"],
    ]) {
      await execa("node", args, {
        cwd: packedRoot,
        env: { ...process.env, TEMPLATE_REPOSITORY_ROOT: "" },
      });
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

/**
 * Finds every actionable remnant.  This is deliberately exported so checks
 * can test negative fixtures and package-packing code can audit tar listings.
 */
export async function findLegacyArchitectureFindings(
  repositoryRoot = defaultRepositoryRoot,
): Promise<readonly LegacyArchitectureFinding[]> {
  const findings = await collectPathFindings(repositoryRoot);
  const files = await filesUnder(repositoryRoot);
  const program = createAuditProgram(repositoryRoot, files);
  const checker = program.getTypeChecker();
  for (const relativePath of files) {
    const source = await readFile(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    findings.push(...collectTextFindings(relativePath, source));
    const sourceFile = program.getSourceFile(
      path.join(repositoryRoot, relativePath),
    );
    if (sourceFile) {
      findings.push(
        ...collectTypeScriptFindings(relativePath, sourceFile, checker),
      );
    }
  }
  findings.push(
    ...(await findLegacyArchitectureDistributionFindings(repositoryRoot)),
  );
  return findings;
}

export async function checkLegacyArchitectureRemoval(
  repositoryRoot = defaultRepositoryRoot,
): Promise<void> {
  const findings = await findLegacyArchitectureFindings(repositoryRoot);
  if (findings.length === 0) return;
  throw new Error(
    `Legacy Architecture Removal Check found ${findings.length} finding(s):\n${findings
      .map(({ rule, file, detail }) => `- [${rule}] ${file}: ${detail}`)
      .join("\n")}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkLegacyArchitectureRemoval();
  if (process.argv.includes("--packed")) await checkPackedPublicArtifact();
}
