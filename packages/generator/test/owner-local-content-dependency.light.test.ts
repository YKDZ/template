import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Composition } from "@ykdz/template-core/composition";
import type {
  ContentIdentity,
  LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import type {
  PackageDefinition,
  PackageDefinitionId,
} from "@ykdz/template-core/project-blueprint";
import type {
  PackageBinding,
  ReferenceDependency,
} from "@ykdz/template-core/reference-package";

import { createGenerator } from "../src/index.ts";

type CreationInput = { readonly path: string };
type Conventions = { readonly edition: string };
type StableCommon = { readonly edition: string };
type PackageInput = { readonly edition: string };
type Facts = { readonly packageName: string };
type Contribution = PackageContribution<Facts>;

const compositionIdentity: ContentIdentity = {
  namespace: "fixture-composition",
  packageName: "@fixture/composition",
  exportPath: "./composition",
};

const composition: Composition<
  Conventions,
  StableCommon,
  PackageInput,
  Facts,
  { readonly packageCount: number },
  CreationInput,
  null
> = {
  identity: compositionIdentity,
  parseConventions(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).edition !== "string"
    ) {
      throw new Error("需要edition约定");
    }
    return value as Conventions;
  },
  resolve({ conventions, packages }) {
    return {
      stableCommon: { edition: conventions.edition },
      packageInputs: new Map(
        packages.map((item) => [
          item.packageDefinitionId,
          { edition: conventions.edition },
        ]),
      ),
    };
  },
  combine({ packages }) {
    return { facts: { packageCount: packages.length } };
  },
};

function referenceDefinition(
  alias: string,
  dependency?: Readonly<Record<string, unknown>>,
  instance: "shared" | "independent" = "independent",
) {
  return {
    alias,
    instance,
    ...(dependency === undefined ? {} : { dependencies: [dependency] }),
    prepare() {
      return { resources: [], facts: { alias } };
    },
    parseCreationInput(value: unknown): CreationInput {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as Record<string, unknown>).path !== "string"
      ) {
        throw new Error("需要包路径");
      }
      return value as CreationInput;
    },
    createDefinition({
      creationInput,
    }: {
      readonly conventions: Conventions;
      readonly creationInput: CreationInput | undefined;
      readonly layout?: unknown;
    }): PackageDefinition {
      if (creationInput === undefined) throw new Error("缺少包路径");
      return {
        name: creationInput.path,
        path: creationInput.path,
        role: "fixture",
      };
    },
    evaluate({
      packageDefinitionId,
      definition,
    }: {
      readonly packageDefinitionId: PackageDefinitionId;
      readonly definition: PackageDefinition;
      readonly createdBy: "initialization" | "addition" | "shared-dependency";
      readonly creationInput: CreationInput | undefined;
      readonly prepared: {
        readonly resources: readonly [];
        readonly facts: { readonly alias: string };
      };
      readonly bindings: ReadonlyMap<string, PackageBinding>;
      readonly conventions: Conventions;
      readonly stableCommon: StableCommon;
      readonly packageInput: PackageInput | undefined;
    }): Contribution {
      return {
        packageDefinitionId,
        files: [],
        facts: { packageName: definition.name },
      };
    },
  };
}

function loadedReference(
  namespace: string,
  packageName: string,
  exportPath: string,
  moduleURL: string,
  definition: unknown,
): LoadedContentMember<unknown, "reference"> {
  return {
    identity: { namespace, packageName, exportPath },
    kind: "reference",
    alias:
      typeof definition === "object" &&
      definition !== null &&
      "alias" in definition &&
      typeof definition.alias === "string"
        ? definition.alias
        : packageName,
    source: {
      specifier: `${packageName}${exportPath.slice(1)}`,
      moduleURL,
      manifestURL: `file:///fixture/${packageName.split("/").at(-1)}.json`,
    },
    definition,
  };
}

function createEngine(content: readonly LoadedContentMember[]) {
  return createGenerator({ content, composition });
}

async function prepareOne(
  engine: ReturnType<typeof createEngine>,
  identity: ContentIdentity,
) {
  return await engine.prepareProject({
    selection: {
      roots: [
        {
          nodeIdentity: "consumer",
          contentIdentity: identity,
          creationInput: { path: "packages/consumer" },
        },
      ],
    },
    conventions: { edition: "stable" },
    operationFacts: null,
  });
}

async function withTemporaryTarget(
  run: (targetRoot: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "owner-local-reference-dependency-"),
  );
  try {
    await run(path.join(temporaryRoot, "target"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void describe("owner-local内容依赖", () => {
  void it("按所属命名空间、公开入口与owner解析结果绑定", async () => {
    let firstResolutionCount = 0;
    const providerIdentity = {
      packageName: "@fixture/tooling",
      exportPath: "./template",
    };
    const dependency = {
      key: "tooling",
      ownerLocal: {
        specifier: "@fixture/tooling/template",
        resolve: (specifier: string) => {
          firstResolutionCount += 1;
          assert.equal(specifier, "@fixture/tooling/template");
          return "file:///fixture/tooling/template.js";
        },
      },
      creationInput: { path: "packages/tooling" },
    } satisfies ReferenceDependency<CreationInput>;
    const consumer = referenceDefinition("consumer", dependency);
    const provider = referenceDefinition("tooling");
    const firstIdentity: ContentIdentity = {
      namespace: "first-source",
      packageName: "@fixture/consumer",
      exportPath: "./template",
    };
    const firstEngine = createEngine([
      loadedReference(
        "first-source",
        "@fixture/consumer",
        "./template",
        "file:///fixture/consumer/template.js",
        consumer,
      ),
      loadedReference(
        "first-source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/tooling/template.js",
        provider,
      ),
    ]);
    const firstPrepared = await prepareOne(firstEngine, firstIdentity);
    assert.equal(firstResolutionCount, 1);
    const first = firstEngine.computeProject(firstPrepared);
    assert.equal(firstResolutionCount, 1);

    assert.deepEqual(
      first.blueprint.packages.map(({ path: packagePath }) => packagePath),
      ["packages/consumer", "packages/tooling"],
    );
    assert.doesNotMatch(
      JSON.stringify(first.generationRecord),
      /file:\/\/|ownerLocal|specifier/u,
    );

    const secondIdentity: ContentIdentity = {
      ...firstIdentity,
      namespace: "second-source",
    };
    const secondEngine = createEngine([
      loadedReference(
        "second-source",
        "@fixture/consumer",
        "./template",
        "file:///fixture/consumer/template.js",
        consumer,
      ),
      loadedReference(
        "second-source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/tooling/template.js",
        provider,
      ),
    ]);
    const second = secondEngine.computeProject(
      await prepareOne(secondEngine, secondIdentity),
    );

    assert.deepEqual(
      second.blueprint.packages.map(({ path: packagePath }) => packagePath),
      ["packages/consumer", "packages/tooling"],
    );

    const wrongNamespaceEngine = createEngine([
      loadedReference(
        "second-source",
        "@fixture/consumer",
        "./template",
        "file:///fixture/consumer/template.js",
        consumer,
      ),
      loadedReference(
        "first-source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/tooling/template.js",
        provider,
      ),
    ]);
    await assert.rejects(
      prepareOne(wrongNamespaceEngine, secondIdentity),
      /同一命名空间/u,
    );
  });

  void it("拒绝同namespace同URL多入口及resolver指向其他修订", async () => {
    const dependency = {
      key: "tooling",
      ownerLocal: {
        specifier: "@fixture/tooling/template",
        resolve: () => "file:///fixture/tooling/template.js",
      },
      creationInput: { path: "packages/tooling" },
    };
    const identity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/consumer",
      exportPath: "./template",
    };
    const consumer = referenceDefinition("consumer", dependency);
    const provider = referenceDefinition("tooling");
    const ambiguousEngine = createEngine([
      loadedReference(
        "source",
        "@fixture/consumer",
        "./template",
        "file:///fixture/consumer/template.js",
        consumer,
      ),
      loadedReference(
        "source",
        "@fixture/tooling",
        "./template",
        "file:///fixture/tooling/template.js",
        provider,
      ),
      loadedReference(
        "source",
        "@fixture/other-entry",
        "./template",
        "file:///fixture/tooling/template.js",
        referenceDefinition("other-entry"),
      ),
    ]);
    await assert.rejects(
      prepareOne(ambiguousEngine, identity),
      /多个公开内容入口/u,
    );

    const wrongRevisionEngine = createEngine([
      loadedReference(
        "source",
        "@fixture/consumer",
        "./template",
        "file:///fixture/consumer/template.js",
        consumer,
      ),
      loadedReference(
        "source",
        "@fixture/tooling",
        "./template",
        "file:///fixture/tooling/v1.js",
        provider,
      ),
    ]);
    await assert.rejects(
      prepareOne(wrongRevisionEngine, identity),
      /同一命名空间/u,
    );
  });

  void it("保留显式完整身份的跨命名空间依赖", async () => {
    const consumerIdentity: ContentIdentity = {
      namespace: "consumer-source",
      packageName: "@fixture/consumer",
      exportPath: "./template",
    };
    const providerIdentity: ContentIdentity = {
      namespace: "provider-source",
      packageName: "@fixture/tooling",
      exportPath: "./template",
    };
    const engine = createEngine([
      loadedReference(
        consumerIdentity.namespace,
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/consumer/template.js",
        referenceDefinition("consumer", {
          key: "tooling",
          contentIdentity: providerIdentity,
          creationInput: { path: "packages/tooling" },
        }),
      ),
      loadedReference(
        providerIdentity.namespace,
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/tooling/template.js",
        referenceDefinition("tooling"),
      ),
    ]);
    const computed = engine.computeProject(
      await prepareOne(engine, consumerIdentity),
    );

    assert.deepEqual(
      computed.blueprint.packages.map(({ path: packagePath }) => packagePath),
      ["packages/consumer", "packages/tooling"],
    );
  });

  void it("同一准备结果完成共享提供者的连续加包规划与提交", async () => {
    let resolutionCount = 0;
    const dependency = {
      key: "tooling",
      ownerLocal: {
        specifier: "@fixture/tooling/template",
        resolve: () => {
          resolutionCount += 1;
          return "file:///fixture/tooling/template.js";
        },
      },
      creationInput: { path: "packages/tooling" },
    };
    const initialIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/consumer-a",
      exportPath: "./template",
    };
    const addedIdentity: ContentIdentity = {
      ...initialIdentity,
      packageName: "@fixture/consumer-b",
    };
    const providerIdentity: ContentIdentity = {
      ...initialIdentity,
      packageName: "@fixture/tooling",
    };
    const consumer = referenceDefinition("consumer", dependency);
    const provider = referenceDefinition("tooling", undefined, "shared");
    const engine = createEngine([
      loadedReference(
        "source",
        initialIdentity.packageName,
        initialIdentity.exportPath,
        "file:///fixture/consumer-a/template.js",
        consumer,
      ),
      loadedReference(
        "source",
        addedIdentity.packageName,
        addedIdentity.exportPath,
        "file:///fixture/consumer-b/template.js",
        consumer,
      ),
      loadedReference(
        "source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/tooling/template.js",
        provider,
      ),
    ]);

    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await engine.init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "consumer-a",
              contentIdentity: initialIdentity,
              creationInput: { path: "packages/consumer-a" },
            },
          ],
        },
        conventions: { edition: "stable" },
        operationFacts: null,
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      assert.equal(resolutionCount, 1);

      const restored = await engine.restoreProject({
        repositoryRoot: targetRoot,
      });
      assert.equal(restored.normalizedDependencies.length, 1);
      assert.equal(resolutionCount, 2);

      const preparation = await engine.prepareAddProject({
        restored,
        selection: {
          contentIdentity: addedIdentity,
          nodeIdentity: "consumer-b",
          creationInput: { path: "packages/consumer-b" },
        },
        operationFacts: null,
      });
      const before = engine.computeProject(preparation.before);
      const after = engine.computeProject(preparation.after);
      assert.equal(resolutionCount, 3);

      const planned = await engine.planComputedAdd({
        preparation,
        before,
        after,
      });
      assert.equal(planned.status, "planned", JSON.stringify(planned));
      if (planned.status !== "planned") {
        throw new Error("owner-local依赖的连续加包应形成计划");
      }
      const committed = await engine.commitPlan(planned.plan);
      assert.equal(committed.status, "success", JSON.stringify(committed));
      assert.equal(resolutionCount, 3);
      assert.doesNotMatch(
        JSON.stringify(committed.generationRecord),
        /file:\/\/|ownerLocal|specifier/u,
      );
    });
  });
});
