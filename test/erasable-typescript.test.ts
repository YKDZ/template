import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import { renderNewProject } from "#template-core/renderer";

type Manifest = {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly bundleDependencies?: readonly string[];
  readonly scripts?: Readonly<Record<string, unknown>>;
};

async function uiTsconfigPaths(root: string): Promise<readonly string[]> {
  const configPaths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (
        entry.isFile() &&
        (entry.name === "tsconfig.app.json" ||
          entry.name === "tsconfig.test.json")
      ) {
        configPaths.push(entryPath);
      }
    }
  }
  await visit(root);
  return configPaths.toSorted();
}

async function compilerApiImports(
  packageRoot: string,
): Promise<readonly string[]> {
  const sourceRoot = path.join(packageRoot, "src");
  const sourcePaths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sourcePaths.push(entryPath);
      }
    }
  }
  await visit(sourceRoot);

  const imports: string[] = [];
  for (const sourcePath of sourcePaths) {
    const sourceFile = ts.createSourceFile(
      sourcePath,
      await readFile(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    function visitNode(node: ts.Node): void {
      const isStaticImport =
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "typescript";
      const isDynamicImport =
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0]!.text === "typescript";
      const isTypeImport =
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.argument.literal.text === "typescript";
      if (isStaticImport || isDynamicImport || isTypeImport) {
        imports.push(path.relative(process.cwd(), sourcePath));
      }
      ts.forEachChild(node, visitNode);
    }
    visitNode(sourceFile);
  }
  return [...new Set(imports)].toSorted();
}

describe("Erasable TypeScript enforcement", () => {
  it("allows transform syntax in UI application and ordinary UI test contexts", async () => {
    const fixtureSource = await readFile(
      path.join(
        process.cwd(),
        "test/fixtures/erasable-typescript/ui-transform-syntax.ts.txt",
      ),
      "utf8",
    );
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "template-ui-transform-typescript-"),
    );

    try {
      const generatedPresetTargets = builtInPresetRegistry
        .all()
        .map((definition) => ({
          definition,
          targetDir: path.join(projectRoot, definition.metadata.name),
        }));
      await Promise.all(
        generatedPresetTargets.map(async ({ definition, targetDir }) => {
          const plan = planGeneratedRepositoryInitialization({
            definition,
            context: createGenerationContext({
              targetDir,
              scope: "erasable",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.11.0",
              },
            }),
          });
          await renderNewProject({
            targetRoot: targetDir,
            operations: [...plan.operations],
          });
          await mkdir(path.join(targetDir, "node_modules/@vue"), {
            recursive: true,
          });
          await mkdir(path.join(targetDir, "node_modules/@erasable"), {
            recursive: true,
          });
          await Promise.all([
            symlink(
              path.join(
                process.cwd(),
                "packages/builtin-presets/node_modules/@vue/tsconfig",
              ),
              path.join(targetDir, "node_modules/@vue/tsconfig"),
              "dir",
            ),
            symlink(
              path.join(targetDir, "packages/typescript-config"),
              path.join(targetDir, "node_modules/@erasable/typescript-config"),
              "dir",
            ),
          ]);
        }),
      );
      const uiConfigPaths = (
        await Promise.all(
          generatedPresetTargets.map(({ targetDir }) =>
            uiTsconfigPaths(targetDir),
          ),
        )
      ).flat();
      expect(uiConfigPaths.length).toBeGreaterThan(0);
      await writeFile(
        path.join(projectRoot, "ui-transform-syntax.ts"),
        fixtureSource,
      );

      for (const [index, configPath] of uiConfigPaths.entries()) {
        const temporaryConfigPath = path.join(
          projectRoot,
          `tsconfig.ui-${index}.json`,
        );
        await writeFile(
          temporaryConfigPath,
          `${JSON.stringify(
            {
              extends: configPath,
              compilerOptions: {
                composite: false,
                noEmit: true,
                tsBuildInfoFile: null,
                types: [],
              },
              include: ["ui-transform-syntax.ts"],
            },
            undefined,
            2,
          )}\n`,
        );

        const result = await execa(
          "pnpm",
          ["exec", "tsc", "-p", temporaryConfigPath],
          { reject: false, all: true },
        );
        expect(result.exitCode, `${configPath}\n${result.all}`).toBe(0);
        expect(result.all).not.toContain("TS1294");
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses TypeScript 7 to reject every non-erasable fixture construct", async () => {
    const fixtureSource = await readFile(
      path.join(
        process.cwd(),
        "test/fixtures/erasable-typescript/non-erasable.ts.txt",
      ),
      "utf8",
    );
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "template-non-erasable-typescript-"),
    );

    try {
      await Promise.all([
        writeFile(
          path.join(projectRoot, "tsconfig.json"),
          `${JSON.stringify(
            {
              extends: path.join(process.cwd(), "tsconfig.base.json"),
              compilerOptions: { noEmit: true },
              include: ["non-erasable.ts"],
            },
            undefined,
            2,
          )}\n`,
        ),
        writeFile(path.join(projectRoot, "non-erasable.ts"), fixtureSource),
      ]);

      const version = await execa("pnpm", ["exec", "tsc", "--version"]);
      expect(version.stdout).toMatch(/^Version 7\./u);

      const result = await execa(
        "pnpm",
        ["exec", "tsc", "-p", path.join(projectRoot, "tsconfig.json")],
        { reject: false, all: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.all?.match(/error TS1294:/gu)).toHaveLength(3);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("activates the source condition for every direct TypeScript script", async () => {
    const repositoryManifests = await Promise.all(
      [
        "package.json",
        "packages/builtin-presets/package.json",
        "packages/checks/package.json",
        "packages/cli/package.json",
        "packages/core/package.json",
        "packages/shared/package.json",
      ].map(
        async (manifestPath) =>
          JSON.parse(await readFile(manifestPath, "utf8")) as Manifest,
      ),
    );
    const generatedManifests = builtInPresetRegistry.all().flatMap(
      (definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(
              "generated-repository",
              "source-condition",
              definition.metadata.name,
            ),
            scope: "source-condition",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        }).manifests as readonly Manifest[],
    );

    for (const manifest of [...repositoryManifests, ...generatedManifests]) {
      for (const [scriptName, command] of Object.entries(
        manifest.scripts ?? {},
      )) {
        if (
          typeof command !== "string" ||
          !/\bnode\b[^\n;&|]*\.ts(?:\s|$)/u.test(command)
        ) {
          continue;
        }
        expect(
          command,
          `${manifest.name ?? "(unnamed)"}#${scriptName}`,
        ).toContain("--conditions=source");
      }
    }
  });

  it("keeps compiler ownership truthful in every package manifest", async () => {
    const repositoryPackages = [
      ".",
      "packages/builtin-presets",
      "packages/checks",
      "packages/cli",
      "packages/core",
      "packages/shared",
    ];
    const repositoryManifests = await Promise.all(
      repositoryPackages.map(async (packageRoot) => ({
        packageRoot,
        manifest: JSON.parse(
          await readFile(path.join(packageRoot, "package.json"), "utf8"),
        ) as Manifest,
      })),
    );
    const generatedManifests = builtInPresetRegistry.all().flatMap(
      (definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(
              "generated-repository",
              "manifest-truth",
              definition.metadata.name,
            ),
            scope: "manifest-truth",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        }).manifests as readonly Manifest[],
    );

    for (const manifest of [
      ...repositoryManifests.map(({ manifest }) => manifest),
      ...generatedManifests,
    ]) {
      const scripts = Object.values(manifest.scripts ?? {}).filter(
        (command): command is string => typeof command === "string",
      );
      const ownsVueCompatibility = scripts.some((command) =>
        command.includes("scripts/run-vue-tsc.ts"),
      );
      if (scripts.some((command) => /\btsc(?:\s|$)/u.test(command))) {
        expect(
          {
            ...manifest.dependencies,
            ...manifest.devDependencies,
          },
          `${manifest.name ?? "(unnamed)"} owns its TypeScript 7 CLI`,
        ).toHaveProperty("typescript-7");
      }
      if (ownsVueCompatibility) {
        expect(
          manifest.devDependencies,
          `${manifest.name ?? "(unnamed)"} owns Vue's TypeScript 6 compatibility package`,
        ).toHaveProperty("typescript");
      } else if (
        !new Set([
          "@ykdz/template-repository",
          "@ykdz/template",
          "@ykdz/template-builtin-presets",
          "@ykdz/template-checks",
          "@ykdz/template-core",
        ]).has(manifest.name ?? "")
      ) {
        expect(
          {
            ...manifest.dependencies,
            ...manifest.devDependencies,
          },
          `${manifest.name ?? "(unnamed)"} does not own TypeScript 6 compatibility`,
        ).not.toHaveProperty("typescript");
      }
    }

    for (const manifest of generatedManifests) {
      expect(
        { ...manifest.dependencies },
        `${manifest.name ?? "(unnamed)"} keeps compilers out of Generated deployment production dependencies`,
      ).not.toHaveProperty("typescript");
      expect(
        { ...manifest.dependencies },
        `${manifest.name ?? "(unnamed)"} keeps compiler CLIs out of Generated deployment production dependencies`,
      ).not.toHaveProperty("typescript-7");
    }

    for (const { packageRoot, manifest } of repositoryManifests) {
      if (
        manifest.dependencies?.typescript === undefined &&
        manifest.peerDependencies?.typescript === undefined
      ) {
        continue;
      }
      if (manifest.name === "@ykdz/template") {
        expect(
          manifest.bundleDependencies,
          "@ykdz/template owns the flattened runtime closure of its bundled private packages",
        ).toContain("@ykdz/template-core");
        expect(
          await compilerApiImports(packageRoot),
          "@ykdz/template leaves TypeScript compiler API usage in its bundled Core boundary",
        ).toHaveLength(0);
        continue;
      }
      expect(
        await compilerApiImports(packageRoot),
        `${manifest.name ?? "(unnamed)"} declares a runtime TypeScript 6 dependency`,
      ).not.toHaveLength(0);
    }

    const core = repositoryManifests.find(
      ({ manifest }) => manifest.name === "@ykdz/template-core",
    );
    expect(core?.manifest.peerDependencies).toHaveProperty("typescript");
    expect(core?.manifest.devDependencies).toHaveProperty("typescript");
    await expect(compilerApiImports(core!.packageRoot)).resolves.toEqual(
      expect.arrayContaining([
        "packages/core/src/renderer.ts",
        "packages/core/src/template-boundary-check.ts",
      ]),
    );

    const cliManifest = repositoryManifests.find(
      ({ manifest }) => manifest.name === "@ykdz/template",
    )?.manifest;
    expect(cliManifest?.dependencies).toHaveProperty("typescript");
    expect(cliManifest?.dependencies).not.toHaveProperty("@typescript/old");
    expect(cliManifest?.bundleDependencies).toEqual(
      expect.arrayContaining(["@ykdz/template-core", "typescript"]),
    );
  });
});
