import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import type { PackageBinding } from "@ykdz/template-core/reference-package";
import {
  defineReferencePackage,
  type ReferencePackageManifest,
} from "@ykdz/template-workspace/reference-package";

type Fixture = {
  readonly source: string;
  readonly manifest: ReferencePackageManifest;
  readonly files: Readonly<Record<string, string>>;
  readonly resources: readonly {
    readonly path: string;
    readonly mode?: number;
    readonly prepareOnly?: boolean;
  }[];
};

async function fixture(
  context: TestContext,
  files: Readonly<Record<string, string>>,
  options: {
    readonly manifest?: Readonly<Record<string, unknown>>;
    readonly modes?: Readonly<Record<string, number>>;
    readonly prepareOnly?: readonly string[];
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "reference-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const manifest = {
    ...options.manifest,
    name: "@author/application",
    private: true,
    type: "module",
    exports: { "./reference": "./package.json" },
  };
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify(manifest));
  for (const [file, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), value);
    const mode = options.modes?.[file];
    if (mode !== undefined) await chmod(path.join(source, file), mode);
  }
  return {
    source,
    manifest,
    files,
    resources: Object.keys(files).map((file) => ({
      path: file,
      ...(options.modes?.[file] === undefined
        ? {}
        : { mode: options.modes[file] }),
      ...(options.prepareOnly?.includes(file) === true
        ? { prepareOnly: true }
        : {}),
    })),
  };
}

function reference(
  setup: Fixture,
  options: {
    readonly dependencies?: Parameters<
      typeof defineReferencePackage
    >[0]["dependencies"];
    readonly templateScripts?: readonly string[];
    readonly transformManifest?: Parameters<
      typeof defineReferencePackage
    >[0]["transformManifest"];
    readonly transformDocument?: Parameters<
      typeof defineReferencePackage
    >[0]["transformDocument"];
  } = {},
) {
  return defineReferencePackage({
    manifest: setup.manifest,
    resourceRoot: pathToFileURL(setup.source + path.sep),
    alias: "application",
    instance: "independent",
    defaultLeafName: "application",
    role: "runtime-service",
    resources: setup.resources,
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.templateScripts === undefined
      ? {}
      : { templateScripts: options.templateScripts }),
    ...(options.transformManifest === undefined
      ? {}
      : { transformManifest: options.transformManifest }),
    ...(options.transformDocument === undefined
      ? {}
      : { transformDocument: options.transformDocument }),
  });
}

function packageBinding(options: {
  readonly key: string;
  readonly contentPackageName: string;
  readonly name: string;
  readonly path: string;
  readonly role: "shared-library";
}): readonly [string, PackageBinding] {
  const packageDefinitionId = "package-provider";
  return [
    options.key,
    {
      packageDefinitionId,
      contentIdentity: {
        namespace: "author",
        packageName: options.contentPackageName,
        exportPath: "./template",
      },
      definition: {
        packageDefinitionId,
        name: options.name,
        path: options.path,
        role: options.role,
      },
      facts: undefined,
    },
  ];
}

async function evaluate(
  setup: Fixture,
  options: {
    readonly dependencies?: Parameters<
      typeof defineReferencePackage
    >[0]["dependencies"];
    readonly templateScripts?: readonly string[];
    readonly bindings?: readonly (readonly [string, PackageBinding])[];
    readonly transformManifest?: Parameters<
      typeof defineReferencePackage
    >[0]["transformManifest"];
    readonly transformDocument?: Parameters<
      typeof defineReferencePackage
    >[0]["transformDocument"];
  } = {},
) {
  const definition = reference(setup, options);
  const prepared = definition.prepare({ excludedPackagePaths: [] });
  const packageDefinitionId = "package-application";
  const contribution = definition.evaluate({
    packageDefinitionId,
    definition: {
      packageDefinitionId,
      name: "@consumer/application",
      path: "apps/application",
      role: "runtime-service",
    },
    createdBy: "initialization",
    creationInput: undefined,
    prepared,
    bindings: new Map(options.bindings ?? []),
    conventions: {
      repositoryName: "consumer",
      defaultPackageScope: "consumer",
    },
    stableCommon: {
      nodeDeclaration: "24.21.0",
      packageManagerPin: "pnpm@12.9.1",
    },
    packageInput: undefined,
  });
  return { prepared, contribution };
}

function fileText(
  contribution: Awaited<ReturnType<typeof evaluate>>["contribution"],
  filePath: string,
): string {
  const file = contribution.files.find(
    (candidate) => candidate.path === filePath,
  );
  assert.ok(file, `expected evaluated package file ${filePath}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
}

await test("只投影显式声明的资源，并保留普通资源来源字节", async (context) => {
  const files = {
    "src/new.txt": "新源码\n",
    "src/data.json": "null\n",
    "test/fixture.json": '{\n\t"include": ["template/example"]\n}\n',
  };
  const setup = await fixture(context, files);
  const { prepared, contribution } = await evaluate(setup);
  assert.deepEqual(
    prepared.resources.map(({ path: resourcePath }) => resourcePath).toSorted(),
    Object.keys(files).toSorted(),
  );
  for (const [file, content] of Object.entries(files)) {
    assert.equal(fileText(contribution, file), content);
  }
});

await test("映射 TypeScript 导入到显式绑定并保留源文件执行权限", async (context) => {
  const sourceText = [
    'import { own } from "@author/application/internal";',
    'export { shared } from "@author/shared/runtime";',
    'import { root } from "@author/shared";',
    'const documented = "@author/shared/runtime";',
    'void import("@author/shared/lazy");',
    "",
  ].join("\n");
  const setup = await fixture(
    context,
    { "src/main.ts": sourceText },
    { modes: { "src/main.ts": 0o751 } },
  );
  const { contribution } = await evaluate(setup, {
    dependencies: [
      {
        key: "shared",
        contentIdentity: {
          namespace: "author",
          packageName: "@author/shared",
          exportPath: "./template",
        },
      },
    ],
    bindings: [
      packageBinding({
        key: "shared",
        contentPackageName: "@author/shared",
        name: "@consumer/shared",
        path: "packages/shared",
        role: "shared-library",
      }),
    ],
  });
  const output = contribution.files.find((file) => file.path === "src/main.ts");
  assert.ok(output);
  assert.equal(
    fileText(contribution, "src/main.ts"),
    [
      'import { own } from "@consumer/application/internal";',
      'export { shared } from "@consumer/shared/runtime";',
      'import { root } from "@consumer/shared";',
      'const documented = "@author/shared/runtime";',
      'void import("@author/shared/lazy");',
      "",
    ].join("\n"),
  );
  assert.equal(output.mode, 0o111);
});

await test("剔除作者资源、脚本和任务，同时保留产品测试配置", async (context) => {
  const setup = await fixture(
    context,
    {
      "src/application.txt": "应用\n",
      "template/definition.js": "作者描述\n",
      "tsconfig.template.json": "{}\n",
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
      manifest: {
        scripts: {
          "build:template": "tsc -p tsconfig.template.json",
          test: "node --test",
        },
      },
      prepareOnly: ["template/definition.js", "tsconfig.template.json"],
    },
  );
  const { contribution } = await evaluate(setup, {
    templateScripts: ["build:template"],
    transformDocument: ({ path: documentPath, value }) => {
      if (documentPath !== "tsconfig.json" || !Array.isArray(value.include)) {
        return value;
      }
      return {
        ...value,
        include: value.include.filter(
          (entry) =>
            typeof entry === "string" && !entry.startsWith("template/"),
        ),
      };
    },
  });
  assert.deepEqual(contribution.facts.manifest.scripts, {
    test: "node --test",
  });
  const turboDocument = contribution.facts.nativeDocuments.find(
    ({ path: documentPath }) => documentPath === "turbo.json",
  );
  assert.ok(turboDocument);
  assert.deepEqual(turboDocument.value, {
    extends: ["//"],
    tasks: { test: { tags: ["quality:light"], dependsOn: [] } },
  });
  const typescriptDocument = contribution.facts.nativeDocuments.find(
    ({ path: documentPath }) => documentPath === "tsconfig.json",
  );
  assert.ok(typescriptDocument);
  assert.deepEqual(typescriptDocument.value, {
    include: ["src/**/*.ts"],
  });
  assert.deepEqual(
    contribution.files.map(({ path: filePath }) => filePath).toSorted(),
    ["src/application.txt"],
  );
});

await test("保留依赖协议，并只重映射精确包任务身份", async (context) => {
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
      manifest: {
        private: false,
        dependencies: { "@author/component": "link:../component" },
        devDependencies: { "@author/config": "workspace:*" },
        optionalDependencies: { "@author/config": "workspace:../config" },
        peerDependencies: { "@author/component": "^1.0.0" },
        description: "说明 @author/config#build 不属于任务身份",
      },
    },
  );
  const { contribution } = await evaluate(setup, {
    dependencies: [
      {
        key: "config",
        contentIdentity: {
          namespace: "author",
          packageName: "@author/config",
          exportPath: "./template",
        },
      },
      {
        key: "component",
        contentIdentity: {
          namespace: "author",
          packageName: "@author/component",
          exportPath: "./template",
        },
      },
    ],
    bindings: [
      packageBinding({
        key: "config",
        contentPackageName: "@author/config",
        name: "@consumer/types",
        path: "settings/types",
        role: "shared-library",
      }),
      packageBinding({
        key: "component",
        contentPackageName: "@author/component",
        name: "@consumer/ui",
        path: "packages/ui",
        role: "shared-library",
      }),
    ],
  });
  assert.deepEqual(contribution.facts.manifest.dependencies, {
    "@consumer/ui": "link:../../packages/ui",
  });
  assert.deepEqual(contribution.facts.manifest.devDependencies, {
    "@consumer/types": "workspace:*",
  });
  assert.deepEqual(contribution.facts.manifest.optionalDependencies, {
    "@consumer/types": "workspace:../../settings/types",
  });
  assert.deepEqual(contribution.facts.manifest.peerDependencies, {
    "@consumer/ui": "^1.0.0",
  });
  assert.equal(
    contribution.facts.manifest.description,
    "说明 @author/config#build 不属于任务身份",
  );
  const turboDocument = contribution.facts.nativeDocuments.find(
    ({ path: documentPath }) => documentPath === "turbo.json",
  );
  assert.ok(turboDocument);
  assert.deepEqual(turboDocument.value, {
    tasks: {
      "@consumer/application#check": {
        dependsOn: [
          "@consumer/types#build",
          "@consumer/ui#build",
          "@author/configuration#build",
        ],
      },
    },
  });
});
