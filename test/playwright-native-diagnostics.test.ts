import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  return object.properties.flatMap((member) => {
    if (
      !ts.isPropertyAssignment(member) ||
      !ts.isIdentifier(member.name) ||
      member.name.text !== name
    ) {
      return [];
    }
    return [member.initializer];
  })[0];
}

async function loadMaintainedConfig(
  relativePath: string,
): Promise<ts.ObjectLiteralExpression> {
  const source = ts.createSourceFile(
    relativePath,
    await readFile(path.join(process.cwd(), relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let config: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      config = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (config === undefined)
    throw new Error(`Missing defineConfig in ${relativePath}`);
  return config;
}

describe("maintained Playwright diagnostic configuration", () => {
  it.each([
    "packages/builtin-presets/templates/vue-app/playwright.config.ts",
    "packages/builtin-presets/templates/vue-hono-app/web/playwright.config.ts",
    "packages/builtin-presets/templates/vike-app/web/playwright.config.ts",
  ])("uses native failure diagnostics in %s", async (relativePath) => {
    const config = await loadMaintainedConfig(relativePath);
    const use = property(config, "use");

    expect(use !== undefined && ts.isObjectLiteralExpression(use)).toBe(true);
    if (use === undefined || !ts.isObjectLiteralExpression(use)) return;
    const trace = property(use, "trace");
    const reporter = property(config, "reporter");

    expect(trace !== undefined && ts.isStringLiteral(trace) && trace.text).toBe(
      "retain-on-failure",
    );
    expect(
      reporter !== undefined && ts.isArrayLiteralExpression(reporter),
    ).toBe(true);
    if (reporter === undefined || !ts.isArrayLiteralExpression(reporter))
      return;
    expect(
      reporter.elements.map((entry) =>
        ts.isArrayLiteralExpression(entry) &&
        entry.elements[0] !== undefined &&
        ts.isStringLiteral(entry.elements[0])
          ? entry.elements[0].text
          : undefined,
      ),
    ).toEqual(["list", "html"]);
    expect(property(config, "retries")).toBeUndefined();
    expect(property(use, "video")).toBeUndefined();
  });
});
