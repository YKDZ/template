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
import { describe, it } from "node:test";

import { preset } from "@ykdz/preset-vue-hono-app/template";
import { referencePackage as api } from "@ykdz/reference-hono-api/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as web } from "@ykdz/reference-vue-hono-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);
const content = [api, web, vueShared, configuration, library, preset] as const;
const missingResourceShared = defineReferencePackage({
  packageName: vueShared.manifest.name,
  resolve: (specifier) => import.meta.resolve(specifier),
  identity: vueShared.identity,
  instance: vueShared.instance,
  defaultLeafName: vueShared.defaultLeafName,
  role: vueShared.role,
  resources: ["__missing-vue-shared-resource__.ts"],
  authoring: {
    dependencies: [
      "@ykdz/template-core",
      "@ykdz/template-environment",
      "@ykdz/template-workspace-authoring",
    ],
    scripts: ["build:template"],
  },
  foundation: {
    toolchains: {},
    editorCapabilities: [],
    dependencyMaintenance: { ecosystems: [], interval: "weekly" },
  },
  environmentNeeds: [],
});

async function snapshotTree(root: string): Promise<{
  readonly rootMode: number;
  readonly entries: readonly {
    readonly path: string;
    readonly kind: "directory" | "file";
    readonly mode: number;
    readonly bytes: string;
  }[];
}> {
  const entries: {
    path: string;
    kind: "directory" | "file";
    mode: number;
    bytes: string;
  }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const entryPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push({
          path: entryPath,
          kind: "directory",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: "",
        });
        await visit(filePath, entryPath);
      } else {
        entries.push({
          path: entryPath,
          kind: "file",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: (await readFile(filePath)).toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return { rootMode: (await stat(root)).mode & 0o777, entries };
}

function generator() {
  return createGenerator({
    content,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  });
}

const strategyInput = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

void describe("Vue-Hono 组合预设公开行为", () => {
  void it("通过真实生成器投影 web 与 API 的联合验收和包连接", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-init-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generated = generator();
    const result = await generated.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput,
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") return;

    assert.deepStrictEqual(
      result.blueprint.packages.map(({ path: packagePath }) => packagePath),
      [
        "apps/web",
        "apps/api",
        "packages/typescript-config",
        "packages/vue-shared",
      ],
    );
    assert.deepStrictEqual(result.blueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "apps/api" },
    ]);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "joint-e2e.json"), "utf8"),
      ),
      { apiPackageName: "@demo/api", webPackageName: "@demo/web" },
    );

    const webManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.strictEqual(webManifest.dependencies["@demo/api"], "workspace:*");
    assert.strictEqual(
      webManifest.dependencies["@demo/vue-shared"],
      "workspace:*",
    );
    assert.strictEqual(
      webManifest.devDependencies["@demo/typescript-config"],
      "workspace:*",
    );

    const apiManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/api/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(
      apiManifest.dependencies["@demo/typescript-config"],
      "workspace:*",
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".template/environment-needs.json"),
          "utf8",
        ),
      ).check.some(
        (need: { kind: string }) => need.kind === "playwright-browser-assets",
      ),
      true,
    );
    assert.strictEqual(
      JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8"))
        .scripts["test:e2e"],
      "playwright test",
    );
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn: readonly string[] }> };
    assert.deepStrictEqual(turbo.tasks["//#test:e2e"]?.dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    assert.ok(
      (
        JSON.parse(
          await readFile(path.join(targetRoot, "tsconfig.json"), "utf8"),
        ) as { include: readonly string[] }
      ).include.includes("test/**/*.ts"),
    );
    assert.match(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
      /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS:[^\n]*\n\s+\./u,
    );

    const beforeUnsupportedAdd = await snapshotTree(targetRoot);
    const rejectedAdd = await generated.add({
      repositoryRoot: targetRoot,
      preset,
    });
    assert.strictEqual(
      rejectedAdd.status,
      "operation-failure",
      JSON.stringify(rejectedAdd),
    );
    assert.deepStrictEqual(
      await snapshotTree(targetRoot),
      beforeUnsupportedAdd,
    );
  });

  void it("保留通过公开内容身份直接组合 web 与 API 的用法", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-direct-composition-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const result = await generator().init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web", contentIdentity: web.identity },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      strategyInput,
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") return;
    assert.ok(
      result.blueprint.packages.some(
        ({ path: packagePath }) => packagePath === "apps/web",
      ),
    );
    assert.ok(
      result.blueprint.packages.some(
        ({ path: packagePath }) => packagePath === "apps/api",
      ),
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
      ).dependencies["@demo/api"],
      "workspace:*",
    );
  });

  void it("拒绝重复选择独立 web 节点且不创建目标目录", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-duplicate-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const result = await generator().init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "web-one", contentIdentity: web.identity },
          { nodeIdentity: "web-two", contentIdentity: web.identity },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      strategyInput,
    });

    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("拒绝用单包布局输入指定多节点预设主包且不创建目标目录", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-primary-input-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const result = await generator().init({
      targetRoot,
      selection: {
        roots: [{ preset, creationInput: { leafName: "custom" } }],
      },
      strategyInput,
    });

    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("缺少 API 参考内容时拒绝预设绑定且不创建目标目录", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-missing-binding-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    assert.throws(
      () =>
        createGenerator({
          content: [web, vueShared, configuration, library, preset],
          strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
        }),
      /缺少预设参考成员：hono-api/u,
    );
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("缺少共享参考资源时给出来源诊断且不创建目标目录", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-missing-resource-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const incompleteGenerator = createGenerator({
      content: [api, web, missingResourceShared, configuration, preset],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });
    const result = await incompleteGenerator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput,
    });

    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    if (result.status === "operation-failure") {
      assert.strictEqual(result.phase, "planning");
      assert.match(result.error.message, /reference-vue-shared/u);
      assert.match(result.error.message, /__missing-vue-shared-resource__/u);
    }
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("缺失实际 API 节点时拒绝后续操作且目标树逐字节不变", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-missing-node-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generated = generator();
    const initialized = await generated.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      nodeInstances: Record<string, string>;
    };
    delete record.nodeInstances.api;
    await writeFile(generationPath, JSON.stringify(record, null, 2) + "\n");
    const before = await snapshotTree(targetRoot);
    const added = await generated.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        leafName: "helper",
        packagePath: "packages/helper",
      },
    });

    assert.strictEqual(
      added.status,
      "operation-failure",
      JSON.stringify(added),
    );
    if (added.status === "operation-failure") {
      assert.strictEqual(added.phase, "metadata");
      assert.match(added.error.message, /api/u);
    }
    assert.deepStrictEqual(await snapshotTree(targetRoot), before);
  });

  void it("加包协调冲突时保留用户文件且不部分加包", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-preset-root-conflict-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const generated = generator();
    const initialized = await generated.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const conflictDirectory = path.join(targetRoot, "packages/helper");
    await mkdir(conflictDirectory, { recursive: true });
    const userFile = path.join(conflictDirectory, "README.md");
    await writeFile(userFile, "user bytes\n");
    const before = await snapshotTree(targetRoot);

    const result = await generated.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        leafName: "helper",
        packagePath: "packages/helper",
      },
    });

    assert.strictEqual(result.status, "conflict", JSON.stringify(result));
    assert.strictEqual(await readFile(userFile, "utf8"), "user bytes\n");
    assert.deepStrictEqual(await snapshotTree(targetRoot), before);
  });
});
