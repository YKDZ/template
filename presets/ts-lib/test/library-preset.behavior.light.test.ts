import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preset as presetDefinition } from "@ykdz/preset-ts-lib/template";
import { referencePackage as libraryDefinition } from "@ykdz/reference-ts-lib/template";
import {
  contentIdentityKey,
  createContentIndex,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import { definePreset } from "@ykdz/template-core/preset-definition";
import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-typescript-config/template",
    "@ykdz/preset-ts-lib/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const contentIndex = createContentIndex(content);
const library = contentIndex.fromDefinition(
  libraryDefinition,
  "reference",
) as LoadedContentMember<
  ReturnType<typeof defineReferencePackage>,
  "reference"
>;
const configuration = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-typescript-config",
    exportPath: "./template",
  },
  "reference",
);
const preset = contentIndex.fromDefinition(presetDefinition, "preset");

async function snapshotTree(root: string): Promise<string> {
  const files: { path: string; mode: number; content: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else {
        files.push({
          path: relativePath,
          mode: (await stat(fullPath)).mode & 0o777,
          content: await readFile(fullPath, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(files);
}

void describe("TypeScript 库公开预设", () => {
  void it("通过公开声明初始化、连续加包并复用共享配置", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-preset-")),
      "demo",
    );
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const initialRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      nodeInstances: Record<string, string>;
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
    };
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ),
      { name: "@demo/lib" },
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "packages/lib/src/index.ts"))).mode &
        0o777,
      0o644,
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "package.json"))).mode & 0o777,
      0o644,
    );

    const sourcePath = path.join(targetRoot, "packages/lib/src/index.ts");
    const rootManifestPath = path.join(targetRoot, "package.json");
    await writeFile(sourcePath, "export const localChange = true;\n");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    rootManifest.scripts.custom = "echo retained";
    await writeFile(
      rootManifestPath,
      JSON.stringify(rootManifest, null, 2) + "\n",
    );

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const beforePreview = await readFile(generationPath, "utf8");
    const preview = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
      dryRun: true,
    });
    assert.strictEqual(preview.status, "success", JSON.stringify(preview));
    assert.strictEqual(await readFile(generationPath, "utf8"), beforePreview);
    await assert.rejects(stat(path.join(targetRoot, "packages/shared")));

    const first = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
    });
    assert.strictEqual(first.status, "success", JSON.stringify(first));
    const repeated = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
    });
    assert.strictEqual(repeated.status, "success", JSON.stringify(repeated));
    if (repeated.status === "success")
      assert.deepStrictEqual(repeated.actions, []);

    const second = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "another" },
    });
    assert.strictEqual(second.status, "success", JSON.stringify(second));
    const updatedRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      nodeInstances: Record<string, string>;
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
    };
    assert.strictEqual(
      updatedRecord.nodeInstances.library,
      initialRecord.nodeInstances.library,
    );
    for (const identity of [library.identity, configuration.identity]) {
      assert.strictEqual(
        updatedRecord.packages.find(
          (item) =>
            contentIdentityKey(item.contentIdentity) ===
            contentIdentityKey(identity),
        )?.packageDefinitionId,
        initialRecord.packages.find(
          (item) =>
            contentIdentityKey(item.contentIdentity) ===
            contentIdentityKey(identity),
        )?.packageDefinitionId,
      );
    }
    assert.strictEqual(
      await readFile(sourcePath, "utf8"),
      "export const localChange = true;\n",
    );
    assert.strictEqual(
      (await readFile(rootManifestPath, "utf8")).includes(
        '"custom": "echo retained"',
      ),
      true,
    );

    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.strictEqual(
      blueprint.packages.filter(
        (item) => item.path === "packages/typescript-config",
      ).length,
      1,
    );
    assert.strictEqual(
      blueprint.packages.some((item) => item.path === "packages/another"),
      true,
    );
  });

  void it("直接参考与预设选择进入相同初始化图", async () => {
    const roots = await Promise.all([
      mkdtemp(path.join(tmpdir(), "template-ts-lib-preset-graph-")),
      mkdtemp(path.join(tmpdir(), "template-ts-lib-reference-graph-")),
    ]);
    const presetGenerator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const referenceGenerator = createGenerator({
      content: [library, configuration],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const presetResult = await presetGenerator.init({
      targetRoot: path.join(roots[0]!, "demo"),
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    const referenceResult = await referenceGenerator.init({
      targetRoot: path.join(roots[1]!, "demo"),
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: "library" }],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(presetResult.status, "success");
    assert.strictEqual(referenceResult.status, "success");
    if (
      presetResult.status !== "success" ||
      referenceResult.status !== "success"
    ) {
      throw new Error("初始化成功后应返回正式生成结果");
    }
    assert.deepStrictEqual(presetResult.blueprint, referenceResult.blueprint);
    assert.deepStrictEqual(
      presetResult.generationRecord.packages,
      referenceResult.generationRecord.packages,
    );
    assert.deepStrictEqual(presetResult.generationRecord.presetSelections, [
      preset.identity,
    ]);
    assert.deepStrictEqual(
      referenceResult.generationRecord.presetSelections,
      [],
    );
    const presetFiles = JSON.parse(
      await snapshotTree(path.join(roots[0]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    const referenceFiles = JSON.parse(
      await snapshotTree(path.join(roots[1]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    assert.deepStrictEqual(
      presetFiles.filter((entry) => entry.path !== ".template/generation.json"),
      referenceFiles.filter(
        (entry) => entry.path !== ".template/generation.json",
      ),
    );
  });

  void it("节点布局和操作输入贯穿初始化、连续加包和真实回放", async () => {
    const layoutPreset = definePreset({
      metadata: presetDefinition.metadata,
      operations: presetDefinition.operations,
      nodes: {
        library: {
          reference: library.definition,
          layout: { packageDirectory: "modules" },
          creationInput: {
            init: { leafName: "archive" },
            add: { leafName: "fallback" },
          },
        },
      },
    });
    const layoutPresetMember = Object.freeze({
      ...preset,
      alias: layoutPreset.metadata.alias,
      definition: layoutPreset,
    });
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-layout-")),
      "demo",
    );
    const generator = createGenerator({
      content: [library, configuration, layoutPresetMember],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: layoutPresetMember.identity }] },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "modules/archive/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/archive",
    );
    const fallback = await generator.add({
      repositoryRoot: targetRoot,
      preset: layoutPresetMember.identity,
    });
    assert.strictEqual(fallback.status, "success", JSON.stringify(fallback));
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "modules/fallback/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/fallback",
    );

    for (const [index, leafName] of ["second", "second", "third"].entries()) {
      const result = await generator.add({
        repositoryRoot: targetRoot,
        preset: layoutPresetMember.identity,
        creationInput: { leafName },
      });
      assert.strictEqual(result.status, "success", JSON.stringify(result));
      if (index === 1 && result.status === "success") {
        assert.deepStrictEqual(result.actions, []);
      }
      assert.strictEqual(
        JSON.parse(
          await readFile(
            path.join(targetRoot, `modules/${leafName}/package.json`),
            "utf8",
          ),
        ).name,
        `@demo/${leafName}`,
      );
    }
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      [
        "modules/archive",
        "modules/fallback",
        "modules/second",
        "modules/third",
        "packages/typescript-config",
      ].toSorted(),
    );
    await assert.rejects(stat(path.join(targetRoot, "packages/lib")));
  });

  void it("缺少原生共享依赖或新增路径冲突时保持目标不变", async () => {
    const missingTarget = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-missing-")),
      "demo",
    );
    const missingGenerator = createGenerator({
      content: [library, preset],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const missing = await missingGenerator.init({
      targetRoot: missingTarget,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(missing.status, "operation-failure");
    await assert.rejects(readFile(path.join(missingTarget, "package.json")));

    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-conflict-")),
      "demo",
    );
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");
    const occupiedDirectory = path.join(targetRoot, "packages/occupied");
    await mkdir(occupiedDirectory, { recursive: true });
    const userFile = path.join(occupiedDirectory, "keep.txt");
    await writeFile(userFile, "user data\n");
    const before = await readFile(
      path.join(targetRoot, ".template/generation.json"),
      "utf8",
    );

    const conflict = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "occupied" },
    });

    assert.strictEqual(conflict.status, "conflict");
    assert.strictEqual(await readFile(userFile, "utf8"), "user data\n");
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
      before,
    );
  });

  void it("加包时不恢复未链接既有库的缺失 manifest", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-missing-manifest-")),
      "demo",
    );
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const existingManifest = path.join(targetRoot, "packages/lib/package.json");
    await unlink(existingManifest);

    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset,
      creationInput: { leafName: "utilities" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") throw new Error("加包应成功");
    assert.ok(
      !added.actions.some(
        (action) => action.path === "packages/lib/package.json",
      ),
    );
    await assert.rejects(stat(existingManifest), { code: "ENOENT" });
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/utilities/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/utilities",
    );
  });

  void it("生成记录缺少必要绑定时加包失败且不提交", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-ts-lib-binding-")),
      "demo",
    );
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: {
        contentIdentity: ContentIdentity;
        bindings: Record<string, string>;
      }[];
    };
    const libraryRecord = record.packages.find(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(library.identity),
    );
    assert.ok(libraryRecord);
    libraryRecord.bindings[contentIdentityKey(configuration.identity)] =
      "missing-package-instance";
    const corruptedRecord = JSON.stringify(record, null, 2) + "\n";
    await writeFile(generationPath, corruptedRecord);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "rejected" },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.strictEqual(await readFile(generationPath, "utf8"), corruptedRecord);
    await assert.rejects(stat(path.join(targetRoot, "packages/rejected")));
  });
});
