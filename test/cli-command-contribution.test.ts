import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertPackageContributionCommandNames,
  validateCliCommandName,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";

import { testEach, assertThrowsContaining } from "./assertions.ts";

function contribution(options: {
  readonly name: string;
  readonly path: string;
  readonly role?: PackageContribution["definition"]["role"];
  readonly bin?: Readonly<Record<string, string>>;
}): PackageContribution {
  return {
    definition: {
      name: options.name,
      path: options.path,
      role: options.role ?? "cli-tool",
    },
    manifest: {
      name: options.name,
      ...(options.bin === undefined ? {} : { bin: options.bin }),
    },
    exposure: { exports: {}, imports: {} },
    operations: [],
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: { ecosystems: [], interval: "weekly" },
    },
    environmentNeeds: [],
  };
}

void describe("CLI command contribution policy", () => {
  testEach(
    [
      ["tools/release", "path"],
      ["tools\\release", "path"],
      ["release tool", "whitespace"],
      ["release\u0000", "control"],
      ["-release", "leading hyphen"],
      ["Release", "lowercase ASCII"],
      ["发布", "lowercase ASCII"],
    ],
    "拒绝格式不合法的命令名 %j",
    (commandName, message) => {
      assertThrowsContaining(
        () => validateCliCommandName(commandName),
        message,
      );
    },
  );

  void it("接受符合格式的命令名，并拒绝工作区中已使用的名称", () => {
    assert.strictEqual(validateCliCommandName("release-tool"), "release-tool");
    assert.throws(
      () => validateCliCommandName("release-tool", ["release-tool"]),
      (error) =>
        error instanceof Error &&
        error.message.includes("already used by another workspace package"),
    );
  });

  void it("rejects workspace command conflicts across package roles", () => {
    assert.throws(
      () =>
        assertPackageContributionCommandNames([
          contribution({
            name: "@demo/cli",
            path: "packages/cli",
            bin: { release: "./dist/cli.js" },
          }),
          contribution({
            name: "@demo/tooling",
            path: "packages/tooling",
            role: "shared-library",
            bin: { release: "./dist/tooling.js" },
          }),
        ]),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          'CLI command name "release" from @demo/tooling is already used by @demo/cli',
        ),
    );
  });
});
