import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import type { CurrentProjectProjectionEntry } from "@ykdz/template-core/project-projection";
import type {
  PackageBinding,
  PresetSelectionDefinition,
} from "@ykdz/template-core/reference-package";

import { createGenerator } from "../src/index.ts";
import {
  createDocumentationEngine,
  glossaryIdentity,
  guideIdentity,
  indexIdentity,
  sharedAdditionPresetIdentity,
} from "../test-support/documentation.ts";

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

function documentationEngine(
  options: {
    readonly onPrepare?: () => void | Promise<void>;
    readonly presetNodes?: PresetSelectionDefinition<CreationInput>["nodes"];
  } = {},
) {
  const reference: LoadedContentMember<
    {
      readonly alias: string;
      readonly instance: "independent";
      prepare(options?: {
        readonly excludedPackagePaths: readonly string[];
      }): Promise<{
        readonly resources: readonly {
          path: string;
          content: Uint8Array;
          mode: number;
        }[];
        readonly facts: {};
      }>;
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
      async prepare(prepareOptions?: {
        readonly excludedPackagePaths: readonly string[];
      }) {
        await options.onPrepare?.();
        const excludedPackagePaths = prepareOptions?.excludedPackagePaths ?? [];
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
      operations: ["init", "add"],
      nodes: options.presetNodes ?? {
        child: {
          reference: { alias: "docs", instance: "independent" },
          creationInput: {
            init: { path: "packages/a" },
            add: { path: "docs/appendix" },
          },
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
  void it("恢复新格式后规划加包，并提交同一 SDK 计划", async () => {
    const { generator } = documentationEngine();
    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "root-guide",
              contentIdentity: referenceIdentity,
              creationInput: { path: "." },
            },
          ],
        },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));

      const staged = documentationEngine().generator;
      const restoredProject = await staged.restoreProject({
        repositoryRoot: targetRoot,
      });
      assert.equal(restoredProject.packages.length, 1);
      assert.ok(
        restoredProject.readFacts.some(
          ({ path: factPath }) => factPath === ".template/generation.json",
        ),
      );
      const additionPreparation = await staged.prepareAddProject({
        restored: restoredProject,
        selection: {
          contentIdentity: referenceIdentity,
          creationInput: { path: "docs/appendix" },
        },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      const before = staged.computeProject(additionPreparation.before);
      const after = staged.computeProject(additionPreparation.after);
      assert.equal(before.packages.length, 1);
      assert.equal(after.packages.length, 2);
      assert.equal(
        after.packages[0]?.package.packageDefinitionId,
        before.packages[0]?.package.packageDefinitionId,
      );

      const providerFactsPath = path.join(targetRoot, "provider-facts.json");
      await writeFile(providerFactsPath, '{"provider":"current"}\n');
      const providerFactsStat = await lstat(providerFactsPath);
      const readFacts: readonly CurrentProjectProjectionEntry[] = [
        {
          path: "provider-facts.json",
          kind: "file",
          content: await readFile(providerFactsPath),
          mode: providerFactsStat.mode & 0o111,
        },
      ];
      const planning = await staged.planComputedAdd({
        preparation: additionPreparation,
        before,
        after,
        readFacts,
      });
      assert.equal(planning.status, "planned", JSON.stringify(planning));
      if (planning.status !== "planned") return;
      assert.ok(
        planning.actions.some(
          (action) => action.path === "docs/appendix/README.md",
        ),
      );

      const committed = await staged.commitPlan(planning.plan);
      assert.equal(committed.status, "success", JSON.stringify(committed));
      await access(path.join(targetRoot, "docs/appendix/README.md"));
    });
  });

  void it("恢复预设选择并连续加包时保留实例标识与选择", async () => {
    const { generator } = documentationEngine();
    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await generator.init({
        targetRoot,
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
      assert.equal(initialized.status, "success", JSON.stringify(initialized));

      let previousRecord = initialized.generationRecord;
      for (const addition of ["preset", "direct"] as const) {
        const restored = documentationEngine().generator;
        const planning =
          addition === "preset"
            ? await restored.planAdd({
                repositoryRoot: targetRoot,
                preset: presetIdentity,
                operationFacts: { currentProvider: "provider-snapshot" },
              })
            : await restored.planAdd({
                repositoryRoot: targetRoot,
                contentIdentity: referenceIdentity,
                creationInput: { path: "docs/faq" },
                operationFacts: { currentProvider: "provider-snapshot" },
              });
        assert.equal(planning.status, "planned", JSON.stringify(planning));
        if (planning.status !== "planned") return;
        const previousIds = previousRecord.packages.map(
          (item) => item.packageDefinitionId,
        );
        assert.ok(
          previousIds.every((id) =>
            planning.generationRecord.packages.some(
              (item) => item.packageDefinitionId === id,
            ),
          ),
        );
        const committed = await restored.commitPlan(planning.plan);
        assert.equal(committed.status, "success", JSON.stringify(committed));
        previousRecord = planning.generationRecord;
      }

      assert.equal(previousRecord.composition.conventions.edition, "draft");
      assert.equal(previousRecord.selections.length, 4);
      assert.ok(
        previousRecord.packages.some(
          (item) =>
            item.createdBy === "addition" &&
            item.creationInput !== null &&
            (item.creationInput as CreationInput).path === "docs/appendix",
        ),
      );
      assert.ok(
        previousRecord.packages.some(
          (item) =>
            item.createdBy === "addition" &&
            item.creationInput !== null &&
            (item.creationInput as CreationInput).path === "docs/faq",
        ),
      );
    });
  });

  void it("按稳定节点身份恢复根顺序不同的同一预设选择", async () => {
    const presetNodes: PresetSelectionDefinition<CreationInput>["nodes"] = {
      zroot: {
        reference: { alias: "docs", instance: "independent" },
        creationInput: { init: { path: "." }, add: { path: "." } },
      },
      aleaf: {
        reference: { alias: "docs", instance: "independent" },
        creationInput: {
          init: { path: "docs/leaf" },
          add: { path: "docs/leaf" },
        },
      },
    };
    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await documentationEngine({
        presetNodes,
      }).generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: presetIdentity }] },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));

      const planning = await documentationEngine({
        presetNodes,
      }).generator.planAdd({
        repositoryRoot: targetRoot,
        preset: presetIdentity,
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(planning.status, "planned", JSON.stringify(planning));
      if (planning.status !== "planned") return;
      assert.equal(planning.generationRecord.packages.length, 2);
      assert.equal(planning.generationRecord.selections.length, 1);
    });
  });

  void it("显式初始化共享实例来源不受根遍历顺序影响", async () => {
    for (const roots of [
      [
        { nodeIdentity: "index", contentIdentity: indexIdentity },
        { nodeIdentity: "guide", contentIdentity: guideIdentity },
        { nodeIdentity: "glossary", contentIdentity: glossaryIdentity },
      ],
      [
        { nodeIdentity: "index", contentIdentity: indexIdentity },
        { nodeIdentity: "glossary", contentIdentity: glossaryIdentity },
        { nodeIdentity: "guide", contentIdentity: guideIdentity },
      ],
    ]) {
      await withTemporaryTarget(async (targetRoot) => {
        const initialized = await createDocumentationEngine({
          author: "公开 SDK",
        }).init({
          targetRoot,
          selection: { roots },
          conventions: { collection: "north", edition: "draft" },
          operationFacts: { providerVersion: "test" },
        });
        assert.equal(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        assert.equal(
          initialized.generationRecord.packages.find(
            ({ contentIdentity }) =>
              contentIdentity.packageName === "@fixture/docs-glossary",
          )?.createdBy,
          "initialization",
        );
      });
    }
  });

  void it("显式加选仍保留历史共享依赖的实例标识与来源", async () => {
    await withTemporaryTarget(async (targetRoot) => {
      const generator = createDocumentationEngine({ author: "公开 SDK" });
      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [
            { nodeIdentity: "index", contentIdentity: indexIdentity },
            { nodeIdentity: "guide", contentIdentity: guideIdentity },
          ],
        },
        conventions: { collection: "north", edition: "draft" },
        operationFacts: { providerVersion: "test" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      const previous = initialized.generationRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@fixture/docs-glossary",
      );
      assert.equal(previous?.createdBy, "shared-dependency");
      assert.ok(previous);

      const planned = await generator.planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: glossaryIdentity,
        operationFacts: { providerVersion: "test" },
      });
      assert.equal(planned.status, "planned", JSON.stringify(planned));
      if (planned.status !== "planned") return;
      const reused = planned.generationRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@fixture/docs-glossary",
      );
      assert.equal(reused?.packageDefinitionId, previous.packageDefinitionId);
      assert.equal(reused?.createdBy, "shared-dependency");
      const committed = await generator.commitPlan(planned.plan);
      assert.equal(committed.status, "success", JSON.stringify(committed));
    });
  });

  void it("add中新建的显式共享选择保留addition来源", async () => {
    await withTemporaryTarget(async (targetRoot) => {
      const generator = createDocumentationEngine({ author: "公开 SDK" });
      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [{ nodeIdentity: "index", contentIdentity: indexIdentity }],
        },
        conventions: { collection: "north", edition: "draft" },
        operationFacts: { providerVersion: "initial" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));

      const addEngine = createDocumentationEngine({
        author: "公开 SDK",
      });
      const planning = await addEngine.planAdd({
        repositoryRoot: targetRoot,
        preset: sharedAdditionPresetIdentity,
        operationFacts: { providerVersion: "addition" },
      });
      assert.equal(planning.status, "planned", JSON.stringify(planning));
      if (planning.status !== "planned") return;
      const guide = planning.generationRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@fixture/docs-guide",
      );
      const glossary = planning.generationRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentity.packageName === "@fixture/docs-glossary",
      );
      assert.equal(glossary?.createdBy, "addition");
      assert.ok(guide);
      assert.ok(glossary);
      assert.equal(
        guide.dependencyBindings.glossary,
        glossary.packageDefinitionId,
      );

      const committed = await addEngine.commitPlan(planning.plan);
      assert.equal(committed.status, "success", JSON.stringify(committed));
      const restored = await createDocumentationEngine({
        author: "公开 SDK",
      }).restoreProject({ repositoryRoot: targetRoot });
      assert.equal(
        restored.generationRecord.packages.find(
          ({ contentIdentity }) =>
            contentIdentity.packageName === "@fixture/docs-glossary",
        )?.createdBy,
        "addition",
      );
    });
  });

  void it("拒绝旧格式和无效关系并保持目标零写入", async () => {
    for (const mutation of ["schema5", "bad-binding", "blueprint3"] as const) {
      await withTemporaryTarget(async (targetRoot) => {
        const initialized = await documentationEngine().generator.init({
          targetRoot,
          selection: {
            roots: [
              {
                nodeIdentity: "root-guide",
                contentIdentity: referenceIdentity,
                creationInput: { path: "." },
              },
            ],
          },
          conventions: { edition: "draft" },
          operationFacts: { currentProvider: "provider-snapshot" },
        });
        assert.equal(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );

        const recordPath = path.join(targetRoot, ".template/generation.json");
        const blueprintPath = path.join(targetRoot, ".template/blueprint.json");
        if (mutation === "blueprint3") {
          const blueprint = JSON.parse(
            await readFile(blueprintPath, "utf8"),
          ) as Record<string, unknown>;
          blueprint.schemaVersion = 3;
          await writeFile(blueprintPath, JSON.stringify(blueprint));
        } else {
          const record = JSON.parse(
            await readFile(recordPath, "utf8"),
          ) as Record<string, unknown>;
          if (mutation === "schema5") {
            record.schemaVersion = 5;
          } else {
            const packages = record.packages as Record<string, unknown>[];
            const first = packages[0]!;
            first.dependencyBindings = {
              ...(first.dependencyBindings as Record<string, string>),
              invalid: `package-${"0".repeat(64)}`,
            };
          }
          await writeFile(recordPath, JSON.stringify(record));
        }
        const recordBefore = await readFile(recordPath);
        const blueprintBefore = await readFile(blueprintPath);
        const readmeBefore = await readFile(path.join(targetRoot, "README.md"));

        const planning = await documentationEngine().generator.planAdd({
          repositoryRoot: targetRoot,
          contentIdentity: referenceIdentity,
          creationInput: { path: "docs/rejected" },
          operationFacts: { currentProvider: "provider-snapshot" },
        });
        assert.equal(
          planning.status,
          "operation-failure",
          JSON.stringify(planning),
        );
        if (planning.status !== "operation-failure") return;
        assert.equal(planning.phase, "metadata");
        assert.match(
          planning.error.message,
          /不支持的生成记录 schema|不支持的本地模板元数据版本|生成记录|蓝图/u,
        );
        assert.deepEqual(await readFile(recordPath), recordBefore);
        assert.deepEqual(await readFile(blueprintPath), blueprintBefore);
        assert.deepEqual(
          await readFile(path.join(targetRoot, "README.md")),
          readmeBefore,
        );
        await assert.rejects(access(path.join(targetRoot, "docs/rejected")), {
          code: "ENOENT",
        });
      });
    }
  });

  void it("保留元数据首次读取快照并拒绝规划期间的只读事实变化", async () => {
    await withTemporaryTarget(async (targetRoot) => {
      let enabled = false;
      let changed = false;
      const recordPath = path.join(targetRoot, ".template/generation.json");
      const generator = documentationEngine({
        onPrepare: async () => {
          if (!enabled || changed) return;
          changed = true;
          const record = JSON.parse(
            await readFile(recordPath, "utf8"),
          ) as unknown;
          await writeFile(recordPath, JSON.stringify(record, null, 2));
        },
      }).generator;
      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "root-guide",
              contentIdentity: referenceIdentity,
              creationInput: { path: "." },
            },
          ],
        },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));

      enabled = true;
      const planning = await generator.planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: referenceIdentity,
        creationInput: { path: "docs/after-read" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(planning.status, "conflict", JSON.stringify(planning));
      if (planning.status !== "conflict") return;
      assert.ok(
        planning.conflicts.some(
          ({ path: conflictPath, reason }) =>
            conflictPath === ".template/generation.json" &&
            reason.includes("准备计算使用的Current事实"),
        ),
      );
      assert.equal(changed, true);
      await assert.rejects(access(path.join(targetRoot, "docs/after-read")), {
        code: "ENOENT",
      });
    });
  });

  void it("提交只受相关事实影响，并保留未变更生成文件的模式定制", async () => {
    await withTemporaryTarget(async (targetRoot) => {
      const generator = documentationEngine().generator;
      const initialized = await generator.init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "root-guide",
              contentIdentity: referenceIdentity,
              creationInput: { path: "." },
            },
          ],
        },
        conventions: { edition: "draft" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      await chmod(path.join(targetRoot, "README.md"), 0o755);
      const planning = await generator.planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: referenceIdentity,
        creationInput: { path: "docs/unrelated-edit" },
        operationFacts: { currentProvider: "provider-snapshot" },
      });
      assert.equal(planning.status, "planned", JSON.stringify(planning));
      if (planning.status !== "planned") return;
      await writeFile(path.join(targetRoot, "user-notes.txt"), "保留\n");
      const committed = await generator.commitPlan(planning.plan);
      assert.equal(committed.status, "success", JSON.stringify(committed));
      assert.equal(
        await readFile(path.join(targetRoot, "user-notes.txt"), "utf8"),
        "保留\n",
      );
      assert.equal(
        (await lstat(path.join(targetRoot, "README.md"))).mode & 0o777,
        0o755,
      );
      await access(path.join(targetRoot, "docs/unrelated-edit/README.md"));
    });
  });

  void it("受阻包路径冲突定位祖先并携带新包来源", async () => {
    for (const blocker of ["file", "symbolic-link"] as const) {
      const parent = await mkdtemp(
        path.join(tmpdir(), `generator-add-${blocker}-`),
      );
      const targetRoot = path.join(parent, "project");
      const outsideRoot = path.join(parent, "outside");
      try {
        const initialized = await documentationEngine().generator.init({
          targetRoot,
          selection: {
            roots: [
              {
                nodeIdentity: "root-guide",
                contentIdentity: referenceIdentity,
                creationInput: { path: "." },
              },
            ],
          },
          conventions: { edition: "draft" },
          operationFacts: { currentProvider: "provider-snapshot" },
        });
        assert.equal(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        if (blocker === "file") {
          await writeFile(path.join(targetRoot, "packages"), "用户数据\n");
        } else {
          await mkdir(outsideRoot);
          await symlink(outsideRoot, path.join(targetRoot, "packages"), "dir");
        }
        const metadataPath = path.join(targetRoot, ".template/generation.json");
        const metadataBefore = await readFile(metadataPath);
        const planning = await documentationEngine().generator.planAdd({
          repositoryRoot: targetRoot,
          contentIdentity: referenceIdentity,
          creationInput: { path: "packages/new" },
          operationFacts: { currentProvider: "provider-snapshot" },
        });
        assert.equal(planning.status, "conflict", JSON.stringify(planning));
        if (planning.status !== "conflict") continue;
        const ancestor = planning.conflicts.find(
          (item) => item.path === "packages",
        );
        assert.ok(ancestor, JSON.stringify(planning.conflicts));
        assert.ok(
          ancestor.sources?.some((source) =>
            source.label.includes("packages/new"),
          ),
          JSON.stringify(ancestor),
        );
        assert.deepEqual(await readFile(metadataPath), metadataBefore);
        await assert.rejects(access(path.join(targetRoot, "packages/new")));
        if (blocker === "file") {
          assert.equal(
            await readFile(path.join(targetRoot, "packages"), "utf8"),
            "用户数据\n",
          );
          assert.equal(
            (await lstat(path.join(targetRoot, "packages"))).isFile(),
            true,
          );
        } else {
          assert.equal(
            await readlink(path.join(targetRoot, "packages")),
            outsideRoot,
          );
          assert.deepEqual(await readdir(outsideRoot), []);
          assert.equal(
            (await lstat(path.join(targetRoot, "packages"))).isSymbolicLink(),
            true,
          );
        }
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  });

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
