import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

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

    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/api/package.json"), "utf8"),
      ),
    ).toMatchObject({
      name: "@demo/api",
      exports: {
        ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
      },
    });
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
    ).toMatchObject({ dependencies: { "@demo/api": "workspace:*" } });
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      boundaries: {
        tags: {
          app: { dependencies: { allow: ["app", "library"] } },
          library: { dependencies: { allow: ["library"] } },
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
