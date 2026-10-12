import {
  assertPackageContributionCommandNames,
  validateCliCommandName,
  type PackageContribution,
} from "@ykdz/template-core/package-contribution";
import { describe, expect, it } from "vitest";

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

describe("CLI command contribution policy", () => {
  it.each([
    ["tools/release", "path"],
    ["tools\\release", "path"],
    ["release tool", "whitespace"],
    ["release\u0000", "control"],
    ["-release", "leading hyphen"],
    ["Release", "lowercase ASCII"],
    ["发布", "lowercase ASCII"],
  ])("拒绝格式不合法的命令名 %j", (commandName, message) => {
    expect(() => validateCliCommandName(commandName)).toThrow(message);
  });

  it("接受符合格式的命令名，并拒绝工作区中已使用的名称", () => {
    expect(validateCliCommandName("release-tool")).toBe("release-tool");
    expect(() =>
      validateCliCommandName("release-tool", ["release-tool"]),
    ).toThrow("already used by another workspace package");
  });

  it("rejects workspace command conflicts across package roles", () => {
    expect(() =>
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
    ).toThrow(
      'CLI command name "release" from @demo/tooling is already used by @demo/cli',
    );
  });
});
