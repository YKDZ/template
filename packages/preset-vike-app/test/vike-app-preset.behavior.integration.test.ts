import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preset } from "@ykdz/preset-vike-app/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as database } from "@ykdz/reference-vike-db/template";
import { referencePackage as migrations } from "@ykdz/reference-vike-migrations/template";
import { referencePackage as web } from "@ykdz/reference-vike-web/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

const configuration = defineReferencePackage(configurationDefinition);
const content = [
  web,
  database,
  migrations,
  vueShared,
  library,
  configuration,
  preset,
];

void describe("Vike 应用公开预设安装行为", () => {
  void it(
    "在真实初始化、安装与构建后解析数据库默认和 source 导出",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-vike-db-export-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-vike");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await createGenerator({
        content,
        strategy: createDefaultWorkspaceStrategy(),
      }).init({
        targetRoot,
        selection: { roots: [{ preset }] },
        strategyInput: {
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
