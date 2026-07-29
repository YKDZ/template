import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { renderNewProject } from "#template-core/renderer";

import { vueHonoAppDefinition } from "./definition.ts";

describe("vue-hono-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  it("owns API and web contributions and derives their workspace link", async () => {
    expect(builtInPresetRegistry.require("vue-hono-app").metadata).toEqual(
      vueHonoAppDefinition.metadata,
    );
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-hono-")),
      "demo-stack",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: vueHonoAppDefinition,
      context,
    });

    expect(plan.blueprint).toMatchObject({
      schemaVersion: 2,
      packages: [
        { name: "@demo/api", path: "apps/api", role: "runtime-service" },
        { name: "@demo/web", path: "apps/web", role: "runtime-service" },
      ],
      packageLinkIntents: [
        {
          consumerPackagePath: "apps/web",
          providerPackagePath: "apps/api",
        },
      ],
    });
    expect(plan.nextStepInstructions.map((step) => step.display)).toContain(
      "pnpm --filter ./apps/web exec playwright install chromium",
    );

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const apiManifest = JSON.parse(
      await readFile(path.join(targetDir, "apps/api/package.json"), "utf8"),
    ) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(apiManifest).toMatchObject({
      name: "@demo/api",
      exports: {
        ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
      },
      imports: {
        "#/*": {
          source: "./src/*.ts",
          types: "./src/*.ts",
          default: "./dist/*.js",
        },
      },
      scripts: { build: "tsc -p tsconfig.build.json" },
    });
    expect(apiManifest.devDependencies).not.toHaveProperty("tsc-alias");
    expect(apiManifest.devDependencies).toHaveProperty("typescript-7");
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/api/tsconfig.json"), "utf8"),
      ),
    ).toMatchObject({
      compilerOptions: {
        customConditions: ["source"],
        erasableSyntaxOnly: true,
      },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "apps/api/tsconfig.build.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ compilerOptions: { customConditions: [] } });
    for (const configPath of [
      "apps/web/tsconfig.app.json",
      "apps/web/tsconfig.test.json",
    ]) {
      const config = JSON.parse(
        await readFile(path.join(targetDir, configPath), "utf8"),
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
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
    ).toMatchObject({
      dependencies: {
        "@demo/api": "workspace:*",
        "@vue/devtools-api": "catalog:",
        pinia: "catalog:",
        vue: "catalog:",
      },
    });
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      boundaries: {
        tags: {
          app: { dependencies: { allow: ["app", "library"] } },
        },
      },
      tasks: {
        build: { dependsOn: ["^build"] },
        typecheck: { dependsOn: ["^typecheck"] },
      },
    });
    expect(
      await readFile(path.join(targetDir, "apps/api/src/runtime.ts"), "utf8"),
    ).toContain("new Hono()");
    expect(
      await readFile(path.join(targetDir, "apps/web/src/api.ts"), "utf8"),
    ).toContain("/api/health");
    expect(
      await readFile(path.join(targetDir, "apps/web/vite.config.ts"), "utf8"),
    ).not.toContain("alias:");
    for (const configPath of [
      "apps/api/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ]) {
      expect(
        await readFile(path.join(targetDir, configPath), "utf8"),
      ).not.toContain("alias:");
    }
    for (const sourcePath of [
      "apps/api/src/index.ts",
      "apps/api/src/server.ts",
      "apps/api/test/app.test.ts",
    ]) {
      expect(
        await readFile(path.join(targetDir, sourcePath), "utf8"),
      ).toContain('from "#/runtime"');
    }
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
      ),
    ).toMatchObject({
      tasks: { "test:e2e": { dependsOn: ["build"], cache: false } },
    });
    expect(
      await readFile(
        path.join(targetDir, "apps/web/playwright.config.ts"),
        "utf8",
      ),
    ).not.toContain("run build");
  });

  it("generates a checked browser-backed multi-package workspace", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-hono-check-")),
      "demo-stack",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: vueHonoAppDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    await execa("pnpm", ["install"], { cwd: targetDir });
    await execa(
      "pnpm",
      ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
      { cwd: targetDir },
    );
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);
});
