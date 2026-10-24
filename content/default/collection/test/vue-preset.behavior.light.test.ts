import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-vue-app/template",
      load: () => import("@ykdz/reference-vue-app/template"),
    },
    {
      specifier: "@ykdz/preset-vue-app/template",
      load: () => import("@ykdz/preset-vue-app/template"),
    },
  ],
});

const vuePreset = content.find(
  (member) =>
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
    const generator = createDefaultGenerator({ content });
    assert.ok(content.includes(vuePreset), "内容集合应提供 Vue 应用预设");

    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: vuePreset.identity }] },
      conventions: {
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
      [".", "apps/web", "packages/tooling-config"].toSorted(),
    );
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
      ).dependencies,
      {
        "@vue/devtools-api": "catalog:",
        pinia: "catalog:",
        vue: "catalog:",
      },
    );
  });
});
