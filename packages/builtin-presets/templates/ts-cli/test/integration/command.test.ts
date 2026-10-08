import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

describe("CLI 契约", () => {
  it("查询成功默认返回结构化数据，也支持中文文本", async () => {
    const output = testRuntime(["lookup", "ada"]);
    expect(await runCli(output.runtime)).toBe(0);
    expect(JSON.parse(output.stdout())).toEqual({
      schemaVersion: "1",
      command: "lookup",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });
    expect(output.stderr()).toBe("");
    const human = testRuntime(["lookup", "ada", "--output-format", "text"]);
    expect(await runCli(human.runtime)).toBe(0);
    expect(human.stdout()).toContain("找到记录");
    expect(human.stdout()).toContain("Ada Lovelace");
  });

  it("未找到记录是已声明失败，非法名称是用法错误", async () => {
    const missing = testRuntime(["lookup", "missing"]);
    expect(await runCli(missing.runtime)).toBe(1);
    expect(missing.stdout()).toBe("");
    expect(JSON.parse(missing.stderr())).toMatchObject({
      kind: "failure",
      variant: "notFound",
      data: { name: "missing" },
    });
    for (const args of [["lookup"], ["lookup", "   "]]) {
      const invalid = testRuntime([...args, "--output-format", "text"]);
      expect(await runCli(invalid.runtime)).toBe(2);
      expect(invalid.stdout()).toBe("");
      expect(JSON.parse(invalid.stderr())).toMatchObject({
        kind: "usageFailure",
      });
    }
  });

  it("帮助和版本使用 manifest 身份，schema 导出完整契约", async () => {
    const version = testRuntime(["--version"]);
    expect(await runCli(version.runtime)).toBe(0);
    expect(version.stdout()).toBe(
      `${identity.commandName} ${identity.version}\n`,
    );
    const help = testRuntime(["--help"]);
    expect(await runCli(help.runtime)).toBe(0);
    expect(help.stdout()).toContain(identity.commandName);
    expect(help.stdout()).toContain("lookup");
    expect(help.stdout()).toContain("schema");
    const schema = testRuntime(["schema"]);
    expect(await runCli(schema.runtime)).toBe(0);
    const humanSchema = testRuntime(["schema", "--output-format", "text"]);
    expect(await runCli(humanSchema.runtime)).toBe(0);
    expect(humanSchema.stdout()).toContain("CLI 契约");
    expect(humanSchema.stdout()).toContain('"commands"');
    const manifest = JSON.parse(schema.stdout()).data.manifest;
    expect(manifest).toMatchObject({
      commands: {
        lookup: {
          input: {
            inputSchema: {
              properties: { name: { pattern: "^[a-z]+$" } },
              required: ["name"],
            },
          },
          success: { variants: { found: { exitCode: 0 } } },
          failures: { notFound: { exitCode: 1 } },
        },
        schema: { success: { variants: { exported: { exitCode: 0 } } } },
      },
      controls: {
        output: {
          defaultFormat: "structured",
          formats: ["structured", "text"],
        },
      },
      usageFailure: { exitCode: 2 },
    });
  });

  it("等待输出完成，仅 stdout EPIPE 安静成功", async () => {
    const output = testRuntime(["lookup", "ada"]);
    expect(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
    ).toBe(0);
    expect(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw new Error("disk");
        },
      }),
    ).toBe(70);
    const failure = testRuntime(["lookup", "missing"]);
    expect(
      await runCli({
        ...failure.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
    ).toBe(70);
    const argv = ["node", identity.commandName];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("内部细节");
      },
    });
    expect(await runCli({ ...output.runtime, argv })).toBe(70);
    expect(output.stderr()).toContain("命令执行失败");
    expect(output.stderr()).not.toContain("内部细节");
  });
});
