import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";
import type { PackageBinding } from "@ykdz/template-core/reference-package";
import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";

await test("根目录位置本身不注入参考包业务规则", () => {
  const owner = defineReferencePackage({
    manifest: {
      name: "@fixture/workspace",
      version: "1.2.3",
      type: "module",
      exports: {
        "./reference": "./package.json",
        "./template": "./template/definition.js",
      },
      engines: { node: ">=20" },
      packageManager: "npm@10.0.0",
    },
    resourceRoot: new URL("../", import.meta.url),
    alias: "workspace",
    instance: "shared",
    defaultLeafName: "workspace",
    defaultPath: ".",
    role: "native-package",
    resources: [],
  });
  const conventions = {
    repositoryName: "sample",
    defaultPackageScope: "sample",
  };
  const definition = owner.createDefinition({
    conventions,
    creationInput: undefined,
  });
  const contribution = owner.evaluate({
    packageDefinitionId:
      "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    definition: {
      packageDefinitionId:
        "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...definition,
    },
    createdBy: "initialization",
    creationInput: undefined,
    prepared: owner.prepare({ excludedPackagePaths: [] }),
    bindings: new Map(),
    conventions,
    stableCommon: {
      nodeDeclaration: "24.21.0",
      packageManagerPin: "pnpm@12.9.1",
    },
    packageInput: undefined,
  });
  const manifest = contribution.facts.nativeDocuments.find(
    ({ path: documentPath }) => documentPath === "package.json",
  )?.value as Record<string, unknown>;

  assert.equal(definition.path, ".");
  assert.equal(definition.name, "@sample/workspace");
  assert.equal(manifest.name, "@sample/workspace");
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.packageManager, "npm@10.0.0");
  assert.deepEqual(manifest.engines, { node: "24.21.0" });
});

await test("原生作者factory只准备快照并把完整原生文档留给组合", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-reference-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "template-dist"), { recursive: true });
    await writeFile(
      path.join(root, "src/index.ts"),
      'import type { Tool } from "@fixture/tooling-config/node.json";\n',
    );
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "@fixture/tooling-config/node.json" }),
    );
    await writeFile(path.join(root, "template-dist/definition.js"), "");

    const owner = defineReferencePackage({
      manifest: {
        name: "@fixture/library",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": {
            source: "./src/index.ts",
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
          "./reference": "./package.json",
          "./template": {
            types: "./template-dist/definition.d.ts",
            default: "./template-dist/definition.js",
          },
        },
        scripts: { "build:template": "tsc -p tsconfig.template.json" },
        devDependencies: {
          "@fixture/tooling-config": "workspace:*",
          "@fixture/template-runtime": "workspace:*",
        },
      },
      resourceRoot: pathToFileURL(`${root}${path.sep}`),
      alias: "library",
      instance: "independent",
      defaultLeafName: "lib",
      role: "shared-library",
      resources: [{ path: "src/index.ts" }, { path: "tsconfig.json" }],
      templateScripts: ["build:template"],
      templateExports: ["./reference", "./template"],
      templateDependencies: [
        {
          name: "@fixture/template-runtime",
          purpose: "template-execution",
        },
      ],
      dependencies: [
        {
          key: "tooling-config",
          ownerLocal: {
            specifier: "@fixture/tooling-config/template",
            resolve: () =>
              "file:///fixture/tooling-config/template/definition.js",
          },
        },
      ],
    });
    const prepared = owner.prepare({ excludedPackagePaths: [] });
    const definition = owner.createDefinition({
      conventions: { repositoryName: "sample", defaultPackageScope: "sample" },
      creationInput: undefined,
    });
    const provider: PackageBinding = {
      packageDefinitionId:
        "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      contentIdentity: {
        namespace: "fixture",
        packageName: "@fixture/tooling-config",
        exportPath: "./template",
      },
      definition: {
        packageDefinitionId:
          "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "@sample/tooling-config",
        path: "packages/tooling-config",
        role: "shared-library",
      },
      facts: undefined,
    };
    const contribution = owner.evaluate({
      packageDefinitionId:
        "package-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      definition: {
        packageDefinitionId:
          "package-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ...definition,
      },
      createdBy: "initialization",
      creationInput: undefined,
      prepared,
      bindings: new Map([["tooling-config", provider]]),
      conventions: { repositoryName: "sample", defaultPackageScope: "sample" },
      stableCommon: undefined,
      packageInput: undefined,
    });

    assert.equal(contribution.files.length, 1);
    assert.equal(contribution.files[0]?.path, "src/index.ts");
    assert.match(
      new TextDecoder().decode(contribution.files[0]?.content),
      /@sample\/tooling-config\/node\.json/u,
    );
    assert.equal(contribution.facts.nativeDocuments.length, 2);
    const manifest = contribution.facts.nativeDocuments.find(
      ({ path: documentPath }) => documentPath === "package.json",
    )?.value;
    assert.ok(manifest);
    const manifestValue = manifest as Record<string, unknown>;
    const exports = manifestValue.exports as Record<string, unknown>;
    const scripts = manifestValue.scripts as
      | Record<string, unknown>
      | undefined;
    const devDependencies = manifestValue.devDependencies as Record<
      string,
      unknown
    >;
    assert.equal(manifestValue.name, "@sample/lib");
    assert.equal(exports["./reference"], undefined);
    assert.equal(scripts?.["build:template"], undefined);
    assert.equal(devDependencies["@sample/tooling-config"], "workspace:*");
    assert.equal(devDependencies["@fixture/template-runtime"], undefined);
    assert.equal(
      contribution.facts.manifest,
      manifest,
      "manifest暴露事实应与最终原生文档使用同一值",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("通过公开来源别名投影外部资源且求值只用准备快照", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "native-reference-source-"),
  );
  const staticRoot = path.join(root, "static");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "template-dist"), { recursive: true });
    await mkdir(staticRoot, { recursive: true });
    const configContent = '{"strict":true}\n';
    await writeFile(
      path.join(root, "src/index.ts"),
      'import type { Tool } from "@fixture/tooling-source/node.json";\n',
    );
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "@fixture/tooling-source/node.json" }),
    );
    await writeFile(path.join(root, "template-dist/definition.js"), "");
    await writeFile(path.join(root, "template-dist/definition.d.ts"), "");
    await writeFile(path.join(staticRoot, "base.json"), configContent);
    await chmod(path.join(staticRoot, "base.json"), 0o751);

    const owner = defineReferencePackage({
      manifest: {
        name: "@fixture/library",
        version: "1.0.0",
        type: "module",
        exports: {
          "./reference": "./package.json",
          "./template": {
            types: "./template-dist/definition.d.ts",
            default: "./template-dist/definition.js",
          },
        },
        devDependencies: {
          "@fixture/tooling-source": "workspace:*",
          "@fixture/tooling-config": "workspace:*",
          "@fixture/template-runtime": "workspace:*",
        },
      },
      resourceRoot: pathToFileURL(`${root}${path.sep}`),
      alias: "library",
      instance: "independent",
      defaultLeafName: "lib",
      role: "shared-library",
      resources: [
        { path: "src/index.ts" },
        { path: "tsconfig.json" },
        {
          path: "base.json",
          targetPath: "base.json",
          source: createTemplateSourceHandle(
            path.join(staticRoot, "base.json"),
          ),
          mode: 0o751,
        },
      ],
      targetExports: { "./base.json": "./base.json" },
      templateScripts: [],
      templateExports: ["./reference", "./template"],
      templateDependencies: [
        { name: "@fixture/tooling-source", purpose: "template-build" },
        { name: "@fixture/template-runtime", purpose: "template-execution" },
      ],
      executionDependencies: ["@fixture/template-runtime"],
      dependencies: [
        {
          key: "tooling-config",
          ownerLocal: {
            specifier: "@fixture/tooling-config/template",
            resolve: () =>
              "file:///fixture/tooling-config/template/definition.js",
          },
        },
      ],
    });

    const prepared = owner.prepare({ excludedPackagePaths: [] });
    const artifact = owner.prepareArtifact();
    const preparedConfig = prepared.resources.find(
      ({ path: resourcePath }) => resourcePath === "base.json",
    );
    const artifactConfig = artifact.resources.find(
      ({ path: resourcePath }) => resourcePath === "base.json",
    );
    assert.ok(preparedConfig);
    assert.ok(artifactConfig);
    assert.equal(
      new TextDecoder().decode(preparedConfig.content),
      configContent,
    );
    assert.deepEqual(artifactConfig.data, preparedConfig.content);
    assert.equal(preparedConfig.mode, 0o111);
    assert.equal(artifactConfig.mode, 0o751);

    await rm(root, { recursive: true, force: true });
    const contribution = owner.evaluate({
      packageDefinitionId:
        "package-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      definition: {
        packageDefinitionId:
          "package-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ...owner.createDefinition({
          conventions: {
            repositoryName: "sample",
            defaultPackageScope: "sample",
          },
          creationInput: undefined,
        }),
      },
      createdBy: "initialization",
      creationInput: undefined,
      prepared,
      bindings: new Map([
        [
          "tooling-config",
          {
            packageDefinitionId:
              "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            contentIdentity: {
              namespace: "fixture",
              packageName: "@fixture/tooling-config",
              exportPath: "./template",
            },
            definition: {
              packageDefinitionId:
                "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: "@sample/tooling-config",
              path: "packages/tooling-config",
              role: "shared-library",
            },
            facts: { sourcePackageName: "@fixture/tooling-source" },
          } satisfies PackageBinding,
        ],
      ]),
      conventions: { repositoryName: "sample", defaultPackageScope: "sample" },
      stableCommon: undefined,
      packageInput: undefined,
    });

    const index = contribution.files.find(({ path: filePath }) =>
      filePath.endsWith("src/index.ts"),
    );
    assert.ok(index);
    assert.match(
      new TextDecoder().decode(index.content),
      /@sample\/tooling-config\/node\.json/u,
    );
    const config = contribution.files.find(
      ({ path: filePath }) => filePath === "base.json",
    );
    assert.ok(config);
    assert.deepEqual(config.content, preparedConfig.content);
    assert.equal(config.mode, 0o111);
    const tsconfig = contribution.facts.nativeDocuments.find(
      ({ path: documentPath }) => documentPath === "tsconfig.json",
    );
    assert.equal(
      tsconfig?.value.extends as string | undefined,
      "@sample/tooling-config/node.json",
    );
    const manifest = contribution.facts.nativeDocuments.find(
      ({ path: documentPath }) => documentPath === "package.json",
    )?.value;
    assert.ok(manifest);
    assert.deepEqual(manifest.exports, {
      "./base.json": "./base.json",
    });
    assert.equal(
      (manifest.devDependencies as Record<string, string>)[
        "@sample/tooling-source"
      ],
      undefined,
    );
    assert.equal(
      (manifest.devDependencies as Record<string, string>)[
        "@sample/tooling-config"
      ],
      "workspace:*",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
