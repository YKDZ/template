import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "@typescript/typescript6";
import { loadBuiltInPresetSourceManifest } from "@ykdz/template-builtin-source";
import {
  loadTemplateCargoDependencyVersions,
  loadTemplateDependencyCatalog,
} from "@ykdz/template-core/dependency-catalog";
import { execa } from "execa";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stringRecordSchema = v.record(v.string(), v.string());
const packageMetadataSchema = v.object({
  bundleDependencies: v.optional(v.array(v.string())),
  dependencies: v.optional(stringRecordSchema),
  devDependencies: v.optional(stringRecordSchema),
  name: v.optional(v.string()),
  packageManager: v.optional(v.string()),
  private: v.optional(v.boolean()),
  version: v.optional(v.string()),
});
const dependabotUpdateSchema = v.object({
  "package-ecosystem": v.string(),
  directory: v.string(),
  schedule: v.object({ interval: v.string() }),
  groups: v.optional(
    v.record(
      v.string(),
      v.object({
        patterns: v.array(v.string()),
      }),
    ),
  ),
  ignore: v.optional(
    v.array(
      v.object({
        "dependency-name": v.string(),
        "update-types": v.array(v.string()),
      }),
    ),
  ),
});
const dependabotConfigSchema = v.object({
  version: v.optional(v.number()),
  updates: v.array(dependabotUpdateSchema),
});
const devcontainerSchema = v.object({
  name: v.optional(v.string()),
  build: v.optional(v.object({ dockerfile: v.optional(v.string()) })),
  customizations: v.optional(
    v.object({
      vscode: v.optional(
        v.object({
          extensions: v.optional(v.array(v.string())),
          settings: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    }),
  ),
  features: v.optional(v.unknown()),
  postCreateCommand: v.optional(stringRecordSchema),
});
const workspaceExtensionsSchema = v.object({
  recommendations: v.array(v.string()),
});

function parseJsonWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, JSON.parse(text) as unknown);
}

function parseYamlWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, parseYaml(text) as unknown);
}

const packageDependencyFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const staleGeneratedCatalogLinePattern =
  /["']\s{2}(?:"@?[\w./-]+"|[\w.-]+): \^\d+\.\d+\.\d+/;
const fixtureOnlyPresetManifestFields = new Set([
  "fixtureMatrix",
  "initSupport",
  "supportedCombinations",
  "semanticSkips",
  "checkRequirements",
  "environmentPreparation",
  "linkFrom",
]);
const packageAdditionSupportField = "packageAdditionSupport";
const duplicateAddabilityFieldPattern =
  /^(?:base.*addability|base.*additionSupport|base.*packageAdditionSupport|.*baseAddability|.*baseAdditionSupport|addability)$/i;

function dependencyVersionGateProjectionFiles(): string[] {
  return loadBuiltInPresetSourceManifest()
    .presets.filter((preset) => preset.generation === "supported")
    .map(
      (preset) =>
        `packages/builtin-source/templates/${preset.name}/projection.ts`,
    )
    .toSorted();
}

function propertyNameText(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
): string {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return name.getText(sourceFile);
}

function relativeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function objectKeyIssues(
  value: unknown,
  pathLabel: string,
  isIssueKey: (key: string) => boolean,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      objectKeyIssues(item, `${pathLabel}[${index}]`, isIssueKey),
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => [
    ...(isIssueKey(key) ? [`${pathLabel}.${key}`] : []),
    ...objectKeyIssues(nestedValue, `${pathLabel}.${key}`, isIssueKey),
  ]);
}

function duplicateAddabilityFieldIssues(
  sourceText: string,
  filePath: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];

  function visit(node: ts.Node): void {
    let name: ts.PropertyName | undefined;

    if (
      ts.isPropertyAssignment(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node)
    ) {
      name = node.name;
    }

    if (name) {
      const fieldName = propertyNameText(name, sourceFile);

      if (
        fieldName !== packageAdditionSupportField &&
        duplicateAddabilityFieldPattern.test(fieldName)
      ) {
        issues.push(
          `${filePath}:${lineForPosition(
            sourceFile,
            name.getStart(sourceFile),
          )}: use packageAdditionSupport as the only addability concept`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return issues;
}

function stringLiteralText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function isDependencySemverRange(value: string): boolean {
  return /^(?:[~^]|[<>=]=?)?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?(?:\s|$|\|\|)/.test(
    value,
  );
}

function inlineDependencyVersionRanges(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "projection.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const dependencyVersions: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      packageDependencyFields.has(propertyNameText(node.name, sourceFile)) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }

        const versionRange = stringLiteralText(property.initializer);
        if (
          versionRange === undefined ||
          !isDependencySemverRange(versionRange)
        ) {
          continue;
        }

        const packageName = propertyNameText(property.name, sourceFile);
        const position = sourceFile.getLineAndCharacterOfPosition(
          property.initializer.getStart(sourceFile),
        );

        dependencyVersions.push(
          `${packageName}: ${versionRange} at ${position.line + 1}:${position.character + 1}`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return dependencyVersions;
}

function expectNoStaleInlineDependencyVersions(source: string): void {
  expect(source).not.toMatch(staleGeneratedCatalogLinePattern);
  expect(inlineDependencyVersionRanges(source)).toEqual([]);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await filesUnder(entryPath)));
      continue;
    }

    files.push(entryPath);
  }

  return files;
}

function isPlaywrightServerTemplate(filePath: string): boolean {
  const normalized = filePath.replaceAll(path.sep, "/");

  return (
    normalized.endsWith("/playwright.config.ts") ||
    normalized.endsWith("/scripts/run-playwright.ts")
  );
}

function expectNoStaticPlaywrightServerPorts(
  source: string,
  filePath: string,
): void {
  const labelledSource = `${filePath}\n${source}`;

  expect(labelledSource).not.toMatch(/\bworkspacePortOffset\b/);
  expect(labelledSource).not.toMatch(/\bfallback\w*Port\b/);
  expect(labelledSource).not.toMatch(/\b(?:--port\s+|PORT=|:)(?:\d[\d_]*)/);
}

const reviewedRootPresetBehaviorFiles = [
  "test/template-init.test.ts",
  "test/editor-customization.test.ts",
  "test/preset-registry.test.ts",
] as const;

function lineForPosition(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function presetLiteralFromExpression(
  expression: ts.Expression,
  supportedPresetNames: ReadonlySet<string>,
): string | undefined {
  return ts.isStringLiteralLike(expression) &&
    supportedPresetNames.has(expression.text)
    ? expression.text
    : undefined;
}

function nodeContainsPresetEquality(
  node: ts.Node,
  supportedPresetNames: ReadonlySet<string>,
): boolean {
  let contains = false;

  function visit(current: ts.Node): void {
    if (contains) {
      return;
    }

    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind ===
        ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
      (presetLiteralFromExpression(current.left, supportedPresetNames) !==
        undefined ||
        presetLiteralFromExpression(current.right, supportedPresetNames) !==
          undefined)
    ) {
      contains = true;
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return contains;
}

function objectLiteralHasProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  sourceFile: ts.SourceFile,
): boolean {
  return objectLiteral.properties.some((property) => {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      return propertyNameText(property.name, sourceFile) === propertyName;
    }

    return false;
  });
}

function nodeContainsPresetLiteral(
  node: ts.Node,
  supportedPresetNames: ReadonlySet<string>,
): boolean {
  let contains = false;

  function visit(current: ts.Node): void {
    if (contains) {
      return;
    }

    if (
      (ts.isStringLiteral(current) ||
        ts.isNoSubstitutionTemplateLiteral(current)) &&
      supportedPresetNames.has(current.text)
    ) {
      contains = true;
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return contains;
}

function rootPresetBehaviorSelectorIssues(
  sourceText: string,
  filePath: string,
  supportedPresetNames: ReadonlySet<string>,
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length > 1 &&
      node.elements.every(
        (element) =>
          ts.isStringLiteralLike(element) &&
          supportedPresetNames.has(element.text),
      )
    ) {
      issues.push(
        `${filePath}:${lineForPosition(
          sourceFile,
          node.getStart(sourceFile),
        )}: derive preset test matrices from manifest capability facts`,
      );
    }

    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length > 1 &&
      node.elements.every(ts.isObjectLiteralExpression) &&
      node.elements.every((element) =>
        ts.isObjectLiteralExpression(element)
          ? nodeContainsPresetLiteral(element, supportedPresetNames)
          : false,
      ) &&
      node.elements.some((element) =>
        ts.isObjectLiteralExpression(element)
          ? objectLiteralHasProperty(
              element,
              packageAdditionSupportField,
              sourceFile,
            )
          : false,
      )
    ) {
      issues.push(
        `${filePath}:${lineForPosition(
          sourceFile,
          node.getStart(sourceFile),
        )}: derive preset object matrices from manifest capability facts`,
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "filter" &&
      node.arguments.some((argument) =>
        nodeContainsPresetEquality(argument, supportedPresetNames),
      )
    ) {
      issues.push(
        `${filePath}:${lineForPosition(
          sourceFile,
          node.getStart(sourceFile),
        )}: derive preset exclusions from manifest capability facts`,
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return issues;
}

describe("template Repository maintenance", () => {
  it("discovers Preset Source Tests named behavior.test.ts by convention", async () => {
    const result = await execa(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--config",
        "vitest.config.ts",
        "--testNamePattern",
        "vue-app Preset Source behavior",
        "--no-color",
      ],
      { cwd: repoRoot },
    );

    expect(result.stdout).toContain(
      "packages/builtin-source/templates/vue-app/behavior.test.ts > vue-app Preset Source behavior",
    );
  });

  it("keeps reviewed root preset behavior selectors derived from manifest facts", async () => {
    const supportedPresetNames = new Set(
      loadBuiltInPresetSourceManifest()
        .presets.filter((preset) => preset.generation === "supported")
        .map((preset) => preset.name),
    );
    const issues = (
      await Promise.all(
        reviewedRootPresetBehaviorFiles.map(async (filePath) =>
          rootPresetBehaviorSelectorIssues(
            await readFile(path.join(repoRoot, filePath), "utf8"),
            filePath,
            supportedPresetNames,
          ),
        ),
      )
    ).flat();

    expect(issues).toEqual([]);
  });

  it("detects root preset object matrices that duplicate manifest capability facts", () => {
    expect(
      rootPresetBehaviorSelectorIssues(
        `
          expect(presets).toEqual([
            { name: "ts-lib", packageAdditionSupport: "supported" },
            { name: "vue-app", packageAdditionSupport: "supported" },
          ]);
        `,
        "test/example.test.ts",
        new Set(["ts-lib", "vue-app"]),
      ),
    ).toEqual([
      "test/example.test.ts:2: derive preset object matrices from manifest capability facts",
    ]);
  });

  it("keeps fixture-only manifest fields out of the built-in Preset Source Manifest", () => {
    const issues = objectKeyIssues(
      loadBuiltInPresetSourceManifest(),
      "$",
      (key) => fixtureOnlyPresetManifestFields.has(key),
    );

    expect(issues).toEqual([]);
  });

  it("keeps Package Addition Support as the only Preset addability field", async () => {
    const manifestIssues = objectKeyIssues(
      loadBuiltInPresetSourceManifest(),
      "$",
      (key) =>
        key !== packageAdditionSupportField &&
        duplicateAddabilityFieldPattern.test(key),
    );
    const packageSourceFiles = (
      await filesUnder(path.join(repoRoot, "packages"))
    )
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.endsWith("/behavior.test.ts"));
    const sourceIssues = (
      await Promise.all(
        packageSourceFiles.map(async (file) =>
          duplicateAddabilityFieldIssues(
            await readFile(file, "utf8"),
            relativeRepoPath(file),
          ),
        ),
      )
    ).flat();

    expect([...manifestIssues, ...sourceIssues]).toEqual([]);
  });

  it("detects duplicate base-addability fields in production source", () => {
    expect(
      duplicateAddabilityFieldIssues(
        "export type Preset = { baseAddability: boolean; packageAdditionSupport: string };",
        "packages/example/src/preset.ts",
      ),
    ).toEqual([
      "packages/example/src/preset.ts:1: use packageAdditionSupport as the only addability concept",
    ]);
  });

  it("detects package metadata dependency ranges in Preset Projection source", () => {
    expect(() =>
      expectNoStaleInlineDependencyVersions(`
        const operation = {
          kind: "writeJson",
          to: "package.json",
          value: {
            name: context.projectName.value,
            version: "0.0.0",
            dependencies: { typescript: "^5.8.0" },
            engines: { node: "24" },
          },
        };
      `),
    ).toThrow();
  });

  it("allows non-dependency versions in Preset Projection source", () => {
    expect(() =>
      expectNoStaleInlineDependencyVersions(`
        const operation = {
          kind: "writeJson",
          to: "package.json",
          value: {
            name: context.projectName.value,
            version: "0.0.0",
            engines: { node: "24" },
            scripts: { dev: "vite --host 0.0.0.0 --port 5173" },
            server: { port: 4173 },
          },
        };
      `),
    ).not.toThrow();
  });

  it("covers every supported Preset Projection in the dependency version gate", () => {
    expect(dependencyVersionGateProjectionFiles()).toEqual(
      expect.arrayContaining([
        "packages/builtin-source/templates/rust-bin/projection.ts",
      ]),
    );
  });

  it("keeps dependency version ranges out of Preset Projection source", async () => {
    for (const projectionFile of dependencyVersionGateProjectionFiles()) {
      const source = await readFile(
        path.join(repoRoot, projectionFile),
        "utf8",
      );

      expectNoStaleInlineDependencyVersions(source);
    }
  });

  it("keeps Playwright server ports runtime-allocated in app templates", async () => {
    const templateRoot = path.join(
      repoRoot,
      "packages/builtin-source/templates",
    );
    const playwrightServerTemplates = (await filesUnder(templateRoot))
      .filter(isPlaywrightServerTemplate)
      .toSorted();

    expect(playwrightServerTemplates).not.toEqual([]);
    for (const filePath of playwrightServerTemplates) {
      const source = await readFile(filePath, "utf8");
      expectNoStaticPlaywrightServerPorts(source, filePath);
    }
  });

  it("keeps Preset Source Dependency Catalog references backed by maintained versions", () => {
    const templateCatalog = loadTemplateDependencyCatalog();
    const manifest = loadBuiltInPresetSourceManifest();
    const presetReferences = Object.fromEntries(
      manifest.presets
        .filter((preset) => preset.generation === "supported")
        .map((preset) => [preset.name, preset.dependencyCatalog ?? []]),
    );

    expect(presetReferences).not.toEqual({});
    for (const [presetName, dependencies] of Object.entries(presetReferences)) {
      expect(dependencies, `${presetName} declares catalog refs`).not.toEqual(
        [],
      );
      for (const dependency of dependencies) {
        expect(
          templateCatalog[dependency],
          `${presetName} ${dependency}`,
        ).toMatch(/^\^?\d/);
      }
    }
  });

  it("keeps root package metadata private and catalog-backed", async () => {
    const packageJson = parseJsonWithSchema(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
      packageMetadataSchema,
    );

    expect(packageJson.private).toBe(true);
    expect([
      ...Object.values(packageJson.dependencies ?? {}),
      ...Object.values(packageJson.devDependencies ?? {}),
    ]).toContain("catalog:");
  });

  it("keeps private workspace package versions out of the release train", async () => {
    const packageDirs = await readdir(path.join(repoRoot, "packages"), {
      withFileTypes: true,
    });

    for (const packageDir of packageDirs) {
      if (!packageDir.isDirectory()) {
        continue;
      }

      const packageJson = parseJsonWithSchema(
        await readFile(
          path.join(repoRoot, "packages", packageDir.name, "package.json"),
          "utf8",
        ),
        packageMetadataSchema,
      );

      if (packageJson.private === true) {
        expect(packageJson.version).toBe(
          packageJson.version === undefined ? undefined : "0.0.0",
        );
      }
    }
  });

  it("keeps bundled private workspace packages on sentinel versions for pnpm pack", async () => {
    const cliPackageJson = parseJsonWithSchema(
      await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
      packageMetadataSchema,
    );
    const packageDirs = await readdir(path.join(repoRoot, "packages"), {
      withFileTypes: true,
    });
    const workspacePackages = new Map<
      string,
      v.InferOutput<typeof packageMetadataSchema>
    >();

    for (const packageDir of packageDirs) {
      if (!packageDir.isDirectory()) {
        continue;
      }

      const packageJson = parseJsonWithSchema(
        await readFile(
          path.join(repoRoot, "packages", packageDir.name, "package.json"),
          "utf8",
        ),
        packageMetadataSchema,
      );

      if (packageJson.name !== undefined) {
        workspacePackages.set(packageJson.name, packageJson);
      }
    }

    expect(cliPackageJson.bundleDependencies).toEqual(
      expect.arrayContaining([
        "@ykdz/template-builtin-source",
        "@ykdz/template-core",
      ]),
    );

    for (const dependency of cliPackageJson.bundleDependencies ?? []) {
      const packageJson = workspacePackages.get(dependency);

      expect(packageJson?.private).toBe(true);
      expect(packageJson?.version).toBe("0.0.0");
    }
  });

  it("maintains the template Repository's real GitHub Actions workflows through Dependabot", async () => {
    const workflowFiles = await readdir(
      path.join(repoRoot, ".github/workflows"),
    );
    const dependabot = parseYamlWithSchema(
      await readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
      dependabotConfigSchema,
    );

    expect(workflowFiles).toEqual(
      expect.arrayContaining([
        "check.yml",
        "release.yml",
        "toolchain-resolution-contract.yml",
      ]),
    );
    expect(dependabot.updates).toContainEqual({
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
    });
  });

  it("keeps Local Template Metadata and local pnpm store paths ignored", async () => {
    const gitignore = await readFile(path.join(repoRoot, ".gitignore"), "utf8");

    expect(gitignore).toContain(".template/\n");
    expect(gitignore).toContain(".project-kit/\n");
    expect(gitignore).toContain(".fixture-replay-cache/\n");
    expect(gitignore).toContain(".pnpm-store/\n");
    expect(gitignore).not.toContain(".devcontainer/\n");
  });

  it("keeps the root Development Container Dockerfile-first with intentional editor customizations", async () => {
    const devcontainer = parseJsonWithSchema(
      await readFile(
        path.join(repoRoot, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
      devcontainerSchema,
    );
    const workspaceExtensions = parseJsonWithSchema(
      await readFile(path.join(repoRoot, ".vscode/extensions.json"), "utf8"),
      workspaceExtensionsSchema,
    );
    const expectedExtensions = [
      "rust-lang.rust-analyzer",
      "tamasfe.even-better-toml",
      "fill-labs.dependi",
      "oxc.oxc-vscode",
      "vitest.explorer",
    ];

    expect(Object.keys(devcontainer).slice(0, 3)).toEqual([
      "name",
      "build",
      "customizations",
    ]);
    expect(devcontainer.build?.dockerfile).toBe("Dockerfile");
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.customizations?.vscode?.extensions).toEqual(
      expectedExtensions,
    );
    expect(workspaceExtensions.recommendations).toEqual(expectedExtensions);
    expect(devcontainer.customizations?.vscode?.settings).toMatchObject({
      "editor.formatOnSave": true,
      "rust-analyzer.check.command": "clippy",
    });

    await expect(
      readFile(path.join(repoRoot, "package.json"), "utf8"),
    ).resolves.toContain('"packageManager"');
    expect(devcontainer.postCreateCommand).toMatchObject({
      installNodeDependencies: "pnpm install",
    });

    await expect(
      readFile(path.join(repoRoot, "Cargo.toml"), "utf8"),
    ).resolves.toContain("[dependencies]");
    expect(loadTemplateCargoDependencyVersions()).toHaveProperty("anyhow");
    expect(Object.values(devcontainer.postCreateCommand ?? {})).not.toContain(
      "cargo fetch",
    );
  });

  it("uses official root Dependabot config for npm, Cargo, GitHub Actions, and the Development Container Dockerfile", async () => {
    const dependabot = parseYamlWithSchema(
      await readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
      dependabotConfigSchema,
    );

    expect(dependabot).toEqual({
      version: 2,
      updates: [
        {
          "package-ecosystem": "npm",
          directory: "/",
          schedule: { interval: "weekly" },
          groups: {
            drizzle: {
              patterns: ["drizzle-*", "drizzle-orm"],
            },
          },
          ignore: [
            {
              "dependency-name": "@types/node",
              "update-types": ["version-update:semver-major"],
            },
          ],
        },
        {
          "package-ecosystem": "github-actions",
          directory: "/",
          schedule: { interval: "weekly" },
        },
        {
          "package-ecosystem": "cargo",
          directory: "/",
          schedule: { interval: "weekly" },
        },
        {
          "package-ecosystem": "docker",
          directory: "/.devcontainer",
          schedule: { interval: "weekly" },
          ignore: [
            {
              "dependency-name": "node",
              "update-types": ["version-update:semver-major"],
            },
          ],
        },
      ],
    });
  });

  it("keeps the root pnpm pin on a GitHub Dependabot-supported major", async () => {
    const packageJson = parseJsonWithSchema(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
      packageMetadataSchema,
    );
    const packageManager = packageJson.packageManager ?? "";
    const match = /^pnpm@(\d+)\.\d+\.\d+$/.exec(packageManager);

    expect(match).not.toBeNull();
    expect([7, 8, 9, 10]).toContain(Number(match?.[1]));
  });
});
