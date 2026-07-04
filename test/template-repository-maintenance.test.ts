import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBuiltInPresetSourceManifest } from "@ykdz/template-builtin-source";
import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import * as ts from "typescript";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stringRecordSchema = v.record(v.string(), v.string());
const packageMetadataSchema = v.object({
  dependencies: v.optional(stringRecordSchema),
  devDependencies: v.optional(stringRecordSchema),
  packageManager: v.optional(v.string()),
  private: v.optional(v.boolean()),
});
const dependabotUpdateSchema = v.object({
  "package-ecosystem": v.string(),
  directory: v.string(),
  schedule: v.object({ interval: v.string() }),
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

describe("template Repository maintenance", () => {
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

    expect(Object.keys(devcontainer).slice(0, 3)).toEqual([
      "name",
      "build",
      "customizations",
    ]);
    expect(devcontainer.build?.dockerfile).toBe("Dockerfile");
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.customizations?.vscode?.extensions).toEqual([
      "rust-lang.rust-analyzer",
      "tamasfe.even-better-toml",
      "vadimcn.vscode-lldb",
      "serayuzgur.crates",
      "redhat.vscode-yaml",
      "fill-labs.dependi",
    ]);
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
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.values(devcontainer.postCreateCommand ?? {})).not.toContain(
      "cargo fetch",
    );
  });

  it("uses official root Dependabot config for npm, GitHub Actions, and the Development Container Dockerfile", async () => {
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
