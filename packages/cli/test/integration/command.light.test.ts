import assert from "node:assert/strict";
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
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import {
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
} from "@ykdz/template-workspace/project-linking";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { execa } from "execa";

import { runCli, type CliRuntime } from "../../src/main.ts";

function assertArrayShape(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    for (const [index, expectedValue] of expected.entries()) {
      assertArrayShape(actual[index], expectedValue);
    }
    return;
  }

  if (expected === null || typeof expected !== "object") return;
  assert.ok(actual !== null && typeof actual === "object");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (Object.hasOwn(actual, key)) {
      assertArrayShape((actual as Record<string, unknown>)[key], expectedValue);
    }
  }
}

function assertPartialDeepStrictEqual(
  actual: unknown,
  expected: unknown,
): void {
  // Vitest 的 toMatchObject 要求数组等长；Node 的部分深比较允许子集。
  assertArrayShape(actual, expected);
  assert.partialDeepStrictEqual(actual, expected);
}

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

void describe("template CLI command control", () => {
  void it("renders the injected package version", async () => {
    const output = testRuntime(["--version"], "9.8.7");

    assert.equal(await runCli(output.runtime), 0);
    assert.equal(output.stdout(), "template 9.8.7\n");
    assert.equal(output.stderr(), "");
  });

  void it("renders bare command and help as Chinese discoverability output", async () => {
    for (const args of [[], ["--help", "--output-format", "structured"]]) {
      const output = testRuntime(args);
      assert.equal(await runCli(output.runtime), 0);
      assert.ok(output.stdout().includes("用法"));
      for (const command of ["init", "add", "presets", "blueprint", "schema"])
        assert.ok(output.stdout().includes(command));
      assert.equal(output.stderr(), "");
    }
  });

  void it("lists deterministic Presets through declared human and JSON modes without writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-cli-presets-"),
    );
    try {
      await writeFile(path.join(workspace, "marker"), "unchanged");
      const before = await workspaceByteSnapshot(workspace);
      const output = testRuntime(["presets", "--output-format", "text"]);
      const repeat = testRuntime(["presets", "--output-format", "text"]);
      const jsonOutput = testRuntime(["presets"], "9.8.7");

      assert.deepEqual(
        await Promise.all([
          runCli({ ...output.runtime, cwd: workspace }),
          runCli({ ...repeat.runtime, cwd: workspace }),
          runCli({ ...jsonOutput.runtime, cwd: workspace }),
        ]),
        [0, 0, 0],
      );
      assert.match(output.stdout(), /^内置预设/mu);
      assert.equal(output.stdout(), repeat.stdout());
      assert.match(output.stdout(), /\n  [^:\s]+:/u);
      assert.ok(
        output
          .stdout()
          .includes("TypeScript 命令行工具 - TypeScript 命令行包。"),
      );
      assert.ok(!output.stdout().includes("TypeScript command-line package."));
      assert.equal(output.stderr(), "");
      assertPartialDeepStrictEqual(JSON.parse(jsonOutput.stdout()), {
        schemaVersion: "2",
        command: "presets",
        kind: "data",
        variant: "listed",
        data: {
          presets: builtInPresetRegistry
            .all()
            .map((definition) => ({ name: definition.metadata.name })),
        },
      });
      assert.equal(jsonOutput.stderr(), "");
      assert.deepEqual(await workspaceByteSnapshot(workspace), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("validates a Project Blueprint through declared human and JSON modes without writes", async () => {
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

      assert.deepEqual(
        await Promise.all([runCli(output.runtime), runCli(jsonOutput.runtime)]),
        [0, 0],
      );
      assert.ok(output.stdout().includes("蓝图有效。"));
      assert.equal(output.stderr(), "");
      assert.deepEqual(JSON.parse(jsonOutput.stdout()), {
        schemaVersion: "2",
        command: "validateBlueprint",
        kind: "data",
        variant: "valid",
        data: { path: blueprintPath },
      });
      assert.equal(jsonOutput.stderr(), "");
      assert.deepEqual(await workspaceByteSnapshot(workspace), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("returns invalid Project Blueprints as typed business results", async () => {
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
      assert.deepEqual(
        await Promise.all([runCli(human.runtime), runCli(json.runtime)]),
        [1, 1],
      );
      assert.equal(human.stdout(), "");
      assert.ok(human.stderr().includes("蓝图无效"));
      assert.ok(human.stderr().includes(".schemaVersion"));
      assertPartialDeepStrictEqual(JSON.parse(json.stderr()), {
        schemaVersion: "2",
        command: "validateBlueprint",
        kind: "failure",
        variant: "invalid",
        data: { path: blueprintPath, issues: [{ path: ".schemaVersion" }] },
      });
      assert.equal(json.stdout(), "");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps unreadable and unparseable Blueprints as operation failures", async () => {
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
        assert.equal(await runCli(output.runtime), 1);
        assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
          kind: "failure",
          variant: "operationFailed",
          data: { reason },
        });
        assert.equal(output.stdout(), "");
        assert.ok(!output.stderr().includes("invalid-source-fragment"));
      }
      assert.deepEqual(await workspaceByteSnapshot(workspace), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("contains process initialization failures in the real entry point", async () => {
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
    assert.equal(result.exitCode, 70);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "命令执行失败；请检查运行环境或报告此问题。");
  });

  void it("reports unexpected argv failures without leaking implementation details", async () => {
    const output = testRuntime([]);
    const argv = ["node", "template"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("private detail");
      },
    });
    assert.equal(await runCli({ ...output.runtime, argv }), 70);
    assert.equal(output.stdout(), "");
    assert.ok(output.stderr().includes("命令执行失败"));
    assert.ok(!output.stderr().includes("private detail"));
  });

  void it("reports malformed calls as stderr JSON even in text mode", async () => {
    for (const args of [
      ["preset"],
      ["add", "package"],
      ["presets", "--machine"],
      ["init", "destination", "--preset"],
      ["presets", "extra"],
    ]) {
      const output = testRuntime([...args, "--output-format", "text"]);
      assert.equal(await runCli(output.runtime), 2);
      assert.equal(output.stdout(), "");
      const failure = JSON.parse(output.stderr());
      assertPartialDeepStrictEqual(failure, {
        schemaVersion: "2",
        kind: "usageFailure",
      });
      assert.ok(Array.isArray(failure.issues));
    }
  });

  void it("only accepts stdout EPIPE and awaits output failures", async () => {
    for (const args of [["--help"], ["presets"]]) {
      const output = testRuntime(args);
      assert.equal(
        await runCli({
          ...output.runtime,
          write: async () => {
            throw Object.assign(new Error("pipe"), { code: "EPIPE" });
          },
        }),
        0,
      );
      assert.equal(output.stderr(), "");
    }
    const output = testRuntime(["--version"]);
    assert.equal(
      await runCli({
        ...output.runtime,
        write: async (event) => {
          if (event.destination === "stdout")
            throw Object.assign(new Error("disk"), { code: "ENOSPC" });
          await output.runtime.write(event);
        },
      }),
      70,
    );
    assert.ok(output.stderr().includes("命令执行失败"));
    const usage = testRuntime(["unknown"]);
    assert.equal(
      await runCli({
        ...usage.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      70,
    );
  });

  void it("renders options and preset choices from the executable commands", async () => {
    for (const args of [
      ["add", "package", "--help"],
      ["init", "--help"],
    ]) {
      const output = testRuntime(args);
      assert.equal(await runCli(output.runtime), 0);
      for (const option of [
        "--preset",
        "--name",
        "--path",
        "--dry-run",
        "--output-format",
      ])
        assert.ok(output.stdout().includes(option));
      assert.ok(output.stdout().includes(addablePresetName));
      assert.equal(output.stderr(), "");
    }
  });

  void it("runs init dry-run JSON through the injected cwd without writing", async () => {
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
      assert.equal(await runCli({ ...output.runtime, cwd: workspace }), 0);
      assertPartialDeepStrictEqual(JSON.parse(output.stdout()), {
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
      assert.equal(await runCli({ ...human.runtime, cwd: workspace }), 0);
      assert.ok(human.stdout().includes("@acme/utility"));
      assert.ok(human.stdout().includes("packages/utility"));
      assert.ok(
        human.stdout().includes(releaseToolchainSnapshot.packageManagerPin),
      );
      assert.equal(output.stderr(), "");
      await assert.rejects(stat(path.join(workspace, "demo")), {
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("initializes the release snapshot without reading any environment fact", async () => {
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

    assert.equal(
      await runCli({
        ...output.runtime,
        cwd: workspace,
        env: unreadableEnvironment,
      }),
      0,
    );
    assertPartialDeepStrictEqual(JSON.parse(output.stdout()), {
      kind: "data",
      variant: "initialized",
    });
    assert.deepEqual(JSON.parse(output.stdout()).data.toolchain, {
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    });
    const rootManifest = JSON.parse(
      await readFile(path.join(workspace, "demo/package.json"), "utf8"),
    ) as {
      readonly engines: { readonly node: string };
      readonly packageManager: string;
    };
    assert.equal(
      rootManifest.engines.node,
      releaseToolchainSnapshot.nodeVersion,
    );
    assert.equal(
      rootManifest.packageManager,
      releaseToolchainSnapshot.packageManagerPin,
    );
  });

  void it("rejects invalid init identities through the input schema without writing", async () => {
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
      assert.equal(await runCli({ ...output.runtime, cwd: workspace }), 2);
      assert.equal(output.stdout(), "");
      assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
        kind: "usageFailure",
      });
      assert.ok(output.stderr().includes("包叶名称"));
      assert.ok(output.stderr().includes("安全路径段"));
      assert.ok(output.stderr().includes("npm scope"));
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects unknown presets and fixed topology overrides without writing", async () => {
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
        [
          "init",
          "fixed",
          "--preset",
          fixed.metadata.name,
          "--path",
          "apps/renamed",
        ],
      ]) {
        const output = testRuntime(args);
        assert.equal(await runCli({ ...output.runtime, cwd: workspace }), 2);
        assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
          kind: "usageFailure",
        });
        if (args[3] === fixed.metadata.name) {
          assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
            helpArgv: ["template", "init", "--help"],
            issues: [{ code: "conditionalConstraintViolation" }],
          });
        }
        assert.equal(output.stdout(), "");
      }
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("reports initialization target failure without modifying the target", async () => {
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
      assert.equal(await runCli({ ...output.runtime, cwd: workspace }), 1);
      assert.equal(output.stdout(), "");
      assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
        kind: "failure",
        variant: "operationFailed",
        data: { phase: "render" },
      });
      assert.deepEqual(await workspaceByteSnapshot(workspace), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("exports the executable contract through schema", async () => {
    const output = testRuntime(["schema"]);
    assert.equal(await runCli(output.runtime), 0);
    assert.equal(output.stderr(), "");
    const result = JSON.parse(output.stdout());
    assertPartialDeepStrictEqual(result, {
      schemaVersion: "2",
      command: "schema",
      kind: "data",
      variant: "exported",
    });
    const humanSchema = testRuntime(["schema", "--output-format", "text"]);
    assert.equal(await runCli(humanSchema.runtime), 0);
    assert.ok(humanSchema.stdout().includes("CLI 契约"));
    assert.ok(humanSchema.stdout().includes('"commands"'));
    const manifest = result.data.manifest;
    assertPartialDeepStrictEqual(manifest, {
      schemaVersion: "4",
      root: "template",
      commands: {
        init: {
          input: {
            inputSchema: {},
          },
          success: {
            variants: {
              initialized: { exitCode: 0 },
              planned: { exitCode: 0 },
            },
          },
        },
        addPackage: {
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
    const requiredFields = manifest.commands.init.input.inputSchema.required;
    assert.ok(requiredFields.includes("dir"));
    assert.ok(requiredFields.includes("preset"));
    const packageFields = manifest.commands.addPackage.fields as {
      readonly key: string;
      readonly kind: string;
      readonly longOption: string;
      readonly required: boolean;
      readonly description: string;
    }[];
    const linkFromField = packageFields.find(
      (field) => field.key === "linkFrom",
    );
    assert.ok(linkFromField);
    assertPartialDeepStrictEqual(linkFromField, {
      key: "linkFrom",
      kind: "repeatableOption",
      longOption: "--link-from",
      required: false,
    });
    assert.equal(typeof linkFromField.description, "string");
  });

  void it("plans add package from injected cwd with path and link intent without writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-cli-add-"));
    const initOutput = testRuntime([
      "init",
      "demo",
      "--preset",
      addablePresetName,
      "--scope",
      "acme",
    ]);
    assert.equal(
      await runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
      0,
    );
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
    assert.equal(
      await runCli({
        ...output.runtime,
        cwd: target,
      }),
      0,
    );

    const result = JSON.parse(output.stdout());
    assertPartialDeepStrictEqual(result, {
      command: "addPackage",
      kind: "data",
      variant: "planned",
    });
    const json = result.data;
    assertPartialDeepStrictEqual(json, { dryRun: true });
    assert.ok(
      (
        json.actions as { readonly path: string; readonly action: string }[]
      ).some(
        (action) =>
          action.path === "packages/utility/package.json" &&
          action.action === "create",
      ),
      "the plan should create the new package manifest",
    );
    assert.equal(output.stderr(), "");
    await assert.rejects(stat(path.join(target, "packages/utility")), {
      code: "ENOENT",
    });

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
    assert.equal(
      await runCli({
        ...unknownConsumer.runtime,
        cwd: target,
      }),
      1,
    );
    assertPartialDeepStrictEqual(JSON.parse(unknownConsumer.stderr()), {
      kind: "failure",
      variant: "invalidRequest",
      data: { issues: [{ code: "UNKNOWN_LINK_FROM" }] },
    });
    assert.equal(unknownConsumer.stdout(), "");
    assert.deepEqual(
      await workspaceByteSnapshot(target),
      beforeUnknownConsumer,
    );

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
    assert.equal(
      await runCli({
        ...apply.runtime,
        cwd: target,
      }),
      0,
    );
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
    assert.equal(
      await runCli({
        ...missingLink.runtime,
        cwd: target,
      }),
      1,
    );
    const missingLinkResult = JSON.parse(missingLink.stderr());
    assertPartialDeepStrictEqual(missingLinkResult, {
      kind: "failure",
      variant: "conflict",
    });
    const missingLinkJson = missingLinkResult.data;
    assertPartialDeepStrictEqual(missingLinkJson, {
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
    assert.deepEqual(
      Object.keys(missingLinkJson.conflicts[0].existing).toSorted(),
      ["name", "path", "role"],
    );
    assert.deepEqual(
      Object.keys(missingLinkJson.conflicts[0].requested).toSorted(),
      ["name", "path", "role"],
    );
    assert.equal(missingLink.stdout(), "");
    assert.deepEqual(await workspaceByteSnapshot(target), beforeMissingLink);

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
    assert.equal(
      await runCli({
        ...retry.runtime,
        cwd: target,
      }),
      0,
    );
    assertPartialDeepStrictEqual(JSON.parse(retry.stdout()), {
      kind: "data",
      variant: "unchanged",
      data: { actions: [] },
    });
  });

  void it("short-circuits reserved link input and explains human correction", async () => {
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
    assert.equal(
      await runCli({ ...json.runtime, cwd: "/not-a-generated-repository" }),
      2,
    );
    assertPartialDeepStrictEqual(JSON.parse(json.stderr()), {
      kind: "usageFailure",
    });
    assert.ok(json.stderr().includes("不能使用保留工作区目录"));

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
    assert.equal(
      await runCli({ ...human.runtime, cwd: "/not-a-generated-repository" }),
      2,
    );
    assert.ok(human.stderr().includes("不能使用保留工作区目录"));
    assert.equal(human.stdout(), "");
  });

  void it("plans an addition without inspecting an unrelated missing Package manifest", async () => {
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
    assert.equal(
      await runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
      0,
    );

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
    assert.equal(exitCode, 0);
    assert.equal(output.stderr(), "");
    const plannedData = JSON.parse(output.stdout()).data;
    assert.equal(plannedData.dryRun, true);
    assert.ok(
      (
        plannedData.actions as {
          readonly path: string;
          readonly action: string;
        }[]
      ).some(
        (action) =>
          action.path === "packages/utility/package.json" &&
          action.action === "create",
      ),
      "the plan should create the new package manifest",
    );
    await assert.rejects(stat(unrelatedManifest), {
      code: "ENOENT",
    });
    assert.deepEqual(await workspaceByteSnapshot(target), before);
  });

  for (const { dryRun, label } of [
    { dryRun: true, label: "dry-run" },
    { dryRun: false, label: "apply" },
  ]) {
    void it(`rejects ${label} when the new Package Path root already exists with zero writes`, async () => {
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
      assert.equal(
        await runCli({
          ...initOutput.runtime,
          cwd: workspace,
        }),
        0,
      );

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

      assert.equal(
        await runCli({
          ...output.runtime,
          cwd: target,
        }),
        1,
      );
      const conflicts = JSON.parse(output.stderr()).data.conflicts;
      assert.equal(conflicts.length, 1);
      assert.equal(
        conflicts[0].reason.includes(
          "Package Path services/existing already exists",
        ),
        true,
      );
      assertPartialDeepStrictEqual(JSON.parse(output.stderr()).data, {
        dryRun,
        actions: [],
        conflicts: [
          {
            path: "services/existing",
            driver: "precondition",
          },
        ],
      });
      assert.equal(output.stdout(), "");
      assert.deepEqual(await workspaceByteSnapshot(target), before);
    });
  }

  void it("rejects a symbolic-link Package Path root without touching its target", async () => {
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
    assert.equal(
      await runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
      0,
    );

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

    assert.equal(
      await runCli({
        ...output.runtime,
        cwd: target,
      }),
      1,
    );
    const linkConflicts = JSON.parse(output.stderr()).data.conflicts;
    assert.equal(linkConflicts.length, 1);
    assert.ok(linkConflicts[0].reason.includes("existing symbolic-link"));
    assertPartialDeepStrictEqual(JSON.parse(output.stderr()).data, {
      actions: [],
      conflicts: [
        {
          path: "services/linked",
          driver: "precondition",
        },
      ],
    });
    assert.deepEqual(await workspaceByteSnapshot(target), before);
    assert.equal(
      await readFile(path.join(target, "user-owned/OWNER"), "utf8"),
      "user\n",
    );
  });

  void it("rejects a regular-file Package Path root with zero writes", async () => {
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
    assert.equal(
      await runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
      0,
    );

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

    assert.equal(
      await runCli({
        ...output.runtime,
        cwd: target,
      }),
      1,
    );
    const fileConflicts = JSON.parse(output.stderr()).data.conflicts;
    assert.equal(fileConflicts.length, 1);
    assert.ok(fileConflicts[0].reason.includes("existing file"));
    assertPartialDeepStrictEqual(JSON.parse(output.stderr()).data, {
      actions: [],
      conflicts: [
        {
          path: "services/occupied",
          driver: "precondition",
        },
      ],
    });
    assert.deepEqual(await workspaceByteSnapshot(target), before);
  });

  void it("rejects reserved dist Package Addition planning in dry-run JSON mode with zero writes", async () => {
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
    assert.equal(
      await runCli({
        ...initOutput.runtime,
        cwd: workspace,
      }),
      0,
    );

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

    assert.equal(
      await runCli({
        ...output.runtime,
        cwd: target,
      }),
      2,
    );
    assertPartialDeepStrictEqual(JSON.parse(output.stderr()), {
      kind: "usageFailure",
    });
    assert.ok(output.stderr().includes("不能使用保留工作区目录"));
    assert.equal(output.stdout(), "");
    assert.deepEqual(await workspaceByteSnapshot(target), before);
  });
});
