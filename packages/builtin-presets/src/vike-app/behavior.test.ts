import { mkdtemp, readFile, stat } from "node:fs/promises";
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

async function assertDockerCopyInputsExist(
  repositoryRoot: string,
  dockerfile: string,
): Promise<void> {
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY ") || line.includes("--from=")) continue;
    const arguments_ = line.slice("COPY ".length).trim().split(/\s+/u);
    for (const input of arguments_.slice(0, -1)) {
      await expect(
        stat(path.join(repositoryRoot, input)),
      ).resolves.toBeDefined();
    }
  }
}

describe("vike-app Built-in Preset Definition behavior", () => {
  it("registers the complete Vike application Definition", () => {
    expect(builtInPresetRegistry.require("vike-app").metadata).toMatchObject({
      name: "vike-app",
      title: "Vike app",
    });
  });

  it("owns its Vike Template Source and deployment fragments through real handles", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("vike-app"),
      context: createGenerationContext({
        targetDir: "/tmp/vike-template-source",
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "web/Dockerfile",
        }),
        expect.objectContaining({
          kind: "writeTextFromFragments",
          to: ".devcontainer/Dockerfile",
          fragments: expect.arrayContaining([
            expect.objectContaining({ from: "browser-test.Dockerfile" }),
            expect.objectContaining({ from: "shellcheck.Dockerfile" }),
          ]),
        }),
      ]),
    );
  });

  it("projects linked web, database, migration, and deployment boundaries", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vike-")),
      "demo-vike",
    );
    const definition = builtInPresetRegistry.require("vike-app");
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir,
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    expect(plan.blueprint).toMatchObject({
      schemaVersion: 2,
      packages: [
        { name: "@demo/web", path: "apps/web", role: "runtime-service" },
        { name: "@demo/db", path: "packages/db", role: "shared-library" },
        {
          name: "@demo/db-migrations",
          path: "packages/db-migrations",
          role: "shared-library",
        },
      ],
      packageLinkIntents: [
        { consumerPackagePath: "apps/web", providerPackagePath: "packages/db" },
        {
          consumerPackagePath: "packages/db-migrations",
          providerPackagePath: "packages/db",
        },
      ],
    });
    expect(plan.deploymentChecks).toEqual([
      {
        kind: "deployment-image",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
    ]);
    expect(plan.nextStepInstructions.map((step) => step.display)).toEqual(
      expect.arrayContaining([
        "pnpm --filter ./apps/web exec playwright install chromium",
        "sudo apt-get update && sudo apt-get install -y shellcheck",
      ]),
    );

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    expect(
      await readFile(path.join(targetDir, ".pnpmfile.cts"), "utf8"),
    ).toContain("readPackage");

    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
    ).toMatchObject({
      dependencies: { "@demo/db": "workspace:*" },
      imports: { "#db/*": { default: "@demo/db/*", types: "@demo/db/*" } },
    });
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ).dependencies,
    ).not.toHaveProperty("drizzle-orm");
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/package.json"),
          "utf8",
        ),
      ).dependencies,
    ).toMatchObject({ "@demo/db": "workspace:*" });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db/package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      exports: { "./types": { types: "./src/types.d.ts" } },
    });
    expect(
      await readFile(
        path.join(targetDir, "apps/web/pages/index/+Page.vue"),
        "utf8",
      ),
    ).toContain('import type { Todo } from "#db/types";');
    expect(
      await readFile(
        path.join(targetDir, "apps/web/pages/index/+Page.telefunc.ts"),
        "utf8",
      ),
    ).not.toContain("export type Todo");
    const dockerfile = await readFile(
      path.join(targetDir, "apps/web/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "pnpm exec turbo prune @demo/web @demo/db-migrations --docker",
    );
    expect(dockerfile).toContain(
      "COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cts ./",
    );
    expect(dockerfile).toContain('ENV DATABASE_PACKAGE_NAME="@demo/db"');
    expect(dockerfile).toContain("for attempt in 1 2 3; do");
    expect(
      await readFile(
        path.join(targetDir, "apps/web/scripts/container-entrypoint.sh"),
        "utf8",
      ),
    ).toContain("cd /migration");
    await execa("pnpm", ["install", "--lockfile-only"], { cwd: targetDir });
    await assertDockerCopyInputsExist(targetDir, dockerfile);
    expect(
      await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8"),
    ).toContain("playwright install-deps chromium");
    expect(
      await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8"),
    ).toContain("install -y --no-install-recommends shellcheck");
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    expect(dependabot).toContain("package-ecosystem: npm\n    directory: /");
    expect(dependabot).toContain("directory: /.devcontainer");
    expect(dependabot).toContain("directory: /apps/web");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain("playwright-report");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain("test-results");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain(".template/");
    expect(
      await readFile(
        path.join(targetDir, ".github/workflows/check.yml"),
        "utf8",
      ),
    ).toContain("check: [root, deployment]");
    expect(
      JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")),
    ).toMatchObject({
      scripts: {
        "check:deployment": "pnpm --filter './apps/web' run check:deployment",
        check: expect.stringContaining("pnpm run check:boundaries"),
        fix: expect.stringContaining("pnpm run format:write:run"),
      },
    });
  });

  it("passes the generated database, browser, and repository checks", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vike-check-")),
      "demo-vike",
    );
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("vike-app"),
      context: createGenerationContext({
        targetDir,
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
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
    for (const _run of [1, 2]) {
      await execa("pnpm", ["run", "check"], {
        cwd: targetDir,
      });
    }
  }, 300_000);
});
