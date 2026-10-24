import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectCliPackageManifest } from "../../template/package-manifest.ts";

const manifest = {
  name: "@ykdz/reference-ts-cli",
  private: true,
  bin: { "reference-cli": "./dist/cli.js" },
  files: ["dist"],
  engines: { node: "^24.21.0" },
};

void describe("CLI 模板清单转换", () => {
  void it("按目标命令名和 Node 大版本转换，并保留其余清单事实", () => {
    assert.deepStrictEqual(
      projectCliPackageManifest({
        manifest,
        commandName: "public-cli",
        nodeDeclaration: "24.21.0",
      }),
      {
        ...manifest,
        bin: { "public-cli": "./dist/cli.js" },
        engines: { node: ">=24" },
      },
    );
    assert.deepStrictEqual(manifest.bin, { "reference-cli": "./dist/cli.js" });
    assert.deepStrictEqual(manifest.engines, { node: "^24.21.0" });
  });

  void it("拒绝不能作为目标命令名的名称", () => {
    for (const commandName of [
      "",
      "tools/release",
      "tools\\release",
      "release tool",
      "release\u0000",
      "-release",
      "Release",
      "发布",
      "public--cli",
    ]) {
      assert.throws(
        () =>
          projectCliPackageManifest({
            manifest,
            commandName,
            nodeDeclaration: "24",
          }),
        /命令名/u,
      );
    }
  });

  void it("拒绝没有唯一字符串入口的原生清单", () => {
    for (const invalid of [
      null,
      {},
      { bin: {} },
      { bin: { release: "./dist/cli.js", ship: "./dist/cli.js" } },
      { bin: { release: 1 } },
    ]) {
      assert.throws(
        () =>
          projectCliPackageManifest({
            manifest: invalid,
            commandName: "public-cli",
            nodeDeclaration: "24",
          }),
        /CLI 包清单/u,
      );
    }
  });
});
