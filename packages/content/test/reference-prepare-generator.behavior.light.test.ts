import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { referencePackage as honoApi } from "@ykdz/reference-hono-api/template";
import { referencePackage as rustBin } from "@ykdz/reference-rust-bin/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as vueApp } from "@ykdz/reference-vue-app/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import type { LoadedContentMember } from "@ykdz/template-core/content-identity";
import type {
  GeneratorContent,
  PackageCreationInput,
} from "@ykdz/template-core/workspace-strategy";
import { createGenerator } from "@ykdz/template-generator";
import type { PackageContribution } from "@ykdz/template-workspace-authoring/package-contribution";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/generation-context";
import {
  defineReferencePackage,
  type ReferencePackage,
} from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);
const namespace = "ticket-15-first-party";

function loadedReference(
  definition: ReferencePackage,
): GeneratorContent<
  GenerationContext,
  PackageContribution,
  PackageCreationInput
> {
  const packageName = definition.manifest.name;
  const specifier = `${packageName}/template`;
  const member: LoadedContentMember<ReferencePackage, "reference"> = {
    identity: {
      namespace,
      packageName,
      exportPath: "./template",
    },
    kind: "reference",
    alias: definition.alias,
    definition,
    source: {
      specifier,
      moduleURL: import.meta.resolve(specifier),
      manifestURL: import.meta.resolve(`${packageName}/reference`),
    },
  };
  return member as GeneratorContent<
    GenerationContext,
    PackageContribution,
    PackageCreationInput
  >;
}

async function snapshotTree(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const itemPath = path.posix.join(relative, entry.name);
      const mode = (await stat(fullPath)).mode & 0o777;
      if (entry.isDirectory()) {
        entries.push([itemPath, "directory", mode]);
        await visit(fullPath, itemPath);
      } else {
        entries.push([
          itemPath,
          "file",
          mode,
          (await readFile(fullPath)).toString("base64"),
        ]);
      }
    }
  }
  await visit(root);
  return entries;
}

function simpleFoundation(): PackageContribution["foundation"] {
  return {
    toolchains: {},
    editorCapabilities: [],
    dependencyMaintenance: { ecosystems: [], interval: "weekly" },
  };
}

void describe("参考包 owner prepare 的公开生成器生命周期", () => {
  void it("ts-lib init 通过准备资源和共享配置依赖完成正式渲染", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-reference-prepare-init-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const libraryMember = loadedReference(library);
    const configurationMember = loadedReference(configuration);
    const generator = createGenerator({
      content: [libraryMember, configurationMember],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "library",
            contentIdentity: libraryMember.identity,
          },
        ],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(
      await readFile(
        path.join(targetRoot, "packages/lib/src/index.ts"),
        "utf8",
      ),
      await readFile(
        new URL("../../../references/ts-lib/src/index.ts", import.meta.url),
        "utf8",
      ),
    );
    const generatedMode =
      (await stat(path.join(targetRoot, "packages/lib/src/index.ts"))).mode &
      0o777;
    const sourceMode =
      (
        await stat(
          new URL("../../../references/ts-lib/src/index.ts", import.meta.url),
        )
      ).mode & 0o777;
    assert.equal(generatedMode, sourceMode);
  });

  void it("Rust owner prepare 返回的 Cargo 事实由项目贡献消费", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-reference-prepare-rust-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const rustMember = loadedReference(rustBin);
    const configurationMember = loadedReference(configuration);
    const generator = createGenerator({
      content: [rustMember, configurationMember],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "binary", contentIdentity: rustMember.identity },
        ],
      },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.equal(result.status, "success", JSON.stringify(result));
    const manifest = await readFile(
      path.join(targetRoot, "packages/app/Cargo.toml"),
      "utf8",
    );
    const lock = await readFile(
      path.join(targetRoot, "packages/app/Cargo.lock"),
      "utf8",
    );
    assert.match(manifest, /name = "app"/u);
    assert.match(lock, /name = "app"/u);
  });

  void it("init 缺少已声明资源时在规划阶段失败且不创建目标", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-reference-prepare-missing-init-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const missingResource = defineReferencePackage({
      packageName: library.manifest.name,
      resolve: (specifier) => import.meta.resolve(specifier),
      alias: library.alias,
      instance: library.instance,
      defaultLeafName: library.defaultLeafName,
      defaultPath: library.defaultPath,
      role: library.role,
      resources: ["__missing-ts-lib-resource__.ts"],
      template: {
        dependencies: library.templateDependencies,
        scripts: ["build:template"],
        resources: ["template", "tsconfig.template.json"],
      },
      foundation: simpleFoundation(),
      environmentNeeds: [],
    });
    const member = loadedReference(missingResource);
    const generator = createGenerator({
      content: [member],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: member.identity }],
      },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.equal(result.status, "operation-failure");
    if (result.status !== "operation-failure") return;
    assert.equal(result.phase, "planning");
    assert.match(
      result.error.message,
      /@ykdz\/reference-ts-lib.*prepare 阶段失败/u,
    );
    await assert.rejects(stat(targetRoot), { code: "ENOENT" });
  });

  void it("add 的 fresh engine 会先回放 owner 准备，未声明模板依赖不写目标", async (context) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "template-reference-prepare-missing-add-"),
    );
    context.after(async () =>
      rm(temporaryRoot, { recursive: true, force: true }),
    );
    const targetRoot = path.join(temporaryRoot, "demo");
    const apiMember = loadedReference(honoApi);
    const configurationMember = loadedReference(configuration);
    const initialGenerator = createGenerator({
      content: [apiMember, configurationMember],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await initialGenerator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "api", contentIdentity: apiMember.identity }],
      },
      strategyInput: { defaultPackageScope: "demo" },
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
    const before = await snapshotTree(targetRoot);

    const missingDependency = defineReferencePackage({
      packageName: vueApp.manifest.name,
      resolve: (specifier) => import.meta.resolve(specifier),
      alias: vueApp.alias,
      instance: vueApp.instance,
      defaultLeafName: vueApp.defaultLeafName,
      defaultPath: vueApp.defaultPath,
      role: vueApp.role,
      resources: ["."],
      template: {
        dependencies: [
          ...vueApp.templateDependencies,
          {
            name: "@ykdz/missing-template-runtime",
            purpose: "template-execution",
          },
        ],
        scripts: ["build:template"],
        resources: ["template", "tsconfig.template.json"],
      },
      foundation: simpleFoundation(),
      environmentNeeds: [],
    });
    const vueMember = loadedReference(missingDependency);
    const freshGenerator = createGenerator({
      content: [apiMember, configurationMember, vueMember],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await freshGenerator.add({
      repositoryRoot: targetRoot,
      contentIdentity: vueMember.identity,
    });

    assert.equal(result.status, "operation-failure");
    if (result.status !== "operation-failure") return;
    assert.equal(result.phase, "planning");
    assert.match(
      result.error.message,
      /@ykdz\/reference-vue-app.*prepare 阶段失败.*@ykdz\/missing-template-runtime/u,
    );
    assert.deepEqual(await snapshotTree(targetRoot), before);

    const brokenShared = defineReferencePackage({
      packageName: vueShared.manifest.name,
      resolve: (specifier) => import.meta.resolve(specifier),
      alias: vueShared.alias,
      instance: vueShared.instance,
      defaultLeafName: vueShared.defaultLeafName,
      defaultPath: vueShared.defaultPath,
      role: vueShared.role,
      resources: ["."],
      template: {
        dependencies: vueShared.templateDependencies,
        scripts: ["build:template"],
        resources: ["template", "tsconfig.template.json"],
      },
      prepare() {
        throw new Error("fixture shared prepare failure");
      },
      foundation: simpleFoundation(),
      environmentNeeds: [],
    });
    const validVueMember = loadedReference(vueApp);
    const brokenSharedMember = loadedReference(brokenShared);
    const dependencyFailureGenerator = createGenerator({
      content: [
        apiMember,
        configurationMember,
        validVueMember,
        brokenSharedMember,
      ],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const dependencyFailure = await dependencyFailureGenerator.add({
      repositoryRoot: targetRoot,
      contentIdentity: validVueMember.identity,
    });

    assert.equal(dependencyFailure.status, "operation-failure");
    if (dependencyFailure.status !== "operation-failure") return;
    assert.equal(dependencyFailure.phase, "planning");
    assert.match(
      dependencyFailure.error.message,
      /@ykdz\/reference-vue-shared.*prepare 阶段失败.*fixture shared prepare failure/u,
    );
    assert.deepEqual(await snapshotTree(targetRoot), before);
  });
});
