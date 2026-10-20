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
  return createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  });
}

void describe("生成任务公共入口", () => {
  void it(
    "正式生成包按原生 glob 执行测试并拒绝空文件和空套件",
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
          },
          {
            check: "node --conditions=source scripts/task-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/task-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/task-gates.ts check:full",
            fix: "node --conditions=source scripts/task-gates.ts fix",
          },
        );
        await writeFile(
          path.join(addedPackageRoot, "test/added-package.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'test("package addition uses native Node test", () => assert.strictEqual(2 + 2, 4));',
            "",
          ].join("\n"),
        );
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        environment.PATH = [path.dirname(process.execPath), environment.PATH]
          .filter((entry) => entry !== undefined)
          .join(path.delimiter);
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

        const packageRoot = path.join(targetRoot, "packages/lib");
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
            'test("newly added business case", () => assert.fail("expected failure"));',
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

        await writeFile(
          addedTest,
          [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'test("newly added business case", () => assert.strictEqual(2 + 2, 4));',
            "",
          ].join("\n"),
        );
        const addedPass = run();
        assert.strictEqual(
          addedPass.status,
          0,
          `${addedPass.stdout}\n${addedPass.stderr}`,
        );
        await rm(addedTest);

        const emptyTest = path.join(packageRoot, "test/empty.test.ts");
        await writeFile(emptyTest, "");

        const emptyFileRun = run();
        assert.strictEqual(emptyFileRun.status, 1);
        assert.ok(
          emptyFileRun.stderr.includes("没有执行任何 Node 业务测试用例"),
        );

        await writeFile(
          emptyTest,
          [
            'import { describe } from "node:test";',
            'describe("empty suite", () => {});',
            "",
          ].join("\n"),
        );
        const emptySuiteRun = run();
        assert.strictEqual(emptySuiteRun.status, 1);
        assert.ok(
          emptySuiteRun.stderr.includes("没有执行任何 Node 业务测试用例"),
        );

        await writeFile(
          emptyTest,
          [
            'import { test } from "node:test";',
            'test("skipped with reason", { skip: "external condition is absent" }, () => {});',
            'test("marked todo", { todo: "not implemented" }, () => {});',
            "",
          ].join("\n"),
        );
        const notExecutedRun = run();
        assert.strictEqual(notExecutedRun.status, 1);
        assert.ok(
          notExecutedRun.stderr.includes("没有执行任何 Node 业务测试用例"),
        );

        await writeFile(
          emptyTest,
          [
            'import { test } from "node:test";',
            'test("skipped", { skip: "waiting" }, () => {});',
            'test("executed", () => {});',
            "",
          ].join("\n"),
        );
        assert.strictEqual(run().status, 0);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
  void it(
    "原生 Cargo 构建警告不能冒充真实测试结果",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-cargo-zero-tests-"),
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
        await writeFile(
          path.join(targetRoot, "packages/app/src/main.rs"),
          "fn main() {}\n",
        );
        await writeFile(
          path.join(targetRoot, "packages/app/build.rs"),
          'fn main() { println!("cargo:warning=test result: ok. 1 passed; 0 failed; 0 ignored;"); }\n',
        );

        const runCargoTests = () =>
          spawnSync("pnpm", ["run", "test"], {
            cwd: path.join(targetRoot, "packages/app"),
            encoding: "utf8",
            env: {
              ...process.env,
              CARGO_TARGET_DIR: path.join(workspace, "cargo-target"),
              CARGO_TERM_COLOR: "never",
            },
          });
        const result = runCargoTests();
        const output = `${result.stdout}\n${result.stderr}`;

        assert.strictEqual(result.status, 1, output);
        assert.ok(
          output.includes("test result: ok. 0 passed; 0 failed; 0 ignored;"),
        );
        assert.ok(
          output.includes("test result: ok. 1 passed; 0 failed; 0 ignored;"),
        );
        assert.ok(
          result.stderr.includes(
            "Cargo 未执行任何业务测试用例；请检查测试内容与 ignored 标记",
          ),
        );

        await writeFile(
          path.join(targetRoot, "packages/app/src/main.rs"),
          [
            "fn main() {}",
            "#[test] fn business_passes() { assert_eq!(2 + 2, 4); }",
            "#[test] #[ignore] fn business_is_ignored() {}",
            "",
          ].join("\n"),
        );
        const mixedResult = runCargoTests();
        assert.strictEqual(
          mixedResult.status,
          0,
          `${mixedResult.stdout}\n${mixedResult.stderr}`,
        );
        assert.ok(mixedResult.stdout.includes("1 passed; 0 failed; 1 ignored"));

        await writeFile(
          path.join(targetRoot, "packages/app/src/main.rs"),
          [
            "fn main() {}",
            "#[test] fn business_fails() { assert_eq!(2, 3); }",
            "",
          ].join("\n"),
        );
        const failedResult = runCargoTests();
        assert.strictEqual(
          failedResult.status,
          101,
          `${failedResult.stdout}\n${failedResult.stderr}`,
        );
        assert.ok(
          `${failedResult.stdout}\n${failedResult.stderr}`.includes(
            "test result: FAILED. 0 passed; 1 failed; 0 ignored;",
          ),
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
