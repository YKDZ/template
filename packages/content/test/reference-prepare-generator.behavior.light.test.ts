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
import { it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import {
  templateContent,
  templatePresets,
  templateReferencePackages,
} from "@ykdz/template-content";
import type { LoadedContentMember } from "@ykdz/template-core/content-identity";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

type TestReference = ReturnType<typeof defineReferencePackage>;

async function packageFixture(
  context: TestContext,
  options: {
    readonly alias: string;
    readonly packageName: string;
    readonly resources: readonly { readonly path: string }[];
    readonly manifest?: Readonly<Record<string, unknown>>;
    readonly templateDependencies?: Parameters<
      typeof defineReferencePackage
    >[0]["templateDependencies"];
    readonly dependencies?: Parameters<
      typeof defineReferencePackage
    >[0]["dependencies"];
    readonly executionDependencies?: readonly string[];
    readonly prepareFacts?: Parameters<
      typeof defineReferencePackage
    >[0]["prepareFacts"];
  },
): Promise<{
  readonly root: string;
  readonly identity: LoadedContentMember["identity"];
  readonly member: LoadedContentMember;
  readonly definition: TestReference;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reference-prepare-owner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  const manifest = {
    name: options.packageName,
    private: true,
    type: "module",
    exports: {
      ".": {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./reference": "./package.json",
      "./template": { default: "./dist/template.js" },
    },
    ...options.manifest,
  };
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "src/index.ts"),
    "export const ownerResource = true;\n",
  );
  await writeFile(path.join(root, "README.md"), "不属于资源快照\n");

  const definition = defineReferencePackage({
    manifest,
    resourceRoot: pathToFileURL(`${root}${path.sep}`),
    alias: options.alias,
    instance: "independent",
    defaultLeafName: options.alias,
    role: "shared-library",
    resources: options.resources,
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.templateDependencies === undefined
      ? {}
      : { templateDependencies: options.templateDependencies }),
    ...(options.executionDependencies === undefined
      ? {}
      : { executionDependencies: options.executionDependencies }),
    ...(options.prepareFacts === undefined
      ? {}
      : { prepareFacts: options.prepareFacts }),
  });
  const identity = {
    namespace: "reference-prepare-fixture",
    packageName: options.packageName,
    exportPath: "./template",
  } as const;
  const member: LoadedContentMember = {
    identity,
    kind: "reference",
    alias: options.alias,
    definition,
    source: {
      specifier: import.meta.url,
      moduleURL: import.meta.url,
      manifestURL: pathToFileURL(path.join(root, "package.json")).href,
    },
  };
  return { root, identity, member, definition };
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

function presetIdentity(alias: string) {
  const preset = templatePresets.find((member) => member.alias === alias);
  assert.ok(preset, `内容集合缺少预设：${alias}`);
  return preset.identity;
}

function referenceMember(packageName: string) {
  const member = templateReferencePackages.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(member, `内容集合缺少参考包：${packageName}`);
  return member;
}

void it("ts-lib预设通过所属资源快照生成源码并绑定共享配置", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-reference-prepare-init-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, "demo");
  const result = await createDefaultGenerator({
    content: templateContent,
  }).init({
    targetRoot,
    selection: { presets: [{ contentIdentity: presetIdentity("ts-lib") }] },
    conventions: {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    },
  });

  assert.equal(result.status, "success", JSON.stringify(result));
  if (result.status !== "success") return;
  const library = referenceMember("@ykdz/reference-ts-lib");
  const prepared = library.definition.prepare({ excludedPackagePaths: [] });
  const source = prepared.resources.find(
    (resource) => resource.path === "src/index.ts",
  );
  assert.ok(source);
  assert.equal(
    await readFile(path.join(targetRoot, "packages/lib/src/index.ts"), "utf8"),
    new TextDecoder("utf-8", { fatal: true }).decode(source.content),
  );
  const libraryPackage = result.generationRecord.packages.find(
    ({ contentIdentity }) =>
      contentIdentity.packageName === "@ykdz/reference-ts-lib",
  );
  assert.ok(libraryPackage);
  const toolingConfigId = libraryPackage.dependencyBindings["tooling-config"];
  assert.ok(toolingConfigId);
  assert.equal(
    result.generationRecord.packages.find(
      ({ packageDefinitionId }) => packageDefinitionId === toolingConfigId,
    )?.contentIdentity.packageName,
    "@ykdz/reference-tooling-config",
  );
  assert.equal(
    (await stat(path.join(targetRoot, "packages/lib/src/index.ts"))).mode &
      0o111,
    source.mode,
  );
});

void it("Rust预设生成所属Cargo声明和锁文件", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-reference-prepare-rust-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, "demo");
  const result = await createDefaultGenerator({
    content: templateContent,
  }).init({
    targetRoot,
    selection: { presets: [{ contentIdentity: presetIdentity("rust-bin") }] },
    conventions: {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    },
  });

  assert.equal(result.status, "success", JSON.stringify(result));
  assert.match(
    await readFile(path.join(targetRoot, "packages/app/Cargo.toml"), "utf8"),
    /name = "app"/u,
  );
  assert.match(
    await readFile(path.join(targetRoot, "packages/app/Cargo.lock"), "utf8"),
    /name = "app"/u,
  );
});

void it("缺少已声明资源时add规划失败且不写入项目", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-reference-prepare-missing-add-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, "demo");
  const generator = createDefaultGenerator({ content: templateContent });
  const initialized = await generator.init({
    targetRoot,
    selection: { presets: [{ contentIdentity: presetIdentity("ts-lib") }] },
    conventions: {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));

  const missing = await packageFixture(context, {
    alias: "missing-resource",
    packageName: "@fixture/missing-resource",
    resources: [{ path: "src/index.ts" }, { path: "src/missing.ts" }],
  });
  const freshGenerator = createDefaultGenerator({
    content: [...templateContent, missing.member],
  });
  const before = await snapshotTree(targetRoot);
  const result = await freshGenerator.planAdd({
    repositoryRoot: targetRoot,
    contentIdentity: missing.identity,
    creationInput: { packagePath: "packages/missing-resource" },
  });

  assert.equal(result.status, "operation-failure");
  if (result.status !== "operation-failure") return;
  assert.equal(result.phase, "preparation");
  assert.match(result.error.message, /src\/missing\.ts/u);
  assert.deepEqual(await snapshotTree(targetRoot), before);
});

void it("资源准备只读取显式声明的文件", async (context) => {
  const fixture = await packageFixture(context, {
    alias: "scoped-resource",
    packageName: "@fixture/scoped-resource",
    resources: [{ path: "src/index.ts" }],
    prepareFacts(resources) {
      return { paths: resources.map(({ path: resourcePath }) => resourcePath) };
    },
  });
  const prepared = fixture.definition.prepare({ excludedPackagePaths: [] });
  assert.deepEqual(
    prepared.resources.map(({ path: resourcePath }) => resourcePath),
    ["src/index.ts"],
  );
  assert.deepEqual(prepared.facts.ownerFacts, { paths: ["src/index.ts"] });
});

void it("fresh add解析缺失的owner依赖时不改写项目", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-reference-prepare-missing-dependency-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, "demo");
  const initialized = await createDefaultGenerator({
    content: templateContent,
  }).init({
    targetRoot,
    selection: { presets: [{ contentIdentity: presetIdentity("ts-lib") }] },
    conventions: {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    },
  });
  assert.equal(initialized.status, "success", JSON.stringify(initialized));

  const missing = await packageFixture(context, {
    alias: "missing-runtime",
    packageName: "@fixture/missing-runtime-owner",
    resources: [{ path: "src/index.ts" }],
    manifest: {
      dependencies: { "@fixture/missing-template-runtime": "workspace:*" },
    },
    dependencies: [
      {
        key: "missing-runtime",
        ownerLocal: {
          specifier: "@fixture/missing-template-runtime/template",
          resolve: (specifier) => import.meta.resolve(specifier),
        },
      },
    ],
    templateDependencies: [
      {
        name: "@fixture/missing-template-runtime",
        purpose: "template-execution",
      },
    ],
    executionDependencies: ["@fixture/missing-template-runtime"],
  });
  const generator = createDefaultGenerator({
    content: [...templateContent, missing.member],
  });
  const before = await snapshotTree(targetRoot);
  const result = await generator.planAdd({
    repositoryRoot: targetRoot,
    contentIdentity: missing.identity,
  });

  assert.equal(result.status, "operation-failure");
  if (result.status !== "operation-failure") return;
  assert.equal(result.phase, "preparation");
  assert.match(result.error.message, /missing-template-runtime/u);
  assert.deepEqual(await snapshotTree(targetRoot), before);
});
