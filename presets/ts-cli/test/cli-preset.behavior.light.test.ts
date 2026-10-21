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

import { projectPublicationWorkspace } from "@ykdz/reference-npm-publication/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { createContentIndex } from "@ykdz/template-core/content-identity";
import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-ts-cli/template",
    "@ykdz/reference-npm-publication/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-rust-bin/template",
    "@ykdz/reference-tooling-config/template",
    "@ykdz/preset-ts-cli/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const contentIndex = createContentIndex(content);
const cli = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-ts-cli",
    exportPath: "./template",
  },
  "reference",
);
const library = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-ts-lib",
    exportPath: "./template",
  },
  "reference",
);
const rust = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-rust-bin",
    exportPath: "./template",
  },
  "reference",
);
const preset = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/preset-ts-cli",
    exportPath: "./template",
  },
  "preset",
);
const temporaryDirectories: string[] = [];

async function createTargetRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "demo");
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function snapshotTree(root: string): Promise<string> {
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
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push({
          path: file,
          kind: "directory",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: "",
        });
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          kind: "file",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: (await readFile(filePath)).toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify({
    rootMode: (await stat(root)).mode & 0o777,
    entries,
  });
}

function generator() {
  return createGenerator({
    content,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>({
      project: projectPublicationWorkspace,
    }),
  });
}

const strategyInput = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

void describe("TypeScript CLI 公开组合预设", () => {
  void it("默认 internal，显式发布按实例恢复并复用共享工具", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-preset-");
    const initialized = await generator().init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    const manifest = async (directory: string) =>
      JSON.parse(
        await readFile(
          path.join(targetRoot, directory, "package.json"),
          "utf8",
        ),
      );
    assert.equal((await manifest("packages/cli")).private, true);
    const customizedRoot = await manifest(".");
    customizedRoot.scripts.notes = "echo 维护者说明";
    await writeFile(
      path.join(targetRoot, "package.json"),
      JSON.stringify(customizedRoot),
    );
    const published = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      configuration: { publication: true },
      creationInput: {
        leafName: "public-cli",
        packagePath: "packages/public-cli",
      },
    });
    assert.equal(published.status, "success", JSON.stringify(published));
    const root = await manifest(".");
    assert.equal(root.scripts.notes, "echo 维护者说明");
    assert.equal(root.devDependencies["@demo/npm-publication"], "workspace:*");
    assert.equal((await manifest("packages/public-cli")).private, false);
    const internal = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "internal-cli",
        packagePath: "packages/internal-cli",
      },
    });
    assert.equal(internal.status, "success", JSON.stringify(internal));
    assert.equal((await manifest("packages/internal-cli")).private, true);
    assert.equal(
      (await manifest("packages/internal-cli")).scripts["publication:prepare"],
      undefined,
    );
    const second = await generator().add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      configuration: { publication: true },
      creationInput: {
        leafName: "public-lib",
        packagePath: "packages/public-lib",
      },
    });
    assert.equal(second.status, "success", JSON.stringify(second));
    const records = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    );
    assert.equal(
      records.packages.filter(
        (record: { contentIdentity: typeof cli.identity }) =>
          record.contentIdentity.packageName ===
          "@ykdz/reference-npm-publication",
      ).length,
      1,
    );
    assert.deepEqual(
      records.packages
        .filter(
          (record: { contentIdentity: typeof cli.identity }) =>
            record.contentIdentity.packageName === "@ykdz/reference-ts-cli",
        )
        .map((record: { configuration: unknown }) => record.configuration),
      [{ publication: false }, { publication: true }, { publication: false }],
    );
    assert.equal(
      (await manifest(".")).devDependencies["@demo/npm-publication"],
      "workspace:*",
    );
  });

  void it("发布拥有者与另一声明来源冲突时在初始化写入前诊断双方", async () => {
    const targetRoot = await createTargetRoot(
      "template-publication-source-conflict-",
    );
    const generated = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>({
        project(options) {
          return [
            ...projectPublicationWorkspace(options),
            {
              kind: "shared-root-files",
              source: "consumer#publication",
              manifest: {
                scripts: {
                  "publication:artifact": "node consumer-artifact.ts",
                },
              },
            },
          ];
        },
      }),
    });
    const result = await generated.init({
      targetRoot,
      selection: {
        roots: [
          { preset: preset.identity, configuration: { publication: true } },
        ],
      },
      strategyInput,
    });
    assert.equal(result.status, "operation-failure", JSON.stringify(result));
    if (result.status !== "operation-failure")
      throw new Error("应在写入前拒绝来源冲突");
    assert.match(
      result.error.message,
      /@ykdz\/reference-npm-publication#\.\/template/u,
    );
    assert.match(result.error.message, /consumer#publication/u);
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("发布共享根脚本与消费者冲突时拒绝整次加包", async () => {
    const targetRoot = await createTargetRoot("template-publication-conflict-");
    const initialized = await generator().init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    const manifestPath = path.join(targetRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts["publication:artifact"] = "node custom-publication.ts";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await snapshotTree(targetRoot);
    const result = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      configuration: { publication: true },
      creationInput: { leafName: "public-cli" },
    });
    assert.equal(result.status, "conflict", JSON.stringify(result));
    if (result.status !== "conflict") throw new Error("应拒绝冲突");
    assert.ok(
      result.conflicts.some(
        (conflict) => conflict.location === "/scripts/publication:artifact",
      ),
    );
    assert.equal(await snapshotTree(targetRoot), before);
  });

  void it("直接选择 CLI 原生参考包时仍按私有包处理", async () => {
    const targetRoot = await createTargetRoot(
      "template-ts-cli-private-reference-",
    );
    const result = await generator().init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "cli", contentIdentity: cli.identity }],
      },
      strategyInput,
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ).engines.node,
      ">=24",
    );
    await assert.rejects(
      stat(
        path.join(
          targetRoot,
          "scripts/npm-publication/publication.config.json",
        ),
      ),
      { code: "ENOENT" },
    );
  });

  void it("库连接由实际 exports 构建并在真实普通加包回放时校验当前根导出", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-link-preset-");
    const generated = generator();
    const initialized = await generated.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: library.identity }],
      },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const linked = await generated.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { linkToNodeIdentity: "library" },
    });
    assert.strictEqual(linked.status, "success", JSON.stringify(linked));
    if (linked.status !== "success") return;
    assert.deepStrictEqual(linked.blueprint.packageLinkIntents, [
      {
        consumerPackagePath: "packages/cli",
        providerPackagePath: "packages/lib",
      },
    ]);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ).exports["."],
      {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ).dependencies["@demo/lib"],
      "workspace:*",
    );

    const ordinaryAdd = await generated.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "next", packagePath: "packages/next" },
    });
    assert.strictEqual(
      ordinaryAdd.status,
      "success",
      JSON.stringify(ordinaryAdd),
    );

    const providerPath = path.join(targetRoot, "packages/lib/package.json");
    const providerManifest = JSON.parse(
      await readFile(providerPath, "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };
    delete (providerManifest.exports["."] as Record<string, unknown>).default;
    await writeFile(
      providerPath,
      JSON.stringify(providerManifest, null, 2) + "\n",
    );
    const beforeRejectedAdd = await snapshotTree(targetRoot);
    const rejected = await generated.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        leafName: "after-broken-link",
        packagePath: "packages/after-broken-link",
      },
    });
    assert.strictEqual(rejected.status, "operation-failure");
    assert.match(
      rejected.status === "operation-failure" ? rejected.error.message : "",
      /Package Link provider packages\/lib does not expose an importable package root/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), beforeRejectedAdd);
  });

  void it("缺失绑定和不支持的 Rust 连接均在提交前拒绝", async () => {
    const missingRoot = await createTargetRoot(
      "template-ts-cli-missing-binding-",
    );
    await mkdir(missingRoot, { recursive: true });
    const missing = await generator().init({
      targetRoot: missingRoot,
      selection: {
        roots: [
          {
            preset: preset.identity,
            creationInput: {
              variant: "private",
              linkToNodeIdentity: "missing",
            },
          },
        ],
      },
      strategyInput,
    });
    assert.strictEqual(missing.status, "operation-failure");
    assert.deepStrictEqual(await readdir(missingRoot), []);

    const unsupportedRoot = await createTargetRoot(
      "template-ts-cli-unsupported-link-",
    );
    await mkdir(unsupportedRoot, { recursive: true });
    const unsupported = await generator().init({
      targetRoot: unsupportedRoot,
      selection: {
        roots: [
          { nodeIdentity: "rust", contentIdentity: rust.identity },
          {
            preset: preset.identity,
            creationInput: { variant: "private", linkToNodeIdentity: "rust" },
          },
        ],
      },
      strategyInput,
    });
    assert.strictEqual(unsupported.status, "operation-failure");
    assert.deepStrictEqual(await readdir(unsupportedRoot), []);
  });

  void it("真实文件冲突拒绝 CLI 加包且目标字节权限不变", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-conflict-");
    const generated = generator();
    const initialized = await generated.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const conflictingFile = path.join(
      targetRoot,
      "packages/private-cli/package.json",
    );
    await mkdir(path.dirname(conflictingFile), { recursive: true });
    await writeFile(conflictingFile, '{"name":"preserve"}\n');
    const before = await snapshotTree(targetRoot);
    const result = await generated.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "private-cli",
        packagePath: "packages/private-cli",
      },
    });

    assert.strictEqual(result.status, "conflict", JSON.stringify(result));
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });
});

void it("已有内部实例正式开启发布保持身份和定制，第二实例复用并可幂等重试", async () => {
  const targetRoot = await createTargetRoot("template-configure-publication-");
  const initialized = await generator().init({
    targetRoot,
    selection: { roots: [{ preset: preset.identity }] },
    strategyInput,
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  const original = initialized.generationRecord.packages.find(
    (record) => record.contentIdentity.packageName === "@ykdz/reference-ts-cli",
  )!;
  const originalDefinition = initialized.blueprint.packages.find(
    (item) => item.packageDefinitionId === original.packageDefinitionId,
  )!;
  const manifestPath = path.join(targetRoot, "packages/cli/package.json");
  const customized = JSON.parse(await readFile(manifestPath, "utf8"));
  customized.scripts.notes = "echo 维护者的命令";
  customized.description = "维护者的包说明";
  await writeFile(manifestPath, JSON.stringify(customized));
  const before = await snapshotTree(targetRoot);
  const preview = await generator().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: original.packageDefinitionId,
    configuration: { publication: true },
    dryRun: true,
  });
  assert.equal(preview.status, "success", JSON.stringify(preview));
  assert.equal(await snapshotTree(targetRoot), before);
  const configured = await generator().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: original.packageDefinitionId,
    configuration: { publication: true },
  });
  assert.equal(configured.status, "success", JSON.stringify(configured));
  if (configured.status !== "success") return;
  const current = configured.generationRecord.packages.find(
    (record) => record.packageDefinitionId === original.packageDefinitionId,
  )!;
  assert.deepEqual(
    {
      ...current,
      configuration: original.configuration,
      bindings: original.bindings,
    },
    original,
  );
  assert.deepEqual(
    configured.blueprint.packages.find(
      (item) => item.packageDefinitionId === original.packageDefinitionId,
    ),
    originalDefinition,
  );
  const actual = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(actual.private, false);
  assert.equal(actual.devDependencies["@demo/npm-publication"], "workspace:*");
  assert.equal(actual.description, "维护者的包说明");
  assert.equal(actual.scripts.notes, "echo 维护者的命令");
  const added = await generator().add({
    repositoryRoot: targetRoot,
    contentIdentity: library.identity,
    creationInput: { leafName: "later" },
  });
  assert.equal(added.status, "success", JSON.stringify(added));
  if (added.status !== "success") return;
  const later = added.generationRecord.packages.find(
    (record) => record.creationInput?.leafName === "later",
  )!;
  const second = await generator().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: later.packageDefinitionId,
    configuration: { publication: true },
  });
  assert.equal(second.status, "success", JSON.stringify(second));
  if (second.status !== "success") return;
  assert.equal(
    second.generationRecord.packages.filter(
      (record) =>
        record.contentIdentity.packageName ===
        "@ykdz/reference-npm-publication",
    ).length,
    1,
  );
  const snapshot = await snapshotTree(targetRoot);
  const repeated = await generator().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: later.packageDefinitionId,
    configuration: { publication: true },
  });
  assert.equal(repeated.status, "success", JSON.stringify(repeated));
  if (repeated.status !== "success") return;
  assert.deepEqual(repeated.actions, []);
  assert.equal(await snapshotTree(targetRoot), snapshot);
});

void it("已有实例开启发布的消费者冲突和未知实例均保留全部字节权限", async () => {
  const targetRoot = await createTargetRoot("template-configure-conflict-");
  const initialized = await generator().init({
    targetRoot,
    selection: { roots: [{ preset: preset.identity }] },
    strategyInput,
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  const target = initialized.generationRecord.packages.find(
    (record) => record.contentIdentity.packageName === "@ykdz/reference-ts-cli",
  )!;
  const manifestPath = path.join(targetRoot, "package.json");
  const root = JSON.parse(await readFile(manifestPath, "utf8"));
  root.scripts["publication:artifact"] = "node consumer-artifact.ts";
  await writeFile(manifestPath, JSON.stringify(root));
  const before = await snapshotTree(targetRoot);
  for (const dryRun of [true, false]) {
    const conflicting = await generator().configure({
      repositoryRoot: targetRoot,
      packageDefinitionId: target.packageDefinitionId,
      configuration: { publication: true },
      dryRun,
    });
    assert.equal(conflicting.status, "conflict", JSON.stringify(conflicting));
    assert.equal(await snapshotTree(targetRoot), before);
  }
  const unknown = await generator().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: `package-${"0".repeat(64)}`,
    configuration: { publication: true },
  });
  assert.equal(unknown.status, "input-invalid", JSON.stringify(unknown));
  assert.equal(await snapshotTree(targetRoot), before);
});

void it("配置已有实例的声明来源冲突列明双方并在写入前拒绝", async () => {
  const targetRoot = await createTargetRoot(
    "template-configure-source-conflict-",
  );
  const create = () =>
    createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>({
        project(options) {
          return [
            ...projectPublicationWorkspace(options),
            {
              kind: "shared-root-files",
              source: "consumer#publication",
              manifest: {
                scripts: {
                  "publication:artifact": "node consumer-artifact.ts",
                },
              },
            },
          ];
        },
      }),
    });
  const initialized = await create().init({
    targetRoot,
    selection: { roots: [{ preset: preset.identity }] },
    strategyInput,
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));
  if (initialized.status !== "success") return;
  const target = initialized.generationRecord.packages.find(
    (record) => record.contentIdentity.packageName === "@ykdz/reference-ts-cli",
  )!;
  const before = await snapshotTree(targetRoot);
  const result = await create().configure({
    repositoryRoot: targetRoot,
    packageDefinitionId: target.packageDefinitionId,
    configuration: { publication: true },
  });
  assert.equal(result.status, "operation-failure", JSON.stringify(result));
  if (result.status !== "operation-failure") return;
  assert.match(
    result.error.message,
    /@ykdz\/reference-npm-publication#\.\/template/u,
  );
  assert.match(result.error.message, /consumer#publication/u);
  assert.equal(await snapshotTree(targetRoot), before);
});
