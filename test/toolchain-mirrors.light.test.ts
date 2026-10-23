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
import { afterEach, describe, it } from "node:test";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, templatePresets } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const temporaryDirectories: string[] = [];

function presetFor(packageName: string) {
  const preset = templatePresets.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(preset, `缺少公开预设：${packageName}`);
  return preset;
}

function workspaceGenerator() {
  return createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  });
}

async function createWorkspace() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-toolchain-mirror-"),
  );
  temporaryDirectories.push(directory);
  const repositoryRoot = path.join(directory, "demo");
  const generator = workspaceGenerator();
  const initialized = await generator.init({
    targetRoot: repositoryRoot,
    selection: {
      roots: [{ preset: presetFor("@ykdz/preset-ts-lib").identity }],
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
  return { generator, repositoryRoot };
}

async function snapshotTree(root: string): Promise<string> {
  const entries: { path: string; mode: number; content: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          mode: (await stat(filePath)).mode & 0o777,
          content: await readFile(filePath, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function addTsLibrary(
  generator: ReturnType<typeof workspaceGenerator>,
  repositoryRoot: string,
  leafName: string,
) {
  return await generator.add({
    repositoryRoot,
    preset: presetFor("@ykdz/preset-ts-lib").identity,
    creationInput: {
      leafName,
      packagePath: `packages/${leafName}`,
    },
  });
}

void it("公开加包规划不写入，并可在同进程提交", async () => {
  const { generator, repositoryRoot } = await createWorkspace();
  const before = await snapshotTree(repositoryRoot);
  const planned = await generator.planAdd({
    repositoryRoot,
    preset: presetFor("@ykdz/preset-ts-lib").identity,
    creationInput: { leafName: "planned", packagePath: "packages/planned" },
  });

  assert.equal(planned.status, "planned", JSON.stringify(planned));
  assert.deepEqual(await snapshotTree(repositoryRoot), before);
  assert.ok(planned.plan.mutations.length > 0);
  const manifestMutation = planned.plan.mutations.find(
    (mutation) => mutation.path === "packages/planned/package.json",
  );
  assert.ok(manifestMutation);
  assert.match(
    new TextDecoder().decode(manifestMutation.content),
    /@demo\/planned/u,
  );

  const committed = await generator.commitPlan(planned.plan);
  assert.equal(committed.status, "success", JSON.stringify(committed));
  assert.notDeepEqual(await snapshotTree(repositoryRoot), before);
});

void it("公开加包提交会拒绝规划后变化的相关事实", async () => {
  const { generator, repositoryRoot } = await createWorkspace();
  const planned = await generator.planAdd({
    repositoryRoot,
    preset: presetFor("@ykdz/preset-ts-lib").identity,
    creationInput: { leafName: "stale", packagePath: "packages/stale" },
  });

  assert.equal(planned.status, "planned", JSON.stringify(planned));
  const packagePath = path.join(repositoryRoot, "packages/stale");
  await mkdir(packagePath);
  await writeFile(path.join(packagePath, "package.json"), "consumer\n");

  const committed = await generator.commitPlan(planned.plan);

  assert.equal(committed.status, "conflict", JSON.stringify(committed));
  assert.match(JSON.stringify(committed), /规划后相关目标事实已变化/u);
  assert.match(JSON.stringify(committed), /@ykdz\/reference-ts-lib/u);
  assert.equal(
    await readFile(path.join(packagePath, "package.json"), "utf8"),
    "consumer\n",
  );
  assert.deepEqual(await readdir(packagePath), ["package.json"]);
});

void it("加包规划保留恢复记录时实际读取的生成元数据", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-toolchain-read-facts-"),
  );
  temporaryDirectories.push(directory);
  const targetRoot = path.join(directory, "demo");
  const baseStrategy = createDefaultWorkspaceStrategy<TsCliCreationInput>();
  const strategy: typeof baseStrategy = {
    ...baseStrategy,
    async prepareUpdate(update) {
      const context = await baseStrategy.prepareUpdate(update);
      await writeFile(
        path.join(targetRoot, ".template/generation.json"),
        "generation record changed after restore\n",
      );
      return context;
    },
  };
  const generator = createGenerator({ content: templateContent, strategy });
  const initialized = await generator.init({
    targetRoot,
    selection: {
      roots: [{ preset: presetFor("@ykdz/preset-ts-lib").identity }],
    },
    strategyInput: { repositoryName: "read-facts" },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));

  const planned = await generator.planAdd({
    repositoryRoot: targetRoot,
    preset: presetFor("@ykdz/preset-ts-lib").identity,
    creationInput: { leafName: "stale", packagePath: "packages/stale" },
  });

  assert.equal(planned.status, "conflict", JSON.stringify(planned));
  if (planned.status !== "conflict") return;
  assert.ok(
    planned.conflicts.some(
      (conflict) => conflict.path === ".template/generation.json",
    ),
  );
  assert.equal(
    await readFile(path.join(targetRoot, ".template/generation.json"), "utf8"),
    "generation record changed after restore\n",
  );
  await assert.rejects(
    readFile(path.join(targetRoot, "packages/stale/package.json")),
    { code: "ENOENT" },
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

void describe("Node 与 Rust 根工具链镜像", () => {
  void it("M1 初始化取根 Node 原值，漂移后协调一次且语义相等不再写入", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const manifestPath = path.join(repositoryRoot, "package.json");
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const manifest = await readJson<{ engines: { node: string } }>(
      manifestPath,
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
      runArgs?: unknown[];
    }>(devcontainerPath);
    assert.strictEqual(
      devcontainer.build.args.NODE_VERSION,
      manifest.engines.node,
    );

    const rootNode = "24.18.0";
    manifest.engines.node = rootNode;
    await writeJson(manifestPath, manifest);
    devcontainer.build.args.NODE_VERSION = "user-edited";
    devcontainer.runArgs = ["--init"];
    await writeJson(devcontainerPath, devcontainer);

    const added = await addTsLibrary(generator, repositoryRoot, "utilities");
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") throw new Error("加包应成功");
    assert.strictEqual(
      added.actions.filter(
        (action) => action.path === ".devcontainer/devcontainer.json",
      ).length,
      1,
    );
    const reconciled = await readJson<{
      build: { args: Record<string, unknown> };
      runArgs?: unknown[];
    }>(devcontainerPath);
    assert.strictEqual(reconciled.build.args.NODE_VERSION, rootNode);
    assert.deepStrictEqual(reconciled.runArgs, ["--init"]);

    const next = await addTsLibrary(generator, repositoryRoot, "helpers");
    assert.strictEqual(next.status, "success", JSON.stringify(next));
    if (next.status !== "success") throw new Error("第二次加包应成功");
    assert.strictEqual(
      next.actions.some(
        (action) => action.path === ".devcontainer/devcontainer.json",
      ),
      false,
    );
  });

  void it("协调时保留缺席的配置文件和 M1 键", async () => {
    const missingFile = await createWorkspace();
    const devcontainerPath = path.join(
      missingFile.repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    await rm(devcontainerPath);
    const afterMissingFile = await addTsLibrary(
      missingFile.generator,
      missingFile.repositoryRoot,
      "utilities",
    );
    assert.strictEqual(
      afterMissingFile.status,
      "success",
      JSON.stringify(afterMissingFile),
    );
    await assert.rejects(readFile(devcontainerPath));

    const missingKey = await createWorkspace();
    const missingKeyPath = path.join(
      missingKey.repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const configuration = await readJson<{
      build: { args: Record<string, unknown> };
    }>(missingKeyPath);
    delete configuration.build.args.NODE_VERSION;
    await writeJson(missingKeyPath, configuration);
    const afterMissingKey = await addTsLibrary(
      missingKey.generator,
      missingKey.repositoryRoot,
      "utilities",
    );
    assert.strictEqual(
      afterMissingKey.status,
      "success",
      JSON.stringify(afterMissingKey),
    );
    const retained = await readJson<{
      build: { args: Record<string, unknown> };
    }>(missingKeyPath);
    assert.strictEqual(
      Object.hasOwn(retained.build.args, "NODE_VERSION"),
      false,
    );
  });

  void it("M1 值类型错误时加包原子失败", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    devcontainer.build.args.NODE_VERSION = [];
    await writeJson(devcontainerPath, devcontainer);
    const before = await snapshotTree(repositoryRoot);

    const rejected = await addTsLibrary(generator, repositoryRoot, "utilities");
    assert.strictEqual(rejected.status, "conflict");
    if (rejected.status !== "conflict")
      throw new Error("配置类型冲突应阻止加包");
    assert.ok(
      rejected.conflicts.some((conflict) =>
        conflict.reason.includes("non-string"),
      ),
    );
    assert.strictEqual(await snapshotTree(repositoryRoot), before);
  });

  void it("Node 仓库首次加 Rust 建立 M5 根声明，后续加包保留用户修改", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const rustPreset = presetFor("@ykdz/preset-rust-bin");
    const first = await generator.add({
      repositoryRoot,
      preset: rustPreset.identity,
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });
    assert.strictEqual(first.status, "success", JSON.stringify(first));
    const toolchainPath = path.join(repositoryRoot, "rust-toolchain.toml");
    const initialToolchain = await readFile(toolchainPath, "utf8");
    const initialChannel = /^channel = "([^"]+)"$/mu.exec(
      initialToolchain,
    )?.[1];
    assert.ok(initialChannel);
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    assert.strictEqual(devcontainer.build.args.RUST_TOOLCHAIN, initialChannel);

    const customToolchain =
      '# local choice\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(toolchainPath, customToolchain);
    const second = await generator.add({
      repositoryRoot,
      preset: rustPreset.identity,
      creationInput: {
        leafName: "second-native",
        packagePath: "packages/second-native",
      },
    });
    assert.strictEqual(second.status, "success", JSON.stringify(second));
    assert.strictEqual(await readFile(toolchainPath, "utf8"), customToolchain);
    const updated = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    assert.strictEqual(updated.build.args.RUST_TOOLCHAIN, "nightly-2026-10-01");
  });
});
