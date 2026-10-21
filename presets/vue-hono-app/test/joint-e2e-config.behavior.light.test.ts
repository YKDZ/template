import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const configurationPath = fileURLToPath(
  new URL("../resources/joint-e2e/playwright.config.ts", import.meta.url),
);

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

void describe("Vue-Hono 联合浏览器验收配置", () => {
  void it("保留浏览器失败诊断并读取所属预设提供的实际包身份", async () => {
    const source = ts.createSourceFile(
      configurationPath,
      await readFile(configurationPath, "utf8"),
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

    assert.ok(config);
    const use = property(config, "use");
    assert.ok(use && ts.isObjectLiteralExpression(use));
    const trace = property(use, "trace");
    const reporter = property(config, "reporter");
    assert.ok(trace && ts.isStringLiteral(trace));
    assert.strictEqual(trace.text, "retain-on-failure");
    assert.ok(reporter && ts.isArrayLiteralExpression(reporter));
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

    const configText = await readFile(configurationPath, "utf8");
    assert.match(configText, /PLAYWRIGHT_API_PACKAGE_NAME/u);
    assert.match(configText, /PLAYWRIGHT_WEB_PACKAGE_NAME/u);
    assert.match(configText, /joint-e2e\.json/u);
  });
});
