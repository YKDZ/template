import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  PresetSelectionDefinition,
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

function loadedPreset(
  identity: ContentIdentity,
  nodes: PresetSelectionDefinition<CreationInput>["nodes"],
): LoadedContentMember<PresetSelectionDefinition<CreationInput>, "preset"> {
  return {
    identity,
    kind: "preset",
    alias: "bound-web-api",
    source: {
      specifier: `${identity.packageName}/preset`,
      moduleURL: `file:///fixture/${identity.packageName}/preset.js`,
      manifestURL: `file:///fixture/${identity.packageName}/package.json`,
    },
    definition: { kind: "preset", operations: ["init", "add"], nodes },
  };
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
  void it("将独立 provider 绑定到显式预设节点并在恢复后保留关系", async () => {
    const consumerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web",
      exportPath: "./template",
    };
    const providerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/api",
      exportPath: "./template",
    };
    const presetIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web-api",
      exportPath: "./preset",
    };
    const consumer = referenceDefinition("web", {
      key: "api",
      contentIdentity: providerIdentity,
    } satisfies ReferenceDependency<CreationInput>);
    const provider = referenceDefinition("api");
    const nodes = [
      [
        "web",
        {
          reference: { alias: "web", instance: "independent" as const },
          creationInput: {
            init: { path: "apps/web" },
            add: { path: "apps/web" },
          },
          dependencyBindings: { api: "api" },
        },
      ],
      [
        "api",
        {
          reference: { alias: "api", instance: "independent" as const },
          creationInput: {
            init: { path: "packages/custom-api" },
            add: { path: "packages/custom-api" },
          },
        },
      ],
    ] as const;

    for (const orderedNodes of [nodes, [...nodes].reverse()]) {
      const content = [
        loadedReference(
          "source",
          consumerIdentity.packageName,
          consumerIdentity.exportPath,
          "file:///fixture/web/template.js",
          consumer,
        ),
        loadedReference(
          "source",
          providerIdentity.packageName,
          providerIdentity.exportPath,
          "file:///fixture/api/template.js",
          provider,
        ),
        loadedPreset(presetIdentity, Object.fromEntries(orderedNodes)),
      ];
      const engine = createEngine(content);
      const directConsumer = referenceDefinition("web", {
        key: "api",
        contentIdentity: providerIdentity,
        creationInput: { path: "packages/default-api" },
      } satisfies ReferenceDependency<CreationInput>);
      const directEngine = createEngine([
        loadedReference(
          "source",
          consumerIdentity.packageName,
          consumerIdentity.exportPath,
          "file:///fixture/web/template.js",
          directConsumer,
        ),
        loadedReference(
          "source",
          providerIdentity.packageName,
          providerIdentity.exportPath,
          "file:///fixture/api/template.js",
          provider,
        ),
      ]);
      const direct = directEngine.computeProject(
        await directEngine.prepareProject({
          selection: {
            roots: [
              {
                nodeIdentity: "web",
                contentIdentity: consumerIdentity,
                creationInput: { path: "apps/direct-web" },
              },
            ],
          },
          conventions: { edition: "stable" },
          operationFacts: null,
        }),
      );
      assert.equal(direct.generationRecord.packages.length, 2);
      assert.equal(
        direct.generationRecord.packages.find(
          (item) =>
            item.contentIdentity.packageName === providerIdentity.packageName,
        )?.createdBy,
        "shared-dependency",
      );

      const equalInputConsumer = referenceDefinition("web", {
        key: "api",
        contentIdentity: providerIdentity,
        creationInput: { path: "packages/custom-api" },
      } satisfies ReferenceDependency<CreationInput>);
      const equalInputEngine = createEngine([
        loadedReference(
          "source",
          consumerIdentity.packageName,
          consumerIdentity.exportPath,
          "file:///fixture/web/template.js",
          equalInputConsumer,
        ),
        loadedReference(
          "source",
          providerIdentity.packageName,
          providerIdentity.exportPath,
          "file:///fixture/api/template.js",
          provider,
        ),
        loadedPreset(presetIdentity, Object.fromEntries(orderedNodes)),
      ]);
      const equalInput = equalInputEngine.computeProject(
        await equalInputEngine.prepareProject({
          selection: { presets: [{ contentIdentity: presetIdentity }] },
          conventions: { edition: "stable" },
          operationFacts: null,
        }),
      );
      assert.equal(equalInput.generationRecord.packages.length, 2);

      await withTemporaryTarget(async (targetRoot) => {
        const initialized = await engine.init({
          targetRoot,
          selection: { presets: [{ contentIdentity: presetIdentity }] },
          conventions: { edition: "stable" },
          operationFacts: null,
        });
        assert.equal(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        if (initialized.status !== "success") return;

        const selection = initialized.generationRecord.selections[0];
        const webId = selection?.nodes.web;
        const apiId = selection?.nodes.api;
        assert.ok(webId);
        assert.ok(apiId);
        assert.equal(initialized.generationRecord.packages.length, 2);
        const webRecord = initialized.generationRecord.packages.find(
          (item) => item.packageDefinitionId === webId,
        );
        const apiRecord = initialized.generationRecord.packages.find(
          (item) => item.packageDefinitionId === apiId,
        );
        assert.equal(webRecord?.dependencyBindings.api, apiId);
        assert.equal(apiRecord?.createdBy, "initialization");
        assert.deepEqual(apiRecord?.creationInput, {
          path: "packages/custom-api",
        });

        const restored = createEngine(content);
        const project = await restored.restoreProject({
          repositoryRoot: targetRoot,
        });
        const before = restored.computeProject(
          await restored
            .prepareAddProject({
              restored: project,
              selection: {
                contentIdentity: providerIdentity,
                creationInput: { path: "packages/another-api" },
              },
              operationFacts: null,
            })
            .then((preparation) => preparation.before),
        );
        assert.ok(
          [webId, apiId].every((id) =>
            before.generationRecord.packages.some(
              (item) => item.packageDefinitionId === id,
            ),
          ),
        );
        const restoredWeb = before.generationRecord.packages.find(
          (item) => item.packageDefinitionId === webId,
        );
        assert.equal(restoredWeb?.dependencyBindings.api, apiId);
      });
    }
  });

  void it("direct add 按持久ID复用自定义独立provider并跨恢复保留", async () => {
    const consumerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web",
      exportPath: "./template",
    };
    const providerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/api",
      exportPath: "./template",
    };
    const consumer = referenceDefinition("web", {
      key: "api",
      contentIdentity: providerIdentity,
    } satisfies ReferenceDependency<CreationInput>);
    const provider = referenceDefinition("api");
    const content = [
      loadedReference(
        "source",
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/web/template.js",
        consumer,
      ),
      loadedReference(
        "source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/api/template.js",
        provider,
      ),
    ];

    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await createEngine(content).init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "api",
              contentIdentity: providerIdentity,
              creationInput: { path: "packages/custom-api" },
            },
          ],
        },
        conventions: { edition: "stable" },
        operationFacts: null,
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      if (initialized.status !== "success") return;

      const apiId = initialized.generationRecord.selections[0]?.nodes.api;
      assert.ok(apiId);
      const firstAdded = await createEngine(content).add({
        repositoryRoot: targetRoot,
        contentIdentity: consumerIdentity,
        nodeIdentity: "web",
        creationInput: { path: "apps/web" },
        dependencyBindings: {
          api: { packageDefinitionId: apiId },
        },
        operationFacts: null,
      });
      assert.equal(firstAdded.status, "success", JSON.stringify(firstAdded));
      if (firstAdded.status !== "success") return;

      const webId = firstAdded.generationRecord.selections.at(-1)?.nodes.web;
      assert.ok(webId);
      const apiRecord = firstAdded.generationRecord.packages.find(
        (item) => item.packageDefinitionId === apiId,
      );
      const webRecord = firstAdded.generationRecord.packages.find(
        (item) => item.packageDefinitionId === webId,
      );
      assert.equal(firstAdded.generationRecord.packages.length, 2);
      assert.equal(apiRecord?.createdBy, "initialization");
      assert.deepEqual(apiRecord?.creationInput, {
        path: "packages/custom-api",
      });
      assert.equal(webRecord?.createdBy, "addition");
      assert.equal(webRecord?.dependencyBindings.api, apiId);

      const secondAdded = await createEngine(content).add({
        repositoryRoot: targetRoot,
        contentIdentity: consumerIdentity,
        nodeIdentity: "web-again",
        creationInput: { path: "apps/web-again" },
        dependencyBindings: {
          api: { packageDefinitionId: apiId },
        },
        operationFacts: null,
      });
      assert.equal(secondAdded.status, "success", JSON.stringify(secondAdded));
      if (secondAdded.status !== "success") return;
      assert.ok(
        [apiId, webId].every((id) =>
          secondAdded.generationRecord.packages.some(
            (item) => item.packageDefinitionId === id,
          ),
        ),
      );
      assert.equal(secondAdded.generationRecord.packages.length, 3);
      assert.equal(
        secondAdded.generationRecord.packages.find(
          (item) => item.packageDefinitionId === apiId,
        )?.createdBy,
        "initialization",
      );
      assert.equal(
        secondAdded.generationRecord.packages.find(
          (item) => item.packageDefinitionId === webId,
        )?.dependencyBindings.api,
        apiId,
      );
    });
  });

  void it("direct add 在多个provider中只接受显式ID、身份与输入一致者", async () => {
    const webIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web",
      exportPath: "./template",
    };
    const strictWebIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/strict-web",
      exportPath: "./template",
    };
    const apiIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/api",
      exportPath: "./template",
    };
    const otherIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/other",
      exportPath: "./template",
    };
    const content = [
      loadedReference(
        "source",
        webIdentity.packageName,
        webIdentity.exportPath,
        "file:///fixture/web/template.js",
        referenceDefinition("web", {
          key: "api",
          contentIdentity: apiIdentity,
        } satisfies ReferenceDependency<CreationInput>),
      ),
      loadedReference(
        "source",
        strictWebIdentity.packageName,
        strictWebIdentity.exportPath,
        "file:///fixture/strict-web/template.js",
        referenceDefinition("strict-web", {
          key: "api",
          contentIdentity: apiIdentity,
          creationInput: { path: "packages/expected-api" },
        } satisfies ReferenceDependency<CreationInput>),
      ),
      loadedReference(
        "source",
        apiIdentity.packageName,
        apiIdentity.exportPath,
        "file:///fixture/api/template.js",
        referenceDefinition("api"),
      ),
      loadedReference(
        "source",
        otherIdentity.packageName,
        otherIdentity.exportPath,
        "file:///fixture/other/template.js",
        referenceDefinition("other"),
      ),
    ];

    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await createEngine(content).init({
        targetRoot,
        selection: {
          roots: [
            {
              nodeIdentity: "api-b",
              contentIdentity: apiIdentity,
              creationInput: { path: "packages/api-b" },
            },
            {
              nodeIdentity: "other",
              contentIdentity: otherIdentity,
              creationInput: { path: "packages/other" },
            },
            {
              nodeIdentity: "api-a",
              contentIdentity: apiIdentity,
              creationInput: { path: "packages/api-a" },
            },
          ],
        },
        conventions: { edition: "stable" },
        operationFacts: null,
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      if (initialized.status !== "success") return;
      const nodes = initialized.generationRecord.selections[0]?.nodes;
      const apiBId = nodes?.["api-b"];
      const apiAId = nodes?.["api-a"];
      const otherId = nodes?.other;
      assert.ok(apiBId);
      assert.ok(apiAId);
      assert.ok(otherId);
      const metadataPath = path.join(targetRoot, ".template/generation.json");
      const metadataBefore = await readFile(metadataPath);

      const wrongIdentity = await createEngine(content).planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: webIdentity,
        nodeIdentity: "web",
        creationInput: { path: "apps/web" },
        dependencyBindings: {
          api: { packageDefinitionId: otherId },
        },
        operationFacts: null,
      });
      assert.equal(wrongIdentity.status, "operation-failure");
      if (wrongIdentity.status === "operation-failure") {
        assert.equal(wrongIdentity.phase, "preparation");
      }
      assert.deepEqual(await readFile(metadataPath), metadataBefore);

      const wrongInput = await createEngine(content).planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: strictWebIdentity,
        nodeIdentity: "strict-web",
        creationInput: { path: "apps/strict-web" },
        dependencyBindings: {
          api: { packageDefinitionId: apiBId },
        },
        operationFacts: null,
      });
      assert.equal(wrongInput.status, "operation-failure");
      if (wrongInput.status === "operation-failure") {
        assert.equal(wrongInput.phase, "preparation");
      }
      assert.deepEqual(await readFile(metadataPath), metadataBefore);

      const missingProvider = await createEngine(content).planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: webIdentity,
        nodeIdentity: "web",
        creationInput: { path: "apps/web" },
        dependencyBindings: {
          api: {
            packageDefinitionId:
              `package-${"0".repeat(64)}` as PackageDefinitionId,
          },
        },
        operationFacts: null,
      });
      assert.equal(missingProvider.status, "operation-failure");
      if (missingProvider.status === "operation-failure") {
        assert.equal(missingProvider.phase, "preparation");
      }
      assert.deepEqual(await readFile(metadataPath), metadataBefore);

      const added = await createEngine(content).add({
        repositoryRoot: targetRoot,
        contentIdentity: webIdentity,
        nodeIdentity: "web",
        creationInput: { path: "apps/web" },
        dependencyBindings: {
          api: { packageDefinitionId: apiBId },
        },
        operationFacts: null,
      });
      assert.equal(added.status, "success", JSON.stringify(added));
      if (added.status !== "success") return;
      const webId = added.generationRecord.selections.at(-1)?.nodes.web;
      assert.ok(webId);
      assert.equal(added.generationRecord.packages.length, 4);
      assert.equal(
        added.generationRecord.packages.find(
          (item) => item.packageDefinitionId === webId,
        )?.dependencyBindings.api,
        apiBId,
      );
      const apiBRecord = added.generationRecord.packages.find(
        (item) => item.packageDefinitionId === apiBId,
      );
      assert.deepEqual(apiBRecord?.creationInput, { path: "packages/api-b" });
      const metadataAfterAdd = await readFile(metadataPath);
      const conflictingSelection = await createEngine(content).planAdd({
        repositoryRoot: targetRoot,
        contentIdentity: webIdentity,
        nodeIdentity: "web",
        creationInput: { path: "apps/web" },
        dependencyBindings: {
          api: { packageDefinitionId: apiAId },
        },
        operationFacts: null,
      });
      assert.equal(conflictingSelection.status, "operation-failure");
      if (conflictingSelection.status === "operation-failure") {
        assert.equal(conflictingSelection.phase, "preparation");
      }
      assert.deepEqual(await readFile(metadataPath), metadataAfterAdd);
    });
  });

  void it("拒绝错误身份、冲突输入和预设实例循环", async () => {
    const consumerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web",
      exportPath: "./template",
    };
    const providerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/api",
      exportPath: "./template",
    };
    const otherIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/other",
      exportPath: "./template",
    };
    const presetIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web-api",
      exportPath: "./preset",
    };
    const webNode = {
      reference: { alias: "web", instance: "independent" as const },
      creationInput: { init: { path: "apps/web" } },
      dependencyBindings: { api: "api" },
    };
    const apiNode = {
      reference: { alias: "api", instance: "independent" as const },
      creationInput: { init: { path: "packages/custom-api" } },
    };
    const baseContent = [
      loadedReference(
        "source",
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/web/template.js",
        referenceDefinition("web", {
          key: "api",
          contentIdentity: providerIdentity,
          creationInput: { path: "packages/expected-api" },
        }),
      ),
      loadedReference(
        "source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/api/template.js",
        referenceDefinition("api"),
      ),
    ];
    const inputMismatchEngine = createEngine([
      ...baseContent,
      loadedPreset(presetIdentity, { web: webNode, api: apiNode }),
    ]);
    await withTemporaryTarget(async (targetRoot) => {
      const result = await inputMismatchEngine.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: presetIdentity }] },
        conventions: { edition: "stable" },
        operationFacts: null,
      });
      assert.notEqual(result.status, "success");
      await assert.rejects(access(targetRoot), { code: "ENOENT" });
    });

    const wrongIdentityEngine = createEngine([
      loadedReference(
        "source",
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/web/template.js",
        referenceDefinition("web", {
          key: "api",
          contentIdentity: providerIdentity,
        }),
      ),
      loadedReference(
        "source",
        otherIdentity.packageName,
        otherIdentity.exportPath,
        "file:///fixture/other/template.js",
        referenceDefinition("other"),
      ),
      loadedPreset(presetIdentity, {
        web: webNode,
        api: {
          reference: { alias: "other", instance: "independent" },
          creationInput: { init: { path: "packages/other" } },
        },
      }),
    ]);
    await assert.rejects(
      wrongIdentityEngine.prepareProject({
        selection: { presets: [{ contentIdentity: presetIdentity }] },
        conventions: { edition: "stable" },
        operationFacts: null,
      }),
      /依赖绑定身份不一致/u,
    );

    const cyclePresetIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/cycle",
      exportPath: "./preset",
    };
    const cycleEngine = createEngine([
      loadedReference(
        "source",
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/web/template.js",
        referenceDefinition("web", {
          key: "api",
          contentIdentity: providerIdentity,
        }),
      ),
      loadedReference(
        "source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/api/template.js",
        referenceDefinition("api", {
          key: "web",
          contentIdentity: consumerIdentity,
        }),
      ),
      loadedPreset(cyclePresetIdentity, {
        web: webNode,
        api: {
          ...apiNode,
          dependencyBindings: { web: "web" },
        },
      }),
    ]);
    await assert.rejects(
      cycleEngine.prepareProject({
        selection: { presets: [{ contentIdentity: cyclePresetIdentity }] },
        conventions: { edition: "stable" },
        operationFacts: null,
      }),
      /依赖形成循环/u,
    );
  });

  void it("恢复时拒绝改绑到同内容的另一个 independent 实例", async () => {
    const consumerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web",
      exportPath: "./template",
    };
    const providerIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/api",
      exportPath: "./template",
    };
    const presetIdentity: ContentIdentity = {
      namespace: "source",
      packageName: "@fixture/web-api",
      exportPath: "./preset",
    };
    const content = [
      loadedReference(
        "source",
        consumerIdentity.packageName,
        consumerIdentity.exportPath,
        "file:///fixture/web/template.js",
        referenceDefinition("web", {
          key: "api",
          contentIdentity: providerIdentity,
        }),
      ),
      loadedReference(
        "source",
        providerIdentity.packageName,
        providerIdentity.exportPath,
        "file:///fixture/api/template.js",
        referenceDefinition("api"),
      ),
      loadedPreset(presetIdentity, {
        web: {
          reference: { alias: "web", instance: "independent" },
          creationInput: { init: { path: "apps/web" } },
          dependencyBindings: { api: "api" },
        },
        api: {
          reference: { alias: "api", instance: "independent" },
          creationInput: { init: { path: "packages/api" } },
        },
        "other-api": {
          reference: { alias: "api", instance: "independent" },
          creationInput: { init: { path: "packages/other-api" } },
        },
      }),
    ];
    await withTemporaryTarget(async (targetRoot) => {
      const initialized = await createEngine(content).init({
        targetRoot,
        selection: { presets: [{ contentIdentity: presetIdentity }] },
        conventions: { edition: "stable" },
        operationFacts: null,
      });
      assert.equal(initialized.status, "success", JSON.stringify(initialized));
      if (initialized.status !== "success") return;
      const selection = initialized.generationRecord.selections[0];
      const webId = selection?.nodes.web;
      const otherApiId = selection?.nodes["other-api"];
      assert.ok(webId);
      assert.ok(otherApiId);
      const recordPath = path.join(targetRoot, ".template/generation.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        packages: {
          packageDefinitionId: string;
          dependencyBindings: Record<string, string>;
        }[];
      };
      const webRecord = record.packages.find(
        (item) => item.packageDefinitionId === webId,
      );
      assert.ok(webRecord);
      webRecord.dependencyBindings.api = otherApiId;
      await writeFile(recordPath, JSON.stringify(record));
      const corruptedRecord = await readFile(recordPath);

      await assert.rejects(
        createEngine(content).restoreProject({ repositoryRoot: targetRoot }),
        /预设节点依赖绑定不一致/u,
      );
      assert.deepEqual(await readFile(recordPath), corruptedRecord);
    });
  });

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

  void it("按完整公开地址解析同模块别名并拒绝错误入口或其他修订", async () => {
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
    const aliasedEngine = createEngine([
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
        "@fixture/tooling",
        "./alias",
        "file:///fixture/tooling/template.js",
        referenceDefinition("tooling-alias"),
      ),
    ]);
    const resolved = await aliasedEngine.prepareProject({
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
    assert.deepEqual(
      aliasedEngine
        .computeProject(resolved)
        .blueprint.packages.map(({ path: packagePath }) => packagePath),
      ["packages/consumer", "packages/tooling"],
    );

    const wrongAddressEngine = createEngine([
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
        "./alias",
        "file:///fixture/tooling/template.js",
        provider,
      ),
    ]);
    await assert.rejects(
      prepareOne(wrongAddressEngine, identity),
      /公开地址与实际内容入口不一致/u,
    );

    assert.throws(
      () =>
        createEngine([
          loadedReference(
            "source",
            "@fixture/tooling",
            "./template",
            "file:///fixture/tooling/template.js",
            provider,
          ),
          loadedReference(
            "source",
            "@fixture/tooling",
            "./template",
            "file:///fixture/tooling/another-revision.js",
            provider,
          ),
        ]),
      /同一规范身份存在多个未明确选择的来源修订/u,
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
      /未解析到当前内容修订/u,
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
