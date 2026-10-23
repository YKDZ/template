import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { preset as presetDefinition } from "@ykdz/preset-ts-lib/template";
import { referencePackage as libraryDefinition } from "@ykdz/reference-ts-lib/template";
import {
  contentIdentityKey,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import { definePreset } from "@ykdz/template-core/preset-definition";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
  ],
});
const root = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-workspace-root",
);
const library = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-ts-lib",
);
const configuration = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-tooling-config",
);
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
assert.ok(root);
assert.ok(library);
assert.ok(configuration);
assert.ok(preset);

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

const temporaryRoots = new Set<string>();

async function createTemporaryRoot(prefix: string, name = "demo") {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, name);
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("TypeScript 库公开预设", () => {
  void it("通过公开声明初始化、连续加包并复用共享配置", async () => {
    const targetRoot = await createTemporaryRoot("template-ts-lib-preset-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: { nodes: Record<string, string> }[];
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
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: { nodes: Record<string, string> }[];
    };
    assert.strictEqual(
      updatedRecord.selections[0]?.nodes.library,
      initialRecord.selections[0]?.nodes.library,
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
        (item) => item.path === "packages/tooling-config",
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
    for (const temporaryRoot of roots) temporaryRoots.add(temporaryRoot);
    const presetGenerator = createDefaultGenerator({ content });
    const referenceGenerator = createDefaultGenerator({
      content,
    });
    const presetResult = await presetGenerator.init({
      targetRoot: path.join(roots[0]!, "demo"),
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    const referenceResult = await referenceGenerator.init({
      targetRoot: path.join(roots[1]!, "demo"),
      selection: {
        roots: [
          { nodeIdentity: "root", contentIdentity: root.identity },
          { nodeIdentity: "library", contentIdentity: library.identity },
        ],
      },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(presetResult.status, "success");
    assert.strictEqual(referenceResult.status, "success");
    if (
      presetResult.status !== "success" ||
      referenceResult.status !== "success"
    ) {
      throw new Error("初始化成功后应返回正式生成结果");
    }
    const comparableBlueprint = (blueprint: typeof presetResult.blueprint) => ({
      ...blueprint,
      packages: blueprint.packages
        .map(({ name, path, role }) => ({ name, path, role }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    });
    assert.deepStrictEqual(
      comparableBlueprint(presetResult.blueprint),
      comparableBlueprint(referenceResult.blueprint),
    );
    assert.deepStrictEqual(
      presetResult.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [preset.identity],
    );
    assert.deepStrictEqual(
      referenceResult.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [null],
    );
    const presetFiles = JSON.parse(
      await snapshotTree(path.join(roots[0]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    const referenceFiles = JSON.parse(
      await snapshotTree(path.join(roots[1]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    assert.deepStrictEqual(
      presetFiles.filter(
        (entry) =>
          entry.path !== ".template/generation.json" &&
          entry.path !== ".template/blueprint.json",
      ),
      referenceFiles.filter(
        (entry) =>
          entry.path !== ".template/generation.json" &&
          entry.path !== ".template/blueprint.json",
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
    const targetRoot = await createTemporaryRoot("template-ts-lib-layout-");
    const generator = createDefaultGenerator({
      content: [root, library, configuration, layoutPresetMember],
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        presets: [{ contentIdentity: layoutPresetMember.identity }],
      },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
        ".",
        "modules/archive",
        "modules/fallback",
        "modules/second",
        "modules/third",
        "packages/tooling-config",
      ].toSorted(),
    );
    await assert.rejects(stat(path.join(targetRoot, "packages/lib")));
  });

  void it("缺少原生共享依赖或新增路径冲突时保持目标不变", async () => {
    const missingTarget = await createTemporaryRoot("template-ts-lib-missing-");
    const missingGenerator = createDefaultGenerator({
      content: [root, library, preset],
    });
    const missing = await missingGenerator.init({
      targetRoot: missingTarget,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(missing.status, "operation-failure");
    await assert.rejects(readFile(path.join(missingTarget, "package.json")));

    const targetRoot = await createTemporaryRoot("template-ts-lib-conflict-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const targetRoot = await createTemporaryRoot(
      "template-ts-lib-missing-manifest-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
      preset: preset.identity,
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
    const targetRoot = await createTemporaryRoot("template-ts-lib-binding-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: {
        contentIdentity: ContentIdentity;
        dependencyBindings: Record<string, string>;
      }[];
    };
    const libraryRecord = record.packages.find(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(library.identity),
    );
    assert.ok(libraryRecord);
    libraryRecord.dependencyBindings["tooling-config"] =
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
