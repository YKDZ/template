import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type TurboBoundaries = {
  readonly boundaries: {
    readonly tags: Record<
      string,
      { readonly dependencies: { readonly allow: readonly string[] } }
    >;
  };
};

const packages = {
  shared: {
    directory: "packages/shared",
    name: "@ykdz/template-shared",
    mayImport: [] as const,
  },
  core: {
    directory: "packages/core",
    name: "@ykdz/template-core",
    mayImport: [] as const,
  },
  "builtin-presets": {
    directory: "packages/builtin-presets",
    name: "@ykdz/template-builtin-presets",
    mayImport: ["core"] as const,
  },
  cli: {
    directory: "packages/cli",
    name: "@ykdz/template",
    mayImport: ["core", "builtin-presets"] as const,
  },
  checks: {
    directory: "packages/checks",
    name: "@ykdz/template-checks",
    mayImport: ["core", "builtin-presets"] as const,
  },
} as const;

type PackageKey = keyof typeof packages;

const packageByName = new Map<string, PackageKey>(
  Object.entries(packages).map(([key, value]) => [
    value.name,
    key as PackageKey,
  ]),
);

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) return typeScriptFiles(child);
        return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)
          ? [child]
          : [];
      }),
    )
  ).flat();
}

function importedPackage(
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
): PackageKey | undefined {
  const packageImport = [...packageByName.entries()].find(
    ([name]) =>
      moduleSpecifier === name || moduleSpecifier.startsWith(`${name}/`),
  );
  if (packageImport !== undefined) return packageImport[1];
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const target = path.resolve(
    path.dirname(sourceFile.fileName),
    moduleSpecifier,
  );
  return (
    Object.entries(packages) as [PackageKey, (typeof packages)[PackageKey]][]
  ).find(([, value]) =>
    target.startsWith(`${path.resolve(value.directory)}${path.sep}`),
  )?.[0];
}

describe("Template Repository dependency DAG", () => {
  it("keeps package manifests and source imports on the one-way architecture", async () => {
    for (const [key, definition] of Object.entries(packages) as [
      PackageKey,
      (typeof packages)[PackageKey],
    ][]) {
      const allowed = new Set<PackageKey>([key, ...definition.mayImport]);
      const manifest = JSON.parse(
        await readFile(path.join(definition.directory, "package.json"), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const target = packageByName.get(dependency);
          if (target !== undefined)
            expect(allowed, `${key} ${field}`).toContain(target);
        }
      }

      for (const file of await typeScriptFiles(
        path.join(definition.directory, "src"),
      )) {
        const sourceFile = ts.createSourceFile(
          path.resolve(file),
          await readFile(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const inspect = (node: ts.Node): void => {
          const specifier =
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)
              ? node.moduleSpecifier.text
              : ts.isCallExpression(node) &&
                  node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                  node.arguments.length === 1 &&
                  ts.isStringLiteral(node.arguments[0]!)
                ? node.arguments[0]!.text
                : undefined;
          if (specifier !== undefined) {
            const target = importedPackage(sourceFile, specifier);
            if (target !== undefined) {
              expect(
                allowed,
                `${key} imports ${specifier} from ${file}`,
              ).toContain(target);
            }
          }
          ts.forEachChild(node, inspect);
        };
        inspect(sourceFile);
      }
    }
  });

  it("keeps Turbo's target-aware compatibility rules no broader than needed", async () => {
    const turbo = JSON.parse(
      await readFile("turbo.json", "utf8"),
    ) as TurboBoundaries;
    const tags = turbo.boundaries.tags;
    for (const tag of [
      "template-shared",
      "template-core",
      "template-builtin-presets",
    ]) {
      expect(tags[tag]?.dependencies.allow).not.toContain("template-cli");
    }
    expect(tags["template-checks"]?.dependencies.allow).not.toContain(
      "template-cli",
    );
    for (const [tag, rule] of Object.entries(tags)) {
      expect(rule.dependencies.allow).toContain(tag);
    }
  });
});
