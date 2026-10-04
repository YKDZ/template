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
    expect(output.stdout()).toBe("template 9.8.7\n");
    expect(output.stderr()).toBe("");
  });

  it("renders bare command and help as Chinese discoverability output", async () => {
    const bare = testRuntime([]);
    await expect(runCli(bare.runtime)).resolves.toBe(0);
    expect(bare.stdout()).toMatch(/^template 1\.2\.3\n/u);
    expect(bare.stdout()).toContain("用法: template [options] [command]");
    expect(bare.stderr()).toBe("");

    const output = testRuntime(["--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toMatch(/^template 1\.2\.3\n/u);
    expect(output.stdout().match(/^template 1\.2\.3$/gmu)).toHaveLength(1);
    expect(output.stdout()).toContain("用法: template [options] [command]");
    expect(output.stdout()).toContain("init <dir>");
    expect(output.stdout()).toContain("add");
    expect(output.stdout()).toContain("presets");
    expect(output.stdout()).toContain("blueprint");
    expect(output.stderr()).toBe("");
  });

  it("lists deterministic Presets through declared human and JSON modes without writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-presets-"),
    );
    try {
      await writeFile(path.join(workspace, "marker"), "unchanged");
      const before = await workspaceByteSnapshot(workspace);
      const output = testRuntime(["presets"]);
      const repeat = testRuntime(["presets"]);
      const jsonOutput = testRuntime(["presets", "--json"], "9.8.7");

      await expect(
        Promise.all([
          runCli({ ...output.runtime, cwd: workspace }),
          runCli({ ...repeat.runtime, cwd: workspace }),
          runCli({ ...jsonOutput.runtime, cwd: workspace }),
        ]),
      ).resolves.toEqual([0, 0, 0]);
      expect(output.stdout()).toMatch(/^template 1\.2\.3\n内置预设/mu);
      expect(output.stdout()).toBe(repeat.stdout());
      expect(output.stdout()).toMatch(/\n  [^:\s]+:/u);
      expect(output.stdout()).toContain(
        "TypeScript 命令行工具 - TypeScript 命令行包。",
      );
      expect(output.stdout()).not.toContain("TypeScript command-line package.");
      expect(output.stderr()).toBe("");
      expect(JSON.parse(jsonOutput.stdout())).toMatchObject({
        schemaVersion: 1,
        cliVersion: "9.8.7",
        command: "presets",
        status: "success",
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
      const output = testRuntime(["blueprint", "validate", blueprintPath]);
      const jsonOutput = testRuntime(
        ["blueprint", "validate", blueprintPath, "--json"],
        "9.8.7",
      );
      const before = await workspaceByteSnapshot(workspace);

      await expect(
        Promise.all([runCli(output.runtime), runCli(jsonOutput.runtime)]),
      ).resolves.toEqual([0, 0]);
      expect(output.stdout()).toMatch(/^template 1\.2\.3\n/u);
      expect(output.stdout()).toContain("蓝图有效。");
      expect(output.stderr()).toBe("");
      expect(JSON.parse(jsonOutput.stdout())).toEqual({
        schemaVersion: 1,
        command: "blueprint validate",
        status: "success",
        path: blueprintPath,
        cliVersion: "9.8.7",
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
      const output = testRuntime(["blueprint", "validate", blueprintPath]);
      const jsonOutput = testRuntime([
        "blueprint",
        "validate",
        blueprintPath,
        "--json",
      ]);

      await expect(
        Promise.all([runCli(output.runtime), runCli(jsonOutput.runtime)]),
      ).resolves.toEqual([1, 1]);
      expect(output.stdout()).toBe("");
      expect(output.stderr()).toMatch(/^template 1\.2\.3\n/u);
      expect(output.stderr()).toContain("蓝图无效。");
      expect(output.stderr()).toContain(".schemaVersion:");
      expect(output.stderr()).toContain("该位置的 Blueprint 定义不符合要求");
      expect(output.stderr()).not.toContain(
        "Unsupported Local Template Metadata schema version 1; expected 3",
      );
      expect(output.stderr()).toContain("建议:");
      expect(output.stderr()).not.toContain("Run `template --help`");
      expect(JSON.parse(jsonOutput.stdout())).toMatchObject({
        schemaVersion: 1,
        command: "blueprint validate",
        status: "invalid",
        code: "BLUEPRINT_INVALID",
        path: blueprintPath,
        issues: [
          {
            path: ".schemaVersion",
            message:
              "Unsupported Local Template Metadata schema version 1; expected 3",
          },
        ],
      });
      expect(jsonOutput.stderr()).toBe("");
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
      const missingPath = path.join(workspace, "missing.json");
      await writeFile(malformedPath, "{ invalid-source-fragment");
      const before = await workspaceByteSnapshot(workspace);
      const missing = testRuntime([
        "blueprint",
        "validate",
        missingPath,
        "--json",
      ]);
      const malformed = testRuntime([
        "blueprint",
        "validate",
        malformedPath,
        "--json",
      ]);

      await expect(
        Promise.all([runCli(missing.runtime), runCli(malformed.runtime)]),
      ).resolves.toEqual([65, 65]);
      expect(JSON.parse(missing.stdout())).toMatchObject({
        schemaVersion: 1,
        command: "blueprint validate",
        status: "operation-failure",
        code: "OPERATION_BLUEPRINT_READ_FAILED",
        path: missingPath,
        reason: "not-found",
        error: {
          message: "找不到 Blueprint 文件。",
          suggestion: "检查路径是否正确后重新验证。",
        },
      });
      expect(missing.stderr()).toBe("");
      expect(JSON.parse(malformed.stdout())).toMatchObject({
        schemaVersion: 1,
        command: "blueprint validate",
        status: "operation-failure",
        code: "OPERATION_BLUEPRINT_PARSE_FAILED",
        path: malformedPath,
        reason: "invalid-json",
        error: {
          message: "Blueprint JSON 格式无效。",
          suggestion:
            "修正 JSON 语法后重新验证；若文件来源不明确，请人工处理。",
        },
      });
      expect(malformed.stdout()).not.toContain("SyntaxError");
      expect(malformed.stdout()).not.toContain("Unexpected end");
      expect(malformed.stdout()).not.toContain("invalid-source-fragment");
      expect(malformed.stderr()).toBe("");
      expect(await workspaceByteSnapshot(workspace)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("converges injected boundary failures without leaking their message", async () => {
    const output = testRuntime(["unknown"]);
    const argv = ["node", "template", "unknown"];
    Object.defineProperty(argv, Symbol.iterator, {
      value() {
        throw new Error("injected implementation detail");
      },
    });
    const runtime: CliRuntime = {
      ...output.runtime,
      argv,
    };

    await expect(runCli(runtime)).resolves.toBe(65);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toMatch(/^template 1\.2\.3\n/u);
    expect(output.stderr()).toContain("OPERATION_INTERNAL_ERROR");
    expect(output.stderr()).not.toContain("injected implementation detail");
  });

  it("reports unknown commands from shared command facts", async () => {
    const output = testRuntime(["preset"]);

    await expect(runCli(output.runtime)).resolves.toBe(64);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toMatch(/^template 1\.2\.3\n/u);
    expect(output.stderr()).toContain("USAGE_UNKNOWN_COMMAND");
    expect(output.stderr()).toContain("Did you mean presets?");
    expect(output.stderr()).toContain("用法: template");

    const jsonOutput = testRuntime(["preset", "--json"], "9.8.7");
    await expect(runCli(jsonOutput.runtime)).resolves.toBe(64);
    expect(JSON.parse(jsonOutput.stdout())).toMatchObject({
      schemaVersion: 1,
      cliVersion: "9.8.7",
      command: "template",
      code: "USAGE_UNKNOWN_COMMAND",
      status: "error",
    });
    expect(jsonOutput.stderr()).toBe("");
  });

  it("only treats stdout EPIPE from final control output as successful truncation", async () => {
    const epiped = testRuntime(["--help"]);
    const epipedRuntime: CliRuntime = {
      ...epiped.runtime,
      streams: {
        ...epiped.runtime.streams,
        stdout: {
          write() {
            throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
          },
        },
      },
    };
    await expect(runCli(epipedRuntime)).resolves.toBe(0);

    const closedResultEpiped = testRuntime(["presets"]);
    const closedResultEpipedRuntime: CliRuntime = {
      ...closedResultEpiped.runtime,
      streams: {
        ...closedResultEpiped.runtime.streams,
        stdout: {
          write() {
            throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
          },
        },
      },
    };
    await expect(runCli(closedResultEpipedRuntime)).resolves.toBe(0);

    const broken = testRuntime(["--version"]);
    const brokenRuntime: CliRuntime = {
      ...broken.runtime,
      streams: {
        ...broken.runtime.streams,
        stdout: {
          write() {
            throw Object.assign(new Error("disk failure"), { code: "ENOSPC" });
          },
        },
      },
    };
    await expect(runCli(brokenRuntime)).resolves.toBe(65);

    const stderrEpiped = testRuntime(["preset"]);
    const stderrEpipedRuntime: CliRuntime = {
      ...stderrEpiped.runtime,
      streams: {
        ...stderrEpiped.runtime.streams,
        stderr: {
          write() {
            throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
          },
        },
      },
    };
    await expect(runCli(stderrEpipedRuntime)).resolves.toBe(65);
  });

  it("reports missing required options and invalid options as usage errors", async () => {
    const missingOptions = testRuntime(["add", "package"]);
    await expect(runCli(missingOptions.runtime)).resolves.toBe(64);
    expect(missingOptions.stderr()).toContain("USAGE_MISSING_REQUIRED_OPTION");
    expect(missingOptions.stderr()).toContain("用法: template add package");

    const invalidOption = testRuntime(["presets", "--machine"]);
    await expect(runCli(invalidOption.runtime)).resolves.toBe(64);
    expect(invalidOption.stderr()).toContain("USAGE_UNKNOWN_OPTION");

    const optionMissingArgument = testRuntime([
      "init",
      "destination",
      "--preset",
    ]);
    await expect(runCli(optionMissingArgument.runtime)).resolves.toBe(64);
    expect(optionMissingArgument.stderr()).toContain(
      "USAGE_OPTION_MISSING_ARGUMENT",
    );
    expect(optionMissingArgument.stderr()).toContain(
      "选项 '--preset <name>' 缺少参数。",
    );
    expect(optionMissingArgument.stderr()).toContain(
      "用法: template init [options] <dir>",
    );

    const excessArguments = testRuntime(["presets", "extra"]);
    await expect(runCli(excessArguments.runtime)).resolves.toBe(64);
    expect(excessArguments.stderr()).toContain("USAGE_EXCESS_ARGUMENTS");
    expect(excessArguments.stderr()).toContain("命令 presets 参数过多。");
    expect(excessArguments.stderr()).not.toMatch(
      /too many arguments|Expected/u,
    );
    expect(excessArguments.stderr()).toContain(
      "用法: template presets [options]",
    );

    const singleArgumentCommand = testRuntime([
      "blueprint",
      "validate",
      "first",
      "second",
    ]);
    await expect(runCli(singleArgumentCommand.runtime)).resolves.toBe(64);
    expect(singleArgumentCommand.stderr()).toContain("USAGE_EXCESS_ARGUMENTS");
    expect(singleArgumentCommand.stderr()).toContain(
      "命令 blueprint validate 参数过多。",
    );
    expect(singleArgumentCommand.stderr()).not.toMatch(
      /too many arguments|Expected/u,
    );
    expect(singleArgumentCommand.stderr()).toContain(
      "用法: template blueprint validate [options] <path>",
    );
  });

  it("converges argv derivation failures before command parsing", async () => {
    const output = testRuntime(["unknown"]);
    const argv = ["node", "template", "unknown"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("argv derivation detail");
      },
    });

    await expect(
      runCli({
        ...output.runtime,
        argv,
      }),
    ).resolves.toBe(65);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("OPERATION_INTERNAL_ERROR");
    expect(output.stderr()).not.toContain("argv derivation detail");
  });

  it("converges interactive confirmation output failures", async () => {
    const args = ["init", "destination", "--preset", addablePresetName];
    const epiped = testRuntime(args);
    await expect(
      runCli({
        ...epiped.runtime,
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: {
          async confirm() {
            throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
          },
        },
      }),
    ).resolves.toBe(0);

    const broken = testRuntime(args);
    await expect(
      runCli({
        ...broken.runtime,
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: {
          async confirm() {
            throw Object.assign(new Error("full device"), { code: "ENOSPC" });
          },
        },
      }),
    ).resolves.toBe(65);

    const generic = testRuntime(args);
    await expect(
      runCli({
        ...generic.runtime,
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: {
          async confirm() {
            throw new Error("prompt adapter implementation detail");
          },
        },
      }),
    ).resolves.toBe(65);
    expect(generic.stderr()).toContain("OPERATION_INTERNAL_ERROR");
    expect(generic.stderr()).not.toContain(
      "prompt adapter implementation detail",
    );

    const codedGeneric = testRuntime(args);
    await expect(
      runCli({
        ...codedGeneric.runtime,
        tty: { stdin: true, stdout: true, stderr: true },
        confirmation: {
          async confirm() {
            throw Object.assign(new Error("prompt adapter code detail"), {
              code: "PROMPT_ADAPTER_FAILED",
            });
          },
        },
      }),
    ).resolves.toBe(65);
    expect(codedGeneric.stderr()).toContain("OPERATION_INTERNAL_ERROR");
    expect(codedGeneric.stderr()).not.toContain("PROMPT_ADAPTER_FAILED");
    expect(codedGeneric.stderr()).not.toContain("prompt adapter code detail");
  });

  it("renders add package help from the nested command options", async () => {
    const output = testRuntime(["add", "package", "--help"]);

    await expect(runCli(output.runtime)).resolves.toBe(0);
    expect(output.stdout()).toContain("用法: template add package [options]");
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
    expect(output.stdout()).toContain("用法: template init [options] <dir>");
    expect(output.stdout()).toContain("初始化前解析预设");
    expect(output.stdout()).toContain("--preset <name>");
    expect(output.stdout()).toContain("--name <name>");
    expect(output.stdout()).toContain("--path <path>");
    expect(output.stdout()).toContain("--scope <name>");
    expect(output.stdout()).toContain("-y, --yes");
    expect(output.stdout()).toContain("--dry-run");
    expect(output.stdout()).toContain("--json");
    expect(output.stdout()).toContain("--no-todo");
    expect(output.stderr()).toBe("");
  });

  it("runs init dry-run JSON through the injected cwd without writing", async () => {
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
    };

    await expect(runCli(runtime)).resolves.toBe(0);
    const json = JSON.parse(output.stdout());
    expect(json).toMatchObject({
      command: "init",
      dryRun: true,
      targetDir: "demo",
      blueprint: { schemaVersion: 3 },
      followUpDocument: { enabled: true, path: "TODO.md" },
    });
    expect(json).toMatchObject({
      cliVersion: "1.2.3",
      status: "success",
    });
    expect(output.stderr()).toBe("");
    await expect(stat(path.join(workspace, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
      "--yes",
      "--json",
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
    expect(JSON.parse(output.stdout()).toolchain).toEqual({
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

  it("uses the injected confirmation boundary and leaves a cancelled init untouched", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-confirm-"),
    );
    const output = testRuntime(["init", "demo", "--preset", addablePresetName]);
    const requests: string[] = [];
    const runtime: CliRuntime = {
      ...output.runtime,
      cwd: workspace,
      tty: { stdin: true, stdout: true, stderr: true },
      confirmation: {
        async confirm(request) {
          requests.push(`${request.message}\n${request.prompt}`);
          return false;
        },
      },
    };

    await expect(runCli(runtime)).resolves.toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("计划生成的项目");
    expect(requests[0]).toContain("预设:");
    expect(requests[0]).toContain("名称:");
    expect(requests[0]).toContain("路径:");
    expect(requests[0]).toContain("Scope:");
    expect(requests[0]).toContain("生成这个项目？[y/N]");
    expect(output.stdout()).toBe("template 1.2.3\n");
    expect(output.stderr()).toContain("已取消初始化；没有写入目标目录。");
    expect(output.stderr()).not.toMatch(/^template /u);
    await expect(stat(path.join(workspace, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aggregates invalid init identity overrides with zero target writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-invalid-init-identity-"),
    );
    const output = testRuntime([
      "init",
      "invalid",
      "--preset",
      builtInPresetRegistry
        .all()
        .find((definition) => definition.initialPrimaryPackage !== undefined)!
        .metadata.name,
      "--name",
      "@acme/invalid",
      "--path",
      ".git/invalid/source",
      "--scope",
      "Bad Scope",
      "--yes",
    ]);

    await expect(
      runCli({
        ...output.runtime,
        cwd: workspace,
      }),
    ).resolves.toBe(64);
    expect(output.stderr()).toContain("USAGE_INIT_INVALID");
    expect(output.stderr()).toContain("--name 必须是有效的无 scope 包叶名称。");
    expect(output.stderr()).toContain("--path 必须恰好包含两个安全路径段。");
    expect(output.stderr()).toContain(
      "--scope 必须是不含空白字符的有效 npm scope。",
    );
    await expect(stat(path.join(workspace, "invalid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("projects unknown Presets and missing non-interactive confirmation as usage without target writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-init-usage-"),
    );
    try {
      const downstreamAccess = new Proxy(
        {},
        {
          get() {
            throw new Error("init usage must not resolve toolchain");
          },
        },
      );
      const unknown = testRuntime([
        "init",
        "unknown",
        "--preset",
        "missing-preset",
        "--yes",
        "--json",
      ]);
      await expect(
        runCli({
          ...unknown.runtime,
          cwd: workspace,
          env: downstreamAccess,
        }),
      ).resolves.toBe(64);
      expect(JSON.parse(unknown.stdout())).toEqual({
        schemaVersion: 1,
        cliVersion: "1.2.3",
        command: "init",
        status: "usage-error",
        code: "USAGE_INIT_INVALID",
        targetDir: "unknown",
        issues: [{ code: "PRESET_UNKNOWN" }],
      });
      expect(unknown.stderr()).toBe("");

      const fixedTopologyPreset = builtInPresetRegistry
        .all()
        .find((definition) => definition.initialPrimaryPackage === undefined);
      if (fixedTopologyPreset === undefined) {
        throw new Error("Expected a fixed-topology Preset");
      }
      const fixedTopology = testRuntime([
        "init",
        "fixed",
        "--preset",
        fixedTopologyPreset.metadata.name,
        "--name",
        "renamed",
        "--yes",
        "--json",
      ]);
      await expect(
        runCli({
          ...fixedTopology.runtime,
          cwd: workspace,
          env: downstreamAccess,
        }),
      ).resolves.toBe(64);
      expect(JSON.parse(fixedTopology.stdout())).toMatchObject({
        cliVersion: "1.2.3",
        command: "init",
        status: "usage-error",
        issues: [{ code: "FIXED_TOPOLOGY_OVERRIDE" }],
      });

      const missingConfirmation = testRuntime([
        "init",
        "confirmation",
        "--preset",
        addablePresetName,
        "--json",
      ]);
      await expect(
        runCli({
          ...missingConfirmation.runtime,
          cwd: workspace,
          env: downstreamAccess,
        }),
      ).resolves.toBe(64);
      expect(JSON.parse(missingConfirmation.stdout())).toMatchObject({
        cliVersion: "1.2.3",
        command: "init",
        status: "usage-error",
        issues: [{ code: "NON_INTERACTIVE_CONFIRMATION_REQUIRED" }],
      });
      await expect(stat(path.join(workspace, "unknown"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
      await expect(
        stat(path.join(workspace, "confirmation")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
      }),
    ).resolves.toBe(0);
    expect(initOutput.stdout()).toContain("已初始化项目");
    expect(initOutput.stdout()).toContain("预设:");
    expect(initOutput.stdout()).toContain("名称:");
    expect(initOutput.stdout()).toContain("路径:");
    expect(initOutput.stdout()).toContain("Scope:");

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
      "--json",
    ]);
    await expect(
      runCli({
        ...output.runtime,
        cwd: target,
      }),
    ).resolves.toBe(0);

    const json = JSON.parse(output.stdout());
    expect(json).toMatchObject({
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
    expect(json).toHaveProperty("cliVersion", "1.2.3");
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
      "--json",
    ]);
    await expect(
      runCli({
        ...unknownConsumer.runtime,
        cwd: target,
      }),
    ).resolves.toBe(64);
    expect(JSON.parse(unknownConsumer.stdout())).toMatchObject({
      cliVersion: "1.2.3",
      status: "usage-error",
      issues: [{ code: "UNKNOWN_LINK_FROM" }],
    });
    expect(unknownConsumer.stderr()).toBe("");
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
      "--json",
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
      "--json",
    ]);
    await expect(
      runCli({
        ...missingLink.runtime,
        cwd: target,
      }),
    ).resolves.toBe(1);
    const missingLinkJson = JSON.parse(missingLink.stdout());
    expect(missingLinkJson).toMatchObject({
      cliVersion: "1.2.3",
      status: "conflict",
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
    expect(missingLink.stderr()).toBe("");
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
      "--json",
    ]);
    await expect(
      runCli({
        ...retry.runtime,
        cwd: target,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(retry.stdout())).toMatchObject({
      status: "success",
      actions: [],
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
      "--json",
    ]);
    await expect(
      runCli({ ...json.runtime, cwd: "/not-a-generated-repository" }),
    ).resolves.toBe(64);
    expect(JSON.parse(json.stdout())).toMatchObject({
      status: "usage-error",
      issues: [{ code: "RESERVED_LINK_FROM" }],
    });

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
    ).resolves.toBe(64);
    expect(human.stderr()).toContain("template 1.2.3");
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
      "--yes",
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
      "--json",
    ]);

    const exitCode = await runCli({
      ...output.runtime,
      cwd: target,
    });
    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toMatchObject({
      status: "success",
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
        "--yes",
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
        "--json",
      ]);

      await expect(
        runCli({
          ...output.runtime,
          cwd: target,
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
      }),
    ).resolves.toBe(64);
    expect(JSON.parse(output.stdout())).toMatchObject({
      cliVersion: "1.2.3",
      status: "usage-error",
      issues: [{ code: "RESERVED_PACKAGE_PATH" }],
    });
    expect(output.stderr()).toBe("");
    expect(await workspaceByteSnapshot(target)).toEqual(before);
  });
});
