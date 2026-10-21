import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { templateReferencePackages } from "@ykdz/template-content";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import ts from "typescript";

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
    await readFile(relativePath, "utf8"),
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

void describe("maintained Playwright diagnostic configuration", () => {
  const playwrightConfiguration = (name: string) => {
    const reference = templateReferencePackages.find(
      (item) => item.identity.packageName === name,
    );
    assert.ok(reference, `内容集合缺少参考包：${name}`);
    return resolveTemplateSource(
      reference.definition.source("playwright.config.ts"),
      ".",
    );
  };
  for (const relativePath of [
    playwrightConfiguration("@ykdz/reference-vue-app"),
    playwrightConfiguration("@ykdz/reference-vike-web"),
  ]) {
    void it(`uses native failure diagnostics in ${relativePath}`, async () => {
      const config = await loadMaintainedConfig(relativePath);
      const use = property(config, "use");

      assert.strictEqual(
        use !== undefined && ts.isObjectLiteralExpression(use),
        true,
      );
      if (use === undefined || !ts.isObjectLiteralExpression(use)) return;
      const trace = property(use, "trace");
      const reporter = property(config, "reporter");

      assert.strictEqual(
        trace !== undefined && ts.isStringLiteral(trace) && trace.text,
        "retain-on-failure",
      );
      assert.strictEqual(
        reporter !== undefined && ts.isArrayLiteralExpression(reporter),
        true,
      );
      if (reporter === undefined || !ts.isArrayLiteralExpression(reporter))
        return;
      assert.deepStrictEqual(
        reporter.elements.map((entry) =>
          ts.isArrayLiteralExpression(entry) &&
          entry.elements[0] !== undefined &&
          ts.isStringLiteral(entry.elements[0])
            ? entry.elements[0].text
            : undefined,
        ),
        ["list", "html"],
      );
      assert.strictEqual(property(config, "retries"), undefined);
      assert.strictEqual(property(use, "video"), undefined);
    });
  }
});
