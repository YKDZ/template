import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  contentIdentityKey,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import { parseGenerationRecord } from "@ykdz/template-generator";

import {
  createDocumentationEngine,
  guideIdentity,
  guideIdentityKey,
  glossaryIdentityKey,
  glossaryIdentity,
  isRecord,
} from "../test-support/documentation.ts";

async function snapshotTree(root: string): Promise<string> {
  const files: {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function packageRecords(value: unknown): {
  readonly strategyIdentity: string;
  readonly packages: readonly {
    readonly contentIdentity: ContentIdentity;
    readonly createdBy: string;
    readonly packageDefinitionId: string;
    readonly bindings: Readonly<Record<string, string>>;
  }[];
} {
  if (!isRecord(value) || !Array.isArray(value.packages)) {
    throw new Error("生成记录缺少包实例");
  }
  return value as ReturnType<typeof packageRecords>;
}

void describe("生成器使用测试拥有的文档内容和策略", () => {
  void it("隔离两个引擎并通过连续加包回放共享文档绑定", async () => {
    const firstRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-docs-first-")),
      "project",
    );
    const secondRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-docs-second-")),
      "project",
    );
    const first = createDocumentationEngine({
      policyId: "test-policy:first",
      author: "作者一",
    });
    const second = createDocumentationEngine({
      policyId: "test-policy:second",
      author: "作者二",
    });

    const firstInitialized = await first.init({
      targetRoot: firstRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
    });
    const secondInitialized = await second.init({
      targetRoot: secondRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "south", edition: "release" },
    });
    assert.strictEqual(
      firstInitialized.status,
      "success",
      JSON.stringify(firstInitialized),
    );
    assert.strictEqual(
      secondInitialized.status,
      "success",
      JSON.stringify(secondInitialized),
    );
    if (firstInitialized.status !== "success") {
      throw new Error("初始化应成功");
    }
    assert.strictEqual(firstInitialized.generationRecord.schemaVersion, 4);
    assert.strictEqual(
      firstInitialized.generationRecord.strategyIdentity,
      "test-policy:first",
    );
    assert.strictEqual(firstInitialized.generationRecord.packages.length, 2);
    const initialGuide = firstInitialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) === guideIdentityKey,
    );
    const initialGlossary = firstInitialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) === glossaryIdentityKey,
    );
    assert.ok(initialGuide);
    assert.ok(initialGlossary);
    assert.strictEqual(initialGuide.createdBy, "initialization");
    assert.strictEqual(initialGlossary.createdBy, "shared-dependency");
    assert.strictEqual(initialGuide.creationInput, null);
    assert.strictEqual(initialGuide.configuration, null);
    assert.strictEqual(
      initialGuide.bindings[glossaryIdentityKey],
      initialGlossary.packageDefinitionId,
    );
    assert.strictEqual(Object.hasOwn(initialGuide, "definition"), false);
    assert.ok(firstInitialized.projection !== null);
    assert.deepStrictEqual(firstInitialized.projection.ownerFacts, {
      edition: "draft",
      packageCount: 2,
    });
    const firstRecordOperation = firstInitialized.projection.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".template/generation.json",
    );
    assert.ok(firstRecordOperation?.kind === "writeJson");
    assert.strictEqual(
      firstRecordOperation.value,
      firstInitialized.generationRecord,
    );
    assert.deepStrictEqual(
      parseGenerationRecord(firstInitialized.generationRecord),
      firstInitialized.generationRecord,
    );

    const dryRunRoot = path.join(firstRoot, "dry-run");
    const dryRunInit = await first.init({
      targetRoot: dryRunRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
      dryRun: true,
    });
    assert.strictEqual(
      dryRunInit.status,
      "success",
      JSON.stringify(dryRunInit),
    );
    if (dryRunInit.status !== "success")
      throw new Error("dry-run 初始化应成功");
    assert.strictEqual(dryRunInit.dryRun, true);
    assert.ok(dryRunInit.projection !== null);
    const dryRunRecordOperation = dryRunInit.projection.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".template/generation.json",
    );
    assert.ok(dryRunRecordOperation?.kind === "writeJson");
    assert.strictEqual(
      dryRunRecordOperation.value,
      dryRunInit.generationRecord,
    );
    await assert.rejects(stat(dryRunRoot), { code: "ENOENT" });

    const firstOverview = path.join(firstRoot, "docs/overview/README.md");
    const firstOverviewBefore = await readFile(firstOverview, "utf8");
    const appendixResult = await createDocumentationEngine({
      policyId: "test-policy:first",
      author: "作者一",
    }).add({
      repositoryRoot: firstRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "appendix" },
    });
    assert.strictEqual(
      appendixResult.status,
      "success",
      JSON.stringify(appendixResult),
    );
    if (appendixResult.status !== "success") throw new Error("加包应成功");
    assert.ok(appendixResult.projection !== null);
    const appendixRecord = appendixResult.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) === guideIdentityKey &&
        record.creationInput?.leafName === "appendix",
    );
    assert.ok(appendixRecord);
    assert.strictEqual(appendixRecord.createdBy, "addition");
    assert.deepStrictEqual(appendixRecord.creationInput, {
      leafName: "appendix",
    });
    assert.strictEqual(
      appendixResult.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === appendixRecord.packageDefinitionId,
      )?.path,
      "docs/appendix",
    );
    assert.deepStrictEqual(appendixResult.projection.ownerFacts, {
      edition: "draft",
      packageCount: 3,
    });
    const appendixIndex = appendixResult.projection.operations.find(
      (operation) =>
        operation.kind === "writeText" && operation.to === "INDEX.md",
    );
    assert.ok(appendixIndex?.kind === "writeText");
    assert.match(appendixIndex.text, /docs\/appendix/u);
    const appendixRecordOperation = appendixResult.projection.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".template/generation.json",
    );
    assert.ok(appendixRecordOperation?.kind === "writeJson");
    assert.strictEqual(
      appendixRecordOperation.value,
      appendixResult.generationRecord,
    );
    assert.deepStrictEqual(
      appendixResult.generationRecord,
      JSON.parse(
        await readFile(
          path.join(firstRoot, ".template/generation.json"),
          "utf8",
        ),
      ),
    );
    const faqAddition = await createDocumentationEngine({
      policyId: "test-policy:first",
      author: "作者一",
    }).add({
      repositoryRoot: firstRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "faq" },
    });
    assert.strictEqual(
      faqAddition.status,
      "success",
      JSON.stringify(faqAddition),
    );
    const unchanged = await createDocumentationEngine({
      policyId: "test-policy:first",
      author: "作者一",
    }).add({
      repositoryRoot: firstRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "faq" },
    });
    assert.strictEqual(unchanged.status, "success", JSON.stringify(unchanged));
    if (unchanged.status === "success") {
      assert.deepStrictEqual(unchanged.actions, []);
      assert.strictEqual(unchanged.projection, null);
      assert.deepStrictEqual(
        unchanged.generationRecord,
        JSON.parse(
          await readFile(
            path.join(firstRoot, ".template/generation.json"),
            "utf8",
          ),
        ),
      );
    }
    const secondRecordPath = path.join(secondRoot, ".template/generation.json");
    const secondTreeBeforeDryRun = await snapshotTree(secondRoot);
    const secondRecordBefore = await readFile(secondRecordPath, "utf8");
    const secondDryRun = await createDocumentationEngine({
      policyId: "test-policy:second",
      author: "作者二",
    }).add({
      repositoryRoot: secondRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "appendix" },
      dryRun: true,
    });
    assert.strictEqual(
      secondDryRun.status,
      "success",
      JSON.stringify(secondDryRun),
    );
    if (secondDryRun.status !== "success") {
      throw new Error("dry-run 加包应成功");
    }
    assert.strictEqual(secondDryRun.dryRun, true);
    assert.ok(secondDryRun.projection !== null);
    const secondDryRunRecordOperation = secondDryRun.projection.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".template/generation.json",
    );
    assert.ok(secondDryRunRecordOperation?.kind === "writeJson");
    assert.strictEqual(
      secondDryRunRecordOperation.value,
      secondDryRun.generationRecord,
    );
    await assert.rejects(
      stat(path.join(secondRoot, "docs/appendix/README.md")),
      { code: "ENOENT" },
    );
    assert.strictEqual(
      await readFile(secondRecordPath, "utf8"),
      secondRecordBefore,
    );
    assert.strictEqual(await snapshotTree(secondRoot), secondTreeBeforeDryRun);

    const secondAdd = await createDocumentationEngine({
      policyId: "test-policy:second",
      author: "作者二",
    }).add({
      repositoryRoot: secondRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "appendix" },
    });
    assert.strictEqual(secondAdd.status, "success", JSON.stringify(secondAdd));

    assert.strictEqual(
      await readFile(firstOverview, "utf8"),
      firstOverviewBefore,
    );
    assert.match(
      await readFile(firstOverview, "utf8"),
      /^north\/draft by 作者一: north:overview uses docs\/glossary\n$/u,
    );
    assert.match(
      await readFile(path.join(firstRoot, "docs/faq/README.md"), "utf8"),
      /^north\/draft by 作者一: north:faq uses docs\/glossary\n$/u,
    );
    assert.match(
      await readFile(path.join(secondRoot, "docs/appendix/README.md"), "utf8"),
      /^south\/release by 作者二: south:appendix uses docs\/glossary\n$/u,
    );
    const firstIndex = await readFile(path.join(firstRoot, "INDEX.md"), "utf8");
    const secondIndex = await readFile(
      path.join(secondRoot, "INDEX.md"),
      "utf8",
    );
    assert.match(firstIndex, /docs\/overview/u);
    assert.match(firstIndex, /docs\/appendix/u);
    assert.match(firstIndex, /docs\/faq/u);
    assert.doesNotMatch(firstIndex, /south|作者二/u);
    assert.match(secondIndex, /docs\/overview/u);
    assert.match(secondIndex, /docs\/appendix/u);
    assert.doesNotMatch(secondIndex, /north|作者一/u);

    const firstRecord = packageRecords(
      JSON.parse(
        await readFile(
          path.join(firstRoot, ".template/generation.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const sharedRecords = firstRecord.packages.filter(
      (record) =>
        contentIdentityKey(record.contentIdentity) === glossaryIdentityKey,
    );
    const guideRecords = firstRecord.packages.filter(
      (record) =>
        contentIdentityKey(record.contentIdentity) === guideIdentityKey,
    );
    assert.strictEqual(firstRecord.strategyIdentity, "test-policy:first");
    assert.strictEqual(sharedRecords.length, 1);
    assert.strictEqual(guideRecords.length, 3);
    assert.ok(
      guideRecords.every(
        (record) =>
          record.bindings[glossaryIdentityKey] ===
          sharedRecords[0]!.packageDefinitionId,
      ),
    );

    const beforeWrongStrategy = await snapshotTree(firstRoot);
    const wrongStrategy = await second.add({
      repositoryRoot: firstRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "wrong-policy" },
    });
    assert.strictEqual(wrongStrategy.status, "operation-failure");
    assert.strictEqual(await snapshotTree(firstRoot), beforeWrongStrategy);
  });

  void it("缺少必要文档内容时初始化失败且新目标不存在", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-docs-missing-")),
      "project",
    );
    const generator = createDocumentationEngine({
      policyId: "test-policy:missing",
      author: "缺失内容测试",
      includeGlossary: false,
    });

    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.strictEqual(await pathExists(targetRoot), false);
  });

  void it("拒绝旧版本和缺失持久事实的记录且所有add模式零写入", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-schema4-")),
      "project",
    );
    const generator = createDocumentationEngine({
      policyId: "test-policy:schema4",
      author: "schema4测试",
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));

    const userFile = path.join(targetRoot, "user-data.txt");
    await writeFile(userFile, "保留用户内容\n");
    await chmod(userFile, 0o640);
    const recordPath = path.join(targetRoot, ".template/generation.json");
    const validRecord = JSON.parse(
      await readFile(recordPath, "utf8"),
    ) as Record<string, unknown>;
    const cloneRecord = () =>
      JSON.parse(JSON.stringify(validRecord)) as Record<string, unknown>;
    const cases = [
      ...([1, 2, 3] as const).map((schemaVersion) => ({
        label: `schema${schemaVersion}`,
        record: {
          schemaVersion,
          strategyIdentity: validRecord.strategyIdentity,
          strategyState: validRecord.strategyState,
          packages: [
            {
              contentIdentity: guideIdentity,
              definition: { packageDefinitionId: "legacy-package" },
            },
          ],
        },
        message: new RegExp(`不支持的生成记录 schema ${schemaVersion}`, "u"),
      })),
      {
        label: "strategyState",
        record: (() => {
          const record = cloneRecord();
          delete record.strategyState;
          return record;
        })(),
        message: /schema4 结构/u,
      },
      {
        label: "creationInput",
        record: (() => {
          const record = cloneRecord();
          const packages = record.packages as Record<string, unknown>[];
          delete packages[0]!.creationInput;
          return record;
        })(),
        message: /schema4 结构/u,
      },
      {
        label: "configuration",
        record: (() => {
          const record = cloneRecord();
          delete (record.packages as Record<string, unknown>[])[0]!
            .configuration;
          return record;
        })(),
        message: /schema4 结构/u,
      },
      {
        label: "nodeInstances",
        record: (() => {
          const record = cloneRecord();
          delete (record.nodeInstances as Record<string, string>).guide;
          return record;
        })(),
        message: /缺少必要节点实例映射/u,
      },
      {
        label: "package instance",
        record: (() => {
          const record = cloneRecord();
          const packages = record.packages as Record<string, unknown>[];
          const guide = packages.find(
            (item) =>
              contentIdentityKey(item.contentIdentity as ContentIdentity) ===
              guideIdentityKey,
          )!;
          delete (guide.bindings as Record<string, string>)[
            glossaryIdentityKey
          ];
          record.packages = packages.filter(
            (item) =>
              contentIdentityKey(item.contentIdentity as ContentIdentity) !==
              glossaryIdentityKey,
          );
          return record;
        })(),
        message: /生成记录与蓝图的包实例数量不一致/u,
      },
      {
        label: "required binding",
        record: (() => {
          const record = cloneRecord();
          const packages = record.packages as Record<string, unknown>[];
          const guide = packages.find(
            (item) =>
              contentIdentityKey(item.contentIdentity as ContentIdentity) ===
              guideIdentityKey,
          )!;
          delete (guide.bindings as Record<string, string>)[
            glossaryIdentityKey
          ];
          return record;
        })(),
        message: /缺少必要实例绑定/u,
      },
    ] as const;

    for (const testCase of cases) {
      await writeFile(recordPath, JSON.stringify(testCase.record));
      const before = await snapshotTree(targetRoot);
      for (const dryRun of [true, false]) {
        const result = await generator.add({
          repositoryRoot: targetRoot,
          contentIdentity: guideIdentity,
          creationInput: { leafName: `rejected-${testCase.label}` },
          dryRun,
        });
        assert.equal(
          result.status,
          "operation-failure",
          JSON.stringify(result),
        );
        if (result.status !== "operation-failure") {
          throw new Error("无效生成记录必须拒绝加包");
        }
        assert.equal(result.phase, "metadata");
        assert.match(result.error.message, testCase.message);
        assert.equal(await snapshotTree(targetRoot), before);
      }
    }
  });

  void it("已有目标拒绝初始化时报告渲染失败并保留目标内容", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-generator-docs-existing-target-"),
    );
    const markerPath = path.join(targetRoot, "keep.txt");
    await writeFile(markerPath, "用户内容\n");
    const before = await snapshotTree(targetRoot);
    const generator = createDocumentationEngine({
      policyId: "test-policy:existing-target",
      author: "已有目标测试",
    });

    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
    });

    assert.deepStrictEqual(result, {
      status: "operation-failure",
      phase: "render",
      error: { message: `Target directory is not empty: ${targetRoot}` },
    });
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("正式协调冲突拒绝新增并完整保留当前目标", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-docs-conflict-")),
      "project",
    );
    const generator = createDocumentationEngine({
      policyId: "test-policy:conflict",
      author: "冲突测试",
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
      },
      strategyInput: { collection: "north", edition: "draft" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    await writeFile(path.join(targetRoot, "INDEX.md"), "# 用户编辑\n");
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "late-addition" },
    });

    assert.strictEqual(result.status, "conflict", JSON.stringify(result));
    assert.strictEqual(await snapshotTree(targetRoot), before);
    assert.strictEqual(
      await pathExists(path.join(targetRoot, "docs/late-addition/README.md")),
      false,
    );
  });

  void it("提交前拒绝重复或未分配的策略蓝图包实例", async () => {
    for (const invalidProjection of ["duplicate", "unallocated"] as const) {
      const targetRoot = path.join(
        await mkdtemp(
          path.join(tmpdir(), `template-generator-docs-${invalidProjection}-`),
        ),
        "project",
      );
      const generator = createDocumentationEngine({
        policyId: `test-policy:${invalidProjection}`,
        author: "无效蓝图测试",
        invalidProjection,
      });

      const result = await generator.init({
        targetRoot,
        selection: {
          roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
        },
        strategyInput: { collection: "north", edition: "draft" },
      });

      assert.strictEqual(result.status, "operation-failure");
      assert.strictEqual(await pathExists(targetRoot), false);
    }
  });
});

void it("现行配置在新建、fresh add恢复和共享依赖回放中保持同一条件决定", async () => {
  const targetRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "template-config-")),
    "project",
  );
  const engine = () =>
    createDocumentationEngine({
      policyId: "configured-docs",
      author: "配置作者",
      configurableGlossary: true,
    });
  const initialized = await engine().init({
    targetRoot,
    selection: {
      roots: [
        {
          nodeIdentity: "guide",
          contentIdentity: guideIdentity,
          configuration: { glossary: false },
        },
      ],
    },
    strategyInput: { collection: "north", edition: "draft" },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  assert.equal(initialized.generationRecord.packages.length, 1);
  assert.deepEqual(initialized.generationRecord.packages[0]!.configuration, {
    glossary: false,
  });
  const added = await engine().add({
    repositoryRoot: targetRoot,
    contentIdentity: guideIdentity,
    creationInput: { leafName: "appendix" },
    configuration: { glossary: true },
  });
  assert.equal(added.status, "success", JSON.stringify(added));
  if (added.status !== "success") return;
  assert.equal(added.generationRecord.packages.length, 3);
  const internal = await engine().add({
    repositoryRoot: targetRoot,
    contentIdentity: guideIdentity,
    creationInput: { leafName: "notes" },
  });
  assert.equal(internal.status, "success", JSON.stringify(internal));
  if (internal.status !== "success") return;
  assert.equal(internal.generationRecord.packages.length, 4);
  assert.equal(
    internal.generationRecord.packages.filter(
      (record) =>
        contentIdentityKey(record.contentIdentity) === glossaryIdentityKey,
    ).length,
    1,
  );
  const notes = internal.generationRecord.packages.find(
    (record) => record.creationInput?.leafName === "notes",
  )!;
  assert.deepEqual(notes.configuration, { glossary: false });
  assert.deepEqual(notes.bindings, {});
  const before = await snapshotTree(targetRoot);
  const conflicting = await engine().add({
    repositoryRoot: targetRoot,
    contentIdentity: guideIdentity,
    creationInput: { leafName: "notes" },
    configuration: { glossary: true },
  });
  assert.equal(conflicting.status, "conflict", JSON.stringify(conflicting));
  assert.equal(await snapshotTree(targetRoot), before);
});

void it("正式配置已有指南保持实例并补齐共享依赖，重复请求无动作", async () => {
  const targetRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "template-configure-")),
    "project",
  );
  const engine = () =>
    createDocumentationEngine({
      policyId: "configured-existing",
      author: "配置作者",
      configurableGlossary: true,
    });
  const initialized = await engine().init({
    targetRoot,
    selection: {
      roots: [
        {
          nodeIdentity: "guide",
          contentIdentity: guideIdentity,
          creationInput: {
            leafName: "custom-guide",
            packagePath: "docs/custom-guide",
          },
        },
      ],
    },
    strategyInput: { collection: "north", edition: "draft" },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  const original = initialized.generationRecord.packages[0]!;
  const configured = await engine().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: original.packageDefinitionId,
    configuration: { glossary: true },
  });
  assert.equal(configured.status, "success", JSON.stringify(configured));
  if (configured.status !== "success") return;
  assert.equal(configured.generationRecord.packages.length, 2);
  const current = configured.generationRecord.packages.find(
    (record) => record.packageDefinitionId === original.packageDefinitionId,
  )!;
  assert.deepEqual(
    {
      ...current,
      configuration: original.configuration,
      bindings: original.bindings,
    },
    original,
  );
  assert.deepEqual(current.configuration, { glossary: true });
  assert.deepEqual(
    configured.blueprint.packages.find(
      (definition) =>
        definition.packageDefinitionId === original.packageDefinitionId,
    ),
    initialized.blueprint.packages[0],
  );
  assert.equal(Object.keys(current.bindings).length, 1);
  const snapshot = await snapshotTree(targetRoot);
  const repeated = await engine().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: original.packageDefinitionId,
    configuration: { glossary: true },
  });
  assert.equal(repeated.status, "success", JSON.stringify(repeated));
  if (repeated.status !== "success") return;
  assert.deepEqual(repeated.actions, []);
  assert.equal(await snapshotTree(targetRoot), snapshot);
});

void it("已有实例的新配置形成跨既有绑定的依赖环时拒绝且不写入", async () => {
  const targetRoot = path.join(
    await mkdtemp(path.join(tmpdir(), "template-configure-cycle-")),
    "project",
  );
  const engine = () =>
    createDocumentationEngine({
      policyId: "configured-cycle",
      author: "文档作者",
      configurableGlossary: true,
      glossaryUsesGuide: true,
    });
  const initialized = await engine().init({
    targetRoot,
    selection: {
      roots: [{ nodeIdentity: "guide", contentIdentity: guideIdentity }],
    },
    strategyInput: { collection: "north", edition: "draft" },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  const target = initialized.generationRecord.packages[0]!;
  const provider = await engine().add({
    repositoryRoot: targetRoot,
    contentIdentity: glossaryIdentity,
  });
  assert.equal(provider.status, "success", JSON.stringify(provider));
  const before = await snapshotTree(targetRoot);
  const configured = await engine().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: target.packageDefinitionId,
    configuration: { glossary: true },
  });
  assert.equal(
    configured.status,
    "operation-failure",
    JSON.stringify(configured),
  );
  if (configured.status !== "operation-failure") return;
  assert.match(configured.error.message, /循环/u);
  assert.equal(await snapshotTree(targetRoot), before);
});
