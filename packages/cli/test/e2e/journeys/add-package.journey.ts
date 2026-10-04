import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import {
  canConsumeNodePackageNameImport,
  canLinkNodePackageRoles,
  canProvideSourceConditionPackageNameImport,
} from "@ykdz/template-core/project-linking-v2";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";

import type { CliJourney } from "../journey.ts";

function requireLinkableAddition(): {
  readonly presetName: string;
  readonly consumerPath: string;
} {
  const context = createGenerationContext({
    targetDir: "project",
    defaultPackageScope: "acme",
    toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
  });
  for (const definition of builtInPresetRegistry.all()) {
    const packageLeafName = "utility";
    const packagePath = definition.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    if (packagePath === undefined || !definition.planPackageAddition) continue;
    const provider = definition.planPackageAddition({
      context,
      packageLeafName,
      packagePath,
    });
    if (!canProvideSourceConditionPackageNameImport(provider)) continue;
    const consumers = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions;
    const consumer = consumers.find(
      (candidate) =>
        canConsumeNodePackageNameImport(candidate) &&
        canLinkNodePackageRoles(
          candidate.definition.role,
          provider.definition.role,
        ),
    );
    if (consumer !== undefined) {
      return {
        presetName: definition.metadata.name,
        consumerPath: consumer.definition.path,
      };
    }
  }
  throw new Error("add package journey requires a linkable addable Preset");
}

const { presetName: addablePresetName, consumerPath } =
  requireLinkableAddition();

async function snapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await snapshot(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

type RootManifest = {
  readonly engines?: { readonly node?: string };
  readonly packageManager?: string;
};

async function readRootManifest(project: string): Promise<RootManifest> {
  return JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ) as RootManifest;
}

async function rewriteRootManifest(
  project: string,
  toolchain: { readonly node: string; readonly packageManager: string },
): Promise<void> {
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.engines = { node: toolchain.node };
  manifest.packageManager = toolchain.packageManager;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readGenerationRecordToolchain(project: string) {
  const record = JSON.parse(
    await readFile(path.join(project, ".template/generation.json"), "utf8"),
  ) as { readonly toolchain: { readonly nodeLtsMajor: string } };
  return record.toolchain;
}

const upgradedNode = "22";
const upgradedPackageManager = "pnpm@10.5.0";

const journey: CliJourney = {
  name: "add-package",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    return [
      {
        name: "initialize base",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
          "--yes",
        ],
      },
      {
        name: "dry-run addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
          "--dry-run",
          "--json",
        ],
      },
      {
        name: "apply addition",
        cwd: project,
        async prepare() {
          await assert.rejects(stat(path.join(project, "packages/utility")), {
            code: "ENOENT",
          });
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
          "--json",
        ],
      },
      {
        name: "repeat addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
          "--json",
        ],
      },
      {
        name: "missing required options",
        cwd: project,
        args: ["add", "package"],
      },
      {
        name: "add package on the target root current toolchain",
        cwd: project,
        async prepare() {
          const record = await readGenerationRecordToolchain(project);
          const root = await readRootManifest(project);
          await writeFile(
            path.join(context.workDir, "toolchain-history.json"),
            JSON.stringify({
              recordNodeLtsMajor: record.nodeLtsMajor,
              rootNode: root.engines?.node,
              rootPackageManager: root.packageManager,
            }),
          );
          await rewriteRootManifest(project, {
            node: upgradedNode,
            packageManager: upgradedPackageManager,
          });
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "upgraded",
          "--path",
          "packages/upgraded",
          "--json",
        ],
      },
      {
        name: "canonical metadata conflict",
        cwd: project,
        async prepare() {
          const generationPath = path.join(
            project,
            ".template/generation.json",
          );
          const generation = JSON.parse(
            await readFile(generationPath, "utf8"),
          ) as unknown;
          await writeFile(generationPath, JSON.stringify(generation));
          await writeFile(
            path.join(context.workDir, "conflict-before.json"),
            JSON.stringify(await snapshot(project)),
          );
          await writeFile(
            path.join(context.workDir, "root-after-current-addition.json"),
            await readFile(path.join(project, "package.json"), "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "second",
          "--path",
          "packages/second",
          "--json",
        ],
      },
      {
        name: "add package on an unusable root toolchain declaration",
        cwd: project,
        async prepare() {
          await writeFile(
            path.join(context.workDir, "conflict-after.json"),
            JSON.stringify(await snapshot(project)),
          );
          const manifestPath = path.join(project, "package.json");
          await rewriteRootManifest(project, {
            node: `>=${upgradedNode}`,
            packageManager: upgradedPackageManager,
          });
          await writeFile(
            path.join(context.workDir, "invalid-root-package.json"),
            await readFile(manifestPath, "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "rejected",
          "--path",
          "packages/rejected",
          "--json",
        ],
      },
      {
        name: "add package on a target root without a pnpm declaration",
        cwd: project,
        async prepare() {
          // 先固化上一轮拒绝后未被写入的根字节，再构造 pnpm 缺失声明。
          await writeFile(
            path.join(context.workDir, "invalid-root-unchanged.json"),
            await readFile(path.join(project, "package.json"), "utf8"),
          );
          const manifestPath = path.join(project, "package.json");
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          manifest.engines = { node: upgradedNode };
          delete manifest.packageManager;
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          await writeFile(
            path.join(context.workDir, "missing-pm-root-package.json"),
            await readFile(manifestPath, "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "missing-pm",
          "--path",
          "packages/missing-pm",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    const manifest = JSON.parse(
      await readFile(path.join(context.packageRoot, "package.json"), "utf8"),
    ) as { readonly version: string };
    assert.equal(results[0]?.exitCode, 0);

    const preview = JSON.parse(results[1]?.stdout ?? "");
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(preview.status, "success");
    assert.equal(preview.dryRun, true);
    assert.ok(
      preview.actions.some(
        (action: { path: string }) =>
          action.path === "packages/utility/package.json",
      ),
    );

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").status, "success");
    assert.match(
      await readFile(
        path.join(context.workDir, "project/packages/utility/package.json"),
        "utf8",
      ),
      /"name": "@acme\/utility"/u,
    );

    assert.deepEqual(JSON.parse(results[3]?.stdout ?? "").actions, []);
    assert.equal(results[4]?.exitCode, 64);
    assert.equal(results[4]?.stdout, "");
    assert.match(
      results[4]?.stderr ?? "",
      new RegExp(`^template ${manifest.version}\\n`, "u"),
    );
    assert.match(results[4]?.stderr ?? "", /USAGE_MISSING_REQUIRED_OPTION/u);
    assert.match(results[4]?.stderr ?? "", /缺少必需选项/u);
    assert.match(
      results[4]?.stderr ?? "",
      /用法: template add package \[options\]/u,
    );

    const project = path.join(context.workDir, "project");
    const history = JSON.parse(
      await readFile(
        path.join(context.workDir, "toolchain-history.json"),
        "utf8",
      ),
    ) as {
      readonly recordNodeLtsMajor: string;
      readonly rootNode: string;
      readonly rootPackageManager: string;
    };
    assert.equal(
      history.rootNode,
      releaseToolchainSnapshot.nodeVersion,
      "初始化根 engines.node 应为 CLI 发版快照的精确 Node 值",
    );
    assert.equal(
      history.rootPackageManager,
      releaseToolchainSnapshot.packageManagerPin,
      "初始化根 packageManager 应为 CLI 发版快照的精确 pnpm pin",
    );
    assert.equal(
      history.recordNodeLtsMajor,
      /^(\d+)\./.exec(history.rootNode)?.[1],
      "Generation Record 只应保存由目标根现行精确值派生的大版本",
    );
    assert.notEqual(history.rootNode, upgradedNode);
    assert.notEqual(history.rootPackageManager, upgradedPackageManager);
    assert.notEqual(history.recordNodeLtsMajor, upgradedNode);

    assert.equal(results[5]?.exitCode, 0);
    assert.equal(JSON.parse(results[5]?.stdout ?? "").status, "success");
    const upgradedManifest = JSON.parse(
      await readFile(
        path.join(project, "packages/upgraded/package.json"),
        "utf8",
      ),
    ) as { readonly engines: { readonly node: string } };
    assert.equal(upgradedManifest.engines.node, upgradedNode);
    const rootAfterAddition = JSON.parse(
      await readFile(
        path.join(context.workDir, "root-after-current-addition.json"),
        "utf8",
      ),
    ) as RootManifest;
    assert.equal(rootAfterAddition.engines?.node, upgradedNode);
    assert.equal(rootAfterAddition.packageManager, upgradedPackageManager);
    assert.equal(
      (await readGenerationRecordToolchain(project)).nodeLtsMajor,
      history.recordNodeLtsMajor,
    );

    const rejected = JSON.parse(results[7]?.stdout ?? "") as {
      readonly status: string;
      readonly code: string;
      readonly phase: string;
      readonly error: { readonly message: string; readonly suggestion: string };
    };
    assert.equal(results[7]?.exitCode, 65);
    assert.equal(rejected.status, "operation-failure");
    assert.equal(rejected.code, "OPERATION_ADD_PACKAGE_FAILED");
    assert.equal(rejected.phase, "metadata");
    // JSON 输出必须点名无效字段与其实际值，并给出修正动作。
    assert.match(rejected.error.message, /engines\.node/u);
    assert.ok(
      rejected.error.message.includes('">=22"'),
      `JSON 诊断应包含实际声明值，实际消息：${rejected.error.message}`,
    );
    assert.match(rejected.error.suggestion, /package\.json 的 engines\.node/u);
    await assert.rejects(stat(path.join(project, "packages/rejected")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(
        path.join(context.workDir, "invalid-root-unchanged.json"),
        "utf8",
      ),
      await readFile(
        path.join(context.workDir, "invalid-root-package.json"),
        "utf8",
      ),
    );
    assert.equal(
      (await readGenerationRecordToolchain(project)).nodeLtsMajor,
      history.recordNodeLtsMajor,
    );

    // 文本输出负例：缺失 packageManager 声明同样给出字段级可行动诊断。
    const missingPm = results[8];
    assert.equal(missingPm?.exitCode, 65);
    assert.equal(missingPm?.stdout, "");
    assert.match(
      missingPm?.stderr ?? "",
      /OPERATION_ADD_PACKAGE_FAILED/u,
      "文本输出应包含失败类别",
    );
    assert.match(missingPm?.stderr ?? "", /阶段: metadata/u);
    assert.match(
      missingPm?.stderr ?? "",
      /package\.json 的 packageManager/u,
      "文本输出应点名 packageManager 字段",
    );
    assert.match(
      missingPm?.stderr ?? "",
      /实际收到 null/u,
      "文本输出应给出实际值",
    );
    assert.match(
      missingPm?.stderr ?? "",
      /请先修改根 package\.json 的 packageManager 声明/u,
      "文本输出应给出修正动作",
    );
    assert.ok(
      !/添加 Package 时发生操作失败/u.test(missingPm?.stderr ?? ""),
      "字段级诊断不应回退为通用提示",
    );
    await assert.rejects(stat(path.join(project, "packages/missing-pm")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(path.join(project, "package.json"), "utf8"),
      await readFile(
        path.join(context.workDir, "missing-pm-root-package.json"),
        "utf8",
      ),
    );

    const conflict = JSON.parse(results[6]?.stdout ?? "");
    assert.equal(results[6]?.exitCode, 1);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.actions, []);
    assert.ok(
      conflict.conflicts.some(
        (entry: { path: string; driver: string }) =>
          entry.path === ".template/generation.json" &&
          entry.driver === "canonical",
      ),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(context.workDir, "conflict-after.json"),
          "utf8",
        ),
      ) as unknown,
      JSON.parse(
        await readFile(
          path.join(context.workDir, "conflict-before.json"),
          "utf8",
        ),
      ) as unknown,
    );
  },
};

export default journey;
