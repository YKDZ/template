import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveFixtureMatrix,
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

void describe("唯一内容集合的真实生成检查场景", () => {
  void it("按声明操作派生六种 init 与完整 6×4 实际 init/add 矩阵", async () => {
    const initializations = deriveInitializationScenarios(
      sourceGeneratedScenarioRuntime,
    );
    const scenarios = deriveFixtureMatrix(sourceGeneratedScenarioRuntime);
    const additions = scenarios.filter(
      (scenario) => scenario.addition !== undefined,
    );
    assert.strictEqual(initializations.length, 6);
    assert.strictEqual(additions.length, 24);

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-content-matrix-"),
    );
    try {
      for (const scenario of scenarios) {
        const receipt = await materializeGeneratedScenario({
          runtime: sourceGeneratedScenarioRuntime,
          scenario,
          workspace,
        });
        if (receipt.status === "not-applicable") continue;
        assert.strictEqual(
          receipt.initialization.generationRecord.schemaVersion,
          1,
        );
        assert.strictEqual(receipt.result.generationRecord.schemaVersion, 1);
        await validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        });
        assert.ok(receipt.initialization.projection !== null);
        assert.ok(receipt.result.projection !== null);
        assert.equal((await stat(receipt.projectDir)).isDirectory(), true);
        const persistedRecord = JSON.parse(
          await readFile(
            path.join(receipt.projectDir, ".template/generation.json"),
            "utf8",
          ),
        ) as { readonly schemaVersion: number };
        assert.strictEqual(persistedRecord.schemaVersion, 1);
        if (scenario.addition !== undefined) {
          assert.ok(
            receipt.result.blueprint.packages.some(
              (definition) =>
                definition.path ===
                receipt.result.generationRecord.packages.find(
                  (record) => record.createdBy === "addition",
                )?.definition.path,
            ),
          );
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
