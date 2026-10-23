import assert from "node:assert/strict";
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
import type { PackageBinding } from "@ykdz/template-core/reference-package";

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

type CreationInput = {
  readonly path: string;
  readonly leak?: boolean;
  readonly nearPrefix?: boolean;
  readonly metadataAncestor?: boolean;
};
type Conventions = { readonly edition: string };
type Contribution = PackageContribution<{
  readonly path: string;
  readonly resourcePaths: readonly string[];
}>;
type DocumentationComposition = Composition<
  Conventions,
  { readonly edition: string },
  unknown,
  Contribution["facts"],
  { readonly packageCount: number },
  CreationInput
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
        readonly stableCommon: { readonly edition: string };
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
        creationInput,
      }) {
        const source = prepared.resources.find(
          (file) => file.path === "README.md",
        );
        if (source === undefined) throw new Error("缺少 README 资源");
        const files = [
          {
            path: creationInput?.leak
              ? "packages/a/README.md"
              : creationInput?.metadataAncestor
                ? ".template"
                : "README.md",
            content: new TextEncoder().encode(
              `${stableCommon.edition}:${new TextDecoder().decode(source.content)}`,
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
    resolve({ conventions }) {
      return {
        stableCommon: { edition: conventions.edition },
        packageInputs: new Map<PackageDefinitionId, unknown>(),
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
  const generator = createGenerator({ content: [reference], composition });

  return { generator, reference };
}

void describe("公开生成计算", () => {
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
    });

    assert.throws(
      () => generator.computeProject(prepared),
      /包贡献路径与生成器元数据路径冲突/u,
    );
  });
});
