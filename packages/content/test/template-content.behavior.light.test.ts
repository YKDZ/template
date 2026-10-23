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
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

type WorkspaceCreationInput = TsCliCreationInput & {
  readonly leafName?: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
};

type PackageLinkIssue =
  | { readonly kind: "unknown-consumer"; readonly path: string }
  | {
      readonly kind: "unsupported-link";
      readonly consumerPath: string;
      readonly providerPath: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function packageLinkIssue(value: unknown): PackageLinkIssue | undefined {
  const error = record(record(value)?.error);
  const issue = record(error?.packageLinkIssue);
  if (issue?.kind === "unknown-consumer" && typeof issue.path === "string") {
    return { kind: issue.kind, path: issue.path };
  }
  if (
    issue?.kind === "unsupported-link" &&
    typeof issue.consumerPath === "string" &&
    typeof issue.providerPath === "string"
  ) {
    return {
      kind: issue.kind,
      consumerPath: issue.consumerPath,
      providerPath: issue.providerPath,
    };
  }
  return undefined;
}

function rootToolchainIssue(value: unknown): string | undefined {
  const issue = record(record(record(value)?.error)?.rootToolchainIssue);
  return issue !== undefined && typeof issue.kind === "string"
    ? issue.kind
    : undefined;
}

function packageIdentityIssueKinds(
  value: unknown,
): readonly { readonly kind: string; readonly field?: string }[] {
  const issues = record(record(value)?.error)?.packageIdentityIssues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issueValue) => {
    const issue = record(issueValue);
    if (issue === undefined || typeof issue.kind !== "string") return [];
    return [
      {
        kind: issue.kind,
        ...(typeof issue.field === "string" ? { field: issue.field } : {}),
      },
    ];
  });
}

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
const rustBinMember = requireReferenceMember("@ykdz/reference-rust-bin");
const vueAppMember = requireReferenceMember("@ykdz/reference-vue-app");
const tsLibPreset = requirePresetMember("@ykdz/preset-ts-lib");
const tsCliPreset = requirePresetMember("@ykdz/preset-ts-cli");
const rustBinPreset = requirePresetMember("@ykdz/preset-rust-bin");
const vikeAppPreset = requirePresetMember("@ykdz/preset-vike-app");
const vueAppPreset = requirePresetMember("@ykdz/preset-vue-app");

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
    const generator = createDefaultGenerator({ content: templateContent });
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
        selection: { presets: [{ contentIdentity: tsLibPreset.identity }] },
        conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsLibPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const generator = createDefaultGenerator({ content: templateContent });

    const result = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsLibPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") throw new Error("初始化应成功");
    assert.strictEqual(
      result.actions.some(({ path: outputPath }) => outputPath === "TODO.md"),
      false,
    );
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      [".", "packages/lib", "packages/tooling-config"].toSorted(),
    );
  });

  void it("同次正式投影生成 TODO 并让 add 沿用该选择", async () => {
    const targetRoot = await createTargetRoot("template-content-todo-");
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: {
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
    const todoText = await readFile(path.join(targetRoot, "TODO.md"), "utf8");
    assert.match(todoText, /pnpm install/u);
    assert.match(todoText, /pnpm run fix/u);
    assert.match(todoText, /pnpm run check/u);
    assert.equal(
      initialized.generationRecord.composition.conventions.todo,
      true,
    );
    assert.strictEqual(
      initialized.ownerFacts.container.dockerfileText,
      await readFile(path.join(targetRoot, ".devcontainer/Dockerfile"), "utf8"),
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: libraryMember.identity,
      creationInput: { packagePath: "packages/provider" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") throw new Error("加包应成功");
    assert.equal(added.generationRecord.composition.conventions.todo, true);
    assert.strictEqual(
      added.actions.some(({ path: outputPath }) => outputPath === "TODO.md"),
      false,
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "TODO.md"), "utf8"),
      todoText,
    );
  });

  void it("正式加包保留消费者定制的编辑器设置", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-editor-customization-",
    );
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const consumerRecord = result.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentity.packageName === "@ykdz/reference-ts-cli",
    );
    const providerRecord = result.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(libraryMember.identity),
    );
    assert.ok(consumerRecord);
    assert.ok(providerRecord);
    assert.deepStrictEqual(result.blueprint.packageLinkIntents, [
      {
        consumerId: consumerRecord.packageDefinitionId,
        providerId: providerRecord.packageDefinitionId,
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

  void it("重复已存在的 provider 时拒绝补交缺失的 linkFrom", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-repeat-",
    );
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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

    assert.strictEqual(
      retry.status,
      "operation-failure",
      JSON.stringify(retry),
    );
    assert.deepStrictEqual(packageIdentityIssueKinds(retry), [
      { kind: "duplicate", field: "name" },
      { kind: "duplicate", field: "path" },
    ]);
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
      "operation-failure",
      JSON.stringify(identityRetry),
    );
    if (identityRetry.status !== "operation-failure") {
      throw new Error("包身份占用应返回冲突");
    }
    assert.deepStrictEqual(packageIdentityIssueKinds(identityRetry), [
      { kind: "duplicate", field: "path" },
    ]);
    assert.strictEqual(await readFile(recordPath, "utf8"), before.record);
    assert.strictEqual(await readFile(blueprintPath, "utf8"), before.blueprint);
  });

  void it("linkFrom 引用未知 consumer 时保留领域原因且不写入", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-unknown-",
    );
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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

    assert.equal(result.status, "operation-failure");
    if (result.status !== "operation-failure") return;
    assert.equal(result.phase, "preparation");
    assert.deepEqual(packageLinkIssue(result), {
      kind: "unknown-consumer",
      path: "packages/missing",
    });
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("加包返回默认 owner 的版本声明诊断并保持目标不变", async () => {
    const cases = [
      {
        field: "engines.node" as const,
        actual: ">=22",
        message: /根package\.json的engines\.node/u,
        issue: "invalid-node-declaration",
      },
      {
        field: "packageManager" as const,
        actual: "null",
        message: /根package\.json的packageManager/u,
        issue: "invalid-package-manager-pin",
      },
    ];

    for (const testCase of cases) {
      const targetRoot = await createTargetRoot(
        `template-content-add-diagnostic-${testCase.field.replaceAll(".", "-")}-`,
      );
      const generator = createDefaultGenerator({ content: templateContent });
      const initialized = await generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
        conventions: {
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
      assert.strictEqual(result.phase, "preparation");
      assert.match(result.error.message, testCase.message);
      assert.ok(result.error.message.includes(testCase.actual));
      assert.equal(rootToolchainIssue(result), testCase.issue);
      assert.strictEqual(await snapshotTree(targetRoot), before);
    }
  });

  void it("linkFrom 保留失去 Node package-name import 能力的当前 consumer 原因", async () => {
    const targetRoot = await createTargetRoot(
      "template-content-link-from-current-",
    );
    const generator = createDefaultGenerator({ content: templateContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: tsCliPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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

    assert.equal(result.status, "operation-failure");
    if (result.status !== "operation-failure") return;
    assert.equal(result.phase, "calculation");
    assert.deepEqual(packageLinkIssue(result), {
      kind: "unsupported-link",
      consumerPath: "packages/cli",
      providerPath: "packages/provider",
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
    const generator = createDefaultGenerator({ content: templateContent });
    const rustRoot = await createTargetRoot("template-content-rust-bin-");
    const result = await generator.init({
      targetRoot: rustRoot,
      selection: { presets: [{ contentIdentity: rustBinPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
    const generator = createDefaultGenerator({ content: templateContent });

    const result = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: vikeAppPreset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
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
      const replayGenerator = createDefaultGenerator({
        content: templateContent,
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
