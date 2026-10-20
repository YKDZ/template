import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { preset as rustBinPreset } from "@ykdz/preset-rust-bin/template";
import { preset as tsCliPreset } from "@ykdz/preset-ts-cli/template";
import { preset } from "@ykdz/preset-ts-lib/template";
import { preset as vikeAppPreset } from "@ykdz/preset-vike-app/template";
import { referencePackage as rustBin } from "@ykdz/reference-rust-bin/template";
import { referencePackage as tsCli } from "@ykdz/reference-ts-cli/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referencePackage as vueApp } from "@ykdz/reference-vue-app/template";
import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const temporaryDirectories: string[] = [];

async function createTargetRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "demo");
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

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

void describe("公开模板内容集合", () => {
  void it("只用集合成员完成库初始化及其公开共享依赖展开", async () => {
    const targetRoot = await createTargetRoot("template-content-ts-lib-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      ["packages/lib", "packages/typescript-config"].toSorted(),
    );
  });

  void it("从同一集合初始化 CLI 发布候选和 Rust 二进制程序", async () => {
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });
    const cliRoot = await createTargetRoot("template-content-ts-cli-");
    const cliResult = await generator.init({
      targetRoot: cliRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(cliResult.status, "success", JSON.stringify(cliResult));
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(cliRoot, "scripts/npm-publication/publication.config.json"),
          "utf8",
        ),
      ),
      { packagePath: "packages/cli" },
    );

    const rustRoot = await createTargetRoot("template-content-rust-bin-");
    const rustResult = await generator.init({
      targetRoot: rustRoot,
      selection: { roots: [{ preset: rustBinPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      rustResult.status,
      "success",
      JSON.stringify(rustResult),
    );
    assert.match(
      await readFile(path.join(rustRoot, "packages/app/Cargo.toml"), "utf8"),
      /name = "app"/u,
    );
  });

  void it("从同一集合初始化 Vike 应用并投影数据库与部署准备", async () => {
    const targetRoot = await createTargetRoot("template-content-vike-app-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: vikeAppPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const collisionPath = path.join(targetRoot, "packages/lib");
    await mkdir(collisionPath, { recursive: true });
    await writeFile(path.join(collisionPath, "unowned.txt"), "用户内容\n");
    const beforeConflict = await snapshotTree(targetRoot);
    const conflict = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
    });
    assert.strictEqual(conflict.status, "conflict");
    assert.strictEqual(await snapshotTree(targetRoot), beforeConflict);
    await rm(collisionPath, { recursive: true, force: true });

    const customizedRootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    customizedRootManifest.scripts["user:check"] = "echo retained";
    await writeFile(
      path.join(targetRoot, "package.json"),
      JSON.stringify(customizedRootManifest, null, 2) + "\n",
    );
    const customizedServer = "// 初始化后的用户修改\nexport default {};\n";
    await writeFile(
      path.join(targetRoot, "apps/web/+server.ts"),
      customizedServer,
    );
    const existingVikeManifests = await Promise.all(
      [
        "apps/web/package.json",
        "packages/db/package.json",
        "packages/db-migrations/package.json",
      ].map((relativePath) =>
        readFile(path.join(targetRoot, relativePath), "utf8"),
      ),
    );

    for (const addition of [
      { contentIdentity: library.identity },
      { contentIdentity: tsCli.identity },
      { contentIdentity: rustBin.identity },
      {
        contentIdentity: vueApp.identity,
        creationInput: { leafName: "vue" },
      },
    ]) {
      const replayGenerator = createGenerator({
        content: templateContent,
        strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
      });
      const added = await replayGenerator.add({
        repositoryRoot: targetRoot,
        ...addition,
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));
    }

    const rootPackageManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as {
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    };
    assert.strictEqual(rootPackageManifest.engines.node, "24.21.0");
    assert.strictEqual(rootPackageManifest.packageManager, "pnpm@12.9.1");
    assert.strictEqual(
      rootPackageManifest.scripts["user:check"],
      "echo retained",
    );
    assert.strictEqual(
      rootPackageManifest.scripts["database:prepare:dev"],
      "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
    );
    const databaseManifest = JSON.parse(
      await readFile(path.join(targetRoot, "packages/db/package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    assert.ok(databaseManifest.exports["./queries/todos"]);
    assert.ok(databaseManifest.exports["./schema"]);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "deployment.json"), "utf8"),
      ),
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
      await readFile(path.join(targetRoot, "apps/web/+server.ts"), "utf8"),
      customizedServer,
    );
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.strictEqual(
      blueprint.packages.filter(
        (definition) => definition.path === "packages/typescript-config",
      ).length,
      1,
    );
    assert.strictEqual(
      blueprint.packages.filter(
        (definition) => definition.path === "packages/vue-shared",
      ).length,
      1,
    );
    assert.deepStrictEqual(
      await Promise.all(
        [
          "apps/web/package.json",
          "packages/db/package.json",
          "packages/db-migrations/package.json",
        ].map((relativePath) =>
          readFile(path.join(targetRoot, relativePath), "utf8"),
        ),
      ),
      existingVikeManifests,
    );
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/cli/package.json"),
        "utf8",
      ),
      /"name": "@demo\/cli"/u,
    );
    assert.match(
      await readFile(path.join(targetRoot, "packages/app/Cargo.toml"), "utf8"),
      /name = "app"/u,
    );
    assert.match(
      await readFile(path.join(targetRoot, "apps/vue/package.json"), "utf8"),
      /"name": "@demo\/vue"/u,
    );
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/lib/package.json"),
        "utf8",
      ),
      /"name": "@demo\/lib"/u,
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "scripts/container-entrypoint.sh")))
        .mode & 0o111,
      0o111,
    );
  });
});
