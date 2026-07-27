import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { builtInPresetRegistry } from "#template-builtin-presets";

import { runCli, type CliRuntime } from "../../src/main.ts";

function requireAddablePresetName(): string {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.planPackageAddition !== undefined);
  if (definition === undefined) {
    throw new Error("CLI integration tests require an addable Preset");
  }
  return definition.metadata.name;
}

const addablePresetName = requireAddablePresetName();

async function workspaceByteSnapshot(
  root: string,
  relative = "",
): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceByteSnapshot(root, child)));
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(root, child);
    files.push({
      path: child.split(path.sep).join("/"),
      mode: (await stat(filePath)).mode & 0o777,
      content: (await readFile(filePath)).toString("base64"),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

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
      argv: ["node", "template", ...args],
      streams: {
        stdin: {},
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) },
      },
      cwd: "/workspace",
      env: {},
      tty: { stdin: false, stdout: false, stderr: false },
      version,
      confirmation: {
        confirm: async () => true,
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("template CLI command control", () => {
  it("renders the injected package version", async () => {
    const output = testRuntime(["--version"], "9.8.7");

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("9.8.7\n");
    expect(output.stderr()).toBe("");
  });

  it("renders top-level command help through the injected stream", async () => {
    const output = testRuntime(["--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("Usage: template [options] [command]");
    expect(output.stdout()).toContain("init <dir>");
    expect(output.stdout()).toContain("add");
    expect(output.stdout()).toContain("presets");
    expect(output.stdout()).toContain("blueprint");
    expect(output.stderr()).toBe("");
  });

  it("lists Built-in Presets through the declared subcommand", async () => {
    const output = testRuntime(["presets"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("Built-in presets");
    expect(output.stdout()).toMatch(/\n  [^:\s]+:/u);
    expect(output.stderr()).toBe("");
  });

  it("validates a Project Blueprint through the nested command", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      JSON.stringify({
        schemaVersion: 2,
        packages: [
          {
            name: "@demo/library",
            path: "packages/library",
            role: "shared-library",
          },
        ],
      }),
    );
    const output = testRuntime(["blueprint", "validate", blueprintPath]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("Blueprint is valid\n");
    expect(output.stderr()).toBe("");
  });

  it("reports Project Blueprint validation failures without terminating the process", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-invalid-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      JSON.stringify({ schemaVersion: 1, packages: [] }),
    );
    const output = testRuntime(["blueprint", "validate", blueprintPath]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("Error:");
    expect(output.stderr()).toContain("Run `template --help` for usage.");
  });

  it("reports unknown commands as Commander usage errors", async () => {
    const output = testRuntime(["unknown"]);

    await expect(runCli(output.runtime)).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error: unknown command 'unknown'");
    expect(output.stderr()).toContain("Usage: template");
  });

  it("reports missing commands and required options as usage errors", async () => {
    const missingCommand = testRuntime([]);
    await expect(runCli(missingCommand.runtime)).resolves.toBe(1);
    expect(missingCommand.stderr()).toContain("error: missing command");
    expect(missingCommand.stderr()).toContain("Usage: template");

    const missingOptions = testRuntime(["add", "package"]);
    await expect(runCli(missingOptions.runtime)).resolves.toBe(1);
    expect(missingOptions.stderr()).toContain(
      "required option '--preset <name>' not specified",
    );
    expect(missingOptions.stderr()).toContain("Usage: template add package");
  });

  it("renders add package help from the nested command options", async () => {
    const output = testRuntime(["add", "package", "--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("Usage: template add package [options]");
    expect(output.stdout()).toContain("--preset <name>");
    expect(output.stdout()).toContain("--name <name>");
    expect(output.stdout()).toContain("--path <path>");
    expect(output.stdout()).toContain("--link-from <path>");
    expect(output.stdout()).toContain("--dry-run");
    expect(output.stdout()).toContain("--json");
    expect(output.stderr()).toBe("");
  });

  it("renders every init option from its command declaration", async () => {
    const output = testRuntime(["init", "--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("Usage: template init [options] <dir>");
    expect(output.stdout()).toContain("--preset <name>");
    expect(output.stdout()).toContain("--scope <name>");
    expect(output.stdout()).toContain("-y, --yes");
    expect(output.stdout()).toContain("--dry-run");
    expect(output.stdout()).toContain("--json");
    expect(output.stdout()).toContain("--no-todo");
    expect(output.stderr()).toBe("");
  });

  it("runs init dry-run JSON through injected cwd and environment without writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-init-"));
    const output = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "@acme",
      "--dry-run",
      "--json",
    ]);
    const runtime: CliRuntime = {
      ...output.runtime,
      cwd: workspace,
      env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
    };

    await expect(runCli(runtime)).resolves.toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "init",
      dryRun: true,
      targetDir: "demo",
      blueprint: { schemaVersion: 2 },
      followUpDocument: { enabled: true, path: "TODO.md" },
    });
    expect(output.stderr()).toBe("");
    await expect(stat(path.join(workspace, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses the injected confirmation boundary and leaves a cancelled init untouched", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-confirm-"),
    );
    const output = testRuntime(["init", "demo", "--preset", addablePresetName]);
    const requests: string[] = [];
    const runtime: CliRuntime = {
      ...output.runtime,
      cwd: workspace,
      env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      tty: { stdin: true, stdout: true, stderr: true },
      confirmation: {
        async confirm(request) {
          requests.push(`${request.message}\n${request.prompt}`);
          return false;
        },
      },
    };

    await expect(runCli(runtime)).resolves.toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("Planned project");
    expect(requests[0]).toContain("Generate this project? [y/N]");
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("Error: Init cancelled");
    await expect(stat(path.join(workspace, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("plans add package from injected cwd with path and link intent without writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-add-"));
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
      "--yes",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(0);

    const target = path.join(workspace, "demo");
    const output = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
      "--link-from",
      "packages/demo",
      "--dry-run",
      "--json",
    ]);
    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 1,
      command: "add package",
      status: "success",
      dryRun: true,
      actions: expect.arrayContaining([
        expect.objectContaining({
          path: "packages/utility/package.json",
          action: "create",
        }),
      ]),
    });
    expect(output.stderr()).toBe("");
    await expect(
      stat(path.join(target, "packages/utility")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { dryRun: true, label: "dry-run" },
    { dryRun: false, label: "apply" },
  ])(
    "rejects $label when the new Package Path root already exists with zero writes",
    async ({ dryRun }) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-cli-existing-package-root-"),
      );
      const initOutput = testRuntime([
        "init",
        "demo",
        "--preset",
        addablePresetName,
        "--scope",
        "acme",
        "--yes",
      ]);
      await expect(
        runCli({
          ...initOutput.runtime,
          cwd: workspace,
          env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
        }),
      ).resolves.toBe(0);

      const target = path.join(workspace, "demo");
      await mkdir(path.join(target, "services/existing"), { recursive: true });
      await writeFile(path.join(target, "services/existing/OWNER"), "user\n");
      const before = await workspaceByteSnapshot(target);
      const output = testRuntime([
        "add",
        "package",
        "--preset",
        addablePresetName,
        "--name",
        "existing",
        "--path",
        "services/existing",
        ...(dryRun ? ["--dry-run"] : []),
        "--json",
      ]);

      await expect(
        runCli({
          ...output.runtime,
          cwd: target,
          env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(output.stdout())).toMatchObject({
        schemaVersion: 1,
        command: "add package",
        status: "conflict",
        dryRun,
        actions: [],
        conflicts: [
          {
            path: "services/existing",
            driver: "precondition",
            reason: expect.stringContaining(
              "Package Path services/existing already exists",
            ),
          },
        ],
      });
      expect(output.stderr()).toBe("");
      expect(await workspaceByteSnapshot(target)).toEqual(before);
    },
  );

  it("rejects a symbolic-link Package Path root without touching its target", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-symlink-package-root-"),
    );
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
      "--yes",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(0);

    const target = path.join(workspace, "demo");
    await mkdir(path.join(target, "services"), { recursive: true });
    await mkdir(path.join(target, "user-owned"));
    await writeFile(path.join(target, "user-owned/OWNER"), "user\n");
    await symlink("../user-owned", path.join(target, "services/linked"));
    const before = await workspaceByteSnapshot(target);
    const output = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "linked",
      "--path",
      "services/linked",
      "--json",
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      status: "conflict",
      actions: [],
      conflicts: [
        {
          path: "services/linked",
          driver: "precondition",
          reason: expect.stringContaining("existing symbolic-link"),
        },
      ],
    });
    expect(await workspaceByteSnapshot(target)).toEqual(before);
    await expect(
      readFile(path.join(target, "user-owned/OWNER"), "utf8"),
    ).resolves.toBe("user\n");
  });

  it("rejects a regular-file Package Path root with zero writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-file-package-root-"),
    );
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
      "--yes",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(0);

    const target = path.join(workspace, "demo");
    await mkdir(path.join(target, "services"), { recursive: true });
    await writeFile(path.join(target, "services/occupied"), "user\n");
    const before = await workspaceByteSnapshot(target);
    const output = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "occupied",
      "--path",
      "services/occupied",
      "--dry-run",
      "--json",
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      status: "conflict",
      actions: [],
      conflicts: [
        {
          path: "services/occupied",
          driver: "precondition",
          reason: expect.stringContaining("existing file"),
        },
      ],
    });
    expect(await workspaceByteSnapshot(target)).toEqual(before);
  });

  it("rejects reserved dist Package Addition planning in dry-run JSON mode with zero writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-reserved-package-root-"),
    );
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
      "--yes",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(0);

    const target = path.join(workspace, "demo");
    const before = await workspaceByteSnapshot(target);
    const output = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "evil",
      "--path",
      "dist/evil",
      "--dry-run",
      "--json",
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
        env: { TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback" },
      }),
    ).resolves.toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain(
      "Package Path dist/evil uses reserved workspace collection dist",
    );
    expect(await workspaceByteSnapshot(target)).toEqual(before);
  });
});
