import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  contentIdentityKey,
  isContentIdentity,
  type ContentIdentity,
} from "@ykdz/template-core/content-identity";
import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import type {
  GeneratorContent,
  PackageCreationInput,
  WorkspaceStrategy,
} from "@ykdz/template-core/workspace-strategy";
import {
  createGenerator,
  parseGenerationRecord,
} from "@ykdz/template-generator";

type DocumentationContext = {
  readonly targetRoot: string;
  readonly policyId: string;
  readonly collection: string;
  readonly edition: string;
};

type DocumentationInput = {
  readonly collection: string;
  readonly edition: string;
};

type DocumentationState = {
  readonly policyId: string;
  readonly collection: string;
  readonly edition: string;
};

type DocumentationContribution = {
  readonly definition: PackageDefinition;
  readonly operations: readonly RenderOperation[];
};

type DocumentationContent = GeneratorContent<
  DocumentationContext,
  DocumentationContribution,
  PackageCreationInput
>;

const guideIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-guide",
  exportPath: "./template",
} satisfies ContentIdentity;
const glossaryIdentity = {
  namespace: "test-docs",
  packageName: "@fixture/docs-glossary",
  exportPath: "./template",
} satisfies ContentIdentity;
const guideIdentityKey = contentIdentityKey(guideIdentity);
const glossaryIdentityKey = contentIdentityKey(glossaryIdentity);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocumentationState(value: unknown): DocumentationState {
  if (
    !isRecord(value) ||
    typeof value.policyId !== "string" ||
    typeof value.collection !== "string" ||
    typeof value.edition !== "string"
  ) {
    throw new Error("文档策略记录缺少必要事实");
  }
  return {
    policyId: value.policyId,
    collection: value.collection,
    edition: value.edition,
  };
}

function createDocumentationEngine(options: {
  readonly policyId: string;
  readonly author: string;
  readonly includeGlossary?: boolean;
  readonly invalidProjection?: "duplicate" | "unallocated";
}) {
  const glossary: DocumentationContent = {
    identity: glossaryIdentity,
    kind: "reference",
    alias: "glossary",
    source: {
      specifier: "@fixture/docs-glossary/template",
      moduleURL: "file:///fixture/docs-glossary/template.js",
      manifestURL: "file:///fixture/docs-glossary/package.json",
    },
    definition: {
      alias: "glossary",
      instance: "shared",
      defaultLeafName: "glossary",
      defaultPath: "docs/glossary",
      role: "documentation",
      contribute({ context, definition }) {
        return {
          definition,
          operations: [
            {
              kind: "writeText",
              to: `${definition.path}/README.md`,
              text: `${context.collection}/${context.edition} glossary by ${options.author}\n`,
            },
          ],
        };
      },
    },
  };
  const guide: DocumentationContent = {
    identity: guideIdentity,
    kind: "reference",
    alias: "guide",
    source: {
      specifier: "@fixture/docs-guide/template",
      moduleURL: "file:///fixture/docs-guide/template.js",
      manifestURL: "file:///fixture/docs-guide/package.json",
    },
    definition: {
      alias: "guide",
      instance: "independent",
      defaultLeafName: "overview",
      defaultPath: "docs/overview",
      role: "documentation",
      contribute({ context, definition, bindings }) {
        const glossaryDefinition = bindings?.get(glossaryIdentityKey);
        if (glossaryDefinition === undefined) {
          throw new Error("文档内容缺少术语表绑定");
        }
        return {
          definition,
          operations: [
            {
              kind: "writeText",
              to: `${definition.path}/README.md`,
              text: `${context.collection}/${context.edition} by ${options.author}: ${definition.name} uses ${glossaryDefinition.path}\n`,
            },
          ],
        };
      },
    },
  };
  const content =
    options.includeGlossary === false ? [guide] : [guide, glossary];

  const strategy: WorkspaceStrategy<
    DocumentationContext,
    DocumentationInput,
    DocumentationState,
    DocumentationContribution,
    PackageCreationInput,
    DocumentationContent
  > = {
    identity: options.policyId,
    initialize({ targetRoot, input, selection }) {
      if (
        selection.length !== 1 ||
        !isContentIdentity(selection[0]?.contentIdentity) ||
        contentIdentityKey(selection[0].contentIdentity) !== guideIdentityKey
      ) {
        throw new Error("文档策略只接受明确选择的指南内容");
      }
      const state = { policyId: options.policyId, ...input };
      return { context: { targetRoot, ...state }, state };
    },
    prepareAddition({ targetRoot, state }) {
      return { targetRoot, ...state };
    },
    parseState: parseDocumentationState,
    dependencies({ content: selected }) {
      return contentIdentityKey(selected.identity) === guideIdentityKey
        ? [glossaryIdentity]
        : [];
    },
    bindings({ providers }) {
      return new Map(providers);
    },
    createDefinition({ context, content: selected, creationInput }) {
      const selectedDefinition = selected.definition;
      const leafName = creationInput?.leafName;
      const leaf = leafName ?? selectedDefinition.defaultLeafName;
      return {
        name: `${context.collection}:${leaf}`,
        path:
          creationInput?.packagePath ??
          (leafName === undefined
            ? selectedDefinition.defaultPath
            : `docs/${leafName}`),
        role: selectedDefinition.role,
      };
    },
    project({ context, state, blueprint, contributions }) {
      const index = [
        `${state.collection}/${state.edition} (${state.policyId})`,
        ...blueprint.packages
          .map(
            (definition) =>
              `${definition.role}\t${definition.name}\t${definition.path}`,
          )
          .toSorted(),
      ].join("\n");
      const strategyDocument = {
        policyId: context.policyId,
        collection: context.collection,
        edition: context.edition,
      };
      return {
        ownerFacts: {
          edition: state.edition,
          packageCount: blueprint.packages.length,
        },
        ...(options.invalidProjection === "duplicate"
          ? {
              blueprint: {
                ...blueprint,
                packages: [...blueprint.packages, ...blueprint.packages],
              },
            }
          : options.invalidProjection === "unallocated"
            ? {
                blueprint: {
                  ...blueprint,
                  packages: [
                    ...blueprint.packages,
                    {
                      ...blueprint.packages[0]!,
                      packageDefinitionId: `package-${"a".repeat(64)}`,
                      name: "north:unallocated",
                      path: "docs/unallocated",
                    },
                  ],
                },
              }
            : {}),
        operations: [
          ...contributions.flatMap((contribution) => contribution.operations),
          {
            kind: "writeJson",
            to: ".template/blueprint.json",
            value: blueprint,
          },
          { kind: "writeText", to: "INDEX.md", text: `${index}\n` },
          {
            kind: "writeJson",
            to: ".workspace/strategy.json",
            value: strategyDocument,
          },
        ],
        reconciliation: [
          { path: ".template/blueprint.json", driver: "canonical" },
          { path: "INDEX.md", driver: "text" },
          { path: ".workspace/strategy.json", driver: "canonical" },
        ],
      };
    },
  };

  return createGenerator({ content, strategy });
}

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
    readonly definition: PackageDefinition & {
      readonly packageDefinitionId: string;
    };
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
    assert.strictEqual(firstInitialized.generationRecord.schemaVersion, 1);
    assert.strictEqual(
      firstInitialized.generationRecord.strategyIdentity,
      "test-policy:first",
    );
    assert.strictEqual(firstInitialized.generationRecord.packages.length, 2);
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
    const appendixResult = await first.add({
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
    const faqAddition = await first.add({
      repositoryRoot: firstRoot,
      contentIdentity: guideIdentity,
      creationInput: { leafName: "faq" },
    });
    assert.strictEqual(
      faqAddition.status,
      "success",
      JSON.stringify(faqAddition),
    );
    const unchanged = await first.add({
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
    const secondRecordBefore = await readFile(secondRecordPath, "utf8");
    const secondDryRun = await second.add({
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

    const secondAdd = await second.add({
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
          sharedRecords[0]!.definition.packageDefinitionId,
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
