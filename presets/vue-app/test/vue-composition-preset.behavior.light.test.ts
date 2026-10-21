import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preset as presetDefinition } from "@ykdz/preset-vue-app/template";
import { referencePackage as vueAppDefinition } from "@ykdz/reference-vue-app/template";
import { referencePackage as vueSharedDefinition } from "@ykdz/reference-vue-shared/template";
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
    "@ykdz/reference-vue-app/template",
    "@ykdz/reference-vue-shared/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-typescript-config/template",
    "@ykdz/preset-vue-app/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const contentIndex = createContentIndex(content);
const vueApp = contentIndex.fromDefinition(
  vueAppDefinition,
  "reference",
) as LoadedContentMember<
  ReturnType<typeof defineReferencePackage>,
  "reference"
>;
const vueShared = contentIndex.fromDefinition(vueSharedDefinition, "reference");
const library = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-ts-lib",
    exportPath: "./template",
  },
  "reference",
);
const configuration = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-typescript-config",
    exportPath: "./template",
  },
  "reference",
);
const preset = contentIndex.fromDefinition(presetDefinition, "preset");

type PersistedPackage = {
  readonly contentIdentity: ContentIdentity;
  readonly createdBy: string;
  readonly packageDefinitionId: string;
  readonly creationInput: unknown;
  readonly bindings: Readonly<Record<string, string>>;
};

async function snapshotTree(
  root: string,
): Promise<
  Record<string, { readonly content: string; readonly mode: number }>
> {
  const files: Record<string, { content: string; mode: number }> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        files[path.relative(root, filePath)] = {
          content: await readFile(filePath, "utf8"),
          mode: (await stat(filePath)).mode & 0o777,
        };
      }
    }
  }
  await visit(root);
  return Object.fromEntries(
    Object.entries(files).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

void describe("Vue 独立组合预设", () => {
  void it("保留现有 Editor 推荐顺序并在末尾追加新能力", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-editor-order-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: library.identity }],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const extensionsPath = path.join(targetRoot, ".vscode/extensions.json");
    const extensions = JSON.parse(await readFile(extensionsPath, "utf8")) as {
      recommendations: string[];
    };
    const initialRecommendation = extensions.recommendations[0];
    assert.ok(initialRecommendation);
    extensions.recommendations = [
      "user.first",
      initialRecommendation,
      "user.last",
    ];
    await writeFile(extensionsPath, `${JSON.stringify(extensions, null, 2)}\n`);

    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "dashboard" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.deepStrictEqual(added.generationRecord.presetSelections, [
      preset.identity,
    ]);

    const updated = JSON.parse(await readFile(extensionsPath, "utf8")) as {
      recommendations: string[];
    };
    assert.deepStrictEqual(updated.recommendations.slice(0, 3), [
      "user.first",
      initialRecommendation,
      "user.last",
    ]);
    assert.deepStrictEqual(updated.recommendations.slice(3), [
      "Vue.volar",
      "bradlc.vscode-tailwindcss",
      "vitest.explorer",
    ]);
  });

  void it("连续新增独立应用并保留应用、共享模块、配置和根定制", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-composition-preset-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    assert.deepStrictEqual(
      initialized.blueprint.packages
        .map(({ path: packagePath }) => packagePath)
        .toSorted(),
      [
        "apps/web",
        "packages/typescript-config",
        "packages/vue-shared",
      ].toSorted(),
    );
    const appManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(appManifest.name, "@demo/web");
    assert.deepStrictEqual(appManifest.dependencies, {
      "@demo/vue-shared": "workspace:*",
      pinia: "catalog:",
      vue: "catalog:",
    });
    assert.strictEqual(
      appManifest.devDependencies["@demo/typescript-config"],
      "workspace:*",
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "apps/web/src/main.ts"))).mode & 0o777,
      0o644,
    );

    const appSourcePath = path.join(targetRoot, "apps/web/src/App.vue");
    const sharedSourcePath = path.join(
      targetRoot,
      "packages/vue-shared/src/stores/counter.ts",
    );
    const configurationPath = path.join(
      targetRoot,
      "packages/typescript-config/base.json",
    );
    const customizedApp =
      (await readFile(appSourcePath, "utf8")) + "\n<!-- 保留已有页面定制 -->\n";
    const customizedShared =
      (await readFile(sharedSourcePath, "utf8")) +
      "\n// 保留已有共享模块定制\n";
    const customizedConfiguration =
      (await readFile(configurationPath, "utf8")) + "\n// 保留已有配置定制\n";
    await writeFile(appSourcePath, customizedApp);
    await writeFile(sharedSourcePath, customizedShared);
    await writeFile(configurationPath, customizedConfiguration);
    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as { scripts: Record<string, string> };
    rootManifest.scripts["custom:workspace"] = "echo retained";
    await writeFile(
      rootManifestPath,
      JSON.stringify(rootManifest, null, 2) + "\n",
    );

    for (const leafName of ["admin", "portal"]) {
      const added = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: { leafName },
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));
      if (added.status !== "success") return;
      const addedManifest = JSON.parse(
        await readFile(
          path.join(targetRoot, `apps/${leafName}/package.json`),
          "utf8",
        ),
      ) as {
        name: string;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      assert.strictEqual(addedManifest.name, `@demo/${leafName}`);
      assert.strictEqual(
        addedManifest.dependencies["@demo/vue-shared"],
        "workspace:*",
      );
      assert.strictEqual(
        addedManifest.devDependencies["@demo/typescript-config"],
        "workspace:*",
      );
      assert.strictEqual(
        (await stat(path.join(targetRoot, `apps/${leafName}/src/main.ts`)))
          .mode & 0o777,
        0o644,
      );
    }

    const retainedWebManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(
      retainedWebManifest.dependencies["@demo/vue-shared"],
      "workspace:*",
    );
    assert.strictEqual(
      retainedWebManifest.devDependencies["@demo/typescript-config"],
      "workspace:*",
    );
    assert.strictEqual(await readFile(appSourcePath, "utf8"), customizedApp);
    assert.strictEqual(
      await readFile(sharedSourcePath, "utf8"),
      customizedShared,
    );
    assert.strictEqual(
      await readFile(configurationPath, "utf8"),
      customizedConfiguration,
    );
    const updatedRootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      updatedRootManifest.scripts["custom:workspace"],
      "echo retained",
    );

    const generation = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      nodeInstances: Record<string, string>;
      packages: PersistedPackage[];
    };
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as {
      packages: {
        packageDefinitionId: string;
        path: string;
        role: string;
      }[];
    };
    function definitionFor(record: PersistedPackage) {
      const definition = blueprint.packages.find(
        (candidate) =>
          candidate.packageDefinitionId === record.packageDefinitionId,
      );
      assert.ok(definition);
      return definition;
    }
    const packages = generation.packages;
    const apps = packages.filter(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.deepStrictEqual(
      apps.map((item) => definitionFor(item).path).toSorted(),
      ["apps/admin", "apps/portal", "apps/web"].toSorted(),
    );
    assert.ok(
      apps.every((item) => definitionFor(item).role === "runtime-service"),
    );
    assert.strictEqual(
      new Set(apps.map((item) => item.packageDefinitionId)).size,
      3,
    );
    assert.strictEqual(
      generation.nodeInstances.web,
      apps.find((item) => definitionFor(item).path === "apps/web")
        ?.packageDefinitionId,
    );
    assert.strictEqual(
      apps.find((item) => definitionFor(item).path === "apps/web")?.createdBy,
      "initialization",
    );
    assert.deepStrictEqual(
      apps
        .filter((item) => definitionFor(item).path !== "apps/web")
        .map((item) => item.createdBy)
        .toSorted(),
      ["addition", "addition"],
    );
    const sharedInstances = packages.filter(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(vueShared.identity),
    );
    const configurationInstances = packages.filter(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(configuration.identity),
    );
    assert.strictEqual(sharedInstances.length, 1);
    assert.strictEqual(configurationInstances.length, 1);
    for (const app of apps) {
      assert.strictEqual(
        app.bindings[contentIdentityKey(vueShared.identity)],
        sharedInstances[0]!.packageDefinitionId,
      );
      assert.strictEqual(
        app.bindings[contentIdentityKey(configuration.identity)],
        configurationInstances[0]!.packageDefinitionId,
      );
    }
  });

  void it("缺少 Vue 共享参考内容时初始化失败且目标仍不存在", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-missing-content-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content: [vueApp, configuration, preset],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "operation-failure");
    if (result.status === "operation-failure") {
      assert.match(result.error.message, /vue-shared/u);
    }
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("生成记录的共享绑定失效时加包失败且目标树不变", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-missing-binding-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
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

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      nodeInstances: Record<string, string>;
      packages: {
        packageDefinitionId: string;
        bindings: Record<string, string>;
      }[];
    };
    const web = record.packages.find(
      (item) => item.packageDefinitionId === record.nodeInstances.web,
    );
    assert.ok(web);
    assert.ok(web.bindings[contentIdentityKey(vueShared.identity)]);
    web.bindings[contentIdentityKey(vueShared.identity)] =
      "missing-shared-instance";
    const invalidRecord = JSON.stringify(record, null, 2) + "\n";
    await writeFile(generationPath, invalidRecord);
    const beforeAddition = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "rejected" },
    });

    assert.strictEqual(result.status, "operation-failure");
    if (result.status === "operation-failure") {
      assert.match(result.error.message, /vue-shared|实例/u);
    }
    assert.deepStrictEqual(await snapshotTree(targetRoot), beforeAddition);
  });

  void it("新增应用路径被用户占用时拒绝操作且保留整棵目标树", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-path-conflict-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
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

    const occupiedDirectory = path.join(targetRoot, "apps/admin");
    await mkdir(occupiedDirectory, { recursive: true });
    const userFile = path.join(occupiedDirectory, "notes.txt");
    await writeFile(userFile, "user file\n");
    const beforeAddition = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "admin" },
    });

    assert.notStrictEqual(result.status, "success", JSON.stringify(result));
    if (result.status === "conflict") {
      assert.ok(
        result.conflicts.some(({ path: conflictPath }) =>
          conflictPath.startsWith("apps/admin"),
        ),
        JSON.stringify(result),
      );
    } else if (result.status === "operation-failure") {
      assert.match(result.error.message, /apps\/admin|admin/u);
    }
    assert.deepStrictEqual(await snapshotTree(targetRoot), beforeAddition);
    assert.strictEqual(await readFile(userFile, "utf8"), "user file\n");
  });

  void it("单节点布局覆盖传播且调用输入覆盖声明默认", async (testContext) => {
    const layoutPresetDefinition = definePreset({
      metadata: {
        alias: "vue-layout-test",
        title: "Vue 布局测试",
        description: "使用 Vue 参考包验证单节点布局输入。",
      },
      operations: ["init", "add"],
      nodes: {
        web: {
          reference: vueApp.definition,
          layout: { packageDirectory: "frontends" },
          creationInput: {
            init: { leafName: "preset-home" },
            add: { leafName: "preset-module" },
          },
        },
      },
    });
    const layoutPreset = Object.freeze({
      ...preset,
      alias: layoutPresetDefinition.metadata.alias,
      definition: layoutPresetDefinition,
    });
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-layout-override-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content: [vueApp, vueShared, configuration, layoutPreset],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            preset: layoutPreset.identity,
            creationInput: { leafName: "caller-home" },
          },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;
    const initializedHome = initialized.generationRecord.packages.find(
      (record) =>
        contentIdentityKey(record.contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.ok(initializedHome);
    assert.deepStrictEqual(initializedHome.creationInput, {
      leafName: "caller-home",
    });
    assert.ok(
      initialized.blueprint.packages.some(
        (definition) =>
          definition.name === "@demo/caller-home" &&
          definition.path === "frontends/caller-home",
      ),
    );

    const defaultAddition = await generator.add({
      repositoryRoot: targetRoot,
      preset: layoutPreset.identity,
    });
    assert.strictEqual(
      defaultAddition.status,
      "success",
      JSON.stringify(defaultAddition),
    );
    if (defaultAddition.status !== "success") return;
    assert.ok(
      defaultAddition.blueprint.packages.some(
        (definition) =>
          definition.name === "@demo/preset-module" &&
          definition.path === "frontends/preset-module",
      ),
    );

    const callerAddition = await generator.add({
      repositoryRoot: targetRoot,
      preset: layoutPreset.identity,
      creationInput: { leafName: "caller-admin" },
    });
    assert.strictEqual(
      callerAddition.status,
      "success",
      JSON.stringify(callerAddition),
    );
    if (callerAddition.status !== "success") return;
    assert.ok(
      callerAddition.blueprint.packages.some(
        (definition) =>
          definition.name === "@demo/caller-admin" &&
          definition.path === "frontends/caller-admin",
      ),
    );

    const explicitPathAddition = await generator.add({
      repositoryRoot: targetRoot,
      preset: layoutPreset.identity,
      creationInput: {
        leafName: "explicit",
        packagePath: "custom/explicit",
      },
    });
    assert.strictEqual(
      explicitPathAddition.status,
      "success",
      JSON.stringify(explicitPathAddition),
    );
    if (explicitPathAddition.status !== "success") return;
    assert.ok(
      explicitPathAddition.blueprint.packages.some(
        (definition) =>
          definition.name === "@demo/explicit" &&
          definition.path === "custom/explicit",
      ),
    );
  });
});
