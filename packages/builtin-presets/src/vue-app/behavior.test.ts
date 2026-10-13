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
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";
import semver from "semver";

import {
  arrayContaining,
  assertContains,
  assertContainsEqual,
  assertDoesNotContain,
  assertLacksProperty,
  assertMatches,
  assertMatchesPartial,
  objectContaining,
  stringMatching,
} from "../../test-support/assertions.ts";
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
    assertLacksProperty(contribution, "checks");
    assertMatchesPartial(contribution.environmentNeeds, [
      { kind: "playwright-browser-assets", browser: "chromium" },
    ]);
    assertMatchesPartial(contribution.foundation, {
      workspacePackageGlobs: ["apps/*"],
    });
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
    assertMatchesPartial(layer, {
      identity: "browser-test",
      requires: ["node-pnpm"],
      buildArguments: [
        {
          name: "PLAYWRIGHT_CLI_PACKAGE",
          value: stringMatching(/^@playwright\/test@/u),
        },
      ],
      probes: [
        {
          identity: "playwright",
          command: "npx",
          args: [
            "--yes",
            "--package",
            playwrightCliPackage,
            "playwright",
            "--version",
          ],
        },
      ],
    });
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
      assertMatches(
        initialization.operations,
        arrayContaining([
          objectContaining({
            kind: "copyFile",
            from: "src/App.vue",
            to: "apps/web/src/App.vue",
          }),
        ]),
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
      assertContains(
        await readFile(
          path.join(targetDir, ".devcontainer/Dockerfile"),
          "utf8",
        ),
        "playwright install --with-deps chromium",
      );
      assertMatchesPartial(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ),
        {
          build: {
            args: {
              PLAYWRIGHT_CLI_PACKAGE: stringMatching(/^@playwright\/test@/u),
            },
          },
        },
      );
      assertContains(viteConfig, "@tailwindcss/vite");
      assertDoesNotContain(viteConfig, "alias:");
      assertDoesNotContain(
        await readFile(
          path.join(targetDir, "apps/web/vitest.config.ts"),
          "utf8",
        ),
        "alias:",
      );
      for (const configPath of ["tsconfig.app.json", "tsconfig.test.json"]) {
        const config = JSON.parse(
          await readFile(path.join(targetDir, "apps/web", configPath), "utf8"),
        ) as {
          readonly compilerOptions?: Readonly<Record<string, unknown>>;
          readonly extends?: string;
        };
        assertMatchesPartial(config.compilerOptions, {
          customConditions: ["source"],
        });
        assertLacksProperty(config.compilerOptions, "erasableSyntaxOnly");
        if (configPath === "tsconfig.app.json") {
          assertMatchesPartial(config.compilerOptions, {
            exactOptionalPropertyTypes: false,
          });
        } else {
          assert.strictEqual(config.extends, "./tsconfig.app.json");
        }
      }
      assertMatchesPartial(
        JSON.parse(
          await readFile(
            path.join(targetDir, "apps/web/tsconfig.node.json"),
            "utf8",
          ),
        ),
        {
          compilerOptions: {
            customConditions: ["source"],
            erasableSyntaxOnly: true,
          },
        },
      );

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

      assertMatches(
        explicitAddition.blueprint.packages,
        arrayContaining([
          objectContaining({
            name: "@demo/admin",
            path: "apps/admin",
            role: "runtime-service",
          }),
          objectContaining({
            name: "@demo/portal",
            path: "products/portal",
            role: "runtime-service",
          }),
        ]),
      );
      assertMatchesPartial(
        JSON.parse(
          await readFile(
            path.join(targetDir, "apps/admin/package.json"),
            "utf8",
          ),
        ),
        { name: "@demo/admin" },
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
      await execa(
        "pnpm",
        ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
        { cwd: targetDir },
      );
      await execa("pnpm", ["run", "check"], { cwd: targetDir });
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

      assertContainsEqual(
        addition.blueprint.packages,
        objectContaining({
          name: "@demo/admin",
          path: "apps/admin",
          role: "runtime-service",
        }),
      );
      assertContainsEqual(addition.blueprint.packageLinkIntents, {
        consumerPackagePath: "apps/web",
        providerPackagePath: "apps/admin",
      });
      assertContainsEqual(
        addition.operations,
        objectContaining({
          kind: "mergeJson",
          to: "apps/web/package.json",
          value: {
            dependencies: { "@demo/admin": "workspace:*" },
            dependenciesMeta: { "@demo/admin": { injected: true } },
          },
          provenance: objectContaining({
            definitionName: "vue-app",
            planningContribution: "foundationPlan",
          }),
        }),
      );

      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assertMatchesPartial(
        JSON.parse(
          await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
        ),
        { dependencies: { "@demo/admin": "workspace:*" } },
      );
      await execa("pnpm", ["install"], { cwd: targetDir });
      await execa(
        "pnpm",
        ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
        { cwd: targetDir },
      );
      await execa("pnpm", ["run", "check"], { cwd: targetDir });
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
      assertMatchesPartial(
        await readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
        {
          boundaries: {
            tags: {
              app: { dependencies: { allow: ["app", "library"] } },
            },
          },
          tasks: { "user:report": { cache: false } },
        },
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

      assertMatches(result, {
        ok: false,
        conflicts: [
          objectContaining({
            path: "turbo.json",
            driver: "structured",
            location: "/boundaries/tags/app/dependencies/allow",
          }),
        ],
      });
      await assert.rejects(
        readFile(path.join(targetDir, "apps/dashboard/package.json")),
        (error) => {
          assertMatchesPartial(error, { code: "ENOENT" });
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
