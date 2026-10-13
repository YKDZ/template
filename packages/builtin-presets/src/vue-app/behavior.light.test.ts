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
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import semver from "semver";

import { vueAppDefinition } from "./definition.ts";

void describe("vue-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  /**
   * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
   * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
   * 这里不另立版本常量。
   */

  void it("owns a browser application contribution with explicit exposure and preparation", () => {
    assert.deepStrictEqual(
      builtInPresetRegistry.require("vue-app").metadata,
      vueAppDefinition.metadata,
    );
    const contribution = vueAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vue",
      repositoryName: "demo-vue",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain,
    });

    assert.deepStrictEqual(vueAppDefinition.metadata, {
      name: "vue-app",
      title: "Vue 应用",
      description: "使用 Vite、Tailwind、Pinia 和测试工具的 Vue 应用工作区。",
    });
    assert.deepStrictEqual(contribution.definition, {
      name: "@demo/web",
      path: "apps/web",
      role: "runtime-service",
    });
    assert.deepStrictEqual(contribution.exposure, {
      exports: { ".": { default: "./src/main.ts", types: "./src/main.ts" } },
      imports: { "#/*": { default: "./src/*.ts", types: "./src/*.ts" } },
    });
    assert.deepStrictEqual(contribution.manifest.dependencies, {
      "@vue/devtools-api": "catalog:",
      pinia: "catalog:",
      vue: "catalog:",
    });
    assert.ok(!("checks" in contribution));
    assert.strictEqual(contribution.environmentNeeds.length, 1);
    assert.partialDeepStrictEqual(contribution.environmentNeeds[0], {
      kind: "playwright-browser-assets",
      browser: "chromium",
    });
    assert.deepStrictEqual(contribution.foundation.workspacePackageGlobs, [
      "apps/*",
    ]);
  });

  void it("declares the shared source-backed browser-test Tool Layer", () => {
    const contribution = vueAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vue",
      repositoryName: "demo-vue",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain,
    });
    const [layer] =
      contribution.foundation.developmentContainerToolLayers ?? [];
    const playwrightCliPackage =
      layer?.buildArguments?.find(
        (argument) => argument.name === "PLAYWRIGHT_CLI_PACKAGE",
      )?.value ?? "";
    const playwrightVersion = playwrightCliPackage.replace(
      /^@playwright\/test@/u,
      "",
    );

    assert.strictEqual(semver.valid(playwrightVersion), playwrightVersion);
    assert.ok(layer !== undefined);
    assert.strictEqual(layer.identity, "browser-test");
    assert.deepStrictEqual(layer.requires, ["node-pnpm"]);
    assert.strictEqual(layer.buildArguments?.length, 1);
    assert.strictEqual(
      layer.buildArguments?.[0]?.name,
      "PLAYWRIGHT_CLI_PACKAGE",
    );
    assert.match(
      layer.buildArguments?.[0]?.value ?? "",
      /^@playwright\/test@/u,
    );
    assert.strictEqual(layer.probes?.length, 1);
    assert.partialDeepStrictEqual(layer.probes?.[0], {
      identity: "playwright",
      command: "npx",
    });
    assert.deepStrictEqual(layer.probes?.[0]?.args, [
      "--yes",
      "--package",
      playwrightCliPackage,
      "playwright",
      "--version",
    ]);
    assert.strictEqual(
      resolveTemplateSource(layer.dockerfile.source, layer.dockerfile.from),
      path.resolve(
        import.meta.dirname,
        "../../templates/shared/devcontainer/browser-test.Dockerfile",
      ),
    );
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
