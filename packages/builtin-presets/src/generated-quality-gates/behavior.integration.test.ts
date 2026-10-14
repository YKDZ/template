import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

import {
  builtInPresetRegistry,
  createGenerationContext,
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
  void it(
    "rejects a native Cargo zero-test result when build warnings contain test-summary text",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-cargo-zero-tests-"),
      );
      const targetRoot = path.join(workspace, "generated-rust");
      const definition = builtInPresetRegistry.require("rust-bin");
      const context = createGenerationContext({
        targetDir: targetRoot,
        defaultPackageScope: "generated",
        toolchain: {
          ...runtimeToolchain,
          rustVersion: releaseToolchainSnapshot.rustVersion,
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot,
          operations: [...plan.operations],
        });
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
