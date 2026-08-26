import { describe, expect, it } from "vitest";

import {
  cliCommandIdentity,
  validateCliCommandName,
} from "../../src/cli-command-identity.ts";

describe("CLI command identity", () => {
  it.each([
    { name: "path separator", command: "tools/release", message: "path" },
    { name: "backslash path", command: "tools\\release", message: "path" },
    { name: "whitespace", command: "release tool", message: "whitespace" },
    { name: "control character", command: "release\u0000", message: "control" },
    { name: "leading hyphen", command: "-release", message: "leading hyphen" },
    { name: "uppercase ASCII", command: "Release", message: "lowercase ASCII" },
    { name: "non-ASCII", command: "发布", message: "lowercase ASCII" },
    { name: "system tool", command: "node", message: "reserved system tool" },
  ])("rejects an unsafe command name: $name", ({ command, message }) => {
    expect(() => validateCliCommandName(command)).toThrow(message);
  });

  it("accepts a portable name unless another workspace command occupies it", () => {
    expect(validateCliCommandName("release-tool", [])).toBe("release-tool");
    expect(() =>
      validateCliCommandName("release-tool", ["release-tool"]),
    ).toThrow("already used by another workspace package");
  });

  it("derives command and unpublished version only from manifest facts", () => {
    expect(cliCommandIdentity({ bin: { release: "./dist/cli.js" } })).toEqual({
      commandName: "release",
      version: "unpublished",
    });
    expect(
      cliCommandIdentity({
        bin: { ship: "./dist/cli.js" },
        version: "2.3.4",
      }),
    ).toEqual({ commandName: "ship", version: "2.3.4" });
  });

  it("rejects malformed manifest identity facts", () => {
    expect(() => cliCommandIdentity(null)).toThrow("must be an object");
    expect(() => cliCommandIdentity({ bin: {} })).toThrow("exactly one bin");
    expect(() =>
      cliCommandIdentity({
        bin: { release: "./dist/cli.js", ship: "./dist/cli.js" },
      }),
    ).toThrow("exactly one bin");
    expect(() =>
      cliCommandIdentity({ bin: { release: "./src/cli.ts" } }),
    ).toThrow('must execute "./dist/cli.js"');
    expect(() =>
      cliCommandIdentity({
        bin: { release: "./dist/cli.js" },
        version: 1,
      }),
    ).toThrow("version must be a non-empty string");
  });
});
