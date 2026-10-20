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
import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

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
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
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
