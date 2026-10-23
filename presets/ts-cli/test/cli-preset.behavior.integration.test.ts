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
import { describe, it } from "node:test";

import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { execa } from "execa";

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
const cliPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-cli",
);
const libraryPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-lib",
);
assert.ok(cliPreset);
assert.ok(libraryPreset);

async function readManifest(
  packageRoot: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

function generator() {
  return createDefaultGenerator({ content });
}

void describe("TypeScript CLI 公开预设安装行为", () => {
  void it(
    "通过真实生成器验证源码、分发文件、工作区命令与打包安装",
    { timeout: 600_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-cli-generated-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-cli");
      const packageRoot = path.join(targetRoot, "packages/cli");
      const libraryRoot = path.join(targetRoot, "packages/lib");
      const packDestination = path.join(workspace, "packs");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await generator().init({
        targetRoot,
        selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
        conventions: {
          repositoryName: "demo-cli",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );
      const added = await generator().add({
        repositoryRoot: targetRoot,
        preset: cliPreset.identity,
        creationInput: { linkToNodeIdentity: "library" },
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));

      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });

      const originalManifestBytes = await readFile(
        path.join(packageRoot, "package.json"),
        "utf8",
      );
      const originalManifest = JSON.parse(originalManifestBytes) as Record<
        string,
        unknown
      >;
      assert.strictEqual(originalManifest.private, true);
      assert.deepStrictEqual(originalManifest.bin, {
        cli: "./dist/cli.js",
      });
      assert.strictEqual(
        (originalManifest.dependencies as Record<string, string>)["@demo/lib"],
        "workspace:*",
      );
      assert.deepStrictEqual(originalManifest.files, ["dist"]);
      assert.strictEqual(Object.hasOwn(originalManifest, "version"), false);

      await mkdir(packDestination);
      const unpublishedPack = await execa(
        "pnpm",
        ["pack", "--pack-destination", packDestination],
        { cwd: packageRoot, cancelSignal: testContext.signal, reject: false },
      );
      assert.strictEqual(unpublishedPack.exitCode, 1);
      assert.ok(
        `${unpublishedPack.stdout}\n${unpublishedPack.stderr}`.includes(
          "ERR_PNPM_PACKAGE_VERSION_NOT_FOUND",
        ),
      );
      assert.strictEqual(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
        originalManifestBytes,
      );
      assert.deepStrictEqual(await readdir(packDestination), []);

      assert.strictEqual(
        await execa(
          process.execPath,
          ["--conditions=source", "src/cli.ts", "--version"],
          { cwd: packageRoot },
        ).then(({ stdout }) => stdout),
        "cli unpublished",
      );
      const sourceManifest = await readManifest(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify(
          {
            ...sourceManifest,
            version: "7.8.9",
            bin: { release: "./dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      const libraryManifest = await readManifest(libraryRoot);
      await writeFile(
        path.join(libraryRoot, "package.json"),
        `${JSON.stringify(
          { ...libraryManifest, version: "1.2.3", private: false },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        path.join(packageRoot, "src/linked-library.ts"),
        [
          'import { greet } from "@demo/lib";',
          "",
          'console.log(greet("Ada").message);',
          "",
        ].join("\n"),
      );
      await execa("pnpm", ["install", "--no-frozen-lockfile"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      assert.strictEqual(
        await execa(
          process.execPath,
          ["--conditions=source", "src/cli.ts", "--version"],
          { cwd: packageRoot },
        ).then(({ stdout }) => stdout),
        "release 7.8.9",
      );
      assert.strictEqual(
        await execa(
          process.execPath,
          ["--conditions=source", "src/linked-library.ts"],
          { cwd: packageRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout),
        "Hello, Ada",
      );
      assert.strictEqual(
        (
          await execa(
            process.execPath,
            ["--conditions=source", "test/e2e/run-journeys.ts", "source"],
            { cwd: packageRoot, cancelSignal: testContext.signal },
          )
        ).stdout,
        "source:lookup:passed",
      );

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/cli", "--force"],
        { cwd: targetRoot, cancelSignal: testContext.signal },
      );
      assert.match(
        await readFile(path.join(packageRoot, "dist/cli.js"), "utf8"),
        /^#!\/usr\/bin\/env node/u,
      );
      assert.strictEqual(
        await execa(process.execPath, ["dist/cli.js", "--version"], {
          cwd: packageRoot,
        }).then(({ stdout }) => stdout),
        "release 7.8.9",
      );
      assert.strictEqual(
        await execa(process.execPath, ["dist/linked-library.js"], {
          cwd: packageRoot,
          cancelSignal: testContext.signal,
        }).then(({ stdout }) => stdout),
        "Hello, Ada",
      );
      assert.strictEqual(
        await execa(
          process.execPath,
          ["dist/cli.js", "lookup", "ada", "--output-format", "text"],
          { cwd: packageRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout),
        "找到记录：Ada Lovelace（ada）",
      );

      const consumerRoot = path.join(targetRoot, "packages/consumer");
      await mkdir(consumerRoot);
      await writeFile(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@demo/consumer",
            private: true,
            dependencies: { "@demo/cli": "workspace:*" },
          },
          null,
          2,
        )}\n`,
      );
      await execa("pnpm", ["install", "--no-frozen-lockfile"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      const consumerBin = path.join(consumerRoot, "node_modules/.bin/release");
      assert.ok((await stat(consumerBin)).isFile());
      assert.strictEqual(
        await execa(consumerBin, ["--version"], {
          cwd: consumerRoot,
        }).then(({ stdout }) => stdout),
        "release 7.8.9",
      );
      assert.strictEqual(
        await execa(consumerBin, ["lookup", "ada", "--output-format", "text"], {
          cwd: consumerRoot,
        }).then(({ stdout }) => stdout),
        "找到记录：Ada Lovelace（ada）",
      );

      await execa("pnpm", ["pack", "--pack-destination", packDestination], {
        cwd: libraryRoot,
        cancelSignal: testContext.signal,
      });
      await execa("pnpm", ["pack", "--pack-destination", packDestination], {
        cwd: packageRoot,
        cancelSignal: testContext.signal,
      });
      const archives = await readdir(packDestination);
      assert.deepStrictEqual(archives.toSorted(), [
        "demo-cli-7.8.9.tgz",
        "demo-lib-1.2.3.tgz",
      ]);
      const installedRoot = path.join(workspace, "installed-consumer");
      await mkdir(installedRoot);
      await writeFile(
        path.join(installedRoot, "package.json"),
        `${JSON.stringify({
          private: true,
          packageManager: (await readManifest(targetRoot)).packageManager,
          dependencies: {
            "@demo/cli": `file:${path.join(packDestination, "demo-cli-7.8.9.tgz")}`,
            "@demo/lib": `file:${path.join(packDestination, "demo-lib-1.2.3.tgz")}`,
          },
        })}\n`,
      );
      await execa("pnpm", ["install"], {
        cwd: installedRoot,
        cancelSignal: testContext.signal,
      });
      const installedBin = path.join(
        installedRoot,
        "node_modules/.bin/release",
      );
      assert.strictEqual(
        await execa(installedBin, ["--version"], {
          cwd: installedRoot,
          cancelSignal: testContext.signal,
        }).then(({ stdout }) => stdout),
        "release 7.8.9",
      );
      assert.strictEqual(
        await execa(
          process.execPath,
          ["test/e2e/run-journeys.ts", "packed", installedBin],
          { cwd: packageRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout),
        "packed:lookup:passed",
      );
      assert.strictEqual(
        await execa(
          process.execPath,
          ["node_modules/@demo/cli/dist/linked-library.js"],
          { cwd: installedRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout),
        "Hello, Ada",
      );
    },
  );
});
