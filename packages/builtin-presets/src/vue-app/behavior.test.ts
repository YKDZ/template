import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";
import semver from "semver";

import { vueAppDefinition } from "./definition.ts";

void describe("vue-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  /**
   * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
   * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
   * 这里不另立版本常量。
   */
  const runtimeToolchain = {
    nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
      0,
      releaseToolchainSnapshot.nodeVersion.indexOf("."),
    ),
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  };

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
      resolveTemplateSource(layer!.dockerfile.source, layer!.dockerfile.from),
      path.resolve(
        import.meta.dirname,
        "../../templates/shared/devcontainer/browser-test.Dockerfile",
      ),
    );
  });

  void it(
    "initializes and adds Vue applications at default and explicit Package Paths",
    { timeout: 300_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-vue-")),
        "demo-vue",
      );
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: vueAppDefinition,
        context,
      });

      assert.deepStrictEqual(
        initialization.nextStepInstructions.map((step) => step.display),
        ["pnpm install", "pnpm run fix", "pnpm run check"],
      );
      assert.ok(
        initialization.operations.some(
          (operation) =>
            operation.kind === "copyFile" &&
            operation.from === "src/App.vue" &&
            operation.to === "apps/web/src/App.vue",
        ),
      );

      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await writeFile(
        path.join(targetDir, "apps/web/scripts/automation-helper.ts"),
        'export const automationOwner = "vue";\n',
      );
      await writeFile(
        path.join(targetDir, "apps/web/scripts/automation-probe.ts"),
        'import { automationOwner } from "./automation-helper.ts";\n\nconsole.log(automationOwner);\n',
      );
      const viteConfig = await readFile(
        path.join(targetDir, "apps/web/vite.config.ts"),
        "utf8",
      );
      assert.ok(
        (
          await readFile(
            path.join(targetDir, ".devcontainer/Dockerfile"),
            "utf8",
          )
        ).includes("playwright install --with-deps chromium"),
      );
      const devcontainer = JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as {
        readonly build?: {
          readonly args?: Readonly<Record<string, unknown>>;
        };
      };
      const playwrightPackage =
        devcontainer.build?.args?.PLAYWRIGHT_CLI_PACKAGE;
      assert.ok(typeof playwrightPackage === "string");
      assert.match(playwrightPackage, /^@playwright\/test@/u);
      assert.ok(viteConfig.includes("@tailwindcss/vite"));
      assert.ok(!viteConfig.includes("alias:"));
      const vitestConfig = await readFile(
        path.join(targetDir, "apps/web/vitest.config.ts"),
        "utf8",
      );
      assert.ok(!vitestConfig.includes("alias:"));
      for (const configPath of ["tsconfig.app.json", "tsconfig.test.json"]) {
        const config = JSON.parse(
          await readFile(path.join(targetDir, "apps/web", configPath), "utf8"),
        ) as {
          readonly compilerOptions?: Readonly<Record<string, unknown>>;
          readonly extends?: string;
        };
        assert.deepStrictEqual(config.compilerOptions?.customConditions, [
          "source",
        ]);
        assert.ok(
          config.compilerOptions === undefined ||
            !("erasableSyntaxOnly" in config.compilerOptions),
        );
        if (configPath === "tsconfig.app.json") {
          assert.strictEqual(
            config.compilerOptions?.exactOptionalPropertyTypes,
            false,
          );
        } else {
          assert.strictEqual(config.extends, "./tsconfig.app.json");
        }
      }
      const nodeConfig = JSON.parse(
        await readFile(
          path.join(targetDir, "apps/web/tsconfig.node.json"),
          "utf8",
        ),
      );
      assert.strictEqual(nodeConfig.compilerOptions.erasableSyntaxOnly, true);
      assert.deepStrictEqual(nodeConfig.compilerOptions.customConditions, [
        "source",
      ]);

      const defaultAddition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "admin",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...defaultAddition.projectProjections,
      });
      const explicitAddition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "portal",
        packagePath: "products/portal",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...explicitAddition.projectProjections,
      });

      assert.ok(
        explicitAddition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === "@demo/admin" &&
            packageDefinition.path === "apps/admin" &&
            packageDefinition.role === "runtime-service",
        ),
      );
      assert.ok(
        explicitAddition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === "@demo/portal" &&
            packageDefinition.path === "products/portal" &&
            packageDefinition.role === "runtime-service",
        ),
      );
      assert.strictEqual(
        JSON.parse(
          await readFile(
            path.join(targetDir, "apps/admin/package.json"),
            "utf8",
          ),
        ).name,
        "@demo/admin",
      );

      await execa("pnpm", ["install"], { cwd: targetDir });
      assert.strictEqual(
        await execa(
          "node",
          ["--conditions=source", "scripts/automation-probe.ts"],
          {
            cwd: path.join(targetDir, "apps/web"),
          },
        ).then(({ stdout }) => stdout),
        "vue",
      );
      await execa("pnpm", ["--filter", "./apps/web", "run", "typecheck"], {
        cwd: targetDir,
      });
      await execa("pnpm", ["run", "check:full"], { cwd: targetDir });
    },
  );

  void it(
    "owns its default Package Path and updates an explicit Link Intent atomically",
    { timeout: 300_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-vue-link-")),
        "demo-vue",
      );
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: vueAppDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });

      const addition = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "admin",
        linkFrom: ["apps/web"],
      });

      assert.ok(
        addition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === "@demo/admin" &&
            packageDefinition.path === "apps/admin" &&
            packageDefinition.role === "runtime-service",
        ),
      );
      assert.ok(
        addition.blueprint.packageLinkIntents?.some((intent) =>
          isDeepStrictEqual(intent, {
            consumerPackagePath: "apps/web",
            providerPackagePath: "apps/admin",
          }),
        ),
      );
      const webPackageMerge = addition.operations.find(
        (operation) =>
          operation.kind === "mergeJson" &&
          operation.to === "apps/web/package.json",
      );
      assert.ok(
        webPackageMerge !== undefined && webPackageMerge.kind === "mergeJson",
      );
      assert.deepStrictEqual(webPackageMerge.value, {
        dependencies: { "@demo/admin": "workspace:*" },
        dependenciesMeta: { "@demo/admin": { injected: true } },
      });
      assert.deepStrictEqual(
        {
          definitionName: webPackageMerge.provenance?.definitionName,
          planningContribution:
            webPackageMerge.provenance?.planningContribution,
        },
        {
          definitionName: "vue-app",
          planningContribution: "foundationPlan",
        },
      );

      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assert.partialDeepStrictEqual(
        JSON.parse(
          await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
        ),
        { dependencies: { "@demo/admin": "workspace:*" } },
      );
      await execa("pnpm", ["install"], { cwd: targetDir });
      await execa("pnpm", ["run", "check:full"], { cwd: targetDir });
    },
  );

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
