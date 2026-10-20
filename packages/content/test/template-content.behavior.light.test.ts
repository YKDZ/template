import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preset } from "@ykdz/preset-ts-lib/template";
import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

void describe("公开模板内容集合", () => {
  void it("只用集合成员完成库初始化及其公开共享依赖展开", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-content-ts-lib-")),
      "demo",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      ["packages/lib", "packages/typescript-config"].toSorted(),
    );
  });
});
