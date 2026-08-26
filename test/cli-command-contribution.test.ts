import { describe, expect, it } from "vitest";

import {
  assertPackageContributionCommandNames,
  validateCliCommandName,
  type PackageContribution,
} from "#template-core/package-contribution";

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
    ["node", "reserved system tool"],
  ])("rejects unsafe CLI command %j", (commandName, message) => {
    expect(() => validateCliCommandName(commandName)).toThrow(message);
  });

  it("accepts one portable command and rejects an occupied command", () => {
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
