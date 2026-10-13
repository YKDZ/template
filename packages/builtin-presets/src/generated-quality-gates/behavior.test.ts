import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  planGeneratedRepositoryInitialization,
} from "../foundation.ts";

const runtimeToolchain = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
};
void describe("generated quality gate entrypoints", () => {
  void it("projects all three public gates for every initialization preset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-gates-"));

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetRoot = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir: targetRoot,
          defaultPackageScope: "generated",
          toolchain: runtimeToolchain,
        });
        const plan = planGeneratedRepositoryInitialization({
          definition,
          context,
        });

        await renderNewProject({
          targetRoot,
          operations: [...plan.operations],
        });

        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const turbo = JSON.parse(
          await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
        ) as {
          readonly tasks: Readonly<
            Record<string, { readonly tags?: readonly string[] }>
          >;
        };

        assert.deepStrictEqual(
          {
            check: rootManifest.scripts.check,
            "check:heavy": rootManifest.scripts["check:heavy"],
            "check:full": rootManifest.scripts["check:full"],
          },
          {
            check: "node --conditions=source scripts/quality-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/quality-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/quality-gates.ts check:full",
          },
        );

        for (const gate of ["check", "check:heavy", "check:full"]) {
          assert.deepStrictEqual(turbo.tasks[`//#${gate}`]?.tags, [
            "quality:entry",
          ]);
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("runs generated Node tests through the native glob and rejects empty files and suites", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-node-gates-"),
    );
    const targetRoot = path.join(workspace, "generated-library");
    const definition = builtInPresetRegistry.require("ts-lib");
    const context = createGenerationContext({
      targetDir: targetRoot,
      defaultPackageScope: "generated",
      toolchain: runtimeToolchain,
    });
    const plan = planGeneratedRepositoryInitialization({ definition, context });

    try {
      await renderNewProject({
        targetRoot,
        operations: [...plan.operations],
      });
      const addedPackage = planGeneratedRepositoryPackageAddition({
        definition,
        localTemplateMetadata: loadLocalTemplateMetadata(targetRoot),
        packageLeafName: "utilities",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot,
        ...addedPackage.projectProjections,
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
        },
        {
          check: "node --conditions=source scripts/quality-gates.ts check",
          "check:heavy":
            "node --conditions=source scripts/quality-gates.ts check:heavy",
          "check:full":
            "node --conditions=source scripts/quality-gates.ts check:full",
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
      const addedPackageRun = spawnSync("pnpm", ["run", "test"], {
        cwd: addedPackageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [path.dirname(process.execPath), process.env.PATH]
            .filter((entry) => entry !== undefined)
            .join(path.delimiter),
        },
      });
      assert.strictEqual(
        addedPackageRun.status,
        0,
        `${addedPackageRun.stdout}\n${addedPackageRun.stderr}`,
      );

      const packageRoot = path.join(targetRoot, "packages/lib");

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

      const greetTest = path.join(packageRoot, "test/greet.test.ts");
      const disabledGreetTest = path.join(
        packageRoot,
        "test/greet.not-test.ts",
      );
      await rename(greetTest, disabledGreetTest);
      const emptyTest = path.join(packageRoot, "test/empty.test.ts");
      await writeFile(emptyTest, "");

      const emptyFileRun = run();
      assert.strictEqual(emptyFileRun.status, 1);
      assert.ok(emptyFileRun.stderr.includes("没有执行任何 Node 业务测试用例"));

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
  });
});
