import { describe, expect, it } from "vitest";

import { runCli, type CliRuntime } from "../../src/main.ts";

let commandName = "demo-cli";
// @template-anchor cli-test-command-name

function testRuntime(
  args: readonly string[],
  version = "1.2.3",
): {
  readonly runtime: CliRuntime;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    runtime: {
      argv: ["node", commandName, ...args],
      streams: {
        stdin: {},
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) },
      },
      cwd: "/workspace",
      env: { MODE: "test" },
      tty: { stdin: false, stdout: false, stderr: false },
      version,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI command control", () => {
  it("parses greet and writes business output to the injected stream", async () => {
    const output = testRuntime(["greet", "  Ada Lovelace  "]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("Hello, Ada Lovelace\n");
    expect(output.stderr()).toBe("");
  });

  it("renders the injected package version", async () => {
    const output = testRuntime(["--version"], "9.8.7");

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("9.8.7\n");
    expect(output.stderr()).toBe("");
  });

  it("renders Commander help without exiting the process", async () => {
    const output = testRuntime(["--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain(
      `Usage: ${commandName} [options] [command]`,
    );
    expect(output.stdout()).toContain("greet <name>");
    expect(output.stderr()).toBe("");
  });

  it("reports missing arguments as Commander usage errors", async () => {
    const output = testRuntime(["greet"]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain(
      "error: missing required argument 'name'",
    );
    expect(output.stderr()).toContain(`Usage: ${commandName} greet`);
  });

  it("adapts business validation into a testable command error", async () => {
    const output = testRuntime(["greet", "   "]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error: Name must not be empty");
  });
});
