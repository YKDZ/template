import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preset as presetDefinition } from "@ykdz/preset-vike-app/template";
import { referencePackage as libraryDefinition } from "@ykdz/reference-ts-lib/template";
import { referencePackage as databaseDefinition } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrationsDefinition } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as webDefinition } from "@ykdz/reference-vike-web/template";
import { createContentIndex } from "@ykdz/template-core/content-identity";
import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

const loadedContent = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-vike-web/template",
    "@ykdz/reference-vike-db/template",
    "@ykdz/reference-vike-migrations/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-tooling-config/template",
    "@ykdz/reference-npm-publication/template",
    "@ykdz/preset-vike-app/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const contentIndex = createContentIndex(loadedContent);
const web = contentIndex.fromDefinition(webDefinition, "reference");
const database = contentIndex.fromDefinition(databaseDefinition, "reference");
const migrations = contentIndex.fromDefinition(
  migrationsDefinition,
  "reference",
);
const library = contentIndex.fromDefinition(libraryDefinition, "reference");
const configuration = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-tooling-config",
    exportPath: "./template",
  },
  "reference",
);
const preset = contentIndex.fromDefinition(presetDefinition, "preset");
const content = [
  web,
  database,
  migrations,
  library,
  configuration,
  contentIndex.resolve(
    {
      namespace: "ykdz",
      packageName: "@ykdz/reference-npm-publication",
      exportPath: "./template",
    },
    "reference",
  ),
  preset,
];
const unsupportedPresetDefinition = {
  ...presetDefinition,
  project: (
    options: Parameters<NonNullable<typeof presetDefinition.project>>[0],
  ) => [
    ...presetDefinition.project!(options),
    JSON.parse('{"kind":"unsupported-documentation"}'),
  ],
};
const unsupportedPreset = Object.freeze({
  ...preset,
  definition: unsupportedPresetDefinition,
});
const contentWithUnsupportedProjectRequirement = content.map((item) =>
  item === preset ? unsupportedPreset : item,
);

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

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

void describe("Vike 应用公开预设", () => {
  void it("拒绝角色不匹配的应用部署实例", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-role-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );

    assert.throws(
      () =>
        presetDefinition.project?.({
          context: {
            targetDir: path.join(temporaryRoot, "demo"),
            repositoryName: "demo",
            defaultPackageScope: "demo",
            toolchain: {
              nodeLtsMajor: "24",
              nodeVersion: "24.21.0",
              packageManagerPin: "pnpm@12.9.1",
            },
          },
          contributions: [],
          nodeInstances: new Map([
            [
              "web",
              { name: "@demo/web", path: "apps/web", role: "shared-library" },
            ],
            [
              "database",
              { name: "@demo/db", path: "packages/db", role: "shared-library" },
            ],
            [
              "migrations",
              {
                name: "@demo/db-migrations",
                path: "packages/db-migrations",
                role: "shared-library",
              },
            ],
          ]),
        }),
      /Vike 应用部署要求应用包具有 runtime-service 角色/u,
    );
  });

  void it("初始化组合并在真实加包回放后保留数据库与部署投影", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-"),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
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

    const rootManifestPath = path.join(targetRoot, "package.json");
    const rootManifestBefore = await readJson(rootManifestPath);
    const scriptsBefore = rootManifestBefore.scripts as Record<string, string>;
    assert.strictEqual(
      scriptsBefore["database:prepare:dev"],
      "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
    );
    const deploymentChecker = await readFile(
      path.join(targetRoot, "scripts/check-standalone-deployment.ts"),
      "utf8",
    );
    assert.match(
      deploymentChecker,
      /const applicationPackageName = "@demo\/web";/u,
    );
    assert.match(deploymentChecker, /APPLICATION_PACKAGE_PATH: "apps\/web"/u);
    assert.match(deploymentChecker, /DATABASE_PACKAGE_NAME: "@demo\/db"/u);
    assert.match(
      deploymentChecker,
      /MIGRATION_PACKAGE_NAME: "@demo\/db-migrations"/u,
    );
    const checkWorkflow = await readFile(
      path.join(targetRoot, ".github/workflows/check.yml"),
      "utf8",
    );
    assert.match(checkWorkflow, /name: Full Check/u);
    assert.ok(
      checkWorkflow.indexOf("id: prepare-deployment") <
        checkWorkflow.indexOf("id: run-heavy-check"),
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "scripts/container-entrypoint.sh")))
        .mode & 0o111,
      0o111,
    );

    const replayGenerator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const added = await replayGenerator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));

    const databaseManifestPath = path.join(
      targetRoot,
      "packages/db/package.json",
    );
    const databaseManifest = await readJson(databaseManifestPath);
    const databaseScripts = databaseManifest.scripts as Record<string, unknown>;
    const resetScript = databaseScripts["db:reset"];
    delete databaseScripts["db:reset"];
    await writeFile(
      databaseManifestPath,
      JSON.stringify(databaseManifest, null, 2) + "\n",
    );
    const beforeInvalidDatabaseAdd = await snapshotTree(targetRoot);
    const invalidDatabaseAdd = await createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    }).add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "next" },
    });
    assert.strictEqual(
      invalidDatabaseAdd.status,
      "operation-failure",
      JSON.stringify(invalidDatabaseAdd),
    );
    if (invalidDatabaseAdd.status === "operation-failure") {
      assert.match(
        invalidDatabaseAdd.error.message,
        /Vike 数据准备要求 @demo\/db 的 scripts\.db:reset 与来源包保持一致/u,
      );
    }
    assert.strictEqual(
      await snapshotTree(targetRoot),
      beforeInvalidDatabaseAdd,
    );

    assert.strictEqual(added.status, "success");
    if (added.status !== "success") return;
    const guide = added.blueprint.packages.find(
      (item) => item.path === "packages/guide",
    )!;
    const invalidConfiguration = await createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    }).configure({
      repositoryRoot: targetRoot,
      packageDefinitionId: guide.packageDefinitionId,
      configuration: { publication: true },
    });
    assert.strictEqual(invalidConfiguration.status, "operation-failure");
    if (invalidConfiguration.status === "operation-failure") {
      assert.match(
        invalidConfiguration.error.message,
        /Vike 数据准备要求 @demo\/db 的 scripts\.db:reset 与来源包保持一致/u,
      );
    }
    assert.strictEqual(
      await snapshotTree(targetRoot),
      beforeInvalidDatabaseAdd,
    );

    databaseScripts["db:reset"] = resetScript;
    await writeFile(
      databaseManifestPath,
      JSON.stringify(databaseManifest, null, 2) + "\n",
    );
    const configured = await createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    }).configure({
      repositoryRoot: targetRoot,
      packageDefinitionId: guide.packageDefinitionId,
      configuration: { publication: true },
    });
    assert.strictEqual(
      configured.status,
      "success",
      JSON.stringify(configured),
    );

    const rootManifestAfter = await readJson(rootManifestPath);
    assert.strictEqual(
      (rootManifestAfter.scripts as Record<string, string>)[
        "database:prepare:dev"
      ],
      scriptsBefore["database:prepare:dev"],
    );
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, "scripts/check-standalone-deployment.ts"),
        "utf8",
      ),
      deploymentChecker,
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "scripts/container-entrypoint.sh")))
        .mode & 0o111,
      0o111,
    );
    const beforeRejectedPresetAdd = await snapshotTree(targetRoot);
    const rejectedPresetAdd = await replayGenerator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });
    assert.strictEqual(rejectedPresetAdd.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeRejectedPresetAdd);
  });

  void it("同一初始化图拒绝重复的独立 Vike 节点", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-duplicate-root-"),
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
        roots: [
          { preset: preset.identity },
          { nodeIdentity: "duplicate-web", contentIdentity: web.identity },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(initialized.status, "operation-failure");
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("缺少必需共享内容时初始化失败且不创建目标目录", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-missing-content-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content: content.filter((item) => item !== configuration),
      strategy: createDefaultWorkspaceStrategy(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(initialized.status, "operation-failure");
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("默认策略在初始化提交前拒绝不支持的项目要求", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-unsupported-init-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generator = createGenerator({
      content: contentWithUnsupportedProjectRequirement,
      strategy: createDefaultWorkspaceStrategy(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: unsupportedPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(initialized.status, "operation-failure");
    if (initialized.status === "operation-failure") {
      assert.match(
        initialized.error.message,
        /默认工作区策略不支持项目要求：unsupported-documentation/u,
      );
    }
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("默认策略在加包提交前拒绝不支持的项目要求且保持原树", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-unsupported-add-"),
    );
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const initialized = await createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    }).init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const beforeAdd = await snapshotTree(targetRoot);
    const add = await createGenerator({
      content: contentWithUnsupportedProjectRequirement,
      strategy: createDefaultWorkspaceStrategy(),
    }).add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });

    assert.strictEqual(add.status, "operation-failure");
    if (add.status === "operation-failure") {
      assert.match(
        add.error.message,
        /默认工作区策略不支持项目要求：unsupported-documentation/u,
      );
    }
    assert.strictEqual(await snapshotTree(targetRoot), beforeAdd);
  });

  void it("缺少预设选择事实时拒绝回放且不改动生成树", async (testContext) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vike-app-preset-record-"),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    testContext.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
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

    const recordPath = path.join(targetRoot, ".template/generation.json");
    const record = await readJson(recordPath);
    delete record.presetSelections;
    await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n");
    const beforeAdd = await snapshotTree(targetRoot);
    const replayGenerator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const added = await replayGenerator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });

    assert.strictEqual(added.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeAdd);

    const missingNodeRoot = path.join(temporaryRoot, "missing-node");
    const secondInitialization = await generator.init({
      targetRoot: missingNodeRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      secondInitialization.status,
      "success",
      JSON.stringify(secondInitialization),
    );
    const missingNodeRecordPath = path.join(
      missingNodeRoot,
      ".template/generation.json",
    );
    const missingNodeRecord = await readJson(missingNodeRecordPath);
    const nodeInstances = missingNodeRecord.nodeInstances as Record<
      string,
      unknown
    >;
    delete nodeInstances.database;
    await writeFile(
      missingNodeRecordPath,
      JSON.stringify(missingNodeRecord, null, 2) + "\n",
    );
    const beforeMissingNodeAdd = await snapshotTree(missingNodeRoot);
    const missingNodeReplay = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const addedWithoutDatabase = await missingNodeReplay.add({
      repositoryRoot: missingNodeRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "guide" },
    });
    assert.strictEqual(addedWithoutDatabase.status, "operation-failure");
    assert.strictEqual(
      await snapshotTree(missingNodeRoot),
      beforeMissingNodeAdd,
    );
  });
});
