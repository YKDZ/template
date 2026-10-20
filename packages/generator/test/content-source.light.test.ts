import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  createContentIndex,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";

import { loadContentSource } from "../src/content-source.ts";

const temporaryDirectories: string[] = [];

async function createSource(options: {
  readonly namespace: string;
  readonly body: string;
}): Promise<readonly LoadedContentMember[]> {
  const root = await mkdtemp(path.join(tmpdir(), "template-content-source-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "collection");
  const packageRoot = path.join(root, "authors", options.namespace, "shared");
  await mkdir(path.join(sourceRoot, "node_modules", "@example"), {
    recursive: true,
  });
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await symlink(
    packageRoot,
    path.join(sourceRoot, "node_modules", "@example", "shared"),
    "dir",
  );
  await writeFile(
    path.join(sourceRoot, "collection.mjs"),
    "export const resolve = (specifier) => import.meta.resolve(specifier);\n",
  );
  const manifest = {
    name: "@example/shared",
    version: "1.0.0",
    type: "module",
    exports: {
      "./reference": "./package.json",
      "./template": {
        source: "./template/definition.mjs",
        default: "./template/definition.mjs",
      },
    },
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    [
      'import manifest from "../package.json" with { type: "json" };',
      `export const referencePackage = { alias: "shared", instance: "independent", defaultLeafName: "shared", defaultPath: "packages/shared", role: "shared-library", manifest, resolve: (specifier) => import.meta.resolve(specifier), value: ${JSON.stringify(options.body)} };`,
      "",
    ].join("\n"),
  );
  const source = await import(
    pathToFileURL(path.join(sourceRoot, "collection.mjs")).href
  );
  return await loadContentSource({
    namespace: options.namespace,
    resolve: source.resolve as (specifier: string) => string,
    members: ["@example/shared/template"],
  });
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

void describe("来源公开入口装载", () => {
  void it("以各集合自己的resolver装载同名包并保留两份真实定义", async () => {
    const alpha = await createSource({
      namespace: "alpha",
      body: "from alpha",
    });
    const beta = await createSource({ namespace: "beta", body: "from beta" });
    const index = createContentIndex([...alpha, ...beta]);
    const selected = index.resolve(
      { alias: "shared", namespace: "beta" },
      "reference",
    );

    assert.strictEqual(alpha[0]?.identity.packageName, "@example/shared");
    assert.strictEqual(alpha[0]?.identity.namespace, "alpha");
    assert.strictEqual(beta[0]?.identity.namespace, "beta");
    assert.notStrictEqual(
      alpha[0]?.source.moduleURL,
      beta[0]?.source.moduleURL,
    );
    assert.strictEqual(
      (selected.definition as { value: string }).value,
      "from beta",
    );
    assert.throws(() => index.resolve("shared", "reference"), /歧义/u);
  });

  void it("拒绝一次集合中重复登记的规范身份", async () => {
    const members = await createSource({
      namespace: "duplicate",
      body: "value",
    });
    const member = members[0]!;
    assert.throws(() => createContentIndex([member, member]), /重复规范身份/u);
  });
});
