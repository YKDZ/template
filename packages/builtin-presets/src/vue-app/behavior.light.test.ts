import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import semver from "semver";

import { vueAppDefinition } from "./definition.ts";

void describe("vue-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  /**
   * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
   * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
   * 这里不另立版本常量。
   */

  void it("通过原生依赖生成完整应用和共同配置", async (testContext) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-native-"),
    );
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "project"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: vueAppDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: context.targetDir,
      operations: [...plan.operations],
    });
    const manifest = JSON.parse(
      await readFile(
        path.join(context.targetDir, "apps/web/package.json"),
        "utf8",
      ),
    );
    assert.partialDeepStrictEqual(manifest, {
      name: "@demo/web",
      dependencies: {
        "@demo/vue-shared": "workspace:*",
        vue: "catalog:",
        pinia: "catalog:",
      },
      devDependencies: { "@demo/typescript-config": "workspace:*" },
      exports: { ".": { default: "./src/main.ts", types: "./src/main.ts" } },
    });
    assert.ok(
      plan.environmentNeeds.some(
        (need) =>
          need.kind === "playwright-browser-assets" &&
          need.owner.path === "apps/web",
      ),
    );
    const container = JSON.parse(
      await readFile(
        path.join(context.targetDir, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    );
    const browserPackage = container.build.args
      .PLAYWRIGHT_CLI_PACKAGE as string;
    assert.ok(semver.valid(browserPackage.replace(/^@playwright\/test@/u, "")));
  });

  void it("reconciles Foundation structured customization and reruns idempotently", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const baseDefinition = builtInPresetRegistry.require("ts-lib");

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, unknown>;
      };
      turbo.tasks["user:report"] = { cache: false };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

      const addition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      const updatedTurbo = await readFile(turboPath, "utf8").then((source) =>
        JSON.parse(source),
      );
      assert.partialDeepStrictEqual(updatedTurbo, {
        boundaries: {
          tags: {
            app: { dependencies: { allow: ["app", "library"] } },
          },
        },
        tasks: { "user:report": { cache: false } },
      });
      assert.deepStrictEqual(
        updatedTurbo.boundaries.tags.app.dependencies.allow,
        ["app", "library"],
      );

      const repeated = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeated.projectProjections,
        }),
        { ok: true, changedPaths: [], actions: [] },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("returns a structured conflict before mutating an incompatible Turbo customization", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const baseDefinition = builtInPresetRegistry.require("ts-lib");

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        boundaries: { tags: Record<string, unknown> };
      };
      turbo.boundaries.tags.app = {
        dependencies: { allow: ["app"] },
      };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

      const addition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.conflicts.length, 1);
      assert.partialDeepStrictEqual(result.conflicts[0], {
        path: "turbo.json",
        driver: "structured",
        location: "/boundaries/tags/app/dependencies/allow",
      });
      await assert.rejects(
        readFile(path.join(targetDir, "apps/dashboard/package.json")),
        (error) => {
          return (
            typeof error === "object" &&
            error !== null &&
            Object.hasOwn(error, "code") &&
            (error as { readonly code?: unknown }).code === "ENOENT"
          );
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
