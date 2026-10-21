import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  installContentCollection,
  prepareContentCollection,
} from "@ykdz/template-content/artifact-builder";
import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";
import { execa } from "execa";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

void it("任意内容集合仅携带显式执行闭包并交付未被初始化选择的拥有者资源", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "independent-content-"));
  const ownerRoot = path.join(root, "owner");
  const consumer = path.join(root, "consumer");
  await mkdir(path.join(ownerRoot, "dist"), { recursive: true });
  await mkdir(path.join(ownerRoot, "resources"));
  const manifest = {
    name: "@fixture/independent-content",
    version: "1.0.0",
    type: "module",
    exports: {
      "./reference": "./package.json",
      "./template": { default: "./dist/index.js" },
    },
    devDependencies: { "never-install-target-application": "1.0.0" },
  };
  await writeFile(
    path.join(ownerRoot, "package.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(ownerRoot, "resources/latent.txt"),
    "完整资源声明\n",
  );
  await writeFile(
    path.join(ownerRoot, "dist/index.js"),
    [
      'import manifest from "../package.json" with { type: "json" };',
      'import { readFile } from "node:fs/promises";',
      'export const referencePackage = { alias: "neutral", instance: "independent", manifest, unselectedResource: () => readFile(new URL("../resources/latent.txt", import.meta.url), "utf8") };',
    ].join("\n"),
  );
  let prepared:
    | Awaited<ReturnType<typeof prepareContentCollection>>
    | undefined;
  try {
    const [loaded] = await loadContentSource({
      namespace: "neutral",
      members: ["@fixture/independent-content/template"],
      resolve: (specifier) =>
        pathToFileURL(
          path.join(
            ownerRoot,
            specifier.endsWith("/reference") ? "package.json" : "dist/index.js",
          ),
        ).href,
    });
    assert.ok(loaded);
    const member = {
      ...loaded,
      definition: defineNativeContentArtifact(loaded.definition as object, {
        manifest,
        resourceRoot: pathToFileURL(`${ownerRoot}/`),
        exportPath: "./template",
        resources: [
          {
            path: "resources/latent.txt",
            source: createTemplateSourceHandle(
              path.join(ownerRoot, "resources/latent.txt"),
            ),
            mode: 0o644,
          },
        ],
      }),
    };
    prepared = await prepareContentCollection({
      content: [member],
      roots: [member],
      workspaceRoot,
      root: path.join(root, "prepared"),
      packageName: "@fixture/neutral-collection",
      collectionVersion: "1.0.0",
    });
    assert.deepEqual(prepared.sdkPackages.map(({ name }) => name).sort(), [
      "@ykdz/template-core",
      "@ykdz/template-generator",
    ]);
    await installContentCollection(prepared, consumer);
    const driver = path.join(consumer, "driver.mjs");
    await writeFile(
      driver,
      [
        'import assert from "node:assert/strict";',
        'import { templateContent } from "@fixture/neutral-collection";',
        'assert.equal(templateContent[0].alias, "neutral");',
        'assert.equal(await templateContent[0].definition.unselectedResource(), "完整资源声明\\n");',
        'for (const name of ["@ykdz/template-workspace/default-workspace-strategy", "@ykdz/template-workspace-authoring/content-artifact", "never-install-target-application"]) { assert.throws(() => import.meta.resolve(name)); }',
      ].join("\n"),
    );
    await chmod(root, 0o755);
    await chmod(ownerRoot, 0);
    try {
      await execa(process.execPath, ["--no-global-search-paths", driver], {
        cwd: consumer,
        uid: 65534,
        gid: 65534,
        env: { NODE_OPTIONS: "", NODE_PATH: "" },
      });
    } finally {
      await chmod(ownerRoot, 0o755);
    }
    const installed = await readFile(
      path.join(
        consumer,
        "node_modules/@fixture/neutral-collection/package.json",
      ),
      "utf8",
    );
    assert.doesNotMatch(installed, /template-workspace/u);
  } finally {
    await prepared?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
