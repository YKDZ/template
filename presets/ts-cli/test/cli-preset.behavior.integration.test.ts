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

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-ts-cli/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-rust-bin/template",
    "@ykdz/reference-typescript-config/template",
    "@ykdz/preset-ts-cli/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-ts-cli",
);
assert.ok(preset);

async function readManifest(
  packageRoot: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

function generator() {
  return createGenerator({
    content,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  });
}

void describe("TypeScript CLI 公开预设安装行为", () => {
  void it(
    "通过真实生成器验证 source、distribution、workspace bin 与未发布 pack",
    { timeout: 600_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-cli-generated-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-cli");
      const packageRoot = path.join(targetRoot, "packages/cli");
      const packDestination = path.join(workspace, "packs");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await generator().init({
        targetRoot,
        selection: { roots: [{ preset: preset.identity }] },
        strategyInput: {
          repositoryName: "demo-cli",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

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
      assert.strictEqual(
        await execa(
          process.execPath,
          ["--conditions=source", "src/cli.ts", "--version"],
          { cwd: packageRoot },
        ).then(({ stdout }) => stdout),
        "release 7.8.9",
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
        (
          await execa(
            process.execPath,
            ["test/e2e/run-journeys.ts", "distribution"],
            { cwd: packageRoot, cancelSignal: testContext.signal },
          )
        ).stdout,
        "distribution:lookup:passed",
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
    },
  );
});
