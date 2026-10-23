import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cliCommandIdentity,
  projectCliPackageManifest,
  validateCliCommandName,
} from "../../src/publication/cli-command-identity.ts";

void describe("CLI command identity", () => {
  for (const { name, command, message } of [
    { name: "path separator", command: "tools/release", message: "path" },
    { name: "backslash path", command: "tools\\release", message: "path" },
    { name: "whitespace", command: "release tool", message: "whitespace" },
    { name: "control character", command: "release\u0000", message: "control" },
    { name: "leading hyphen", command: "-release", message: "leading hyphen" },
    { name: "uppercase ASCII", command: "Release", message: "lowercase ASCII" },
    { name: "non-ASCII", command: "发布", message: "lowercase ASCII" },
  ]) {
    void it(`拒绝格式不合法的命令名：${name}`, () => {
      assert.throws(
        () => validateCliCommandName(command),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(message));
          return true;
        },
      );
    });
  }

  void it("接受符合格式的命令名，并拒绝工作区中已使用的名称", () => {
    assert.equal(validateCliCommandName("release-tool", []), "release-tool");
    assert.throws(
      () => validateCliCommandName("release-tool", ["release-tool"]),
      /already used by another workspace package/,
    );
  });

  void it("derives command and unpublished version only from manifest facts", () => {
    assert.deepStrictEqual(
      cliCommandIdentity({ bin: { release: "./dist/cli.js" } }),
      { commandName: "release", version: "unpublished" },
    );
    assert.deepStrictEqual(
      cliCommandIdentity({
        bin: { ship: "./dist/cli.js" },
        version: "2.3.4",
      }),
      { commandName: "ship", version: "2.3.4" },
    );
  });

  void it("按目标命令名和 Node 大版本转换原生清单", () => {
    assert.deepStrictEqual(
      projectCliPackageManifest({
        manifest: {
          name: "@ykdz/reference-ts-cli",
          private: true,
          bin: { "reference-cli": "./dist/cli.js" },
          files: ["dist"],
          engines: { node: "^24.21.0" },
        },
        commandName: "public-cli",
        nodeDeclaration: "24.21.0",
      }),
      {
        name: "@ykdz/reference-ts-cli",
        private: true,
        bin: { "public-cli": "./dist/cli.js" },
        files: ["dist"],
        engines: { node: ">=24" },
      },
    );
  });

  void it("拒绝无效命令名和含多个入口的原生清单", () => {
    const manifest = {
      name: "@ykdz/reference-ts-cli",
      bin: { "reference-cli": "./dist/cli.js" },
    };
    assert.throws(
      () =>
        projectCliPackageManifest({
          manifest,
          commandName: "public--cli",
          nodeDeclaration: "24",
        }),
      /single hyphens/u,
    );
    assert.throws(
      () =>
        projectCliPackageManifest({
          manifest: {
            ...manifest,
            bin: {
              "reference-cli": "./dist/cli.js",
              other: "./dist/other.js",
            },
          },
          commandName: "public-cli",
          nodeDeclaration: "24.21.0",
        }),
      /exactly one bin/u,
    );
  });

  void it("rejects malformed manifest identity facts", () => {
    assert.throws(() => cliCommandIdentity(null), /must be an object/);
    assert.throws(() => cliCommandIdentity({ bin: {} }), /exactly one bin/);
    assert.throws(
      () =>
        cliCommandIdentity({
          bin: { release: "./dist/cli.js", ship: "./dist/cli.js" },
        }),
      /exactly one bin/,
    );
    assert.throws(
      () => cliCommandIdentity({ bin: { release: "./src/cli.ts" } }),
      /must execute ".\/dist\/cli\.js"/,
    );
    assert.throws(
      () =>
        cliCommandIdentity({
          bin: { release: "./dist/cli.js" },
          version: 1,
        }),
      /version must be a non-empty string/,
    );
  });
});
