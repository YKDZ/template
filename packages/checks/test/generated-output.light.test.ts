import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  builtInPresetRegistry,
  prepareGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";

import { validateGeneratedOutput } from "../scripts/check-generated-output.ts";

await test("安装前检查正式生成结果，并拒绝最终源码格式与实际依赖绑定错误", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-output-"));
  try {
    const definition = builtInPresetRegistry
      .all()
      .find((item) => item.metadata.name === "ts-lib")!;
    const preparation = prepareGeneratedRepositoryInitialization({
      definition,
      targetDir: path.join(root, "consumer"),
      overrides: { scope: "custom", name: "library", path: "modules/library" },
    });
    assert.equal(preparation.status, "ready");
    if (preparation.status !== "ready") throw new Error("初始化准备失败");
    const projectDir = preparation.context.targetDir;
    await renderNewProject({
      targetRoot: projectDir,
      operations: [...preparation.plan.operations],
    });
    await validateGeneratedOutput({ projectDir, plan: preparation.plan });

    const sourceFile = path.join(projectDir, "modules/library/src/index.ts");
    const source = await readFile(sourceFile, "utf8");
    await writeFile(sourceFile, "  \n" + source);
    await assert.rejects(
      validateGeneratedOutput({ projectDir, plan: preparation.plan }),
      /modules\/library\/src\/index.ts.*格式/u,
    );
    await writeFile(sourceFile, source);

    const manifestFile = path.join(projectDir, "modules/library/package.json");
    const manifest = await readFile(manifestFile, "utf8");
    await writeFile(
      manifestFile,
      manifest.replace('"valibot": "catalog:"', '"valibot": "^1.0.0"'),
    );
    await assert.rejects(
      validateGeneratedOutput({ projectDir, plan: preparation.plan }),
      /依赖目录归属/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
