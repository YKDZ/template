import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { vueAppDefinition } from "./definition.ts";

void describe("vue-app Built-in Preset Definition behavior", () => {
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
});
