import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

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
    expect(contribution.manifest.dependencies).toEqual({
      "@vue/devtools-api": "catalog:",
      pinia: "catalog:",
      vue: "catalog:",
    });
    expect(contribution).not.toHaveProperty("checks");
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
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).toContain("@tailwindcss/vite");
    expect(viteConfig).not.toContain("alias:");
    expect(
      await readFile(path.join(targetDir, "apps/web/vitest.config.ts"), "utf8"),
    ).not.toContain("alias:");
    for (const configPath of ["tsconfig.app.json", "tsconfig.test.json"]) {
      const config = JSON.parse(
        await readFile(path.join(targetDir, "apps/web", configPath), "utf8"),
      ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
      expect(config.compilerOptions).toMatchObject({
        customConditions: ["source"],
      });
      expect(config.compilerOptions).not.toHaveProperty("erasableSyntaxOnly");
    }
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "apps/web/tsconfig.node.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      compilerOptions: {
        customConditions: ["source"],
        erasableSyntaxOnly: true,
      },
    });

    const defaultAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      context,
      blueprint: initialization.blueprint,
      packageLeafName: "admin",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...defaultAddition.projectProjections,
    });
    const explicitAddition = planGeneratedRepositoryPackageAddition({
      definition: vueAppDefinition,
      context,
      blueprint: defaultAddition.blueprint,
      packageLeafName: "portal",
      packagePath: "products/portal",
    });
    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...explicitAddition.projectProjections,
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
        value: {
          dependencies: { "@demo/admin": "workspace:*" },
          dependenciesMeta: { "@demo/admin": { injected: true } },
        },
        provenance: expect.objectContaining({
          definitionName: "vue-app",
          planningContribution: "foundationPlan",
        }),
      }),
    );

    await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.projectProjections,
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

  it("reconciles Foundation structured customization and reruns idempotently", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
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
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(
        readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        boundaries: {
          tags: {
            app: { dependencies: { allow: ["app", "library"] } },
          },
        },
        tasks: { "user:report": { cache: false } },
      });

      const repeated = planGeneratedRepositoryPackageAddition({
        definition: vueAppDefinition,
        context,
        blueprint: addition.blueprint,
        packageLeafName: "dashboard",
      });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeated.projectProjections,
        }),
      ).resolves.toEqual({ ok: true, changedPaths: [], actions: [] });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a structured conflict before mutating an incompatible Turbo customization", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-structured-conflict-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
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
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result).toEqual({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: "turbo.json",
            driver: "structured",
            location: "/boundaries/tags/app/dependencies/allow",
          }),
        ],
      });
      await expect(
        readFile(path.join(targetDir, "apps/dashboard/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
