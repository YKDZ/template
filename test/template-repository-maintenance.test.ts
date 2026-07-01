import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const packageDependencyFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const staleGeneratedCatalogLinePattern =
  /["']\s{2}(?:"@?[\w./-]+"|[\w.-]+): \^\d+\.\d+\.\d+/;

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

  it("keeps dependency version ranges out of Preset Projection source", async () => {
    const projectionFiles = [
      "templates/hono-api/projection.ts",
      "templates/ts-lib/projection.ts",
      "templates/vue-app/projection.ts",
      "templates/vue-hono-app/projection.ts",
    ];

    for (const projectionFile of projectionFiles) {
      const source = await readFile(
        path.join(repoRoot, projectionFile),
        "utf8",
      );

      expectNoStaleInlineDependencyVersions(source);
    }
  });

  it("keeps root package metadata on publishable semver ranges", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect([
      ...Object.values(packageJson.dependencies ?? {}),
      ...Object.values(packageJson.devDependencies ?? {}),
    ]).not.toContain("catalog:");
  });

  it("keeps Local Template Metadata and local pnpm store paths ignored", async () => {
    const gitignore = await readFile(path.join(repoRoot, ".gitignore"), "utf8");

    expect(gitignore).toContain(".template/\n");
    expect(gitignore).toContain(".project-kit/\n");
    expect(gitignore).toContain(".pnpm-store/\n");
    expect(gitignore).not.toContain(".devcontainer/\n");
  });

  it("marks workspace-shape ADRs superseded when ADR-0058 replaces their direction", async () => {
    const workspaceOnlyAdr = await readFile(
      path.join(repoRoot, "docs/adr/0002-workspace-only-for-multi-package-v1.md"),
      "utf8",
    );

    expect(workspaceOnlyAdr).toContain("Superseded by ADR-0058");
    expect(workspaceOnlyAdr).not.toContain(
      "Single-package presets should stay single-package",
    );
  });

  it("keeps the root Development Container Dockerfile-first with intentional editor customizations", async () => {
    const devcontainer = JSON.parse(
      await readFile(
        path.join(repoRoot, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ) as {
      name?: string;
      build?: { dockerfile?: string };
      customizations?: {
        vscode?: {
          extensions?: string[];
          settings?: Record<string, unknown>;
        };
      };
      features?: unknown;
      postCreateCommand?: Record<string, string>;
    };

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
    const dependabot = parseYaml(
      await readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
    ) as {
      version: number;
      updates: {
        "package-ecosystem": string;
        directory: string;
        schedule: { interval: string };
        ignore?: {
          "dependency-name": string;
          "update-types": string[];
        }[];
      }[];
    };

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
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      packageManager?: string;
    };
    const packageManager = packageJson.packageManager ?? "";
    const match = /^pnpm@(\d+)\.\d+\.\d+$/.exec(packageManager);

    expect(match).not.toBeNull();
    expect([7, 8, 9, 10]).toContain(Number(match?.[1]));
  });
});
