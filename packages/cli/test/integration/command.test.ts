import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import {
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
} from "@ykdz/template-core/project-linking-v2";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { runCli, type CliRuntime } from "../../src/main.ts";

function requireLinkableAddablePreset(): {
  readonly name: string;
  readonly consumerPath: string;
} {
  const context = createGenerationContext({
    targetDir: "demo",
    defaultPackageScope: "acme",
    toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
  });
  for (const definition of builtInPresetRegistry.all()) {
    const packageLeafName = "utility";
    const packagePath = definition.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    if (packagePath === undefined || !definition.planPackageAddition) continue;
    const provider = definition.planPackageAddition({
      context,
      packageLeafName,
      packagePath,
    });
    if (!canProvideSourceConditionPackageNameImport(provider)) continue;
    const consumers = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions;
    const consumer = consumers.find(
      (candidate) =>
        canConsumeNodePackageNameImport(candidate) &&
        canLinkNodePackageRoles(
          candidate.definition.role,
          provider.definition.role,
        ),
    );
    if (consumer !== undefined) {
      return {
        name: definition.metadata.name,
        consumerPath: consumer.definition.path,
      };
    }
  }
  throw new Error("CLI integration tests require a linkable addable Preset");
}

const { name: addablePresetName, consumerPath } =
  requireLinkableAddablePreset();

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
      commandName: "template",
      write: ({ destination, chunk }) => {
        if (destination === "stdout") stdout += chunk;
        else stderr += chunk;
      },
      cwd: "/workspace",
      env: {},
      version,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("template CLI command control", () => {
  it("renders the injected package version", async () => {
    const output = testRuntime(["--version"], "9.8.7");

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toBe("template 9.8.7\n");
    expect(output.stderr()).toBe("");
  });

  it("renders bare command and help as Chinese discoverability output", async () => {
    for (const args of [[], ["--help", "--output-format", "structured"]]) {
      const output = testRuntime(args);
      expect(await runCli(output.runtime)).toBe(0);
      expect(output.stdout()).toContain("用法");
      for (const command of ["init", "add", "presets", "blueprint", "schema"])
        expect(output.stdout()).toContain(command);
      expect(output.stderr()).toBe("");
    }
  });

  it("lists deterministic Presets through declared human and JSON modes without writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-presets-"),
    );
    try {
      await writeFile(path.join(workspace, "marker"), "unchanged");
      const before = await workspaceByteSnapshot(workspace);
      const output = testRuntime(["presets", "--output-format", "text"]);
      const repeat = testRuntime(["presets", "--output-format", "text"]);
      const jsonOutput = testRuntime(["presets"], "9.8.7");

      await expect(
        Promise.all([
          runCli({ ...output.runtime, cwd: workspace }),
          runCli({ ...repeat.runtime, cwd: workspace }),
          runCli({ ...jsonOutput.runtime, cwd: workspace }),
        ]),
      ).resolves.toEqual([0, 0, 0]);
      expect(output.stdout()).toMatch(/^内置预设/mu);
      expect(output.stdout()).toBe(repeat.stdout());
      expect(output.stdout()).toMatch(/\n  [^:\s]+:/u);
      expect(output.stdout()).toContain(
        "TypeScript 命令行工具 - TypeScript 命令行包。",
      );
      expect(output.stdout()).not.toContain("TypeScript command-line package.");
      expect(output.stderr()).toBe("");
      expect(JSON.parse(jsonOutput.stdout())).toMatchObject({
        schemaVersion: "1",
        command: "presets",
        kind: "data",
        variant: "listed",
        data: {
          presets: expect.arrayContaining([
            expect.objectContaining({ name: "ts-cli" }),
          ]),
        },
      });
      expect(jsonOutput.stderr()).toBe("");
      expect(await workspaceByteSnapshot(workspace)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates a Project Blueprint through declared human and JSON modes without writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-blueprint-"),
    );
    try {
      const blueprintPath = path.join(workspace, "blueprint.json");
      await writeFile(
        blueprintPath,
        JSON.stringify({
          schemaVersion: 3,
          packages: [
            {
              name: "@demo/library",
              packageDefinitionId: `package-${"1".repeat(64)}`,
              path: "packages/library",
              role: "shared-library",
            },
          ],
        }),
      );
      const output = testRuntime([
        "blueprint",
        "validate",
        blueprintPath,
        "--output-format",
        "text",
      ]);
      const jsonOutput = testRuntime(
        ["blueprint", "validate", blueprintPath],
        "9.8.7",
      );
      const before = await workspaceByteSnapshot(workspace);

      await expect(
        Promise.all([runCli(output.runtime), runCli(jsonOutput.runtime)]),
      ).resolves.toEqual([0, 0]);
      expect(output.stdout()).toContain("蓝图有效。");
      expect(output.stderr()).toBe("");
      expect(JSON.parse(jsonOutput.stdout())).toEqual({
        schemaVersion: "1",
        command: "validateBlueprint",
        kind: "data",
        variant: "valid",
        data: { path: blueprintPath },
      });
      expect(jsonOutput.stderr()).toBe("");
      expect(await workspaceByteSnapshot(workspace)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns invalid Project Blueprints as typed business results", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-invalid-blueprint-"),
    );
    try {
      const blueprintPath = path.join(workspace, "blueprint.json");
      await writeFile(
        blueprintPath,
        JSON.stringify({ schemaVersion: 1, packages: [] }),
      );
      const human = testRuntime([
        "blueprint",
        "validate",
        blueprintPath,
        "--output-format",
        "text",
      ]);
      const json = testRuntime(["blueprint", "validate", blueprintPath]);
      await expect(
        Promise.all([runCli(human.runtime), runCli(json.runtime)]),
      ).resolves.toEqual([1, 1]);
      expect(human.stdout()).toBe("");
      expect(human.stderr()).toContain("蓝图无效");
      expect(human.stderr()).toContain(".schemaVersion");
      expect(JSON.parse(json.stderr())).toMatchObject({
        schemaVersion: "1",
        command: "validateBlueprint",
        kind: "failure",
        variant: "invalid",
        data: { path: blueprintPath, issues: [{ path: ".schemaVersion" }] },
      });
      expect(json.stdout()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps unreadable and unparseable Blueprints as operation failures", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-blueprint-operation-"),
    );
    try {
      const malformedPath = path.join(workspace, "malformed.json");
      await writeFile(malformedPath, "{ invalid-source-fragment");
      const before = await workspaceByteSnapshot(workspace);
      for (const [file, reason] of [
        ["missing.json", "not-found"],
        ["malformed.json", "invalid-json"],
      ]) {
        const output = testRuntime([
          "blueprint",
          "validate",
          path.join(workspace, file!),
        ]);
        await expect(runCli(output.runtime)).resolves.toBe(1);
        expect(JSON.parse(output.stderr())).toMatchObject({
          kind: "failure",
          variant: "operationFailed",
          data: { reason },
        });
        expect(output.stdout()).toBe("");
        expect(output.stderr()).not.toContain("invalid-source-fragment");
      }
      expect(await workspaceByteSnapshot(workspace)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("contains process initialization failures in the real entry point", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-deleted-cwd-"),
    );
    const result = await execa(
      process.execPath,
      [
        "--conditions=source",
        "--input-type=module",
        "-e",
        'import { rmdirSync } from "node:fs"; const target = process.argv[1]; const entry = process.argv[2]; process.chdir(target); rmdirSync(target); process.argv = ["node", "template", "presets"]; await import(entry);',
        workspace,
        new URL("../../src/cli.ts", import.meta.url).href,
      ],
      { reject: false },
    );
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("命令执行失败；请检查运行环境或报告此问题。");
  });

  it("reports unexpected argv failures without leaking implementation details", async () => {
    const output = testRuntime([]);
    const argv = ["node", "template"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("private detail");
      },
    });
    expect(await runCli({ ...output.runtime, argv })).toBe(70);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("命令执行失败");
    expect(output.stderr()).not.toContain("private detail");
  });

  it("reports malformed calls as stderr JSON even in text mode", async () => {
    for (const args of [
      ["preset"],
      ["add", "package"],
      ["presets", "--machine"],
      ["init", "destination", "--preset"],
      ["presets", "extra"],
    ]) {
      const output = testRuntime([...args, "--output-format", "text"]);
      expect(await runCli(output.runtime)).toBe(2);
      expect(output.stdout()).toBe("");
      expect(JSON.parse(output.stderr())).toMatchObject({
        schemaVersion: "1",
        kind: "usageFailure",
        issues: expect.any(Array),
      });
    }
  });

  it("only accepts stdout EPIPE and awaits output failures", async () => {
    for (const args of [["--help"], ["presets"]]) {
      const output = testRuntime(args);
      expect(
        await runCli({
          ...output.runtime,
          write: async () => {
            throw Object.assign(new Error("pipe"), { code: "EPIPE" });
          },
        }),
      ).toBe(0);
      expect(output.stderr()).toBe("");
    }
    const output = testRuntime(["--version"]);
    expect(
      await runCli({
        ...output.runtime,
        write: async (event) => {
          if (event.destination === "stdout")
            throw Object.assign(new Error("disk"), { code: "ENOSPC" });
          await output.runtime.write(event);
        },
      }),
    ).toBe(70);
    expect(output.stderr()).toContain("命令执行失败");
    const usage = testRuntime(["unknown"]);
    expect(
      await runCli({
        ...usage.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
    ).toBe(70);
  });

  it("renders options and preset choices from the executable commands", async () => {
    for (const args of [
      ["add", "package", "--help"],
      ["init", "--help"],
    ]) {
      const output = testRuntime(args);
      expect(await runCli(output.runtime)).toBe(0);
      for (const option of [
        "--preset",
        "--name",
        "--path",
        "--dry-run",
        "--output-format",
      ])
        expect(output.stdout()).toContain(option);
      expect(output.stdout()).toContain(addablePresetName);
      expect(output.stderr()).toBe("");
    }
  });

  it("runs init dry-run JSON through the injected cwd without writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-init-"));
    try {
      const output = testRuntime([
        "init",
        "demo",
        "--preset",
        addablePresetName,
        "--scope",
        "@acme",
        "--dry-run",
      ]);
      await expect(runCli({ ...output.runtime, cwd: workspace })).resolves.toBe(
        0,
      );
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "init",
        kind: "data",
        variant: "planned",
        data: {
          dryRun: true,
          targetDir: "demo",
          blueprint: { schemaVersion: 3 },
          resolved: { scope: "acme" },
          followUpDocument: { enabled: true, path: "TODO.md" },
        },
      });
      const human = testRuntime([
        "init",
        "demo",
        "--preset",
        addablePresetName,
        "--scope",
        "acme",
        "--name",
        "utility",
        "--path",
        "packages/utility",
        "--dry-run",
        "--output-format",
        "text",
      ]);
      expect(await runCli({ ...human.runtime, cwd: workspace })).toBe(0);
      expect(human.stdout()).toContain("@acme/utility");
      expect(human.stdout()).toContain("packages/utility");
      expect(human.stdout()).toContain(
        releaseToolchainSnapshot.packageManagerPin,
      );
      expect(output.stderr()).toBe("");
      await expect(stat(path.join(workspace, "demo"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("initializes the release snapshot without reading any environment fact", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-snapshot-init-"),
    );
    const output = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
    ]);
    const unreadableEnvironment = new Proxy(
      {},
      {
        get() {
          throw new Error("init must not read the environment");
        },
      },
    );

    await expect(
      runCli({
        ...output.runtime,
        cwd: workspace,
        env: unreadableEnvironment,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      kind: "data",
      variant: "initialized",
    });
    expect(JSON.parse(output.stdout()).data.toolchain).toEqual({
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    });
    const rootManifest = JSON.parse(
      await readFile(path.join(workspace, "demo/package.json"), "utf8"),
    ) as {
      readonly engines: { readonly node: string };
      readonly packageManager: string;
    };
    expect(rootManifest.engines.node).toBe(
      releaseToolchainSnapshot.nodeVersion,
    );
    expect(rootManifest.packageManager).toBe(
      releaseToolchainSnapshot.packageManagerPin,
    );
  });

  it("rejects invalid init identities through the input schema without writing", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-invalid-init-"),
    );
    try {
      const output = testRuntime([
        "init",
        "invalid",
        "--preset",
        addablePresetName,
        "--name",
        "@acme/invalid",
        "--path",
        ".git/invalid/source",
        "--scope",
        "Bad Scope",
        "--output-format",
        "text",
      ]);
      expect(await runCli({ ...output.runtime, cwd: workspace })).toBe(2);
      expect(output.stdout()).toBe("");
      expect(JSON.parse(output.stderr())).toMatchObject({
        kind: "usageFailure",
      });
      expect(output.stderr()).toContain("包叶名称");
      expect(output.stderr()).toContain("安全路径段");
      expect(output.stderr()).toContain("npm scope");
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unknown presets and fixed topology overrides without writing", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-init-usage-"),
    );
    try {
      const fixed = builtInPresetRegistry
        .all()
        .find((definition) => definition.initialPrimaryPackage === undefined)!;
      for (const args of [
        ["init", "unknown", "--preset", "missing-preset"],
        ["init", "fixed", "--preset", fixed.metadata.name, "--name", "renamed"],
      ]) {
        const output = testRuntime(args);
        expect(await runCli({ ...output.runtime, cwd: workspace })).toBe(2);
        expect(JSON.parse(output.stderr())).toMatchObject({
          kind: "usageFailure",
        });
        expect(output.stdout()).toBe("");
      }
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports initialization target failure without modifying the target", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-init-conflict-"),
    );
    try {
      await mkdir(path.join(workspace, "demo"));
      await writeFile(path.join(workspace, "demo/keep.txt"), "keep");
      const before = await workspaceByteSnapshot(workspace);
      const output = testRuntime([
        "init",
        "demo",
        "--preset",
        addablePresetName,
      ]);
      expect(await runCli({ ...output.runtime, cwd: workspace })).toBe(1);
      expect(output.stdout()).toBe("");
      expect(JSON.parse(output.stderr())).toMatchObject({
        kind: "failure",
        variant: "operationFailed",
        data: { phase: "render" },
      });
      expect(await workspaceByteSnapshot(workspace)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exports the executable contract through schema", async () => {
    const output = testRuntime(["schema"]);
    expect(await runCli(output.runtime)).toBe(0);
    expect(output.stderr()).toBe("");
    const result = JSON.parse(output.stdout());
    expect(result).toMatchObject({
      schemaVersion: "1",
      command: "schema",
      kind: "data",
      variant: "exported",
    });
    const humanSchema = testRuntime(["schema", "--output-format", "text"]);
    expect(await runCli(humanSchema.runtime)).toBe(0);
    expect(humanSchema.stdout()).toContain("CLI 契约");
    expect(humanSchema.stdout()).toContain('"commands"');
    expect(result.data.manifest).toMatchObject({
      root: "template",
      commands: {
        init: {
          input: {
            inputSchema: {
              required: expect.arrayContaining(["dir", "preset"]),
            },
          },
          success: {
            variants: {
              initialized: { exitCode: 0 },
              planned: { exitCode: 0 },
            },
          },
        },
        addPackage: {
          fields: expect.arrayContaining([
            expect.objectContaining({
              key: "linkFrom",
              kind: "repeatableOption",
              longOption: "--link-from",
              required: false,
              description: expect.any(String),
            }),
          ]),
          failures: { conflict: { exitCode: 1 } },
        },
        validateBlueprint: {
          failures: {
            invalid: { exitCode: 1 },
            operationFailed: { exitCode: 1 },
          },
        },
        presets: { success: { variants: { listed: { exitCode: 0 } } } },
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

  it("plans add package from injected cwd with path and link intent without writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-add-"));
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
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
      consumerPath,
      "--dry-run",
    ]);
    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
      }),
    ).resolves.toBe(0);

    const result = JSON.parse(output.stdout());
    expect(result).toMatchObject({
      command: "addPackage",
      kind: "data",
      variant: "planned",
    });
    const json = result.data;
    expect(json).toMatchObject({
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

    const beforeUnknownConsumer = await workspaceByteSnapshot(target);
    const unknownConsumer = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
      "--link-from",
      "packages/missing",
    ]);
    await expect(
      runCli({
        ...unknownConsumer.runtime,
        cwd: target,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(unknownConsumer.stderr())).toMatchObject({
      kind: "failure",
      variant: "invalidRequest",
      data: { issues: [{ code: "UNKNOWN_LINK_FROM" }] },
    });
    expect(unknownConsumer.stdout()).toBe("");
    expect(await workspaceByteSnapshot(target)).toEqual(beforeUnknownConsumer);

    const apply = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
    ]);
    await expect(
      runCli({
        ...apply.runtime,
        cwd: target,
      }),
    ).resolves.toBe(0);
    const beforeMissingLink = await workspaceByteSnapshot(target);
    const missingLink = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
      "--link-from",
      consumerPath,
    ]);
    await expect(
      runCli({
        ...missingLink.runtime,
        cwd: target,
      }),
    ).resolves.toBe(1);
    const missingLinkResult = JSON.parse(missingLink.stderr());
    expect(missingLinkResult).toMatchObject({
      kind: "failure",
      variant: "conflict",
    });
    const missingLinkJson = missingLinkResult.data;
    expect(missingLinkJson).toMatchObject({
      conflicts: [
        {
          kind: "missing-link",
          missingLink: {
            consumerPackagePath: consumerPath,
            providerPackagePath: "packages/utility",
          },
          existing: {
            name: "@acme/utility",
            path: "packages/utility",
            role: "shared-library",
          },
          requested: {
            name: "@acme/utility",
            path: "packages/utility",
            role: "shared-library",
          },
        },
      ],
    });
    expect(
      Object.keys(missingLinkJson.conflicts[0].existing).toSorted(),
    ).toEqual(["name", "path", "role"]);
    expect(
      Object.keys(missingLinkJson.conflicts[0].requested).toSorted(),
    ).toEqual(["name", "path", "role"]);
    expect(missingLink.stdout()).toBe("");
    expect(await workspaceByteSnapshot(target)).toEqual(beforeMissingLink);

    const retry = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
    ]);
    await expect(
      runCli({
        ...retry.runtime,
        cwd: target,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(retry.stdout())).toMatchObject({
      kind: "data",
      variant: "unchanged",
      data: { actions: [] },
    });
  });

  it("short-circuits reserved link input and explains human correction", async () => {
    const json = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--link-from",
      "dist/app",
    ]);
    await expect(
      runCli({ ...json.runtime, cwd: "/not-a-generated-repository" }),
    ).resolves.toBe(2);
    expect(JSON.parse(json.stderr())).toMatchObject({ kind: "usageFailure" });
    expect(json.stderr()).toContain("不能使用保留工作区目录");

    const human = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--link-from",
      "dist/app",
    ]);
    await expect(
      runCli({ ...human.runtime, cwd: "/not-a-generated-repository" }),
    ).resolves.toBe(2);
    expect(human.stderr()).toContain("不能使用保留工作区目录");
    expect(human.stdout()).toBe("");
  });

  it("plans an addition without inspecting an unrelated missing Package manifest", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-missing-existing-manifest-"),
    );
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
    ).resolves.toBe(0);

    const target = path.join(workspace, "demo");
    const blueprint = JSON.parse(
      await readFile(path.join(target, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    const unrelatedManifest = path.join(
      target,
      blueprint.packages[0]!.path,
      "package.json",
    );
    await unlink(unrelatedManifest);
    const before = await workspaceByteSnapshot(target);
    const output = testRuntime([
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "utility",
      "--path",
      "packages/utility",
      "--dry-run",
    ]);

    const exitCode = await runCli({
      ...output.runtime,
      cwd: target,
    });
    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout()).data).toMatchObject({
      dryRun: true,
      actions: expect.arrayContaining([
        expect.objectContaining({
          path: "packages/utility/package.json",
          action: "create",
        }),
      ]),
    });
    await expect(stat(unrelatedManifest)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await workspaceByteSnapshot(target)).toEqual(before);
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
      ]);
      await expect(
        runCli({
          ...initOutput.runtime,
          cwd: workspace,
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
      ]);

      await expect(
        runCli({
          ...output.runtime,
          cwd: target,
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(output.stderr()).data).toMatchObject({
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
      expect(output.stdout()).toBe("");
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
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
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
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stderr()).data).toMatchObject({
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
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
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
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(output.stderr()).data).toMatchObject({
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
    ]);
    await expect(
      runCli({
        ...initOutput.runtime,
        cwd: workspace,
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
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
      }),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr())).toMatchObject({ kind: "usageFailure" });
    expect(output.stderr()).toContain("不能使用保留工作区目录");
    expect(output.stdout()).toBe("");
    expect(await workspaceByteSnapshot(target)).toEqual(before);
  });
});
