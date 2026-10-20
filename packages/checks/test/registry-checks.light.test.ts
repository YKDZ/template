import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

void describe("真实 Generator receipt 检查", () => {
  void it("拒绝与 default owner Dockerfile 事实不一致的生成产物", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-owner-facts-"),
    );
    try {
      const scenario = deriveInitializationScenarios(
        sourceGeneratedScenarioRuntime,
      ).find((candidate) => candidate.base.metadata.alias === "ts-lib");
      assert.ok(scenario);
      const receipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario,
        workspace,
      });
      if (receipt.status !== "generated") {
        throw new Error("ts-lib initialization must be applicable");
      }
      const dockerfile = path.join(
        receipt.projectDir,
        ".devcontainer/Dockerfile",
      );
      const original = await readFile(dockerfile, "utf8");
      await writeFile(dockerfile, `${original}\n# changed owner fact\n`);
      await assert.rejects(
        validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        }),
        /does not match the default workspace owner facts/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
