import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Composition } from "@ykdz/template-core/composition";
import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  PackageDefinition,
  PackageDefinitionId,
} from "@ykdz/template-core/project-blueprint";
import type {
  PackageBinding,
  PresetSelectionDefinition,
} from "@ykdz/template-core/reference-package";

import { createGenerator } from "../src/index.ts";

const referenceIdentity: ContentIdentity = {
  namespace: "fixture",
  packageName: "@fixture/docs",
  exportPath: "./reference",
};
const compositionIdentity: ContentIdentity = {
  namespace: "fixture",
  packageName: "@fixture/docs",
  exportPath: "./composition",
};
const presetIdentity: ContentIdentity = {
  namespace: "fixture",
  packageName: "@fixture/docs",
  exportPath: "./preset",
};

type CreationInput = {
  readonly path: string;
  readonly leak?: boolean;
  readonly nearPrefix?: boolean;
  readonly metadataAncestor?: boolean;
  readonly outputPath?: string;
  readonly emptyFiles?: boolean;
  readonly hierarchicalOutputs?: "conflict" | "valid";
};
type Conventions = { readonly edition: string };
type Contribution = PackageContribution<{
  readonly path: string;
  readonly resourcePaths: readonly string[];
}>;
type OperationFacts = { readonly currentProvider: string };
type StableCommon = {
  readonly edition: string;
  readonly currentProvider: string;
};
type PackageInput = { readonly currentProvider: string };
type DocumentationComposition = Composition<
  Conventions,
  StableCommon,
  PackageInput,
  Contribution["facts"],
  { readonly packageCount: number },
  CreationInput,
  OperationFacts
>;

function documentationEngine() {
  const reference: LoadedContentMember<
    {
      readonly alias: string;
      readonly instance: "independent";
      prepare(options?: { readonly excludedPackagePaths: readonly string[] }): {
        readonly resources: readonly {
          path: string;
          content: Uint8Array;
          mode: number;
        }[];
        readonly facts: {};
      };
      parseCreationInput(value: unknown): CreationInput;
      createDefinition(options: {
        readonly creationInput: CreationInput | undefined;
      }): PackageDefinition;
      evaluate(options: {
        readonly packageDefinitionId: Contribution["packageDefinitionId"];
        readonly definition: PackageDefinition;
        readonly prepared: {
          readonly resources: readonly {
            path: string;
            content: Uint8Array;
            mode: number;
          }[];
          readonly facts: {};
        };
        readonly stableCommon: StableCommon;
        readonly packageInput: PackageInput | undefined;
        readonly bindings: ReadonlyMap<string, PackageBinding>;
        readonly creationInput: CreationInput | undefined;
      }): Contribution;
    },
    "reference"
  > = {
    identity: referenceIdentity,
    kind: "reference",
    alias: "docs",
    source: {
      specifier: "@fixture/docs/reference",
      moduleURL: "file:///fixture/docs/reference.js",
      manifestURL: "file:///fixture/docs/package.json",
    },
    definition: {
      alias: "docs",
      instance: "independent",
      prepare(options?: { readonly excludedPackagePaths: readonly string[] }) {
        const excludedPackagePaths = options?.excludedPackagePaths ?? [];
        const resources = [
          {
            path: "README.md",
            content: new TextEncoder().encode("guide\n"),
            mode: 0,
          },
        ];
        if (!excludedPackagePaths.includes("packages/a")) {
          resources.push({
            path: "packages/a/README.md",
            content: new TextEncoder().encode("nested child resource\n"),
            mode: 0,
          });
        }
        return {
          resources,
          facts: {},
        };
      },
      parseCreationInput(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          typeof (value as Record<string, unknown>).path !== "string"
        ) {
          throw new Error("包创建输入必须包含路径");
        }
        return value as CreationInput;
      },
      createDefinition({ creationInput }) {
        const packagePath = creationInput?.path ?? "docs/overview";
        return {
          name: packagePath === "." ? "docs-root" : packagePath,
          path: packagePath,
          role: "documentation",
        };
      },
      evaluate({
        packageDefinitionId,
        definition,
        prepared,
        stableCommon,
        packageInput,
        creationInput,
      }) {
        const source = prepared.resources.find(
          (file) => file.path === "README.md",
        );
        if (source === undefined) throw new Error("缺少 README 资源");
        const files = creationInput?.emptyFiles
          ? []
          : creationInput?.hierarchicalOutputs === "conflict"
            ? ["config", "config.example", "config/settings.json"].map(
                (path) => ({
                  path,
                  content: new TextEncoder().encode(`${path}\n`),
                  mode: 0,
                }),
              )
            : creationInput?.hierarchicalOutputs === "valid"
              ? ["config.example", "config/settings.json"].map((path) => ({
                  path,
                  content: new TextEncoder().encode(`${path}\n`),
                  mode: 0,
                }))
              : [
                  {
                    path:
                      creationInput?.outputPath ??
                      (creationInput?.leak
                        ? "packages/a/README.md"
                        : creationInput?.metadataAncestor
                          ? ".template"
                          : "README.md"),
                    content: new TextEncoder().encode(
                      `${stableCommon.edition}:${stableCommon.currentProvider}:${packageInput?.currentProvider}:${new TextDecoder().decode(source.content)}`,
                    ),
                    mode: 0,
                  },
                ];
        if (creationInput?.nearPrefix) {
          files.push({
            path: "packages/ab/ROOT.md",
            content: new TextEncoder().encode("near prefix\n"),
            mode: 0,
          });
        }
        return {
          packageDefinitionId,
          files,
          reconciliation: files.map(({ path }) => ({
            path,
            driver: "text" as const,
          })),
          facts: {
            path: definition.path,
            resourcePaths: prepared.resources.map((file) => file.path),
          },
        };
      },
    },
  };

  const preset: LoadedContentMember<
    PresetSelectionDefinition<CreationInput>,
    "preset"
  > = {
    identity: presetIdentity,
    kind: "preset",
    alias: "docs-preset",
    source: {
      specifier: "@fixture/docs/preset",
      moduleURL: "file:///fixture/docs/preset.js",
      manifestURL: "file:///fixture/docs/package.json",
    },
    definition: {
      kind: "preset",
      operations: ["init"],
      nodes: {
        child: {
          reference: { alias: "docs", instance: "independent" },
          creationInput: { init: { path: "packages/a" } },
        },
      },
    },
  };

  const composition: DocumentationComposition = {
    identity: compositionIdentity,
    parseConventions(value: unknown): Conventions {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as Record<string, unknown>).edition !== "string"
      ) {
        throw new Error("缺少 edition 约定");
      }
      return { edition: (value as { edition: string }).edition };
    },
    resolve({ conventions, operationFacts, packages }) {
      return {
        stableCommon: {
          edition: conventions.edition,
          currentProvider: operationFacts.currentProvider,
        },
        packageInputs: new Map<PackageDefinitionId, PackageInput>(
          packages.map((item) => [
            item.packageDefinitionId,
            { currentProvider: operationFacts.currentProvider },
          ]),
        ),
      };
    },
    combine({ blueprint, packages }) {
      const root = blueprint.packages.find((item) => item.path === ".");
      if (root === undefined) throw new Error("组合需要根目录参考包");
      const child = blueprint.packages.find(
        (item) => item.path === "packages/a",
      );
      const rootPackage = packages.find(
        (item) => item.package.packageDefinitionId === root.packageDefinitionId,
      );
      if (
        child !== undefined &&
        rootPackage?.contribution.facts.resourcePaths.includes(
          "packages/a/README.md",
        )
      ) {
        throw new Error("根包收集了已登记子包的资源");
      }
      return {
        files: [
          {
            packageDefinitionId: root.packageDefinitionId,
            file: {
              path: "INDEX.md",
              content: new TextEncoder().encode("documentation index\n"),
              mode: 0,
            },
          },
        ],
        reconciliation: [
          {
            packageDefinitionId: root.packageDefinitionId,
            reconciliation: { path: "INDEX.md", driver: "text" as const },
          },
        ],
        facts: { packageCount: blueprint.packages.length },
      };
    },
  };
  const generator = createGenerator({
    content: [reference, preset],
    composition,
  });

  return { generator, reference };
}

async function withTemporaryTarget(
  run: (targetRoot: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "generator-public-sdk-"),
  );
  try {
    await run(path.join(temporaryRoot, "target"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void describe("公开生成计算", () => {
  void it("准备资源时包含直接根与预设子包的完整目标作用域", async () => {
    const { generator } = documentationEngine();
    const prepared = await generator.prepareProject({
      selection: {
        roots: [
          {
            nodeIdentity: "root-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: "." },
          },
        ],
        presets: [{ contentIdentity: presetIdentity }],
      },
      conventions: { edition: "draft" },
      operationFacts: { currentProvider: "provider-snapshot" },
    });
    const root = prepared.selections[0]?.roots[0];

    assert.ok(root);
    assert.deepEqual(
      root.preparation.resources.map((resource) => resource.path),
      ["README.md"],
    );
    assert.equal(generator.computeProject(prepared).packages.length, 2);
  });

  void it("拒绝文件占用已登记子包目录及其祖先", async () => {
    const { generator } = documentationEngine();
    await withTemporaryTarget(async (targetRoot) => {
      for (const outputPath of ["packages/a", "packages"]) {
        const result = await generator.planInit({
          targetRoot,
          selection: {
            roots: [
              {
                nodeIdentity: "root-guide",
                contentIdentity: referenceIdentity,
                creationInput: { path: ".", outputPath },
              },
              {
                nodeIdentity: "child-guide",
                contentIdentity: referenceIdentity,
                creationInput: { path: "packages/a", emptyFiles: true },
              },
            ],
          },
          conventions: { edition: "draft" },
          operationFacts: { currentProvider: "provider-snapshot" },
        });
        assert.equal(
          result.status,
          "operation-failure",
          JSON.stringify(result),
        );
        if (result.status !== "operation-failure") {
          throw new Error("文件不能占用已登记包目录");
        }
        assert.equal(result.phase, "calculation");
        assert.match(result.error.message, /已登记包目录/u);
        await assert.rejects(access(targetRoot), { code: "ENOENT" });
      }
    });
  });

  void it("纯规划检测非相邻文件与目录冲突且允许近似路径", async () => {
    const { generator } = documentationEngine();
    await withTemporaryTarget(async (targetRoot) => {
      const conflicted = await generator.planInit({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "root-guide",
              contentIdentity: referenceIdentity,
              creationInput: { path: ".", hierarchicalOutputs: "conflict" },
            },
          ],
        },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });

      assert.equal(
        conflicted.status,
        "operation-failure",
        JSON.stringify(conflicted),
      );
      if (conflicted.status !== "operation-failure") {
        throw new Error("文件树前缀冲突必须在计算阶段拒绝");
      }
      assert.equal(conflicted.phase, "calculation");
      assert.match(conflicted.error.message, /文件与目录路径冲突/u);
      await assert.rejects(access(targetRoot), { code: "ENOENT" });

      const valid = await generator.planInit({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "root-guide",
              contentIdentity: referenceIdentity,
              creationInput: { path: ".", hierarchicalOutputs: "valid" },
            },
          ],
        },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });

      assert.equal(valid.status, "planned", JSON.stringify(valid));
      await assert.rejects(access(targetRoot), { code: "ENOENT" });
    });
  });

  void it("同一参考声明可作为根包和子包，重复计算不访问目标或改变结果", async () => {
    const { generator } = documentationEngine();
    const prepared = await generator.prepareProject({
      selection: {
        roots: [
          {
            nodeIdentity: "root-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: ".", nearPrefix: true },
          },
          {
            nodeIdentity: "child-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: "packages/a" },
          },
        ],
      },
      conventions: { edition: "draft" },
      operationFacts: { currentProvider: "provider-snapshot" },
    });

    const first = generator.computeProject(prepared);
    const second = generator.computeProject(prepared);
    const summarize = (result: typeof first) =>
      result.projection.entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        content: new TextDecoder().decode(entry.content),
      }));

    assert.deepEqual(summarize(first), summarize(second));
    const reorderedPreparation = await generator.prepareProject({
      selection: {
        roots: [
          {
            nodeIdentity: "root-guide",
            contentIdentity: referenceIdentity,
            creationInput: { nearPrefix: true, path: "." },
          },
          {
            nodeIdentity: "child-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: "packages/a" },
          },
        ],
      },
      conventions: { edition: "draft" },
      operationFacts: { currentProvider: "provider-snapshot" },
    });
    const reordered = generator.computeProject(reorderedPreparation);
    assert.deepEqual(summarize(first), summarize(reordered));
    assert.deepEqual(
      summarize(first).map((entry) => entry.path),
      [
        ".template/blueprint.json",
        ".template/generation.json",
        "INDEX.md",
        "README.md",
        "packages/a/README.md",
        "packages/ab/ROOT.md",
      ],
    );
    assert.equal(
      first.projection.entries.some((entry) => entry.path === "package.json"),
      false,
    );
    assert.deepEqual(first.ownerFacts, { packageCount: 2 });
    assert.equal(
      new TextDecoder().decode(
        first.projection.entries.find((entry) => entry.path === "README.md")
          ?.content,
      ),
      "draft:provider-snapshot:provider-snapshot:guide\n",
    );
    const ownerPackageCount: number = first.ownerFacts.packageCount;
    const savedEdition: string =
      first.generationRecord.composition.conventions.edition;
    assert.equal(ownerPackageCount, 2);
    assert.equal(savedEdition, "draft");
    assert.equal(
      contentIdentityKey(first.generationRecord.composition.identity),
      contentIdentityKey(compositionIdentity),
    );
    assert.equal(first.blueprint.schemaVersion, 4);
  });

  void it("拒绝根包越界写入已登记子包目录", async () => {
    const { generator } = documentationEngine();
    const prepared = await generator.prepareProject({
      selection: {
        roots: [
          {
            nodeIdentity: "root-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: ".", leak: true },
          },
          {
            nodeIdentity: "child-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: "packages/a" },
          },
        ],
      },
      conventions: { edition: "draft" },
      operationFacts: { currentProvider: "provider-snapshot" },
    });

    assert.throws(
      () => generator.computeProject(prepared),
      /该路径归属于 packages\/a/u,
    );
  });

  void it("拒绝包文件占用生成器元数据目录", async () => {
    const { generator } = documentationEngine();
    const prepared = await generator.prepareProject({
      selection: {
        roots: [
          {
            nodeIdentity: "root-guide",
            contentIdentity: referenceIdentity,
            creationInput: { path: ".", metadataAncestor: true },
          },
        ],
      },
      conventions: { edition: "draft" },
      operationFacts: { currentProvider: "provider-snapshot" },
    });

    assert.throws(
      () => generator.computeProject(prepared),
      /包贡献路径与生成器元数据路径冲突/u,
    );
  });
});
