import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { renderProject } from "@ykdz/template-core/renderer";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";

async function fixture(
  context: TestContext,
  files: Readonly<Record<string, string>>,
  manifest: Readonly<Record<string, unknown>> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "reference-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({
      name: "@author/application",
      private: true,
      type: "module",
      exports: {
        "./reference": "./package.json",
        "./assets/*": "./*",
      },
      ...manifest,
    }),
    ...files,
  })) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), value);
  }
  await writeFile(
    path.join(source, "resolve.mjs"),
    "export const resolve = (specifier) => import.meta.resolve(specifier);\n",
  );
  const { resolve } = (await import(
    pathToFileURL(path.join(source, "resolve.mjs")).href
  )) as {
    resolve: (specifier: string) => string;
  };
  return {
    source,
    target,
    options: {
      packageName: "@author/application",
      resolve,
      identity: "application",
      instance: "independent" as const,
      defaultLeafName: "application",
      role: "runtime-service" as const,
      resources: ["."],
      resourceIgnore: "/resolve.mjs\n",
      authoring: { dependencies: [], scripts: [] },
      foundation: {
        toolchains: {},
        editorCapabilities: [],
        dependencyMaintenance: { ecosystems: [], interval: "weekly" as const },
      },
      environmentNeeds: [],
    },
    input: {
      context: {
        targetDir: target,
        repositoryName: "consumer",
        defaultPackageScope: "consumer",
        foundationPackages: {
          typescriptConfiguration: { name: "@consumer/config" },
        },
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@12.9.1" },
      },
      definition: {
        name: "@consumer/application",
        path: "apps/application",
        role: "runtime-service" as const,
      },
    },
  };
}

await test("未提交普通文件自动生成，忽略规则在无 Git 的资源目录中仍生效", async (context) => {
  const setup = await fixture(context, {
    ".gitignore": "node_modules/\n.cache/\n*.log\n",
    "src/.gitignore": "*.secret\n!public.secret\n",
    "src/new.txt": "新源码\n",
    "src/public.secret": "可公开的内容\n",
    "src/private.secret": "不交付\n",
    "src/debug.log": "诊断\n",
    "test/application.test.js": "export const checked = true;\n",
    "node_modules/dependency/index.js": "依赖安装内容\n",
    ".cache/result": "缓存\n",
  });
  const reference = defineReferencePackage(setup.options);
  const contribution = reference.contribute(setup.input);
  await renderProject({
    targetRoot: setup.target,
    operations: [...contribution.operations],
  });
  const output = path.join(setup.target, "apps/application");
  const files = (
    await readdir(output, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(output, path.join(entry.parentPath, entry.name)),
    )
    .sort();
  assert.deepEqual(files, [
    ".gitignore",
    "package.json",
    "src/.gitignore",
    "src/new.txt",
    "src/public.secret",
    "test/application.test.js",
  ]);
  assert.equal(
    await readFile(path.join(output, "src/new.txt"), "utf8"),
    "新源码\n",
  );
});

await test("普通 JSON 业务资源按原始字节生成，不解释 include 或包身份", async (context) => {
  const files = {
    "src/data.json": "null\n",
    "test/fixture.json":
      '{\n\t"include": ["template/example"], "package": "@author/application"\n}\n',
  };
  const setup = await fixture(context, files);
  const reference = defineReferencePackage({
    ...setup.options,
    authoring: { dependencies: [], scripts: [], resources: ["template"] },
  });
  const contribution = reference.contribute(setup.input);
  await renderProject({
    targetRoot: setup.target,
    operations: [...contribution.operations],
  });
  for (const [file, content] of Object.entries(files)) {
    assert.equal(
      await readFile(path.join(setup.target, "apps/application", file), "utf8"),
      content,
    );
  }
});

await test("作者用途声明同步剔除作者资源、命令和任务配置并保留用户测试", async (context) => {
  const setup = await fixture(
    context,
    {
      "src/application.txt": "应用\n",
      "template/definition.js": "作者描述\n",
      "template-dist/definition.js": "作者编译产物\n",
      "tsconfig.template.json": "{}",
      "tsconfig.json": JSON.stringify({
        include: ["src/**/*.ts", "template/**/*.ts"],
      }),
      "turbo.json": JSON.stringify({
        extends: ["//"],
        tasks: {
          "build:template": {
            tags: ["work:preparation"],
            outputs: ["template-dist/**"],
          },
          test: { tags: ["quality:light"], dependsOn: [] },
        },
      }),
    },
    {
      scripts: {
        "build:template": "tsc -p tsconfig.template.json",
        test: "node --test",
      },
    },
  );
  const reference = defineReferencePackage({
    ...setup.options,
    authoring: {
      dependencies: [],
      scripts: ["build:template"],
      resources: ["template", "template-dist", "tsconfig.template.json"],
    },
  });
  const contribution = reference.contribute(setup.input);
  await renderProject({
    targetRoot: setup.target,
    operations: [...contribution.operations],
  });
  const output = path.join(setup.target, "apps/application");
  assert.deepEqual(contribution.manifest.scripts, { test: "node --test" });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output, "turbo.json"), "utf8")),
    {
      extends: ["//"],
      tasks: { test: { tags: ["quality:light"], dependsOn: [] } },
    },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output, "tsconfig.json"), "utf8")),
    {
      include: ["src/**/*.ts"],
    },
  );
  assert.deepEqual((await readdir(output)).sort(), [
    "package.json",
    "src",
    "tsconfig.json",
    "turbo.json",
  ]);
});

await test("原生 JSONC 配置支持注释和尾逗号，并只移除作者用途", async (context) => {
  const setup = await fixture(context, {
    "tsconfig.json": `{
      // 作者和产品在维护期共享检查。
      "extends": "@author/config/node.json",
      "include": ["src/**/*.ts", "template/**/*.ts",],
    }`,
    "turbo.jsonc": `{
      // 生成后仅保留产品任务。
      "tasks": {
        "build:template": {},
        "build": {"dependsOn": ["@author/config#build",],},
      },
    }`,
  });
  const reference = defineReferencePackage({
    ...setup.options,
    authoring: {
      dependencies: [],
      scripts: ["build:template"],
      resources: ["template"],
    },
  });
  const contribution = reference.contribute({
    ...setup.input,
    bindings: new Map([
      [
        "@author/config",
        {
          name: "@consumer/types",
          path: "settings/types",
          role: "shared-library",
        },
      ],
    ]),
  });
  await renderProject({
    targetRoot: setup.target,
    operations: [...contribution.operations],
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(setup.target, "apps/application/tsconfig.json"),
        "utf8",
      ),
    ),
    { extends: "@consumer/types/node.json", include: ["src/**/*.ts"] },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(setup.target, "apps/application/turbo.jsonc"),
        "utf8",
      ),
    ),
    { tasks: { build: { dependsOn: ["@consumer/types#build"] } } },
  );
});

await test("组合身份映射保留原生依赖协议，并只重映射精确的包任务身份", async (context) => {
  const setup = await fixture(
    context,
    {
      "turbo.json": JSON.stringify({
        tasks: {
          "@author/application#check": {
            dependsOn: [
              "@author/config#build",
              "@author/component#build",
              "@author/configuration#build",
            ],
          },
        },
      }),
    },
    {
      private: false,
      dependencies: { "@author/component": "link:../component" },
      devDependencies: { "@author/config": "workspace:*" },
      optionalDependencies: { "@author/config": "workspace:../config" },
      peerDependencies: { "@author/component": "^1.0.0" },
      description: "说明 @author/config#build 不属于任务身份",
    },
  );
  const reference = defineReferencePackage(setup.options);
  const contribution = reference.contribute({
    ...setup.input,
    bindings: new Map([
      [
        "@author/config",
        {
          name: "@consumer/types",
          path: "settings/types",
          role: "shared-library" as const,
        },
      ],
      [
        "@author/component",
        {
          name: "@consumer/ui",
          path: "packages/ui",
          role: "shared-library" as const,
        },
      ],
    ]),
  });
  await renderProject({
    targetRoot: setup.target,
    operations: [...contribution.operations],
  });
  assert.deepEqual(contribution.manifest.dependencies, {
    "@consumer/ui": "link:../../packages/ui",
  });
  assert.deepEqual(contribution.manifest.devDependencies, {
    "@consumer/types": "workspace:*",
  });
  assert.deepEqual(contribution.manifest.optionalDependencies, {
    "@consumer/types": "workspace:../../settings/types",
  });
  assert.deepEqual(contribution.manifest.peerDependencies, {
    "@consumer/ui": "^1.0.0",
  });
  assert.equal(
    contribution.manifest.description,
    "说明 @author/config#build 不属于任务身份",
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(setup.target, "apps/application/turbo.json"),
        "utf8",
      ),
    ),
    {
      tasks: {
        "@consumer/application#check": {
          dependsOn: [
            "@consumer/types#build",
            "@consumer/ui#build",
            "@author/configuration#build",
          ],
        },
      },
    },
  );
});

await test("发布载荷保留生成描述读取的作者资产且继续排除安装产物", async (context) => {
  const setup = await fixture(context, {
    ".gitignore": "node_modules/\n.cache/\n",
    "src/application.txt": "应用\n",
    "template/rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
    "node_modules/dependency/index.js": "安装产物\n",
    ".cache/build": "缓存\n",
  });
  const reference = defineReferencePackage({
    ...setup.options,
    authoring: { dependencies: [], scripts: [], resources: ["template"] },
  });
  await renderProject({
    targetRoot: setup.target,
    operations: reference.payloadOperations("payload"),
  });
  assert.equal(
    await readFile(
      path.join(setup.target, "payload/template/rust-toolchain.toml"),
      "utf8",
    ),
    '[toolchain]\nchannel = "stable"\n',
  );
  assert.deepEqual((await readdir(path.join(setup.target, "payload"))).sort(), [
    ".gitignore",
    "src",
    "template",
  ]);
});
