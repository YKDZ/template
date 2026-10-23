import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";
import { requireReferencePresetName } from "../reference-preset.ts";

const libraryPresetName = requireReferencePresetName("@ykdz/reference-ts-lib");

const consumerPath = "services/domain";
const providerPath = "libraries/utilities";
const customScript = "node --eval \"console.log('用户自定义命令')\"";

type PackageManifest = {
  readonly name: string;
  scripts: Record<string, string>;
  readonly dependencies?: Readonly<Record<string, string>>;
};

async function readManifest(project: string, packagePath: string) {
  return JSON.parse(
    await readFile(path.join(project, packagePath, "package.json"), "utf8"),
  ) as PackageManifest;
}

const journey: CliJourney = {
  name: "reference-library",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    const sourcePath = path.join(project, consumerPath, "src/index.ts");
    const manifestPath = path.join(project, consumerPath, "package.json");
    const installedRoot = path.join(context.workDir, "installed-consumer");
    const addArgs = [
      "add",
      "package",
      "--preset",
      libraryPresetName,
      "--name",
      "utilities",
      "--path",
      providerPath,
      "--link-from",
      consumerPath,
      "--publication",
    ];
    return [
      {
        name: "以自定义身份初始化 library",
        args: [
          "init",
          "project",
          "--preset",
          libraryPresetName,
          "--name",
          "domain",
          "--scope",
          "acme",
          "--path",
          consumerPath,
          "--publication",
        ],
      },
      {
        name: "保留用户修改并预览第二个 library",
        cwd: project,
        args: [...addArgs, "--dry-run"],
        async prepare() {
          const manifest = await readManifest(project, consumerPath);
          assert.equal(manifest.name, "@acme/domain");
          manifest.scripts["user:note"] = customScript;
          const customizedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
          const customizedSource = `${await readFile(sourcePath, "utf8")}\nexport const userMessage = "用户保留的业务逻辑";\n`;
          await writeFile(manifestPath, customizedManifest);
          await writeFile(sourcePath, customizedSource);
          await writeFile(
            path.join(context.workDir, "customized-manifest.json"),
            customizedManifest,
          );
          await writeFile(
            path.join(context.workDir, "customized-index.ts"),
            customizedSource,
          );
        },
      },
      {
        name: "添加第二个 library 并连接依赖",
        cwd: project,
        args: addArgs,
        async prepare() {
          await assert.rejects(stat(path.join(project, providerPath)), {
            code: "ENOENT",
          });
          assert.equal(
            await readFile(manifestPath, "utf8"),
            await readFile(
              path.join(context.workDir, "customized-manifest.json"),
              "utf8",
            ),
            "dry-run 不应改写用户 manifest",
          );
          assert.equal(
            await readFile(sourcePath, "utf8"),
            await readFile(
              path.join(context.workDir, "customized-index.ts"),
              "utf8",
            ),
            "dry-run 不应改写用户源码",
          );
        },
      },
      {
        name: "安装生成项目的依赖",
        executable: "pnpm",
        cwd: project,
        args: ["install"],
      },
      {
        name: "通过正式发布入口构建并打包库",
        executable: "pnpm",
        cwd: project,
        args: ["run", "publication:pack"],
      },
      {
        name: "独立安装生成的库归档",
        executable: "npm",
        cwd: installedRoot,
        args: ["install", "--no-audit", "--no-fund"],
        async prepare() {
          const packedRoot = path.join(project, ".changeset/packed");
          const plan = JSON.parse(
            await readFile(path.join(packedRoot, "publish-plan.json"), "utf8"),
          ) as {
            plan: readonly (readonly {
              name: string;
              tarball: { path: string };
            }[])[];
          };
          const provider = plan.plan
            .flat()
            .find(({ name }) => name === "@acme/utilities");
          assert.ok(provider, "发布计划应包含提供方库");
          await mkdir(installedRoot);
          await writeFile(
            path.join(installedRoot, "package.json"),
            JSON.stringify({
              private: true,
              dependencies: {
                [provider.name]: `file:${path.join(packedRoot, provider.tarball.path)}`,
              },
            }),
          );
        },
      },
      {
        name: "运行安装后库的公开导出与输入校验",
        executable: process.execPath,
        cwd: installedRoot,
        args: [
          "--input-type=module",
          "--eval",
          [
            'import assert from "node:assert/strict";',
            'import { greet } from "@acme/utilities";',
            'assert.deepEqual(greet("Ada"), { message: "Hello, Ada" });',
            'assert.throws(() => greet(""));',
          ].join("\n"),
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    for (const result of results) {
      assert.equal(result.exitCode, 0, result.commandName);
    }
    const initialized = JSON.parse(results[0]!.stdout);
    assert.equal(initialized.variant, "initialized");
    assert.deepEqual(initialized.data.resolved.packages, [
      { name: "@acme/domain", path: consumerPath },
    ]);
    const preview = JSON.parse(results[1]!.stdout);
    assert.equal(preview.variant, "planned");
    assert.equal(preview.data.dryRun, true);
    assert.ok(
      preview.data.actions.some(
        (action: { path: string }) =>
          action.path === `${providerPath}/package.json`,
      ),
    );

    const project = path.join(context.workDir, "project");
    const consumer = await readManifest(project, consumerPath);
    const provider = await readManifest(project, providerPath);
    assert.equal(consumer.name, "@acme/domain");
    assert.equal(provider.name, "@acme/utilities");
    assert.equal(consumer.dependencies?.[provider.name], "workspace:*");
    assert.equal(consumer.scripts["user:note"], customScript);
    assert.equal(
      await readFile(path.join(project, consumerPath, "src/index.ts"), "utf8"),
      await readFile(path.join(context.workDir, "customized-index.ts"), "utf8"),
      "添加依赖后应逐字节保留用户源码",
    );
    const blueprint = JSON.parse(
      await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
    ) as { packages: readonly { name: string; path: string }[] };
    assert.deepEqual(
      blueprint.packages
        .filter(({ name }) => name === consumer.name || name === provider.name)
        .map(({ name, path: packagePath }) => ({ name, path: packagePath }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      [
        { name: "@acme/domain", path: consumerPath },
        { name: "@acme/utilities", path: providerPath },
      ],
    );
  },
};

export default journey;
