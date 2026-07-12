import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { builtInPresetRegistry } from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

describe("cut-over CLI", () => {
  const preset = builtInPresetRegistry.all()[0]!;
  const addablePreset = builtInPresetRegistry
    .all()
    .find((definition) => definition.planPackageAddition !== undefined)!;
  it("adds a package without replacing the caller's working-directory inode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-add-cwd-"));
    const target = path.join(workspace, "@acme", "project");
    const cli = path.resolve("packages/cli/src/cli.ts");

    await execa(
      "node",
      [
        "--conditions=source",
        cli,
        "init",
        target,
        "--preset",
        addablePreset.metadata.name,
        "--scope",
        "acme",
        "--yes",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );

    const result = await execa(
      "bash",
      [
        "-lc",
        `cd ${JSON.stringify(target)} && node --conditions=source ${JSON.stringify(cli)} add package --preset ${addablePreset.metadata.name} --name second --path packages/second && pwd && test -f packages/second/package.json`,
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );

    expect(result.stdout).toContain(target);
    await expect(
      readFile(path.join(target, "packages/second/package.json"), "utf8"),
    ).resolves.toContain('"name": "@acme/second"');
  });

  it("exposes only the supported catalog, initialization, addition, and Blueprint workflows", async () => {
    const help = await execa("node", [
      "--conditions=source",
      "packages/cli/src/cli.ts",
      "--help",
    ]);

    expect(help.stdout).toContain("template presets");
    expect(help.stdout).toContain("template init <dir>");
    expect(help.stdout).toContain("template add package");
    expect(help.stdout).toContain("template blueprint validate <path>");
    expect(help.stdout).not.toContain("schema preset");
    expect(help.stdout).not.toContain("schema");
    expect(help.stdout).not.toContain("preset validate");
  });

  it("plans and persists registry-owned Blueprint v2 metadata without Preset identity", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cutover-"));
    const target = path.join(workspace, "library");
    const command = ["--conditions=source", "packages/cli/src/cli.ts"];
    const dryRun = await execa(
      "node",
      [
        ...command,
        "init",
        target,
        "--preset",
        preset.metadata.name,
        "--yes",
        "--dry-run",
        "--json",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    const planned: unknown = JSON.parse(dryRun.stdout);
    expect(planned).toMatchObject({
      blueprint: { schemaVersion: 2 },
      generationRecord: { preset: preset.metadata.name },
    });
    expect(JSON.stringify(planned)).not.toContain('"blueprint":{"preset"');

    await execa(
      "node",
      [...command, "init", target, "--preset", preset.metadata.name, "--yes"],
      {
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      },
    );
    const blueprint = JSON.parse(
      await readFile(path.join(target, ".template/blueprint.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(blueprint).toMatchObject({ schemaVersion: 2 });
    expect(blueprint).not.toHaveProperty("preset");
    expect(blueprint).not.toHaveProperty("features");
  });

  it("writes Template Source-backed next-step instructions unless --no-todo is selected", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-todo-"));
    const withTodo = path.join(workspace, "with-todo");
    const withoutTodo = path.join(workspace, "without-todo");
    const command = ["--conditions=source", "packages/cli/src/cli.ts"];

    const withTodoResult = await execa(
      "node",
      [...command, "init", withTodo, "--preset", preset.metadata.name, "--yes"],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    expect(withTodoResult.stdout).toContain("Next steps");
    expect(withTodoResult.stdout).toContain("pnpm install");
    await expect(
      readFile(path.join(withTodo, "TODO.md"), "utf8"),
    ).resolves.toContain("1. `pnpm install`");

    await execa(
      "node",
      [
        ...command,
        "init",
        withoutTodo,
        "--preset",
        preset.metadata.name,
        "--yes",
        "--no-todo",
      ],
      { env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" } },
    );
    await expect(
      readFile(path.join(withoutTodo, "TODO.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
