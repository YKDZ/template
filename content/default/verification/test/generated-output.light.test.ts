import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { validateGeneratedOutput } from "../scripts/check-generated-output.ts";
import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

await test("在真实生成目标上检查格式与依赖目录事实", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-output-"));
  try {
    const scenario = deriveInitializationScenarios(
      sourceGeneratedScenarioRuntime,
    ).find((item) => item.base.definition.metadata.alias === "ts-lib");
    assert.ok(scenario);
    const receipt = await materializeGeneratedScenario({
      runtime: sourceGeneratedScenarioRuntime,
      scenario,
      workspace: root,
      conventions: { defaultPackageScope: "custom" },
      initializationCreationInput: {
        leafName: "library",
        packagePath: "modules/library",
      },
    });
    if (receipt.status !== "generated") {
      throw new Error("ts-lib initialization must be applicable");
    }
    await validateGeneratedOutput(receipt);

    const sourceFile = path.join(
      receipt.projectDir,
      "modules/library/src/index.ts",
    );
    const source = await readFile(sourceFile, "utf8");
    await writeFile(sourceFile, `  \n${source}`);
    await assert.rejects(
      validateGeneratedOutput(receipt),
      /modules\/library\/src\/index\.ts.*格式/u,
    );
    await writeFile(sourceFile, source);

    const manifestFile = path.join(
      receipt.projectDir,
      "modules/library/package.json",
    );
    const manifest = await readFile(manifestFile, "utf8");
    assert.match(manifest, /"valibot": "catalog:"/u);
    await writeFile(
      manifestFile,
      manifest.replace('"valibot": "catalog:"', '"valibot": "^1.0.0"'),
    );
    await assert.rejects(
      validateGeneratedOutput(receipt),
      /default dependency catalog contract/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
