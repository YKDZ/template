import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { defineReferencePackage } from "@ykdz/template-core/reference-package";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);

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

void describe("显式生成器默认库行为", () => {
  void it("通过显式内容和工作区策略初始化库及共享配置", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-ts-lib-")),
      "demo",
    );
    const generator = createGenerator({
      content: [library, configuration],
      strategy: createDefaultWorkspaceStrategy(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { contentIdentity: "library" },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    assert.partialDeepStrictEqual(
      JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")),
      {
        scripts: {
          check: "node --conditions=source scripts/task-gates.ts check",
          boundaries:
            "node --conditions=source scripts/run-turbo-boundaries.ts && node --conditions=source scripts/check-toolchain-versions.ts",
        },
        packageManager: "pnpm@12.9.1",
        engines: { node: "24.21.0" },
      },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ),
      { name: "@demo/lib" },
    );
    assert.ok(
      (
        await readFile(path.join(targetRoot, "pnpm-workspace.yaml"), "utf8")
      ).includes("packages/*"),
    );
    assert.ok(
      await readFile(
        path.join(targetRoot, "packages/typescript-config/base.json"),
        "utf8",
      ),
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "package.json"))).mode & 0o777,
      0o644,
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "packages/lib/src/index.ts"))).mode &
        0o777,
      0o644,
    );
  });

  void it("初始化时递归展开共享内容的传递依赖", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-closure-")),
      "demo",
    );
    const bridge = {
      ...configuration,
      identity: "typescript-config-bridge",
      defaultLeafName: "typescript-config-bridge",
      defaultPath: "packages/typescript-config-bridge",
    };
    const baseStrategy = createDefaultWorkspaceStrategy();
    const generator = createGenerator({
      content: [library, bridge, configuration],
      strategy: {
        ...baseStrategy,
        dependencies({ content }) {
          if (content.identity === library.identity) {
            return [bridge.identity];
          }
          if (content.identity === bridge.identity) {
            return [configuration.identity];
          }
          return [];
        },
      },
    });

    const result = await generator.init({
      targetRoot,
      selection: { contentIdentity: library.identity },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status === "success") {
      assert.deepStrictEqual(
        result.blueprint.packages.map((definition) => definition.path),
        [
          "packages/lib",
          "packages/typescript-config-bridge",
          "packages/typescript-config",
        ],
      );
    }
  });

  void it("连续加包时复用共享配置并保留已有源码与工作区定制", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-add-")),
      "demo",
    );
    const generator = createGenerator({
      content: [library, configuration],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { contentIdentity: "library" },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");

    const customizedSource = path.join(targetRoot, "packages/lib/src/index.ts");
    const customizedConfiguration = path.join(
      targetRoot,
      "packages/typescript-config/base.json",
    );
    const customizedRoot = path.join(targetRoot, "package.json");
    await writeFile(customizedSource, "export const localChange = true;\n");
    await writeFile(
      customizedConfiguration,
      '{"compilerOptions":{"strict":false}}\n',
    );
    const rootManifest = JSON.parse(await readFile(customizedRoot, "utf8")) as {
      scripts: Record<string, string>;
    };
    rootManifest.scripts.custom = "echo retained";
    await writeFile(
      customizedRoot,
      JSON.stringify(rootManifest, null, 2) + "\n",
    );
    await writeFile(
      path.join(targetRoot, ".gitignore"),
      (await readFile(path.join(targetRoot, ".gitignore"), "utf8")) +
        "local-only.txt\n",
    );

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const beforeDryRun = await readFile(generationPath, "utf8");
    const preview = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "shared",
      dryRun: true,
    });
    assert.strictEqual(preview.status, "success");
    assert.deepStrictEqual(
      await readFile(generationPath, "utf8"),
      beforeDryRun,
    );
    await assert.rejects(stat(path.join(targetRoot, "packages/shared")));

    const first = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "shared",
    });
    assert.strictEqual(first.status, "success");
    const repeated = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "shared",
    });
    assert.strictEqual(repeated.status, "success");
    if (repeated.status === "success")
      assert.deepStrictEqual(repeated.actions, []);

    const second = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "another",
    });
    assert.strictEqual(second.status, "success");
    assert.strictEqual(
      (await readFile(customizedSource, "utf8")).includes("localChange"),
      true,
    );
    assert.strictEqual(
      await readFile(customizedConfiguration, "utf8"),
      '{"compilerOptions":{"strict":false}}\n',
    );
    assert.strictEqual(
      (await readFile(customizedRoot, "utf8")).includes(
        '"custom": "echo retained"',
      ),
      true,
    );
    assert.strictEqual(
      (await readFile(path.join(targetRoot, ".gitignore"), "utf8")).includes(
        "local-only.txt",
      ),
      true,
    );
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.strictEqual(
      blueprint.packages.filter(
        (item) => item.path === "packages/typescript-config",
      ).length,
      1,
    );
    assert.strictEqual(
      blueprint.packages.some((item) => item.path === "packages/another"),
      true,
    );
  });

  void it("加包从根读取当前精确或纯大版本 Node 与 pnpm 并保留既有包事实", async () => {
    for (const [nodeDeclaration, expectedContainerNode] of [
      ["26.1.0", "26.1.0"],
      ["26", "26"],
    ]) {
      const targetRoot = path.join(
        await mkdtemp(
          path.join(tmpdir(), "template-generator-current-toolchain-"),
        ),
        "demo",
      );
      const generator = createGenerator({
        content: [library, configuration],
        strategy: createDefaultWorkspaceStrategy(),
      });
      const initialized = await generator.init({
        targetRoot,
        selection: { contentIdentity: "library" },
        strategyInput: { defaultPackageScope: "demo" },
      });
      assert.strictEqual(initialized.status, "success");

      const rootManifestPath = path.join(targetRoot, "package.json");
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as {
        engines: Record<string, string>;
        packageManager: string;
      };
      rootManifest.engines.node = nodeDeclaration!;
      rootManifest.packageManager = "pnpm@12.9.2";
      await writeFile(
        rootManifestPath,
        JSON.stringify(rootManifest, null, 2) + "\n",
      );
      const existingPackagePath = path.join(
        targetRoot,
        "packages/lib/package.json",
      );
      const existingPackageBefore = await readFile(existingPackagePath, "utf8");

      const result = await generator.add({
        repositoryRoot: targetRoot,
        contentIdentity: "library",
        leafName: "current-node",
      });

      assert.strictEqual(result.status, "success", JSON.stringify(result));
      assert.deepStrictEqual(
        JSON.parse(await readFile(rootManifestPath, "utf8")),
        rootManifest,
      );
      const devcontainer = JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { build: { args: Record<string, string> } };
      assert.strictEqual(
        devcontainer.build.args.NODE_VERSION,
        expectedContainerNode,
      );
      const addedPackage = JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/current-node/package.json"),
          "utf8",
        ),
      ) as { engines: { node: string } };
      assert.strictEqual(addedPackage.engines.node, "26");
      assert.strictEqual(
        await readFile(existingPackagePath, "utf8"),
        existingPackageBefore,
      );
    }
  });

  void it("共享配置缺少原生公开接口时加包失败且目标树零写入", async () => {
    const targetRoot = path.join(
      await mkdtemp(
        path.join(tmpdir(), "template-generator-missing-shared-export-"),
      ),
      "demo",
    );
    const generator = createGenerator({
      content: [library, configuration],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { contentIdentity: "library" },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");
    const configurationPath = path.join(
      targetRoot,
      "packages/typescript-config/package.json",
    );
    const configurationManifest = JSON.parse(
      await readFile(configurationPath, "utf8"),
    ) as { exports: Record<string, unknown> };
    delete configurationManifest.exports["./base.json"];
    await writeFile(
      configurationPath,
      JSON.stringify(configurationManifest, null, 2) + "\n",
    );
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "missing-export-consumer",
    });

    assert.strictEqual(
      result.status,
      "operation-failure",
      JSON.stringify(result),
    );
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("新增路径冲突时不改动目标或用户文件", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-conflict-")),
      "demo",
    );
    const generator = createGenerator({
      content: [library, configuration],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { contentIdentity: "library" },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");
    const occupiedDirectory = path.join(targetRoot, "packages/occupied");
    await mkdir(occupiedDirectory, { recursive: true });
    const userFile = path.join(occupiedDirectory, "keep.txt");
    await writeFile(userFile, "user data\n");
    const generationPath = path.join(targetRoot, ".template/generation.json");
    const before = await readFile(generationPath, "utf8");

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "library",
      leafName: "occupied",
    });

    assert.strictEqual(result.status, "conflict");
    if (result.status === "conflict") {
      assert.strictEqual(result.conflicts.length, 1);
      assert.strictEqual(result.conflicts[0]?.driver, "precondition");
    }
    assert.strictEqual(await readFile(userFile, "utf8"), "user data\n");
    assert.strictEqual(await readFile(generationPath, "utf8"), before);
    await assert.rejects(stat(path.join(occupiedDirectory, "package.json")));
  });
});
