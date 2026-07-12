import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import {
  renderNewProject,
  renderProject,
  renderProjectAtomically,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { vueAppDefinition } from "./definition.ts";

describe("vue-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  it("owns a browser application contribution with explicit exposure and preparation", () => {
    expect(builtInPresetRegistry.require("vue-app").metadata).toEqual(
      vueAppDefinition.metadata,
    );
    const contribution = vueAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vue",
      projectName: "demo-vue",
      scope: "demo",
      toolchain,
    });

    expect(vueAppDefinition.metadata).toEqual({
      name: "vue-app",
      title: "Vue app",
      description:
        "Vue app workspace with Vite, Tailwind, Pinia, and test tooling.",
    });
    expect(contribution.definition).toEqual({
      name: "@demo/web",
      path: "apps/web",
      role: "runtime-service",
    });
    expect(contribution.exposure).toEqual({
      exports: { ".": { default: "./src/main.ts", types: "./src/main.ts" } },
      imports: { "#/*": { default: "./src/*.ts", types: "./src/*.ts" } },
    });
    expect(contribution.checks.map((check) => check.kind)).toEqual([
      "typescript-typecheck",
      "oxc-lint",
      "oxc-format-check",
      "build",
      "unit-test",
      "e2e-test",
    ]);
    expect(contribution.environmentNeeds).toMatchObject([
      { kind: "playwright-browser-assets", browser: "chromium" },
    ]);
    expect(contribution.foundation).toMatchObject({
      workspacePackageGlobs: ["apps/*"],
    });
  });

  it("initializes and adds Vue applications at default and explicit Package Paths", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-")),
      "demo-vue",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: vueAppDefinition,
      context,
    });

    expect(
      initialization.nextStepInstructions.map((step) => step.display),
    ).toContain("pnpm --filter ./apps/web exec playwright install chromium");
    expect(initialization.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
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
    expect(
      await readFile(path.join(targetDir, "apps/web/vite.config.ts"), "utf8"),
    ).toContain("@tailwindcss/vite");

    const defaultAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: "admin",
    });
    await renderProjectAtomically({
      targetRoot: targetDir,
      operations: [...defaultAddition.operations],
    });
    const explicitAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      context,
      blueprint: defaultAddition.blueprint,
      packageLeafName: "portal",
      packagePath: "products/portal",
    });
    await renderProject({
      targetRoot: targetDir,
      operations: [...explicitAddition.operations],
    });

    expect(explicitAddition.blueprint.packages).toEqual(
      expect.arrayContaining([
        { name: "@demo/admin", path: "apps/admin", role: "runtime-service" },
        {
          name: "@demo/portal",
          path: "products/portal",
          role: "runtime-service",
        },
      ]),
    );
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/admin/package.json"), "utf8"),
      ),
    ).toMatchObject({ name: "@demo/admin" });

    await execa("pnpm", ["install"], { cwd: targetDir });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: targetDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);

  it("owns its default Package Path and updates an explicit Link Intent atomically", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-link-")),
      "demo-vue",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain,
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
      context,
      blueprint: initialization.blueprint,
      packageLeafName: "admin",
      linkFrom: ["apps/web"],
    });

    expect(addition.blueprint.packages).toContainEqual({
      name: "@demo/admin",
      path: "apps/admin",
      role: "runtime-service",
    });
    expect(addition.blueprint.packageLinkIntents).toContainEqual({
      consumerPackagePath: "apps/web",
      providerPackagePath: "apps/admin",
    });
    expect(addition.operations).toContainEqual(
      expect.objectContaining({
        kind: "mergeJson",
        to: "apps/web/package.json",
        value: { dependencies: { "@demo/admin": "workspace:*" } },
        provenance: expect.objectContaining({
          definitionName: "vue-app",
          planningContribution: "foundationPlan",
        }),
      }),
    );

    await renderProjectAtomically({
      targetRoot: targetDir,
      operations: [...addition.operations],
    });
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
    ).toMatchObject({ dependencies: { "@demo/admin": "workspace:*" } });
    await execa("pnpm", ["install"], { cwd: targetDir });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: targetDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);
});
