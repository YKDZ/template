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
import { after, describe, it } from "node:test";

import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import { definePreset } from "@ykdz/template-core/preset-definition";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-workspace-root/template",
    "@ykdz/reference-vue-app/template",
    "@ykdz/reference-tooling-config/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-npm-publication/template",
    "@ykdz/preset-vue-app/template",
  ],
});

function member(
  kind: "preset" | "reference",
  packageName: string,
): LoadedContentMember {
  const found = content.find(
    (item) => item.kind === kind && item.identity.packageName === packageName,
  );
  assert.ok(found, `显式内容集合缺少 ${kind} ${packageName}`);
  return found;
}

const root = member("reference", "@ykdz/reference-workspace-root");
const vueApp = member("reference", "@ykdz/reference-vue-app");
const configuration = member("reference", "@ykdz/reference-tooling-config");
const preset = member("preset", "@ykdz/preset-vue-app");

const conventions = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

async function snapshotTree(targetRoot: string): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly bytes: string;
  }[]
> {
  const entries: { path: string; mode: number; bytes: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const entryPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, entryPath);
      } else {
        entries.push({
          path: entryPath,
          mode: (await stat(absolutePath)).mode & 0o777,
          bytes: (await readFile(absolutePath)).toString("base64"),
        });
      }
    }
  }
  await visit(targetRoot);
  return entries;
}

function generator() {
  return createDefaultGenerator({ content });
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Vue 独立组合预设公开行为", () => {
  void it("添加应用时保留现有 Editor 推荐顺序定制", async () => {
    const targetRoot = await createTargetRoot("template-vue-editor-order-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    const extensionsPath = path.join(targetRoot, ".vscode/extensions.json");
    const extensions = JSON.parse(await readFile(extensionsPath, "utf8")) as {
      recommendations: string[];
    };
    const customizedRecommendations = [
      "user.first",
      ...extensions.recommendations,
      "user.last",
    ];
    extensions.recommendations = customizedRecommendations;
    await writeFile(extensionsPath, `${JSON.stringify(extensions, null, 2)}\n`);

    const added = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "dashboard" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;
    assert.deepStrictEqual(
      added.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [preset.identity, preset.identity],
    );

    const updated = JSON.parse(await readFile(extensionsPath, "utf8")) as {
      recommendations: string[];
    };
    assert.deepStrictEqual(updated.recommendations, customizedRecommendations);
  });

  void it("连续新增独立应用并保留应用、状态模块、配置和根定制", async () => {
    const targetRoot = await createTargetRoot("template-vue-composition-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
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
      [".", "apps/web", "packages/tooling-config"].toSorted(),
    );
    const appManifestPath = path.join(targetRoot, "apps/web/package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(appManifest.name, "@demo/web");
    assert.deepStrictEqual(appManifest.dependencies, {
      "@vue/devtools-api": "catalog:",
      pinia: "catalog:",
      vue: "catalog:",
    });
    assert.strictEqual(
      appManifest.devDependencies["@demo/tooling-config"],
      "workspace:*",
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "apps/web/src/main.ts"))).mode & 0o777,
      0o644,
    );

    const appSourcePath = path.join(targetRoot, "apps/web/src/App.vue");
    const storeSourcePath = path.join(
      targetRoot,
      "apps/web/src/stores/counter.ts",
    );
    const configurationPath = path.join(
      targetRoot,
      "packages/tooling-config/base.json",
    );
    const customizedApp =
      (await readFile(appSourcePath, "utf8")) + "\n<!-- 保留已有页面定制 -->\n";
    const customizedStore =
      (await readFile(storeSourcePath, "utf8")) + "\n// 保留已有应用状态定制\n";
    const customizedConfiguration =
      (await readFile(configurationPath, "utf8")) + "\n// 保留已有配置定制\n";
    await writeFile(appSourcePath, customizedApp);
    await writeFile(storeSourcePath, customizedStore);
    await writeFile(configurationPath, customizedConfiguration);

    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    rootManifest.scripts["custom:workspace"] = "echo retained";
    await writeFile(
      rootManifestPath,
      `${JSON.stringify(rootManifest, null, 2)}\n`,
    );

    for (const leafName of ["admin", "portal"]) {
      const added = await generator().add({
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
        devDependencies: Record<string, string>;
      };
      assert.strictEqual(addedManifest.name, `@demo/${leafName}`);
      assert.strictEqual(
        addedManifest.devDependencies["@demo/tooling-config"],
        "workspace:*",
      );
      assert.strictEqual(
        (await stat(path.join(targetRoot, `apps/${leafName}/src/main.ts`)))
          .mode & 0o777,
        0o644,
      );
    }

    assert.strictEqual(await readFile(appSourcePath, "utf8"), customizedApp);
    assert.strictEqual(
      await readFile(storeSourcePath, "utf8"),
      customizedStore,
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

    const vuePackages = initialized.generationRecord.packages.filter(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.strictEqual(vuePackages.length, 1);
    const firstVueId = vuePackages[0]!.packageDefinitionId;
    const rootId = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(root.identity),
    )?.packageDefinitionId;
    assert.ok(rootId);
    const finalGeneration = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: ContentIdentity;
        createdBy: string;
        packageDefinitionId: string;
        dependencyBindings: Record<string, string>;
      }[];
    };
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as {
      packages: { packageDefinitionId: string; path: string; role: string }[];
    };
    const pathFor = (id: string) => {
      const definition = blueprint.packages.find(
        (item) => item.packageDefinitionId === id,
      );
      assert.ok(definition);
      return definition;
    };
    const allVuePackages = finalGeneration.packages.filter(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.deepStrictEqual(
      allVuePackages
        .map(({ packageDefinitionId }) => pathFor(packageDefinitionId).path)
        .toSorted(),
      ["apps/admin", "apps/portal", "apps/web"].toSorted(),
    );
    assert.ok(
      allVuePackages.every(
        ({ packageDefinitionId }) =>
          pathFor(packageDefinitionId).role === "runtime-service",
      ),
    );
    assert.strictEqual(
      new Set(
        allVuePackages.map(({ packageDefinitionId }) => packageDefinitionId),
      ).size,
      3,
    );
    assert.strictEqual(
      finalGeneration.packages.find(
        ({ contentIdentity }) =>
          contentIdentityKey(contentIdentity) ===
          contentIdentityKey(root.identity),
      )?.packageDefinitionId,
      rootId,
    );
    assert.strictEqual(pathFor(firstVueId).path, "apps/web");
    assert.strictEqual(
      finalGeneration.packages.find(
        ({ packageDefinitionId }) => packageDefinitionId === firstVueId,
      )?.createdBy,
      "initialization",
    );
    assert.deepStrictEqual(
      allVuePackages
        .filter(({ packageDefinitionId }) => packageDefinitionId !== firstVueId)
        .map(({ createdBy }) => createdBy)
        .toSorted(),
      ["addition", "addition"],
    );
    const configurationPackages = finalGeneration.packages.filter(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(configuration.identity),
    );
    assert.strictEqual(configurationPackages.length, 1);
    for (const app of allVuePackages) {
      assert.strictEqual(
        app.dependencyBindings["tooling-config"],
        configurationPackages[0]!.packageDefinitionId,
      );
    }
  });

  void it("共享绑定失效时拒绝加包并保持目标树不变", async () => {
    const targetRoot = await createTargetRoot("template-vue-missing-binding-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
        dependencyBindings: Record<string, string>;
      }[];
    };
    const web = record.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.ok(web);
    const key = "tooling-config";
    assert.ok(web.dependencyBindings[key]);
    web.dependencyBindings[key] = `package-${"0".repeat(64)}`;
    await writeFile(generationPath, `${JSON.stringify(record, null, 2)}\n`);
    const beforeAddition = await snapshotTree(targetRoot);

    const result = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "rejected" },
    });
    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    if (result.status === "operation-failure") {
      assert.match(result.error.message, /依赖绑定/u);
    }
    assert.deepStrictEqual(await snapshotTree(targetRoot), beforeAddition);
  });

  void it("新增应用路径被用户占用时拒绝操作并保留整棵目标树", async () => {
    const targetRoot = await createTargetRoot("template-vue-path-conflict-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
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

    const result = await generator().add({
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

  void it("布局与创建输入贯穿初始化和连续加包", async () => {
    const vueDefinition = vueApp.definition as {
      readonly alias: string;
      readonly instance: "shared" | "independent";
    };
    const layoutPresetDefinition = definePreset({
      metadata: {
        alias: "vue-layout-test",
        title: "Vue 布局测试",
        description: "使用 Vue 参考包验证单节点布局输入。",
      },
      operations: ["init", "add"],
      nodes: {
        web: {
          reference: vueDefinition,
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
    const layoutContent = [
      ...content.filter((item) => item.kind !== "preset"),
      layoutPreset,
    ];
    const targetRoot = await createTargetRoot("template-vue-layout-");
    const layoutGenerator = () =>
      createDefaultGenerator({ content: layoutContent });
    const initialized = await layoutGenerator().init({
      targetRoot,
      selection: {
        presets: [
          {
            contentIdentity: layoutPreset.identity,
            creationInput: { leafName: "caller-home" },
          },
        ],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;
    const initialVue = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(vueApp.identity),
    );
    assert.ok(initialVue);
    assert.deepStrictEqual(initialVue.creationInput, {
      leafName: "caller-home",
    });
    assert.ok(
      initialized.blueprint.packages.some(
        ({ name, path: packagePath }) =>
          name === "@demo/caller-home" &&
          packagePath === "frontends/caller-home",
      ),
    );

    const defaultAddition = await layoutGenerator().add({
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
        ({ name, path: packagePath }) =>
          name === "@demo/preset-module" &&
          packagePath === "frontends/preset-module",
      ),
    );

    const callerAddition = await layoutGenerator().add({
      repositoryRoot: targetRoot,
      preset: layoutPreset.identity,
      creationInput: { leafName: "caller-module" },
    });
    assert.strictEqual(
      callerAddition.status,
      "success",
      JSON.stringify(callerAddition),
    );
    if (callerAddition.status !== "success") return;
    assert.ok(
      callerAddition.blueprint.packages.some(
        ({ name, path: packagePath }) =>
          name === "@demo/caller-module" &&
          packagePath === "frontends/caller-module",
      ),
    );
  });
});
