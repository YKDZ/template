import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";
import { execa } from "execa";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-rust-bin/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-typescript-config/template",
    "@ykdz/preset-rust-bin/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-rust-bin",
);
assert.ok(preset);

void describe("Rust 二进制公开预设任务", () => {
  void it(
    "单次准备 Rust 工具链、发现手工包测试，并限制根格式化范围",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-rust-bin-task-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-rust");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await createGenerator({
        content,
        strategy: createDefaultWorkspaceStrategy(),
      }).init({
        targetRoot,
        selection: { roots: [{ preset: preset.identity }] },
        strategyInput: {
          repositoryName: "demo-rust",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

      await mkdir(path.join(targetRoot, "apps/controlled"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, "apps/controlled/package.json"),
        JSON.stringify({
          name: "@demo/controlled",
          private: true,
          scripts: {
            build:
              "node --eval \"console.error('BUILD_FAIL'); process.exit(1)\"",
            lint: "node --eval \"console.error('LINT_FAIL'); process.exit(1)\"",
            test: "node --eval \"require('node:fs').writeFileSync('TEST_EXECUTED', 'yes')\"",
          },
        }),
      );
      await writeFile(
        path.join(targetRoot, "apps/controlled/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["app"],
          tasks: {
            build: {
              dependsOn: ["^build"],
              inputs: [],
              outputs: [],
              tags: ["quality:light"],
            },
            lint: {
              inputs: [],
              outputs: [],
              tags: ["quality:light"],
            },
            test: {
              dependsOn: [],
              inputs: [],
              outputs: [],
              tags: ["quality:light"],
            },
          },
        }),
      );
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });

      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "format:check",
          "lint",
          "typecheck",
          "build",
          "test",
          "format:write",
          "--dry-run=json",
        ],
        { cwd: targetRoot, cancelSignal: testContext.signal },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          readonly tasks: readonly {
            readonly taskId: string;
            readonly dependencies: readonly string[];
          }[];
        }
      ).tasks;
      assert.strictEqual(
        tasks.filter((task) => task.taskId === "//#toolchain:prepare").length,
        1,
      );
      for (const taskId of [
        "@demo/app#format:check",
        "@demo/app#lint",
        "@demo/app#test",
        "@demo/controlled#build",
        "@demo/controlled#lint",
        "@demo/controlled#test",
      ]) {
        assert.ok(
          tasks.some((task) => task.taskId === taskId),
          taskId,
        );
      }
      const controlledTest = tasks.find(
        (task) => task.taskId === "@demo/controlled#test",
      );
      assert.ok(controlledTest);
      assert.ok(
        !controlledTest.dependencies.includes("@demo/controlled#build"),
      );
      for (const taskId of [
        "@demo/app#format:check",
        "@demo/app#lint",
        "@demo/app#test",
      ]) {
        const task = tasks.find((candidate) => candidate.taskId === taskId);
        assert.ok(task);
        assert.ok(task.dependencies.includes("//#toolchain:prepare"));
      }

      const cargoHome = path.join(workspace, "cargo-home");
      const fakeBin = path.join(workspace, "fake-bin");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        path.join(fakeBin, "cargo"),
        `#!/bin/sh
set -eu
state="\${CARGO_HOME:?}/template-cargo-calls"
prepared="\${CARGO_HOME:?}/template-toolchain-prepared"
mkdir -p "\${CARGO_HOME}"
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  if [ -e "$prepared" ]; then
    printf '%s\\n' 'toolchain preparation ran more than once' >&2
    exit 91
  fi
  : > "$prepared"
  printf '%s\\n' "$*" >> "$state"
  exit 0
fi
if [ ! -e "$prepared" ]; then
  printf '%s\\n' 'Cargo task ran before toolchain preparation' >&2
  exit 90
fi
printf '%s\\n' "$*" >> "$state"
if [ "$1" = "test" ]; then
  printf '%s\\n' 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
fi
`,
        { mode: 0o755 },
      );
      const failedFullCheck = await execa("pnpm", ["run", "check:full"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          CARGO_HOME: cargoHome,
          RUSTUP_HOME: path.join(workspace, "rustup-home"),
        },
        reject: false,
      });
      assert.notStrictEqual(failedFullCheck.exitCode, 0);
      const failureOutput = `${failedFullCheck.stdout}\n${failedFullCheck.stderr}`;
      assert.ok(failureOutput.includes("@demo/controlled#build"));
      assert.ok(failureOutput.includes("@demo/controlled#lint"));
      assert.ok(failureOutput.includes("BUILD_FAIL"));
      assert.ok(failureOutput.includes("LINT_FAIL"));
      assert.strictEqual(
        await readFile(
          path.join(targetRoot, "apps/controlled/TEST_EXECUTED"),
          "utf8",
        ),
        "yes",
      );
      const cargoCalls = (
        await readFile(path.join(cargoHome, "template-cargo-calls"), "utf8")
      )
        .trim()
        .split("\n");
      assert.strictEqual(
        cargoCalls.filter((call) => call === "--version").length,
        1,
      );
      assert.ok(cargoCalls.includes("fmt --all -- --check"));
      assert.ok(
        cargoCalls.includes("clippy --workspace --all-targets -- -D warnings"),
      );
      assert.ok(cargoCalls.includes("test --workspace"));

      const rootManifestPath = path.join(
        targetRoot,
        "packages/app/package.json",
      );
      const rootManifest = JSON.stringify({ name: "@demo/package-pollution" });
      await writeFile(rootManifestPath, rootManifest);
      await writeFile(path.join(targetRoot, "TODO.md"), "# root\n\n-   text\n");
      await writeFile(
        path.join(targetRoot, ".devcontainer/devcontainer.json"),
        '{"name":"root-owned","image":"node:24"}\n',
      );
      const rootFormatCheck = await execa(
        "pnpm",
        ["exec", "turbo", "run", "format:check", "--filter=//"],
        { cwd: targetRoot, cancelSignal: testContext.signal, reject: false },
      );
      const formatOutput = `${rootFormatCheck.stdout}\n${rootFormatCheck.stderr}`;
      assert.notStrictEqual(rootFormatCheck.exitCode, 0);
      assert.ok(formatOutput.includes("TODO.md"));
      assert.ok(formatOutput.includes(".devcontainer/devcontainer.json"));
      assert.ok(!formatOutput.includes("packages/app/package.json"));

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "format:write", "--filter=//"],
        { cwd: targetRoot, cancelSignal: testContext.signal },
      );
      assert.ok(
        !(await readFile(path.join(targetRoot, "TODO.md"), "utf8")).includes(
          "-   text",
        ),
      );
      assert.strictEqual(
        await readFile(rootManifestPath, "utf8"),
        rootManifest,
      );
    },
  );
});
