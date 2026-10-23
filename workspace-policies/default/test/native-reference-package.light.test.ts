import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { PackageBinding } from "@ykdz/template-core/reference-package";

import { defineReferencePackage } from "../src/reference-package.ts";

test("原生作者factory只准备快照并把完整原生文档留给组合", async () => {
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
    assert.equal(
      devDependencies["@sample/tooling-config"],
      "workspace:../tooling-config",
    );
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
