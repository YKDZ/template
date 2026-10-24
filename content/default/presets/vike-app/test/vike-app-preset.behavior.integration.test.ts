import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
      specifier: "@ykdz/reference-vike-web/template",
      load: () => import("@ykdz/reference-vike-web/template"),
    },
    {
      specifier: "@ykdz/reference-vike-db/template",
      load: () => import("@ykdz/reference-vike-db/template"),
    },
    {
      specifier: "@ykdz/reference-vike-migrations/template",
      load: () => import("@ykdz/reference-vike-migrations/template"),
    },
    {
      specifier: "@ykdz/reference-tooling-config/template",
      load: () => import("@ykdz/reference-tooling-config/template"),
    },
    {
      specifier: "@ykdz/reference-ts-lib/template",
      load: () => import("@ykdz/reference-ts-lib/template"),
    },
    {
      specifier: "@ykdz/reference-npm-publication/template",
      load: () => import("@ykdz/reference-npm-publication/template"),
    },
    {
      specifier: "@ykdz/preset-vike-app/template",
      load: () => import("@ykdz/preset-vike-app/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@ykdz/preset-vike-app",
);
assert.ok(preset);

void describe("Vike 应用公开预设安装行为", () => {
  void it(
    "在真实生成仓库中准备数据、验收部署并解析数据库导出",
    { timeout: 600_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-vike-db-export-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-vike");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await createDefaultGenerator({ content }).init({
        targetRoot,
        selection: { presets: [{ contentIdentity: preset.identity }] },
        conventions: {
          repositoryName: "demo-vike",
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
      for (const profile of ["dev", "test", "e2e"] as const) {
        await execa("pnpm", ["run", `database:prepare:${profile}`], {
          cwd: targetRoot,
          cancelSignal: testContext.signal,
        });
      }
      await execa(
        "pnpm",
        ["--filter", "./apps/web", "run", "browser:prepare"],
        {
          cwd: targetRoot,
          cancelSignal: testContext.signal,
        },
      );
      await execa("pnpm", ["run", "deployment"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      await execa("pnpm", ["--filter", "./packages/db", "run", "typecheck"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      for (const packagePath of [
        "apps/web",
        "packages/db-migrations",
      ] as const) {
        await assert.rejects(
          execa("pnpm", ["--filter", `./${packagePath}`, "run", "typecheck"], {
            cwd: targetRoot,
            cancelSignal: testContext.signal,
          }),
          (error: unknown) => {
            assert.ok(
              typeof error === "object" &&
                error !== null &&
                Object.hasOwn(error, "stdout"),
            );
            const stdout = (error as { readonly stdout: unknown }).stdout;
            assert.ok(typeof stdout === "string" && stdout.includes("TS2307"));
            return true;
          },
        );
      }

      await execa("pnpm", ["exec", "turbo", "run", "typecheck"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      const resolveDatabaseStorage = (conditions: readonly string[] = []) =>
        execa(
          process.execPath,
          [
            ...conditions,
            "--input-type=module",
            "--eval",
            'console.log(import.meta.resolve("@demo/db/storage"));',
          ],
          {
            cwd: path.join(targetRoot, "apps/web"),
            cancelSignal: testContext.signal,
          },
        ).then(({ stdout }) => stdout);

      assert.match(await resolveDatabaseStorage(), /\/dist\/storage\.js$/u);
      assert.match(
        await resolveDatabaseStorage(["--conditions=source"]),
        /\/src\/storage\.ts$/u,
      );
    },
  );
});
