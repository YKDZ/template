import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { preset as rustBinPreset } from "@ykdz/preset-rust-bin/template";
import { preset as tsCliPreset } from "@ykdz/preset-ts-cli/template";
import { preset } from "@ykdz/preset-ts-lib/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import {
  createDefaultWorkspaceStrategy,
  type DefaultWorkspaceCreationInput,
} from "@ykdz/template-workspace/default-workspace-strategy";

type WorkspaceCreationInput = DefaultWorkspaceCreationInput<TsCliCreationInput>;

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

void describe("公开模板内容集合", () => {
  void it("只用集合成员完成库初始化及其公开共享依赖展开", async () => {
    const targetRoot = await createTargetRoot("template-content-ts-lib-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") throw new Error("初始化应成功");
    assert.ok(result.projection !== null);
    assert.strictEqual(
      result.projection.operations.some(
        (operation) =>
          operation.kind !== "setExecutable" && operation.to === "TODO.md",
      ),
      false,
    );
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      ["packages/lib", "packages/typescript-config"].toSorted(),
    );
  });

  void it("同次正式投影生成 TODO 并让 add 沿用该选择", async () => {
    const targetRoot = await createTargetRoot("template-content-todo-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
        todo: true,
      },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") throw new Error("初始化应成功");
    assert.ok(initialized.projection !== null);
    const todoOperation = initialized.projection.operations.find(
      (operation) =>
        operation.kind === "writeText" && operation.to === "TODO.md",
    );
    assert.ok(todoOperation?.kind === "writeText");
    assert.deepStrictEqual(
      initialized.projection.ownerFacts?.nextSteps.map(
        ({ display }) => display,
      ),
      ["pnpm install", "pnpm run fix", "pnpm run check"],
    );
    assert.strictEqual(
      (initialized.generationRecord.strategyState as { todo: boolean }).todo,
      true,
    );
    assert.strictEqual(
      todoOperation.text,
      await readFile(path.join(targetRoot, "TODO.md"), "utf8"),
    );
    assert.deepStrictEqual(initialized.projection.ownerFacts?.publication, {
      candidate: { name: "@demo/cli", path: "packages/cli" },
      setup: { command: "./scripts/npm-publication-setup/setup.sh" },
    });
    assert.strictEqual(
      initialized.projection.ownerFacts?.container.dockerfileText,
      await readFile(path.join(targetRoot, ".devcontainer/Dockerfile"), "utf8"),
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { packagePath: "packages/provider" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") throw new Error("加包应成功");
    assert.ok(added.projection !== null);
    assert.strictEqual(
      (added.generationRecord.strategyState as { todo: boolean }).todo,
      true,
    );
    assert.strictEqual(
      added.projection.operations.some(
        (operation) =>
          operation.kind === "writeText" && operation.to === "TODO.md",
      ),
      true,
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "TODO.md"), "utf8"),
      todoOperation.text,
    );
  });

  void it("linkFrom 让现有 consumer 在正式加包事务中依赖新 provider", async () => {
    const targetRoot = await createTargetRoot("template-content-link-from-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const creationInput = {
      leafName: "provider",
      packagePath: "packages/provider",
      linkFrom: ["packages/cli"],
    } satisfies WorkspaceCreationInput;
    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput,
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") throw new Error("加包应成功");
    assert.ok(result.projection !== null);
    assert.deepStrictEqual(result.blueprint.packageLinkIntents, [
      {
        consumerPackagePath: "packages/cli",
        providerPackagePath: "packages/provider",
      },
    ]);
    const consumerManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/cli/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(
      consumerManifest.dependencies["@demo/provider"],
      "workspace:*",
    );
    assert.deepStrictEqual(
      result.generationRecord.packages.find(
        (item) => item.contentIdentity === library.identity,
      )?.creationInput,
      creationInput,
    );
  });

  void it("重复已存在的 provider 时拒绝补交缺失的 linkFrom", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-repeat-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const originalInput = {
      leafName: "provider",
      packagePath: "packages/provider",
    } satisfies WorkspaceCreationInput;
    const created = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: originalInput,
    });
    assert.strictEqual(created.status, "success", JSON.stringify(created));

    const recordPath = path.join(targetRoot, ".template/generation.json");
    const blueprintPath = path.join(targetRoot, ".template/blueprint.json");
    const consumerManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const before = {
      record: await readFile(recordPath, "utf8"),
      blueprint: await readFile(blueprintPath, "utf8"),
      consumerManifest: await readFile(consumerManifestPath, "utf8"),
      providerManifest: await readFile(
        path.join(targetRoot, "packages/provider/package.json"),
        "utf8",
      ),
    };
    const retry = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        ...originalInput,
        linkFrom: ["packages/cli"],
      } satisfies WorkspaceCreationInput,
    });

    assert.strictEqual(retry.status, "conflict", JSON.stringify(retry));
    if (retry.status !== "conflict") throw new Error("缺失链接重试应冲突");
    assert.match(retry.reason, /不能接受不同的加包输入/u);
    assert.deepStrictEqual(retry.actions, []);
    assert.strictEqual(await readFile(recordPath, "utf8"), before.record);
    assert.strictEqual(await readFile(blueprintPath, "utf8"), before.blueprint);
    assert.strictEqual(
      await readFile(consumerManifestPath, "utf8"),
      before.consumerManifest,
    );
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, "packages/provider/package.json"),
        "utf8",
      ),
      before.providerManifest,
    );
    assert.strictEqual(
      JSON.parse(before.consumerManifest).dependencies["@demo/provider"],
      undefined,
    );
  });

  void it("linkFrom 拒绝已失去 Node package-name import 能力的当前 consumer", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-current-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const consumerManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const currentManifest = JSON.parse(
      await readFile(consumerManifestPath, "utf8"),
    ) as Record<string, unknown>;
    currentManifest.type = "commonjs";
    const changedCurrentManifest = `${JSON.stringify(currentManifest, null, 2)}\n`;
    await writeFile(consumerManifestPath, changedCurrentManifest);
    const blueprintPath = path.join(targetRoot, ".template/blueprint.json");
    const blueprintBefore = await readFile(blueprintPath, "utf8");
    const creationInput = {
      packagePath: "packages/provider",
      linkFrom: ["packages/cli"],
    } satisfies WorkspaceCreationInput;

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput,
    });

    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    assert.strictEqual(
      await readFile(consumerManifestPath, "utf8"),
      changedCurrentManifest,
    );
    assert.strictEqual(await readFile(blueprintPath, "utf8"), blueprintBefore);
    await assert.rejects(
      readFile(path.join(targetRoot, "packages/provider/package.json")),
      {
        code: "ENOENT",
      },
    );
  });

  void it("从同一集合初始化 CLI 发布候选和 Rust 二进制程序", async () => {
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<WorkspaceCreationInput>(),
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
});
