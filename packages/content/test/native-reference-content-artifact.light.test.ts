import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { defineNativeReferenceContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

const roots: string[] = [];

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

void it("同一资源声明为参考包准备快照并保留完整制品", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reference-artifact-"));
  roots.push(root);
  await mkdir(path.join(root, "template-dist"), { recursive: true });
  await mkdir(path.join(root, "resources"), { recursive: true });
  await mkdir(path.join(root, "packages/child"), { recursive: true });
  await writeFile(path.join(root, "template-dist/index.js"), "export {};\n");
  await writeFile(
    path.join(root, "template-dist/index.d.ts"),
    'export declare const templateVersion: "v1";\n',
  );
  await writeFile(path.join(root, "resources/guide.md"), "指南字节\n");
  await writeFile(path.join(root, "packages/child/README.md"), "子包字节\n");

  const manifest = {
    name: "@fixture/native-reference",
    version: "1.0.0",
    exports: {
      "./template": {
        types: "./template-dist/index.d.ts",
        default: "./template-dist/index.js",
      },
    },
  };
  const referencePackage = defineNativeReferenceContentArtifact(
    {
      alias: "native-reference",
      instance: "independent",
      externalExtension: { version: "v1" as const },
    },
    {
      manifest,
      resourceRoot: pathToFileURL(`${root}${path.sep}`),
      exportPath: "./template",
      resources: [
        {
          path: "resources/guide.md",
          source: createTemplateSourceHandle(
            path.join(root, "resources/guide.md"),
          ),
          mode: 0o644,
        },
        {
          path: "packages/child/README.md",
          source: createTemplateSourceHandle(
            path.join(root, "packages/child/README.md"),
          ),
          mode: 0o644,
        },
      ],
      prepareFacts(resources) {
        return { resourceCount: resources.length };
      },
    },
  );

  const extensionVersion: "v1" = referencePackage.externalExtension.version;
  const prepared = referencePackage.prepare({
    excludedPackagePaths: ["packages/child"],
  });
  const artifact = referencePackage.prepareArtifact();
  assert.equal(extensionVersion, "v1");
  assert.deepEqual(
    prepared.resources.map(({ path: resourcePath, mode }) => [
      resourcePath,
      mode,
    ]),
    [["resources/guide.md", 0]],
  );
  assert.deepEqual(prepared.facts, { resourceCount: 1 });
  assert.deepEqual(
    artifact.resources.map(({ path: resourcePath, data, mode }) => [
      resourcePath,
      data.toString(),
      mode,
    ]),
    [
      ["resources/guide.md", "指南字节\n", 0o644],
      ["packages/child/README.md", "子包字节\n", 0o644],
    ],
  );
  assert.ok(
    artifact.compiled.some(({ path: filePath }) => filePath.endsWith(".d.ts")),
  );
});
