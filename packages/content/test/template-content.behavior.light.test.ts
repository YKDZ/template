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

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import {
  templateContent,
  type TemplatePreset,
  type TemplateReferencePackage,
} from "@ykdz/template-content";
import { contentIdentityKey } from "@ykdz/template-core/content-identity";
import type { PackageCreationInput } from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";
import {
  createDefaultWorkspaceStrategy,
  type DefaultWorkspaceCreationInput,
} from "@ykdz/template-workspace/default-workspace-strategy";

type WorkspaceCreationInput = DefaultWorkspaceCreationInput<TsCliCreationInput>;

function requireReferenceMember(packageName: string): TemplateReferencePackage {
  const member = templateContent.find(
    (candidate): candidate is TemplateReferencePackage =>
      candidate.kind === "reference" &&
      candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少参考包：${packageName}`);
  return member;
}

function requirePresetMember(packageName: string): TemplatePreset {
  const member = templateContent.find(
    (candidate): candidate is TemplatePreset =>
      candidate.kind === "preset" &&
      candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少预设：${packageName}`);
  return member;
}

const libraryMember = requireReferenceMember("@ykdz/reference-ts-lib");
const tsCliMember = requireReferenceMember("@ykdz/reference-ts-cli");
const npmPublicationMember = requireReferenceMember(
  "@ykdz/reference-npm-publication",
);
const rustBinMember = requireReferenceMember("@ykdz/reference-rust-bin");
const vueAppMember = requireReferenceMember("@ykdz/reference-vue-app");
const library = libraryMember.definition;
const tsLibPreset = requirePresetMember("@ykdz/preset-ts-lib");
const tsCliPreset = requirePresetMember("@ykdz/preset-ts-cli");
const rustBinPreset = requirePresetMember("@ykdz/preset-rust-bin");
const vikeAppPreset = requirePresetMember("@ykdz/preset-vike-app");
const vueAppPreset = requirePresetMember("@ykdz/preset-vue-app");

function createContentTestStrategy<
  CreationInput extends PackageCreationInput = TsCliCreationInput,
>() {
  return createDefaultWorkspaceStrategy<CreationInput>({
    cliPublicationReference: npmPublicationMember.definition,
  });
}

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
  void it("按路径顺序聚合诊断制品并原子拒绝用户覆盖", async () => {
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<TsCliCreationInput>(),
    });
    const rendered: string[] = [];

    for (const names of [
      ["web", "admin"],
      ["admin", "web"],
    ] as const) {
      const targetRoot = await createTargetRoot(
        "template-content-diagnostics-",
      );
      const initialized = await generator.init({
        targetRoot,
        selection: { roots: [{ preset: tsLibPreset.identity }] },
        strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );
      const workflowPath = path.join(targetRoot, ".github/workflows/check.yml");
      const originalWorkflow = await readFile(workflowPath, "utf8");
      await writeFile(workflowPath, `# 用户工作流策略\n${originalWorkflow}`);

      if (rendered.length === 0) {
        const userStep =
          "      - name: Upload User-owned diagnostics\n        run: echo user-owned\n";
        const customizedWorkflow = (
          await readFile(workflowPath, "utf8")
        ).replace(
          "      - name: Run Heavy Check\n        id: run-heavy-check\n        run: node --conditions=source scripts/task-gates.ts check:heavy\n",
          `      - name: Run Heavy Check\n        id: run-heavy-check\n        run: node --conditions=source scripts/task-gates.ts check:heavy\n${userStep}`,
        );
        assert.notStrictEqual(
          customizedWorkflow,
          await readFile(workflowPath, "utf8"),
        );
        await writeFile(workflowPath, customizedWorkflow);
        const beforeConflict = await snapshotTree(targetRoot);
        const conflict = await generator.add({
          repositoryRoot: targetRoot,
          preset: vueAppPreset.identity,
          creationInput: { leafName: names[0] },
        });
        assert.strictEqual(
          conflict.status,
          "conflict",
          JSON.stringify(conflict),
        );
        assert.strictEqual(await snapshotTree(targetRoot), beforeConflict);
        await writeFile(workflowPath, customizedWorkflow.replace(userStep, ""));
      }

      for (const leafName of names) {
        const added = await generator.add({
          repositoryRoot: targetRoot,
          preset: vueAppPreset.identity,
          creationInput: { leafName },
        });
        assert.strictEqual(added.status, "success", JSON.stringify(added));
      }

      const workflow = await readFile(workflowPath, "utf8");
      rendered.push(workflow);
      assert.match(workflow, /^# 用户工作流策略\n/u);
      assert.ok(
        workflow.includes(
          "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/admin\n            apps/web",
        ),
      );
      assert.strictEqual(
        workflow.match(/PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: \|-/gu)?.length,
        1,
      );
      assert.strictEqual(
        workflow.match(/Upload Root Check diagnostics/gu)?.length,
        1,
      );
    }

    assert.strictEqual(rendered[0], rendered[1]);
  });

  void it("非诊断加包不读取未变化的工作流目标", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-no-diagnostics-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<TsCliCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsLibPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const workflowPath = path.join(targetRoot, ".github/workflows/check.yml");
    await rm(workflowPath);
    await mkdir(workflowPath);
    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: tsLibPreset.identity,
      creationInput: { leafName: "utilities" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.ok((await stat(workflowPath)).isDirectory());
  });

  void it("只用集合成员完成库初始化及其公开共享依赖展开", async () => {
    const targetRoot = await createTargetRoot("template-content-ts-lib-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsLibPreset.identity }] },
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
      ["packages/lib", "packages/tooling-config"].toSorted(),
    );
  });

  void it("同次正式投影生成 TODO 并让 add 沿用该选择", async () => {
    const targetRoot = await createTargetRoot("template-content-todo-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
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
      contentIdentity: libraryMember.identity,
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

  void it("正式加包保留消费者定制的编辑器设置", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-editor-customization-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const settingsPath = path.join(targetRoot, ".vscode/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const customizedSettings = {
      ...settings,
      "editor.formatOnSave": false,
      "editor.tabSize": 2,
    };
    await writeFile(
      settingsPath,
      `${JSON.stringify(customizedSettings, null, 2)}\n`,
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: libraryMember.identity,
      creationInput: { packagePath: "packages/provider" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.deepStrictEqual(
      JSON.parse(await readFile(settingsPath, "utf8")),
      customizedSettings,
    );
  });

  void it("linkFrom 让现有 consumer 在正式加包事务中依赖新 provider", async () => {
    const targetRoot = await createTargetRoot("template-content-link-from-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
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
      contentIdentity: libraryMember.identity,
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
        (item) =>
          contentIdentityKey(item.contentIdentity) ===
          contentIdentityKey(libraryMember.identity),
      )?.creationInput,
      creationInput,
    );
  });

  void it("linkFrom 按同次正式贡献的 provider manifest 校验新端点", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-contribution-",
    );
    const providerDefinition = {
      ...library,
      manifest: { ...library.manifest, exports: {} },
      contribute(options: Parameters<typeof library.contribute>[0]) {
        const contribution = library.contribute(options);
        return {
          ...contribution,
          manifest: { ...contribution.manifest, exports: {} },
          exposure: { ...contribution.exposure, exports: {} },
        };
      },
    };
    const provider = {
      ...libraryMember,
      identity: { ...libraryMember.identity, namespace: "test-content" },
      alias: "manifest-transformed-provider",
      definition: providerDefinition,
    };
    const generator = createGenerator({
      content: [...templateContent, provider],
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const before = await snapshotTree(targetRoot);
    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: provider.identity,
      creationInput: {
        leafName: "provider",
        packagePath: "packages/provider",
        linkFrom: ["packages/cli"],
      },
    });

    assert.strictEqual(result.status, "input-invalid", JSON.stringify(result));
    if (result.status === "input-invalid") {
      assert.deepStrictEqual(result.issues, [{ code: "UNSUPPORTED_LINK" }]);
    }
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("重复已存在的 provider 时拒绝补交缺失的 linkFrom", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-repeat-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
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
      contentIdentity: libraryMember.identity,
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
      contentIdentity: libraryMember.identity,
      creationInput: {
        ...originalInput,
        linkFrom: ["packages/cli"],
      } satisfies WorkspaceCreationInput,
    });

    assert.strictEqual(retry.status, "conflict", JSON.stringify(retry));
    if (retry.status !== "conflict") throw new Error("缺失链接重试应冲突");
    assert.deepStrictEqual(retry.ownerConflict, {
      code: "MISSING_LINK",
      facts: {
        existing: {
          name: "@demo/provider",
          path: "packages/provider",
          role: "shared-library",
        },
        requested: {
          name: "@demo/provider",
          path: "packages/provider",
          role: "shared-library",
        },
        missingLink: {
          consumerPackagePath: "packages/cli",
          providerPackagePath: "packages/provider",
        },
      },
    });
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

    const identityRetry = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: libraryMember.identity,
      creationInput: {
        leafName: "other",
        packagePath: "packages/provider",
      } satisfies WorkspaceCreationInput,
    });
    assert.strictEqual(
      identityRetry.status,
      "conflict",
      JSON.stringify(identityRetry),
    );
    if (identityRetry.status !== "conflict") {
      throw new Error("包身份占用应返回冲突");
    }
    assert.deepStrictEqual(identityRetry.identityConflict, {
      existing: {
        name: "@demo/provider",
        path: "packages/provider",
        role: "shared-library",
      },
      requested: {
        name: "@demo/other",
        path: "packages/provider",
        role: "shared-library",
      },
    });
    assert.deepStrictEqual(identityRetry.actions, []);
    assert.strictEqual(await readFile(recordPath, "utf8"), before.record);
    assert.strictEqual(await readFile(blueprintPath, "utf8"), before.blueprint);
  });

  void it("linkFrom 引用未知 consumer 时返回 input-invalid 且不写入", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-unknown-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: libraryMember.identity,
      creationInput: {
        packagePath: "packages/provider",
        linkFrom: ["packages/missing"],
      } satisfies WorkspaceCreationInput,
    });

    assert.deepStrictEqual(result, {
      status: "input-invalid",
      issues: [{ code: "UNKNOWN_LINK_FROM" }],
    });
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("加包返回默认 owner 的版本声明诊断并保持目标不变", async () => {
    const cases = [
      {
        field: "engines.node" as const,
        actual: '实际收到 ">=22"',
        suggestion: "请先修改根 package.json 的 engines.node 声明再加包。",
      },
      {
        field: "packageManager" as const,
        actual: "实际收到 null",
        suggestion: "请先修改根 package.json 的 packageManager 声明再加包。",
      },
    ];

    for (const testCase of cases) {
      const targetRoot = await createTargetRoot(
        `template-content-add-diagnostic-${testCase.field.replaceAll(".", "-")}-`,
      );
      const generator = createGenerator({
        content: templateContent,
        strategy: createContentTestStrategy<WorkspaceCreationInput>(),
      });
      const initialized = await generator.init({
        targetRoot,
        selection: { roots: [{ preset: tsCliPreset.identity }] },
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

      const rootManifestPath = path.join(targetRoot, "package.json");
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as Record<string, unknown>;
      if (testCase.field === "engines.node") {
        rootManifest.engines = { node: ">=22" };
      } else {
        delete rootManifest.packageManager;
      }
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      const before = await snapshotTree(targetRoot);

      const result = await generator.add({
        repositoryRoot: targetRoot,
        contentIdentity: libraryMember.identity,
        creationInput: { leafName: "diagnostic-package" },
      });

      assert.strictEqual(result.status, "operation-failure");
      if (result.status !== "operation-failure") {
        throw new Error("无效的根版本声明应返回操作失败");
      }
      assert.strictEqual(result.phase, "metadata");
      assert.match(result.error.message, /加包需要目标仓库根 package\.json/u);
      assert.ok(result.error.message.includes(testCase.actual));
      assert.deepStrictEqual(result.error.diagnostic, {
        message: result.error.message,
        suggestion: testCase.suggestion,
      });
      assert.strictEqual(await snapshotTree(targetRoot), before);
    }
  });

  void it("linkFrom 拒绝已失去 Node package-name import 能力的当前 consumer", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-current-",
    );
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: tsCliPreset.identity }] },
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
      contentIdentity: libraryMember.identity,
      creationInput,
    });

    assert.deepStrictEqual(result, {
      status: "input-invalid",
      issues: [{ code: "UNSUPPORTED_LINK" }],
    });
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

  void it("从同一集合初始化 Rust 二进制程序", async () => {
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<WorkspaceCreationInput>(),
    });
    const rustRoot = await createTargetRoot("template-content-rust-bin-");
    const result = await generator.init({
      targetRoot: rustRoot,
      selection: { roots: [{ preset: rustBinPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const manifest = JSON.parse(
      await readFile(path.join(rustRoot, "packages/app/package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.ok(!Object.hasOwn(manifest, "files"));
    assert.match(
      await readFile(path.join(rustRoot, "packages/app/Cargo.toml"), "utf8"),
      /name = "app"/u,
    );
  });

  void it("从同一集合初始化 Vike 应用并投影数据库与部署准备", async () => {
    const targetRoot = await createTargetRoot("template-content-vike-app-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createContentTestStrategy<TsCliCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: vikeAppPreset.identity }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const collisionPath = path.join(targetRoot, "packages/lib");
    await mkdir(collisionPath, { recursive: true });
    await writeFile(path.join(collisionPath, "unowned.txt"), "用户内容\n");
    const beforeConflict = await snapshotTree(targetRoot);
    const conflict = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: libraryMember.identity,
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
    const [webManifest, databaseManifestBeforeAdd, migrationsManifest] =
      existingVikeManifests.map((manifest) => JSON.parse(manifest)) as [
        { files: string[] },
        { files: string[] },
        { files: string[] },
      ];
    assert.deepStrictEqual(webManifest.files, ["dist"]);
    assert.deepStrictEqual(databaseManifestBeforeAdd.files, ["dist"]);
    assert.deepStrictEqual(migrationsManifest.files, [
      "drizzle.config.ts",
      "drizzle/migrations",
    ]);

    for (const addition of [
      { contentIdentity: libraryMember.identity },
      { contentIdentity: tsCliMember.identity },
      { contentIdentity: rustBinMember.identity },
      {
        contentIdentity: vueAppMember.identity,
        creationInput: { leafName: "vue" },
      },
    ]) {
      const replayGenerator = createGenerator({
        content: templateContent,
        strategy: createContentTestStrategy<TsCliCreationInput>(),
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
    const checkWorkflow = await readFile(
      path.join(targetRoot, ".github/workflows/check.yml"),
      "utf8",
    );
    assert.ok(
      checkWorkflow.includes(
        "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS: |-\n            apps/vue",
      ),
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
        (definition) => definition.path === "packages/tooling-config",
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
