import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, templatePresets } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "../../test-support/installed-integration-signal.ts";
function presetFor(packageName: string) {
  const preset = templatePresets.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(preset, `缺少公开预设：${packageName}`);
  return preset;
}

function generator() {
  const publicationReference = templateContent.find(
    (member) =>
      member.kind === "reference" &&
      member.identity.packageName === "@ykdz/reference-npm-publication" &&
      member.identity.exportPath === "./template",
  );
  assert.ok(publicationReference?.kind === "reference");
  return createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>({
      cliPublicationReference: publicationReference.definition,
    }),
  });
}

void describe("生成任务公共入口", () => {
  void it(
    "正式生成包按原生 Node 测试执行并将失败传至根 check",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-node-gates-"),
      );
      const targetRoot = path.join(workspace, "generated-library");
      const preset = presetFor("@ykdz/preset-ts-lib");
      const currentGenerator = generator();

      try {
        const initialized = await currentGenerator.init({
          targetRoot,
          selection: { roots: [{ preset: preset.identity }] },
          strategyInput: {
            repositoryName: "generated-library",
            defaultPackageScope: "generated",
          },
        });
        assert.strictEqual(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        const addedPackage = await currentGenerator.add({
          repositoryRoot: targetRoot,
          preset: preset.identity,
          creationInput: {
            leafName: "utilities",
            packagePath: "packages/utilities",
          },
        });
        assert.strictEqual(
          addedPackage.status,
          "success",
          JSON.stringify(addedPackage),
        );
        throwIfInstalledIntegrationWasCancelled();
        await execa("pnpm", ["install"], {
          cwd: targetRoot,
          cancelSignal: installedIntegrationSignal(),
        });
        const addedPackageRoot = path.join(targetRoot, "packages/utilities");
        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        assert.deepStrictEqual(
          {
            check: rootManifest.scripts.check,
            "check:heavy": rootManifest.scripts["check:heavy"],
            "check:full": rootManifest.scripts["check:full"],
            fix: rootManifest.scripts.fix,
            boundaries: rootManifest.scripts.boundaries,
          },
          {
            check: "node --conditions=source scripts/task-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/task-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/task-gates.ts check:full",
            fix: "node --conditions=source scripts/task-gates.ts fix",
            boundaries: "turbo boundaries",
          },
        );
        await writeFile(
          path.join(addedPackageRoot, "test/added-package.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'void test("package addition uses native Node test", () => {',
            "  assert.strictEqual(2 + 2, 4);",
            "});",
            "",
          ].join("\n"),
        );
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        environment.PATH = [path.dirname(process.execPath), environment.PATH]
          .filter((entry) => entry !== undefined)
          .join(path.delimiter);
        const runRootCommand = (command: string) =>
          spawnSync("pnpm", ["run", command], {
            cwd: targetRoot,
            encoding: "utf8",
            env: environment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 180_000,
          });
        const assertRootCommandFailsWith = (
          command: string,
          diagnostic: string,
        ) => {
          const result = runRootCommand(command);
          const output = `${result.stdout}\n${result.stderr}`;
          assert.strictEqual(result.status, 1, output);
          assert.ok(output.includes(diagnostic), output);
        };
        const passingBoundariesRun = runRootCommand("boundaries");
        assert.strictEqual(
          passingBoundariesRun.status,
          0,
          `${passingBoundariesRun.stdout}\n${passingBoundariesRun.stderr}`,
        );
        const addedPackageRun = spawnSync("pnpm", ["run", "test"], {
          cwd: addedPackageRoot,
          encoding: "utf8",
          env: environment,
        });
        assert.strictEqual(
          addedPackageRun.status,
          0,
          `${addedPackageRun.stdout}\n${addedPackageRun.stderr}`,
        );
        const passingRootRun = spawnSync("pnpm", ["run", "check:full"], {
          cwd: targetRoot,
          encoding: "utf8",
          env: environment,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
        });
        assert.strictEqual(
          passingRootRun.status,
          0,
          `${passingRootRun.stdout}\n${passingRootRun.stderr}`,
        );

        const packageRoot = path.join(targetRoot, "packages/lib");
        const rootManifestPath = path.join(targetRoot, "package.json");
        const rootTurboPath = path.join(targetRoot, "turbo.json");
        const libraryManifestPath = path.join(packageRoot, "package.json");
        const libraryTurboPath = path.join(packageRoot, "turbo.json");
        type TurboTaskConfiguration = {
          tags?: string[];
          dependsOn?: string[];
          [key: string]: unknown;
        };
        type RootManifest = {
          scripts: Record<string, string>;
          [key: string]: unknown;
        };
        type TurboManifest = {
          tasks: Record<string, TurboTaskConfiguration>;
          [key: string]: unknown;
        };
        const originalRootManifest = JSON.parse(
          await readFile(rootManifestPath, "utf8"),
        ) as RootManifest;
        const originalRootTurbo = JSON.parse(
          await readFile(rootTurboPath, "utf8"),
        ) as TurboManifest;
        const originalLibraryManifest = JSON.parse(
          await readFile(libraryManifestPath, "utf8"),
        ) as RootManifest;
        const originalLibraryTurbo = JSON.parse(
          await readFile(libraryTurboPath, "utf8"),
        ) as TurboManifest;
        const writeJson = async (filePath: string, value: unknown) =>
          writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);

        const missingRoleTurbo = structuredClone(originalLibraryTurbo);
        missingRoleTurbo.tasks.test!.tags = [];
        await writeJson(libraryTurboPath, missingRoleTurbo);
        assertRootCommandFailsWith("check", "缺少唯一职责标签");
        await writeJson(libraryTurboPath, originalLibraryTurbo);

        const ambiguousRoleTurbo = structuredClone(originalLibraryTurbo);
        ambiguousRoleTurbo.tasks.test!.tags = [
          "quality:light",
          "work:development",
        ];
        await writeJson(libraryTurboPath, ambiguousRoleTurbo);
        assertRootCommandFailsWith("check", "有多个职责标签");
        await writeJson(libraryTurboPath, originalLibraryTurbo);

        const danglingRoleTurbo = structuredClone(originalLibraryTurbo);
        danglingRoleTurbo.tasks["orphan-check"] = {
          tags: ["work:on-demand"],
        };
        await writeJson(libraryTurboPath, danglingRoleTurbo);
        assertRootCommandFailsWith("check", "悬空职责标签");
        await writeJson(libraryTurboPath, originalLibraryTurbo);

        const wrongRootEntry = structuredClone(originalRootManifest);
        wrongRootEntry.scripts["check:heavy"] =
          "node --conditions=source scripts/task-gates.ts check:full";
        await writeJson(rootManifestPath, wrongRootEntry);
        assertRootCommandFailsWith("check", "公共入口接线错误");
        await writeJson(rootManifestPath, originalRootManifest);

        const heavyScopeManifest = structuredClone(originalLibraryManifest);
        heavyScopeManifest.scripts["test:e2e"] = 'node -e "process.exit(0)"';
        await writeJson(libraryManifestPath, heavyScopeManifest);
        const heavyScopeTurbo = structuredClone(originalLibraryTurbo);
        heavyScopeTurbo.tasks.test!.dependsOn = ["test:e2e"];
        heavyScopeTurbo.tasks["test:e2e"] = {
          tags: ["quality:heavy"],
        };
        await writeJson(libraryTurboPath, heavyScopeTurbo);
        assertRootCommandFailsWith("check", "轻检查不能间接启动重验收");
        await writeJson(libraryManifestPath, originalLibraryManifest);
        await writeJson(libraryTurboPath, originalLibraryTurbo);

        const greetTest = path.join(packageRoot, "test/greet.test.ts");
        const disabledGreetTest = path.join(
          packageRoot,
          "test/greet.not-test.ts",
        );
        await rename(greetTest, disabledGreetTest);

        const run = (cwd: string = packageRoot) => {
          const environment = { ...process.env };
          delete environment.NODE_TEST_CONTEXT;
          environment.PATH = [path.dirname(process.execPath), environment.PATH]
            .filter((entry) => entry !== undefined)
            .join(path.delimiter);
          return spawnSync("pnpm", ["run", "test"], {
            cwd,
            encoding: "utf8",
            env: environment,
          });
        };

        const addedTest = path.join(packageRoot, "test/added.test.ts");
        await writeFile(
          addedTest,
          [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'void test("newly added business case", () => {',
            '  assert.fail("expected failure");',
            "});",
            "",
          ].join("\n"),
        );
        const addedFailure = run();
        assert.strictEqual(
          addedFailure.status,
          1,
          JSON.stringify({
            stdout: addedFailure.stdout,
            stderr: addedFailure.stderr,
            error: addedFailure.error?.message,
          }),
        );
        assert.ok(addedFailure.stdout.includes("newly added business case"));

        const rootFailure = spawnSync("pnpm", ["run", "check"], {
          cwd: targetRoot,
          encoding: "utf8",
          env: environment,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
        });
        const rootOutput = `${rootFailure.stdout}\n${rootFailure.stderr}`;
        assert.strictEqual(rootFailure.status, 1, rootOutput);
        assert.ok(rootOutput.includes("newly added business case"), rootOutput);

        const emptyRootManifest = structuredClone(originalRootManifest);
        emptyRootManifest.scripts = Object.fromEntries(
          ["check", "check:heavy", "check:full", "fix"].map((name) => [
            name,
            originalRootManifest.scripts[name]!,
          ]),
        );
        await writeJson(rootManifestPath, emptyRootManifest);
        const emptyRootTurbo = structuredClone(originalRootTurbo);
        emptyRootTurbo.tasks = Object.fromEntries(
          Object.entries(originalRootTurbo.tasks).filter(([taskName]) =>
            ["//#check", "//#check:heavy", "//#check:full", "//#fix"].includes(
              taskName,
            ),
          ),
        );
        await writeJson(rootTurboPath, emptyRootTurbo);
        for (const packagePath of [
          "packages/lib",
          "packages/utilities",
          "packages/tooling-config",
        ]) {
          const packageManifestPath = path.join(
            targetRoot,
            packagePath,
            "package.json",
          );
          const packageManifest = JSON.parse(
            await readFile(packageManifestPath, "utf8"),
          ) as RootManifest;
          packageManifest.scripts = {};
          await writeJson(packageManifestPath, packageManifest);
          const packageTurboPath = path.join(
            targetRoot,
            packagePath,
            "turbo.json",
          );
          const packageTurbo = JSON.parse(
            await readFile(packageTurboPath, "utf8"),
          ) as TurboManifest;
          packageTurbo.tasks = {};
          await writeJson(packageTurboPath, packageTurbo);
        }
        assertRootCommandFailsWith("check", "轻检查没有选中有效任务");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
  void it(
    "正式生成 Rust 包直接运行 Cargo 并将失败传至根 check",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-rust-tests-"),
      );
      const targetRoot = path.join(workspace, "generated-rust");
      const preset = presetFor("@ykdz/preset-rust-bin");
      const currentGenerator = generator();

      try {
        const initialized = await currentGenerator.init({
          targetRoot,
          selection: { roots: [{ preset: preset.identity }] },
          strategyInput: {
            repositoryName: "generated-rust",
            defaultPackageScope: "generated",
          },
        });
        assert.strictEqual(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        await execa("pnpm", ["install"], {
          cwd: targetRoot,
          cancelSignal: installedIntegrationSignal(),
        });
        const cargoTarget = path.join(workspace, "cargo-target");
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        environment.CARGO_TARGET_DIR = cargoTarget;
        environment.CARGO_TERM_COLOR = "never";
        const runCargoTests = (cwd: string) =>
          spawnSync("pnpm", ["run", "test"], {
            cwd,
            encoding: "utf8",
            env: environment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 180_000,
          });
        const appRoot = path.join(targetRoot, "packages/app");
        await writeFile(
          path.join(targetRoot, "packages/app/src/main.rs"),
          [
            "fn main() -> std::io::Result<()> {",
            "    use std::io::Write;",
            '    writeln!(std::io::stdout().lock(), "ready")',
            "}",
            "",
            "#[test]",
            "fn business_passes() {",
            "    assert_eq!(2 + 2, 4);",
            "}",
            "",
          ].join("\n"),
        );
        const passingResult = runCargoTests(appRoot);
        assert.strictEqual(
          passingResult.status,
          0,
          `${passingResult.stdout}\n${passingResult.stderr}`,
        );
        assert.ok(
          passingResult.stdout.includes("1 passed; 0 failed; 0 ignored"),
        );
        const passingRootResult = spawnSync("pnpm", ["run", "check:full"], {
          cwd: targetRoot,
          encoding: "utf8",
          env: environment,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
        });
        assert.strictEqual(
          passingRootResult.status,
          0,
          `${passingRootResult.stdout}\n${passingRootResult.stderr}`,
        );

        await writeFile(
          path.join(targetRoot, "packages/app/src/main.rs"),
          [
            "fn main() -> std::io::Result<()> {",
            "    use std::io::Write;",
            '    writeln!(std::io::stdout().lock(), "ready")',
            "}",
            "",
            "#[test]",
            "fn business_fails() {",
            "    assert_eq!(2, 3);",
            "}",
            "",
          ].join("\n"),
        );
        const failedResult = runCargoTests(appRoot);
        const failedOutput = `${failedResult.stdout}\n${failedResult.stderr}`;
        assert.strictEqual(failedResult.status, 101, failedOutput);
        assert.ok(
          failedOutput.includes(
            "test result: FAILED. 0 passed; 1 failed; 0 ignored;",
          ),
        );

        const rootFailure = spawnSync("pnpm", ["run", "check"], {
          cwd: targetRoot,
          encoding: "utf8",
          env: environment,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
        });
        const rootOutput = `${rootFailure.stdout}\n${rootFailure.stderr}`;
        assert.notStrictEqual(rootFailure.status, 0, rootOutput);
        assert.ok(rootOutput.includes("business_fails"), rootOutput);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
