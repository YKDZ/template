import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, type TemplatePreset } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const vuePreset = templateContent.find(
  (member): member is TemplatePreset =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-vue-app",
);
assert.ok(vuePreset, "内容集合缺少 Vue 应用预设");

void describe("公开内容集合中的 Vue 预设", () => {
  void it("通过公开声明初始化原生 Vue 应用及其共享依赖", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-content-vue-preset-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });
    assert.ok(
      templateContent.includes(vuePreset),
      "内容集合应提供 Vue 应用预设",
    );

    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: vuePreset.identity }] },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".template/blueprint.json"),
          "utf8",
        ),
      )
        .packages.map((definition: { path: string }) => definition.path)
        .toSorted(),
      [
        "apps/web",
        "packages/typescript-config",
        "packages/vue-shared",
      ].toSorted(),
    );
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
      ).dependencies,
      {
        "@demo/vue-shared": "workspace:*",
        pinia: "catalog:",
        vue: "catalog:",
      },
    );
  });
});
