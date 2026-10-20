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

import { preset } from "@ykdz/preset-vike-app/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as web } from "@ykdz/reference-vike-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);
const content = [
  web,
  database,
  migrations,
  vueShared,
  library,
  configuration,
  preset,
];

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
      selection: { roots: [{ preset }] },
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
    assert.deepStrictEqual(
      await readJson(path.join(targetRoot, "deployment.json")),
      {
        application: { name: "@demo/web", path: "apps/web" },
        database: { name: "@demo/db", path: "packages/db" },
        migrations: {
          name: "@demo/db-migrations",
          path: "packages/db-migrations",
        },
      },
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
    const rootManifestAfter = await readJson(rootManifestPath);
    assert.strictEqual(
      (rootManifestAfter.scripts as Record<string, string>)[
        "database:prepare:dev"
      ],
      scriptsBefore["database:prepare:dev"],
    );
    assert.deepStrictEqual(
      await readJson(path.join(targetRoot, "deployment.json")),
      {
        application: { name: "@demo/web", path: "apps/web" },
        database: { name: "@demo/db", path: "packages/db" },
        migrations: {
          name: "@demo/db-migrations",
          path: "packages/db-migrations",
        },
      },
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "scripts/container-entrypoint.sh")))
        .mode & 0o111,
      0o111,
    );
    const beforeRejectedPresetAdd = await snapshotTree(targetRoot);
    const rejectedPresetAdd = await replayGenerator.add({
      repositoryRoot: targetRoot,
      preset,
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
          { preset },
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
      content: content.filter((item) => item !== vueShared),
      strategy: createDefaultWorkspaceStrategy(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(initialized.status, "operation-failure");
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
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
      selection: { roots: [{ preset }] },
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
      selection: { roots: [{ preset }] },
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
