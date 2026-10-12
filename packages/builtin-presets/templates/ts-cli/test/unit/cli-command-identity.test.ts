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
  ])("拒绝格式不合法的命令名：$name", ({ command, message }) => {
    expect(() => validateCliCommandName(command)).toThrow(message);
  });

  it("接受符合格式的命令名，并拒绝工作区中已使用的名称", () => {
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
