import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { templatePresets } from "@ykdz/template-content";
import { canLinkNodePackageRoles } from "@ykdz/template-workspace/project-linking";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { execa } from "execa";

import type { CliJourney, CliJourneyCommand } from "../journey.ts";

function requireLinkableAddition(): {
  readonly presetName: string;
  readonly consumerPath: string;
} {
  const presets = templatePresets.map((member) => member.definition);
  for (const preset of presets) {
    if (
      !preset.operations.includes("init") ||
      !preset.operations.includes("add")
    ) {
      continue;
    }
    const [node] = Object.values(preset.nodes);
    if (
      node !== undefined &&
      node.reference.defaultPath !== undefined &&
      canLinkNodePackageRoles(node.reference.role, node.reference.role)
    ) {
      return {
        presetName: preset.metadata.alias,
        consumerPath: node.reference.defaultPath,
      };
    }
  }
  throw new Error(
    "add package journey requires a linkable preset in the content collection",
  );
}

const { presetName: addablePresetName, consumerPath } =
  requireLinkableAddition();
const initializationPresets = templatePresets.filter((member) =>
  member.definition.operations.includes("init"),
);
const additionPresets = templatePresets.filter(
  (member) =>
    member.definition.operations.includes("add") &&
    Object.keys(member.definition.nodes).length === 1,
);
const presetMatrix = initializationPresets.flatMap((initialization) =>
  additionPresets.map((addition) => ({ initialization, addition })),
);
const legacyCommandOffset = 9;
const matrixCommandOffset = legacyCommandOffset + 3;

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
  ) as {
    readonly schemaVersion: number;
    readonly strategyState: {
      readonly toolchain: { readonly nodeLtsMajor: string };
    };
  };
  assert.equal(record.schemaVersion, 3);
  return record.strategyState.toolchain;
}

const upgradedNode = "22";
const upgradedPackageManager = "pnpm@10.5.0";

const journey: CliJourney = {
  name: "add-package",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    const commands: CliJourneyCommand[] = [
      {
        name: "initialize base",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
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
          "--output-format",
          "text",
        ],
      },
    ];

    const legacyProject = path.join(context.workDir, "legacy-project");
    const legacySnapshot = path.join(context.workDir, "legacy-before.json");
    const legacyAddition = [
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "legacy-addition",
      "--path",
      "packages/legacy-addition",
    ];
    commands.push(
      {
        name: "initialize a project before testing legacy record rejection",
        args: [
          "init",
          "legacy-project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
        ],
      },
      {
        name: "old v2 dry-run rejection without writes",
        cwd: legacyProject,
        async prepare() {
          const recordPath = path.join(
            legacyProject,
            ".template/generation.json",
          );
          const record = JSON.parse(await readFile(recordPath, "utf8")) as {
            schemaVersion: number;
          };
          record.schemaVersion = 2;
          await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
          await writeFile(
            legacySnapshot,
            JSON.stringify(await snapshot(legacyProject)),
          );
        },
        args: [...legacyAddition, "--dry-run"],
      },
      {
        name: "old v2 execute rejection without writes",
        cwd: legacyProject,
        async prepare() {
          assert.deepEqual(
            await snapshot(legacyProject),
            JSON.parse(await readFile(legacySnapshot, "utf8")),
            "旧 v2 预览必须保持目标不变",
          );
        },
        args: legacyAddition,
      },
    );

    for (const { initialization, addition } of presetMatrix) {
      const initializationAlias = initialization.definition.metadata.alias;
      const additionAlias = addition.definition.metadata.alias;
      const targetName = `matrix-${initializationAlias}-${additionAlias}`;
      const project = path.join(context.workDir, targetName);
      commands.push(
        {
          name: `为 ${initializationAlias} 项目初始化以添加 ${additionAlias} 预设`,
          args: [
            "init",
            targetName,
            "--preset",
            initializationAlias,
            "--scope",
            "acme",
          ],
        },
        {
          name: `在 ${initializationAlias} 项目添加 ${additionAlias} 预设`,
          cwd: project,
          async prepare() {
            await writeFile(
              path.join(
                context.workDir,
                `${targetName}-before-add-record.json`,
              ),
              await readFile(
                path.join(project, ".template/generation.json"),
                "utf8",
              ),
            );
            await writeFile(
              path.join(
                context.workDir,
                `${targetName}-before-add-blueprint.json`,
              ),
              await readFile(
                path.join(project, ".template/blueprint.json"),
                "utf8",
              ),
            );
          },
          args: [
            "add",
            "package",
            "--preset",
            additionAlias,
            "--name",
            additionAlias,
            "--path",
            `packages/${initializationAlias}-${additionAlias}`,
          ],
        },
      );
    }
    return commands;
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);

    const previewResult = JSON.parse(results[1]?.stdout ?? "");
    assert.equal(previewResult.variant, "planned");
    const preview = previewResult.data;
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(preview.dryRun, true);
    assert.ok(
      preview.actions.some(
        (action: { path: string }) =>
          action.path === "packages/utility/package.json",
      ),
    );

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").kind, "data");
    assert.match(
      await readFile(
        path.join(context.workDir, "project/packages/utility/package.json"),
        "utf8",
      ),
      /"name": "@acme\/utility"/u,
    );

    assert.deepEqual(JSON.parse(results[3]?.stdout ?? "").data.actions, []);
    assert.equal(results[4]?.exitCode, 2);
    assert.equal(results[4]?.stdout, "");
    assert.equal(JSON.parse(results[4]?.stderr ?? "").kind, "usageFailure");

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
    assert.equal(JSON.parse(results[5]?.stdout ?? "").kind, "data");
    const upgradedManifest = JSON.parse(
      await readFile(
        path.join(project, "packages/upgraded/package.json"),
        "utf8",
      ),
    ) as {
      readonly name: string;
      readonly engines: { readonly node: string };
    };
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

    const rejectedResult = JSON.parse(results[7]?.stderr ?? "");
    assert.equal(rejectedResult.variant, "operationFailed");
    const rejected = rejectedResult.data as {
      readonly phase: string;
      readonly error: { readonly message: string; readonly suggestion: string };
    };
    assert.equal(results[7]?.exitCode, 1);
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
    assert.equal(missingPm?.exitCode, 1);
    assert.equal(missingPm?.stdout, "");
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

    const conflictResult = JSON.parse(results[6]?.stderr ?? "");
    assert.equal(conflictResult.variant, "conflict");
    const conflict = conflictResult.data;
    assert.equal(results[6]?.exitCode, 1);
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

    await rewriteRootManifest(project, {
      node: releaseToolchainSnapshot.nodeVersion,
      packageManager: releaseToolchainSnapshot.packageManagerPin,
    });

    const utilityManifestPath = path.join(
      project,
      "packages/utility/package.json",
    );
    const utilityManifest = JSON.parse(
      await readFile(utilityManifestPath, "utf8"),
    ) as {
      readonly name: string;
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    // 构造真实依赖链：utility 保留 ^build 任务配置但不提供 build 命令。
    delete utilityManifest.scripts.build;
    utilityManifest.dependencies = {
      ...utilityManifest.dependencies,
      [upgradedManifest.name]: "workspace:*",
    };
    await writeFile(
      utilityManifestPath,
      `${JSON.stringify(utilityManifest, null, 2)}\n`,
    );
    await execa("pnpm", ["install"], { cwd: project });

    const blueprint = JSON.parse(
      await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly name: string;
        readonly path: string;
        readonly role: string;
      }[];
    };
    const packageRole = (packagePath: string): string => {
      const definition = blueprint.packages.find(
        (candidate) => candidate.path === packagePath,
      );
      assert.notStrictEqual(
        definition,
        undefined,
        `Blueprint 应记录 ${packagePath} 的身份`,
      );
      return definition!.role;
    };
    const packageTagsForRole = (role: string): readonly string[] => {
      switch (role) {
        case "cli-tool":
        case "runtime-service":
          return ["app"];
        case "shared-library":
          return ["library"];
        case "native-package":
          return ["native"];
        default:
          throw new Error(`未识别的 PackageDefinition.role：${role}`);
      }
    };
    const consumerManifest = JSON.parse(
      await readFile(path.join(project, consumerPath, "package.json"), "utf8"),
    ) as { readonly name: string };
    const nativeDirectory = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "query",
        "{ packages { items { name tags tasks { items { name tags script } } } } }",
      ],
      { cwd: project },
    );
    const nativePackages = (
      JSON.parse(nativeDirectory.stdout) as {
        readonly data: {
          readonly packages: {
            readonly items: readonly {
              readonly name: string;
              readonly tags: readonly string[];
              readonly tasks: {
                readonly items: readonly {
                  readonly name: string;
                  readonly tags: readonly string[];
                  readonly script: string | null;
                }[];
              };
            }[];
          };
        };
      }
    ).data.packages.items;
    const nativePackage = (name: string) => {
      const result = nativePackages.find(
        (candidate) => candidate.name === name,
      );
      assert.notStrictEqual(result, undefined, `Turbo 原生目录缺少 ${name}`);
      return result!;
    };
    const utility = nativePackage(utilityManifest.name);
    const consumer = nativePackage(consumerManifest.name);
    const upgraded = nativePackage(upgradedManifest.name);
    assert.deepStrictEqual(
      utility.tags,
      packageTagsForRole(packageRole("packages/utility")),
    );
    assert.deepStrictEqual(
      consumer.tags,
      packageTagsForRole(packageRole(consumerPath)),
    );
    assert.deepStrictEqual(
      upgraded.tags,
      packageTagsForRole(packageRole("packages/upgraded")),
    );
    for (const packageTasks of [consumer, upgraded]) {
      for (const name of ["build", "typecheck"] as const) {
        const task = packageTasks.tasks.items.find(
          (candidate) => candidate.name === name,
        );
        assert.notStrictEqual(
          task,
          undefined,
          `${packageTasks.name} 应发现 ${name}`,
        );
        assert.deepStrictEqual(task!.tags, ["quality:light"]);
        assert.notStrictEqual(task!.script, null);
      }
    }
    const utilityBuild = utility.tasks.items.find(
      (candidate) => candidate.name === "build",
    );
    assert.notStrictEqual(utilityBuild, undefined);
    assert.deepStrictEqual(utilityBuild!.tags, ["quality:light"]);
    assert.strictEqual(utilityBuild!.script, null);
    const utilityTypecheck = utility.tasks.items.find(
      (candidate) => candidate.name === "typecheck",
    );
    assert.notStrictEqual(utilityTypecheck, undefined);
    assert.strictEqual(utilityTypecheck!.script === null, false);

    const taskPlanResult = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        "typecheck",
        `--filter=${consumerManifest.name}`,
        "--dry-run=json",
      ],
      { cwd: project },
    );
    const taskPlan = (
      JSON.parse(taskPlanResult.stdout) as {
        readonly tasks: readonly {
          readonly taskId: string;
          readonly directory: string;
          readonly dependencies: readonly string[];
          readonly command: string;
          readonly resolvedTaskDefinition: {
            readonly dependsOn: readonly string[];
          };
        }[];
      }
    ).tasks;
    for (const name of ["build", "typecheck"] as const) {
      const consumerTask = taskPlan.find(
        (task) => task.taskId === `${consumerManifest.name}#${name}`,
      );
      const utilityTask = taskPlan.find(
        (task) => task.taskId === `${utilityManifest.name}#${name}`,
      );
      const upgradedTask = taskPlan.find(
        (task) => task.taskId === `${upgradedManifest.name}#${name}`,
      );
      assert.notStrictEqual(consumerTask, undefined);
      assert.notStrictEqual(utilityTask, undefined);
      assert.notStrictEqual(upgradedTask, undefined);
      assert.strictEqual(consumerTask!.directory, consumerPath);
      assert.strictEqual(utilityTask!.directory, "packages/utility");
      assert.strictEqual(upgradedTask!.directory, "packages/upgraded");
      assert.ok(
        consumerTask!.dependencies.includes(utilityTask!.taskId),
        `${utilityTask!.taskId} 应先于 ${consumerTask!.taskId}`,
      );
    }
    const consumerBuild = taskPlan.find(
      (task) => task.taskId === `${consumerManifest.name}#build`,
    )!;
    const utilityBuildPlan = taskPlan.find(
      (task) => task.taskId === `${utilityManifest.name}#build`,
    )!;
    const upgradedBuild = taskPlan.find(
      (task) => task.taskId === `${upgradedManifest.name}#build`,
    )!;
    assert.strictEqual(utilityBuildPlan.command, "<NONEXISTENT>");
    assert.deepStrictEqual(utilityBuildPlan.resolvedTaskDefinition.dependsOn, [
      "^build",
    ]);
    assert.ok(
      consumerBuild.dependencies.includes(utilityBuildPlan.taskId) &&
        utilityBuildPlan.dependencies.includes(upgradedBuild.taskId),
      `${upgradedBuild.taskId} 应经无命令的 ${utilityBuildPlan.taskId} 先于 ${consumerBuild.taskId}`,
    );

    assert.equal(results[legacyCommandOffset]?.exitCode, 0);
    const legacyProject = path.join(context.workDir, "legacy-project");
    const legacyFailures = results.slice(
      legacyCommandOffset + 1,
      matrixCommandOffset,
    );
    assert.equal(legacyFailures.length, 2);
    for (const result of legacyFailures) {
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.variant, "operationFailed");
      assert.equal(failure.data.phase, "metadata");
      assert.equal(typeof failure.data.error.message, "string");
      assert.notEqual(failure.data.error.message.length, 0);
    }
    assert.deepEqual(
      await snapshot(legacyProject),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "legacy-before.json"),
          "utf8",
        ),
      ),
    );
    await assert.rejects(
      stat(path.join(legacyProject, "packages/legacy-addition")),
      { code: "ENOENT" },
    );

    const matrixResults = results.slice(matrixCommandOffset);
    assert.equal(matrixResults.length, presetMatrix.length * 2);
    for (const [
      index,
      { initialization, addition },
    ] of presetMatrix.entries()) {
      const initializationAlias = initialization.definition.metadata.alias;
      const additionAlias = addition.definition.metadata.alias;
      const targetName = `matrix-${initializationAlias}-${additionAlias}`;
      const project = path.join(context.workDir, targetName);
      const initializationResult = matrixResults[index * 2]!;
      const additionResult = matrixResults[index * 2 + 1]!;

      assert.equal(
        initializationResult.exitCode,
        0,
        initializationResult.stderr,
      );
      const initialized = JSON.parse(initializationResult.stdout).data;
      assert.equal(initialized.resolved.preset, initializationAlias);
      assert.deepEqual(
        initialized.generationRecord,
        JSON.parse(
          await readFile(
            path.join(context.workDir, `${targetName}-before-add-record.json`),
            "utf8",
          ),
        ),
      );
      assert.deepEqual(
        initialized.blueprint,
        JSON.parse(
          await readFile(
            path.join(
              context.workDir,
              `${targetName}-before-add-blueprint.json`,
            ),
            "utf8",
          ),
        ),
      );
      for (const packageEntry of initialized.resolved.packages as readonly {
        readonly name: string;
        readonly path: string;
      }[]) {
        const manifest = JSON.parse(
          await readFile(
            path.join(project, packageEntry.path, "package.json"),
            "utf8",
          ),
        ) as { readonly name: string };
        assert.equal(manifest.name, packageEntry.name);
      }

      assert.equal(additionResult.exitCode, 0, additionResult.stderr);
      const added = JSON.parse(additionResult.stdout);
      assert.equal(added.variant, "added");
      const addedPath = `packages/${initializationAlias}-${additionAlias}`;
      const packageName = `@acme/${additionAlias}`;
      assert.ok(
        added.data.actions.some(
          (action: { readonly path: string }) =>
            action.path === `${addedPath}/package.json`,
        ),
      );
      const packageManifest = JSON.parse(
        await readFile(path.join(project, addedPath, "package.json"), "utf8"),
      ) as { readonly name: string };
      assert.equal(packageManifest.name, packageName);

      const blueprint = JSON.parse(
        await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
      );
      const addedDefinition = blueprint.packages.find(
        (definition: { readonly name: string; readonly path: string }) =>
          definition.name === packageName && definition.path === addedPath,
      );
      assert.notEqual(addedDefinition, undefined);
      const generationRecord = JSON.parse(
        await readFile(path.join(project, ".template/generation.json"), "utf8"),
      );
      assert.equal(generationRecord.schemaVersion, 4);
      assert.ok(
        generationRecord.packages.some(
          (record: { readonly packageDefinitionId: string }) =>
            record.packageDefinitionId === addedDefinition.packageDefinitionId,
        ),
      );
      assert.ok(
        generationRecord.presetSelections.some(
          (selection: { readonly packageName: string }) =>
            selection.packageName === addition.identity.packageName,
        ),
      );
    }
  },
};

export default journey;
