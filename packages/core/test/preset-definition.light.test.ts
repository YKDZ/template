import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  definePreset,
  presetOwnerFromManifest,
} from "../src/preset-definition.ts";

void describe("预设声明", () => {
  void it("从所属包的真实公开导出推导预设身份", () => {
    assert.deepStrictEqual(
      presetOwnerFromManifest({
        name: "@demo/example-preset",
        exports: {
          "./internal": {
            source: "./internal.ts",
          },
          "./template": {
            source: "./template/definition.ts",
          },
        },
      }),
      {
        packageName: "@demo/example-preset",
        exportPath: "./template",
      },
    );
    assert.throws(
      () =>
        presetOwnerFromManifest({
          name: "@demo/hidden-preset",
          exports: { "./template": "./template/index.js" },
        }),
      /未公开当前模板入口/u,
    );
  });

  void it("保留稳定节点、来源成员和允许操作", () => {
    const library = {
      identity: "library",
      instance: "independent" as const,
    };
    const layout = { packageDirectory: "modules" };
    const creationInput = {
      init: { variant: "published" },
      add: { variant: "private" },
    };
    const preset = definePreset({
      metadata: {
        alias: "ts-lib",
        title: "TypeScript 库",
        description: "严格 TypeScript 库。",
      },
      operations: ["init", "add"],
      nodes: { library: { reference: library, layout, creationInput } },
    });

    assert.strictEqual(preset.kind, "preset");
    assert.strictEqual(preset.nodes.library?.reference, library);
    assert.strictEqual(preset.nodes.library?.layout, layout);
    assert.strictEqual(preset.nodes.library?.creationInput, creationInput);
    assert.deepStrictEqual(preset.operations, ["init", "add"]);
  });

  void it("接受所属包的根公开导出作为预设项目身份", () => {
    const preset = definePreset({
      metadata: {
        alias: "application",
        title: "应用",
        description: "包含项目级投影的应用预设。",
      },
      operations: ["init"],
      nodes: {
        application: {
          reference: { identity: "application", instance: "independent" },
        },
      },
      owner: { packageName: "@demo/application-preset", exportPath: "." },
      project: () => [],
    });

    assert.deepStrictEqual(preset.owner, {
      packageName: "@demo/application-preset",
      exportPath: ".",
    });
  });

  void it("拒绝无节点、空操作、无效节点名和重复独立参考", () => {
    const library = {
      identity: "library",
      instance: "independent" as const,
    };
    const metadata = {
      alias: "ts-lib",
      title: "TypeScript 库",
      description: "严格 TypeScript 库。",
    };

    assert.throws(
      () => definePreset({ metadata, operations: ["init"], nodes: {} }),
      /至少声明一个节点/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: [],
          nodes: { library: { reference: library } },
        }),
      /至少允许一种操作/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: { "bad node": { reference: library } },
        }),
      /节点身份无效/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            first: { reference: library },
            second: { reference: library },
          },
        }),
      /重复选择独立参考/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            library: {
              reference: library,
              creationInput: { add: { variant: "private" } },
            },
          },
        }),
      /创建输入操作无效/u,
    );
  });
});
