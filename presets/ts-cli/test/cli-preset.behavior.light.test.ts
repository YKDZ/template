import assert from "node:assert/strict";
import {
  chmod,
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

import type { LoadedContentMember } from "@ykdz/template-core/content-identity";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@ykdz/reference-workspace-root/template",
      load: () => import("@ykdz/reference-workspace-root/template"),
    },
    {
      specifier: "@ykdz/reference-ts-cli/template",
      load: () => import("@ykdz/reference-ts-cli/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-ts-cli/template",
      load: () => import("@ykdz/preset-ts-cli/template"),
    },
    {
      specifier: "@ykdz/preset-ts-lib/template",
      load: () => import("@ykdz/preset-ts-lib/template"),
    },
  ],
});

const cli = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-ts-cli",
);
const root = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-workspace-root",
);
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-cli",
);
const libraryPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
assert.ok(cli);
assert.ok(root);
assert.ok(preset);
assert.ok(libraryPreset);

const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

async function readManifest(
  targetRoot: string,
  packagePath: string,
): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(path.join(targetRoot, packagePath, "package.json"), "utf8"),
  ) as Record<string, any>;
}

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

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("TypeScript CLI 公开预设", () => {
  void it("直接参考与单节点预设共享原生命令入口和Node引擎转换", async () => {
    const targets = await Promise.all([
      createTargetRoot("template-ts-cli-direct-"),
      createTargetRoot("template-ts-cli-preset-"),
    ]);
    const conventions = {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    };
    const presetResult = await createDefaultGenerator({ content }).init({
      targetRoot: targets[0]!,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    const referenceResult = await createDefaultGenerator({ content }).init({
      targetRoot: targets[1]!,
      selection: {
        roots: [{ nodeIdentity: "cli", contentIdentity: cli.identity }],
      },
      conventions,
    });

    assert.strictEqual(
      presetResult.status,
      "success",
      JSON.stringify(presetResult),
    );
    assert.strictEqual(
      referenceResult.status,
      "success",
      JSON.stringify(referenceResult),
    );
    const presetManifest = await readManifest(targets[0]!, "packages/cli");
    const referenceManifest = await readManifest(targets[1]!, "packages/cli");
    for (const manifest of [presetManifest, referenceManifest]) {
      assert.strictEqual(manifest.private, true);
      assert.deepStrictEqual(manifest.bin, { cli: "./dist/cli.js" });
      assert.strictEqual(manifest.engines.node, ">=24");
      assert.deepStrictEqual(manifest.devDependencies, {
        "@demo/tooling-config": "link:../tooling-config",
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        "oxlint-tsgolint": "catalog:",
        "typescript-7": "catalog:",
      });
      assert.strictEqual(
        Object.hasOwn(manifest.exports ?? {}, "./command-identity"),
        false,
      );
    }
    assert.deepStrictEqual(presetManifest, referenceManifest);
    const generatedTurbo = JSON.parse(
      await readFile(path.join(targets[0]!, "packages/cli/turbo.json"), "utf8"),
    ) as {
      readonly tasks: { readonly build: { readonly dependsOn: string[] } };
    };
    assert.deepStrictEqual(generatedTurbo.tasks.build.dependsOn, ["^build"]);
    for (const targetRoot of targets) {
      const rootManifest = await readManifest(targetRoot, ".");
      assert.strictEqual(
        rootManifest.devDependencies["@changesets/cli"],
        "catalog:",
      );
      assert.match(
        rootManifest.scripts["publication:pack"],
        /turbo run build/u,
      );
    }
  });

  void it("直接参考与预设CLI都只通过显式节点身份连接已有库", async () => {
    for (const usePreset of [false, true]) {
      const targetRoot = await createTargetRoot(
        usePreset ? "template-ts-cli-preset-link-" : "template-ts-cli-link-",
      );
      const generator = createDefaultGenerator({ content });
      const initialized = await generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
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
      const rootManifest = await readManifest(targetRoot, ".");
      rootManifest.scripts["user:note"] = "node --version";
      await writeFile(
        path.join(targetRoot, "package.json"),
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      const releaseWorkflowPath = path.join(
        targetRoot,
        ".github/workflows/release.yml",
      );
      await writeFile(
        releaseWorkflowPath,
        `${await readFile(releaseWorkflowPath, "utf8")}\n# 用户保留的发布工作流定制\n`,
      );

      const planned = await generator.planAdd({
        repositoryRoot: targetRoot,
        ...(usePreset
          ? { preset: preset.identity }
          : { contentIdentity: cli.identity, nodeIdentity: "cli" }),
        creationInput: { linkTo: { nodeIdentity: "library" } },
      });
      assert.strictEqual(planned.status, "planned", JSON.stringify(planned));
      if (planned.status !== "planned") {
        throw new Error("CLI显式库连接应可规划");
      }
      assert.strictEqual(planned.blueprint.packageLinkIntents.length, 1);
      const committed = await generator.commitPlan(planned.plan);
      assert.strictEqual(
        committed.status,
        "success",
        JSON.stringify(committed),
      );

      const manifest = await readManifest(targetRoot, "packages/cli");
      assert.strictEqual(manifest.dependencies["@demo/lib"], "workspace:*");
      assert.strictEqual(
        (await readManifest(targetRoot, ".")).scripts["user:note"],
        "node --version",
      );
      assert.match(
        await readFile(releaseWorkflowPath, "utf8"),
        /# 用户保留的发布工作流定制/u,
      );

      manifest.dependencies["@demo/custom"] = "workspace:*";
      await writeFile(
        path.join(targetRoot, "packages/cli/package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const addedAgain = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: {
          leafName: "cli-extra",
          linkTo: { nodeIdentity: "library" },
        },
      });
      assert.strictEqual(
        addedAgain.status,
        "success",
        JSON.stringify(addedAgain),
      );
      const customizedManifest = await readManifest(targetRoot, "packages/cli");
      assert.strictEqual(
        customizedManifest.dependencies["@demo/lib"],
        "workspace:*",
      );
      assert.strictEqual(
        customizedManifest.dependencies["@demo/custom"],
        "workspace:*",
      );
      const blueprint = JSON.parse(
        await readFile(
          path.join(targetRoot, ".template/blueprint.json"),
          "utf8",
        ),
      ) as { readonly packageLinkIntents: readonly unknown[] };
      assert.strictEqual(blueprint.packageLinkIntents.length, 2);
    }
  });

  void it("按实例ID选择同名库，并在后续加包时保留该连接", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-instance-link-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        presets: [
          {
            contentIdentity: libraryPreset.identity,
            creationInput: { leafName: "lib-one" },
          },
          {
            contentIdentity: libraryPreset.identity,
            creationInput: { leafName: "lib-two" },
          },
        ],
      },
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
    if (initialized.status !== "success") {
      throw new Error("两个同名节点应初始化为不同的包实例");
    }
    const selectedLibrary = initialized.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "packages/lib-two",
    );
    assert.ok(selectedLibrary);

    const linked = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      nodeIdentity: "cli",
      creationInput: {
        linkTo: { packageDefinitionId: selectedLibrary.packageDefinitionId },
      },
    });
    assert.strictEqual(linked.status, "success", JSON.stringify(linked));
    if (linked.status !== "success") {
      throw new Error("CLI应按实例ID连接指定的库");
    }
    const cliPackage = linked.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "packages/cli",
    );
    assert.ok(cliPackage);
    assert.deepStrictEqual(linked.blueprint.packageLinkIntents, [
      {
        consumerId: cliPackage.packageDefinitionId,
        providerId: selectedLibrary.packageDefinitionId,
      },
    ]);
    const linkedManifest = await readManifest(targetRoot, "packages/cli");
    assert.strictEqual(
      linkedManifest.dependencies["@demo/lib-two"],
      "workspace:*",
    );
    assert.strictEqual(linkedManifest.dependencies["@demo/lib"], undefined);

    const addedSameName = await generator.add({
      repositoryRoot: targetRoot,
      preset: libraryPreset.identity,
      creationInput: { leafName: "lib-three" },
    });
    assert.strictEqual(
      addedSameName.status,
      "success",
      JSON.stringify(addedSameName),
    );
    if (addedSameName.status !== "success") {
      throw new Error("后续同名节点不能改变已有CLI连接");
    }
    assert.deepStrictEqual(
      addedSameName.blueprint.packageLinkIntents,
      linked.blueprint.packageLinkIntents,
    );
    assert.strictEqual(
      (await readManifest(targetRoot, "packages/cli")).dependencies[
        "@demo/lib-two"
      ],
      "workspace:*",
    );
  });

  void it("未知节点身份或不兼容的原生提供者会在写入前拒绝", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-invalid-link-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
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
    const beforeUnknown = await snapshotTree(targetRoot);
    const unknown = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "not-selected" } },
    });
    assert.strictEqual(unknown.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeUnknown);

    const missingId = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        linkTo: { packageDefinitionId: "package-not-restored" },
      },
    });
    assert.strictEqual(missingId.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeUnknown);

    const nativeTarget = await createTargetRoot("template-ts-cli-native-link-");
    const nativeGenerator = createDefaultGenerator({ content });
    const nativeInitialized = await nativeGenerator.init({
      targetRoot: nativeTarget,
      selection: {
        roots: [{ nodeIdentity: "workspace", contentIdentity: root.identity }],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      nativeInitialized.status,
      "success",
      JSON.stringify(nativeInitialized),
    );
    const beforeNative = await snapshotTree(nativeTarget);
    const native = await nativeGenerator.add({
      repositoryRoot: nativeTarget,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "workspace" } },
    });
    assert.strictEqual(native.status, "operation-failure");
    assert.strictEqual(await snapshotTree(nativeTarget), beforeNative);
  });

  void it("读取的提供者清单和字符串导出目标会过期而无关编辑可提交", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-read-facts-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
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
    const providerManifestPath = path.join(
      targetRoot,
      "packages/lib/package.json",
    );
    const providerManifest = JSON.parse(
      await readFile(providerManifestPath, "utf8"),
    ) as Record<string, any>;
    providerManifest.exports["."] = "./src/index.ts";
    await writeFile(
      providerManifestPath,
      `${JSON.stringify(providerManifest, null, 2)}\n`,
    );
    const providerSourcePath = path.join(
      targetRoot,
      "packages/lib/src/index.ts",
    );

    const staleTargetPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(staleTargetPlan.status, "planned");
    if (staleTargetPlan.status !== "planned") {
      throw new Error("有效CLI显式连接应可规划");
    }
    const originalSource = await readFile(providerSourcePath, "utf8");
    await writeFile(providerSourcePath, `${originalSource}\n// 当前修改\n`);
    const staleTargetCommit = await generator.commitPlan(staleTargetPlan.plan);
    assert.strictEqual(staleTargetCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/cli")));

    const staleManifestPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(staleManifestPlan.status, "planned");
    if (staleManifestPlan.status !== "planned") {
      throw new Error("当前CLI显式连接应可规划");
    }
    const changedManifest = JSON.parse(
      await readFile(providerManifestPath, "utf8"),
    ) as Record<string, any>;
    changedManifest.description = "用户修改";
    await writeFile(
      providerManifestPath,
      `${JSON.stringify(changedManifest, null, 2)}\n`,
    );
    const staleManifestCommit = await generator.commitPlan(
      staleManifestPlan.plan,
    );
    assert.strictEqual(staleManifestCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/cli")));

    const unrelatedPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(unrelatedPlan.status, "planned");
    if (unrelatedPlan.status !== "planned") {
      throw new Error("当前CLI显式连接应可规划");
    }
    await writeFile(path.join(targetRoot, "notes.txt"), "用户文件\n");
    const unrelatedCommit = await generator.commitPlan(unrelatedPlan.plan);
    assert.strictEqual(
      unrelatedCommit.status,
      "success",
      JSON.stringify(unrelatedCommit),
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "notes.txt"), "utf8"),
      "用户文件\n",
    );

    const linkedConsumerManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const staleConsumerPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "next-cli",
        linkTo: { nodeIdentity: "library" },
      },
    });
    assert.strictEqual(staleConsumerPlan.status, "planned");
    if (staleConsumerPlan.status !== "planned") {
      throw new Error("已有CLI连接应可回放并继续加包");
    }
    const customizedConsumer = JSON.parse(
      await readFile(linkedConsumerManifestPath, "utf8"),
    ) as Record<string, any>;
    customizedConsumer.scripts["user:note"] = "node custom";
    await writeFile(
      linkedConsumerManifestPath,
      `${JSON.stringify(customizedConsumer, null, 2)}\n`,
    );
    const staleConsumerCommit = await generator.commitPlan(
      staleConsumerPlan.plan,
    );
    assert.strictEqual(staleConsumerCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/next-cli")));
  });

  void it("当前提供者移除可导入入口时零写入失败", async () => {
    const targetRoot = await createTargetRoot(
      "template-ts-cli-invalid-export-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
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
    const manifestPath = path.join(targetRoot, "packages/lib/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      any
    >;
    delete manifest.exports["."].default;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("新CLI目标目录冲突时保留用户文件内容和权限", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-path-conflict-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
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
    const occupiedDirectory = path.join(targetRoot, "packages/occupied-cli");
    await mkdir(occupiedDirectory, { recursive: true });
    const userManifest = path.join(occupiedDirectory, "package.json");
    await writeFile(userManifest, '{"name":"user-package"}\n');
    await chmod(userManifest, 0o640);
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        leafName: "occupied-cli",
        packagePath: "packages/occupied-cli",
        linkTo: { nodeIdentity: "library" },
      },
    });

    assert.strictEqual(result.status, "conflict");
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("整个工作区的二进制入口名称必须唯一", async () => {
    const duplicateDefinition = defineReferencePackage({
      manifest: {
        name: "@fixture/duplicate-command",
        private: true,
        type: "module",
        bin: { cli: "./dist/cli.js" },
        exports: {
          "./reference": "./package.json",
          "./template": {
            source: "./template/definition.ts",
            types: "./template-dist/definition.d.ts",
            default: "./template-dist/definition.js",
          },
        },
      },
      resourceRoot: new URL("../", import.meta.url),
      alias: "duplicate-command",
      instance: "independent",
      defaultLeafName: "duplicate-tool",
      role: "shared-library",
      resources: [],
      templateExports: ["./template"],
    });
    const duplicateMember: LoadedContentMember<
      typeof duplicateDefinition,
      "reference"
    > = {
      identity: {
        namespace: "fixture",
        packageName: "@fixture/duplicate-command",
        exportPath: "./template",
      },
      kind: "reference",
      alias: duplicateDefinition.alias,
      definition: duplicateDefinition,
      source: {
        specifier: "@fixture/duplicate-command/template",
        moduleURL: import.meta.url,
        manifestURL: import.meta.url,
      },
    };
    const targetRoot = await createTargetRoot(
      "template-ts-cli-duplicate-command-",
    );
    await mkdir(targetRoot);
    const before = await snapshotTree(targetRoot);
    const result = await createDefaultGenerator({
      content: [...content, duplicateMember],
    }).init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "cli", contentIdentity: cli.identity },
          { nodeIdentity: "tool", contentIdentity: duplicateMember.identity },
        ],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.match(
      result.status === "operation-failure" ? result.error.message : "",
      /CLI命令名称 "cli" 重复：@demo\/cli 与 @demo\/duplicate-tool/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });
});
