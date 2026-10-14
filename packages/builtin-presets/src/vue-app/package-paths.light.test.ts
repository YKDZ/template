import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

import { vueAppDefinition } from "./definition.ts";

void describe("vue-app Built-in Preset Definition behavior", () => {
  const runtimeToolchain = {
    nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
      0,
      releaseToolchainSnapshot.nodeVersion.indexOf("."),
    ),
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  };

  void it("initializes and adds Vue applications at default and explicit Package Paths", async (testContext) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-vue-"));
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const targetDir = path.join(workspace, "demo-vue");
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
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    assert.ok(
      (
        await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8")
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
    const playwrightPackage = devcontainer.build?.args?.PLAYWRIGHT_CLI_PACKAGE;
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
        await readFile(path.join(targetDir, "apps/admin/package.json"), "utf8"),
      ).name,
      "@demo/admin",
    );
  });

  void it("owns its default Package Path and updates an explicit Link Intent atomically", async (testContext) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-vue-link-"));
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const targetDir = path.join(workspace, "demo-vue");
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
        planningContribution: webPackageMerge.provenance?.planningContribution,
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
  });
});
