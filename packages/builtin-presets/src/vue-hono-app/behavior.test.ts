import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { vueHonoAppDefinition } from "./definition.ts";

async function treeBytes(
  root: string,
  relativePath = "",
): Promise<Readonly<Record<string, string>>> {
  const entries = await readdir(path.join(root, relativePath), {
    withFileTypes: true,
  });
  const snapshots = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const entryPath = path.join(relativePath, entry.name);
        if (entry.isDirectory()) return await treeBytes(root, entryPath);
        return {
          [entryPath]: (await readFile(path.join(root, entryPath))).toString(
            "base64",
          ),
        };
      }),
  );
  return Object.assign({}, ...snapshots);
}

describe("vue-hono-app Built-in Preset Definition behavior", () => {
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
      defaultPackageScope: "demo",
      toolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: vueHonoAppDefinition,
      context,
    });
    const browserLayer = vueHonoAppDefinition.planInitializationContributions!(
      context,
    )
      .flatMap(
        (contribution) =>
          contribution.foundation.developmentContainerToolLayers ?? [],
      )
      .find((layer) => layer.identity === "browser-test");

    expect(plan.blueprint).toMatchObject({
      schemaVersion: 3,
      packages: [
        { name: "@demo/api", path: "apps/api", role: "runtime-service" },
        { name: "@demo/web", path: "apps/web", role: "runtime-service" },
        {
          name: "@demo/typescript-config",
          path: "packages/typescript-config",
          role: "shared-library",
        },
      ],
      packageLinkIntents: [
        {
          consumerPackagePath: "apps/web",
          providerPackagePath: "apps/api",
        },
      ],
    });
    expect(plan.nextStepInstructions.map((step) => step.display)).toEqual([
      "pnpm install",
      "pnpm run fix",
      "pnpm run check",
    ]);
    expect(plan.environmentNeeds).toContainEqual({
      kind: "playwright-browser-assets",
      browser: "chromium",
      owner: { kind: "workspace-orchestration", path: "." },
    });
    expect(browserLayer).toMatchObject({
      identity: "browser-test",
      requires: ["node-pnpm"],
      buildArguments: [
        {
          name: "PLAYWRIGHT_CLI_PACKAGE",
          value: expect.stringMatching(/^@playwright\/test@/u),
        },
      ],
      probes: [
        {
          identity: "playwright",
          command: "npx",
          args: expect.arrayContaining(["playwright", "--version"]),
        },
      ],
    });

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
      ) as {
        readonly compilerOptions?: Readonly<Record<string, unknown>>;
        readonly extends?: string;
      };
      expect(config.compilerOptions).toMatchObject({
        customConditions: ["source"],
      });
      expect(config.compilerOptions).not.toHaveProperty("erasableSyntaxOnly");
      if (configPath.endsWith("tsconfig.app.json")) {
        expect(config.compilerOptions).toMatchObject({
          exactOptionalPropertyTypes: false,
        });
      } else {
        expect(config.extends).toBe("./tsconfig.app.json");
      }
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
    const webManifest = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(webManifest).toMatchObject({
      dependencies: {
        "@demo/api": "workspace:*",
        "@vue/devtools-api": "catalog:",
        pinia: "catalog:",
        vue: "catalog:",
      },
    });
    expect(webManifest.devDependencies).not.toHaveProperty("@playwright/test");
    expect(webManifest.scripts).not.toHaveProperty("test:e2e");
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
      await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8"),
    ).toContain("playwright install --with-deps chromium");
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      build: {
        args: {
          PLAYWRIGHT_CLI_PACKAGE: expect.stringMatching(/^@playwright\/test@/u),
        },
      },
    });
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
    const rootManifest = JSON.parse(
      await readFile(path.join(targetDir, "package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(rootManifest.scripts).toMatchObject({
      "test:e2e": "playwright test",
    });
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      tasks: {
        "//#test:e2e": {
          dependsOn: ["@demo/api#build", "@demo/web#build"],
          cache: false,
        },
      },
    });
    expect(
      await readFile(path.join(targetDir, "playwright.config.ts"), "utf8"),
    ).toContain("pnpm --filter @demo/api --fail-if-no-match run start");
    await expect(
      readFile(path.join(targetDir, "apps/web/playwright.config.ts"), "utf8"),
    ).rejects.toThrow();
  });

  it("generates a checked browser-backed multi-package workspace", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vue-hono-check-")),
      "demo-stack",
    );
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: runtimeToolchain,
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
    await execa("pnpm", ["exec", "playwright", "install", "chromium"], {
      cwd: targetDir,
    });
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 300_000);

  it("replays the linked API identity through additions without guessing names or collections", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vue-hono-replay-"),
    );
    const targetDir = path.join(workspace, "demo-stack");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: vueHonoAppDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      await Promise.all([
        mkdir(path.join(targetDir, "services")),
        mkdir(path.join(targetDir, "products")),
      ]);
      await rename(
        path.join(targetDir, "apps/api"),
        path.join(targetDir, "services/backend"),
      );
      await rename(
        path.join(targetDir, "apps/web"),
        path.join(targetDir, "products/client"),
      );

      const blueprintPath = path.join(targetDir, ".template/blueprint.json");
      const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
        packages: { name: string; path: string; role: string }[];
        packageLinkIntents: {
          consumerPackagePath: string;
          providerPackagePath: string;
        }[];
      };
      const api = blueprint.packages.find(
        (candidate) => candidate.path === "apps/api",
      )!;
      const web = blueprint.packages.find(
        (candidate) => candidate.path === "apps/web",
      )!;
      Object.assign(api, { name: "@octo/backend", path: "services/backend" });
      Object.assign(web, { name: "@octo/client", path: "products/client" });
      blueprint.packageLinkIntents = [
        {
          consumerPackagePath: web.path,
          providerPackagePath: api.path,
        },
      ];
      await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);

      const generationPath = path.join(targetDir, ".template/generation.json");
      const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
        packages: { contributionIdentity: string; path: string }[];
      };
      for (const record of generation.packages) {
        if (record.contributionIdentity === "api")
          record.path = "services/backend";
        if (record.contributionIdentity === "web")
          record.path = "products/client";
      }
      await writeFile(
        generationPath,
        `${JSON.stringify(generation, null, 2)}\n`,
      );

      const apiManifestPath = path.join(
        targetDir,
        "services/backend/package.json",
      );
      const apiManifest = JSON.parse(
        await readFile(apiManifestPath, "utf8"),
      ) as {
        name: string;
      };
      apiManifest.name = api.name;
      await writeFile(
        apiManifestPath,
        `${JSON.stringify(apiManifest, null, 2)}\n`,
      );
      const webManifestPath = path.join(
        targetDir,
        "products/client/package.json",
      );
      const webManifest = JSON.parse(
        await readFile(webManifestPath, "utf8"),
      ) as {
        name: string;
        dependencies: Record<string, string>;
      };
      webManifest.name = web.name;
      delete webManifest.dependencies["@demo/api"];
      webManifest.dependencies[api.name] = "workspace:*";
      await writeFile(
        webManifestPath,
        `${JSON.stringify(webManifest, null, 2)}\n`,
      );

      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { dependsOn?: string[]; cache?: boolean }>;
      };
      turbo.tasks["//#test:e2e"] = {
        dependsOn: [`${api.name}#build`, `${web.name}#build`],
        cache: false,
      };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
      const playwrightConfigPath = path.join(targetDir, "playwright.config.ts");
      const playwrightConfig = await readFile(playwrightConfigPath, "utf8");
      await writeFile(
        playwrightConfigPath,
        playwrightConfig
          .replace("@demo/api", api.name)
          .replace("@demo/web", web.name)
          .replace("env: { PORT: apiPort }", 'env: { "PORT": apiPort }')
          .replace(
            '  reporter: [["list"], ["html"]],',
            '  metadata: { owner: "customer" },\n  reporter: [["list"], ["html"]],',
          ),
      );
      const workspacePath = path.join(targetDir, "pnpm-workspace.yaml");
      const workspace = await readFile(workspacePath, "utf8");
      await writeFile(
        workspacePath,
        workspace.replace(
          "  - apps/*\n  - packages/*",
          "  - apps/*\n  - packages/*\n  - services/*\n  - products/*",
        ),
      );

      const preparation = prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: targetDir,
        preset: "ts-lib",
        packageLeafName: "shared",
      });
      expect(preparation).toMatchObject({ status: "ready" });
      if (preparation.status !== "ready")
        throw new Error("expected quoted API env key addition to prepare");
      const addition = preparation.plan;
      expect(addition.blueprint.packages).toEqual(
        expect.arrayContaining([
          expect.objectContaining(api),
          expect.objectContaining(web),
          expect.objectContaining({
            name: "@demo/shared",
            path: "packages/shared",
          }),
        ]),
      );
      expect(addition.operations).toContainEqual(
        expect.objectContaining({
          kind: "writeTextTemplate",
          to: "playwright.config.ts",
          replacements: {
            API_PACKAGE_NAME: "@octo/backend",
            WEB_PACKAGE_NAME: "@octo/client",
          },
        }),
      );
      expect(addition.blueprint.packageLinkIntents).toContainEqual({
        consumerPackagePath: "products/client",
        providerPackagePath: "services/backend",
      });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(readFile(playwrightConfigPath, "utf8")).resolves.toContain(
        `pnpm --filter ${api.name} --fail-if-no-match run start`,
      );
      await expect(readFile(playwrightConfigPath, "utf8")).resolves.toContain(
        `pnpm --filter ${web.name} --fail-if-no-match run preview --host 127.0.0.1 --strictPort`,
      );
      await expect(readFile(playwrightConfigPath, "utf8")).resolves.toContain(
        'env: { "PORT": apiPort }',
      );
      const workspaceGlobs = (await readFile(workspacePath, "utf8"))
        .split("nodeLinker:")[0]!
        .split("\n")
        .filter((line) => line.startsWith("  - "))
        .map((line) => line.slice("  - ".length));
      expect(workspaceGlobs).toEqual([
        "apps/*",
        "packages/*",
        "services/*",
        "products/*",
      ]);

      const beforeConflict = await treeBytes(targetDir);
      expect(
        prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "ts-lib",
          packageLeafName: "shared",
          packagePath: "libraries/shared",
        }),
      ).toMatchObject({ status: "conflict", conflict: { kind: "identity" } });
      await expect(treeBytes(targetDir)).resolves.toEqual(beforeConflict);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    "missing",
    "stale",
    "syntax",
    "dynamic",
    "api-port",
    "web-port",
    "api-capture",
    "web-capture",
    "web-endpoint-override",
    "api-port-reassigned",
    "web-port-duplicate",
  ] as const)(
    "rejects %s root Playwright truth before a Package Addition writes",
    async (kind) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), `template-vue-hono-root-truth-${kind}-`),
      );
      const targetDir = path.join(workspace, "demo-stack");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: vueHonoAppDefinition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        const configPath = path.join(targetDir, "playwright.config.ts");
        const config = await readFile(configPath, "utf8");
        if (kind === "missing") await unlink(configPath);
        if (kind === "stale")
          await writeFile(
            configPath,
            config.replace("@demo/api", "@demo/stale"),
          );
        if (kind === "syntax")
          await writeFile(configPath, "export default defineConfig({");
        if (kind === "dynamic")
          await writeFile(
            configPath,
            `const apiCommand = "pnpm --filter @demo/api --fail-if-no-match run start";\n${config.replace('command: "pnpm --filter @demo/api --fail-if-no-match run start"', "command: apiCommand")}`,
          );
        if (kind === "api-port")
          await writeFile(
            configPath,
            config.replace("env: { PORT: apiPort }", 'env: { PORT: "9" }'),
          );
        if (kind === "web-port")
          await writeFile(
            configPath,
            config.replace(
              "env: { PLAYWRIGHT_WEB_PORT: webPort }",
              'env: { PLAYWRIGHT_WEB_PORT: "9" }',
            ),
          );
        if (kind === "api-capture")
          await writeFile(
            configPath,
            config.replace("VITE_API_BASE_URL", "WRONG_API_URL"),
          );
        if (kind === "web-capture")
          await writeFile(
            configPath,
            config.replace("PLAYWRIGHT_WEB_URL", "WRONG_WEB_URL"),
          );
        if (kind === "web-endpoint-override")
          await writeFile(
            configPath,
            config.replace(
              "env: { PLAYWRIGHT_WEB_PORT: webPort }",
              'env: { PLAYWRIGHT_WEB_PORT: webPort, VITE_API_BASE_URL: "http://wrong" }',
            ),
          );
        if (kind === "api-port-reassigned")
          await writeFile(
            configPath,
            config.replace(
              'const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "0";',
              'let apiPort = process.env.PLAYWRIGHT_API_PORT ?? "0";\napiPort = "9";',
            ),
          );
        if (kind === "web-port-duplicate")
          await writeFile(
            configPath,
            config.replace(
              'const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "0";',
              'const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "0";\nconst webPort = "9";',
            ),
          );

        const beforeAddition = await treeBytes(targetDir);
        expect(
          prepareGeneratedRepositoryPackageAddition({
            repositoryRoot: targetDir,
            preset: "ts-lib",
            packageLeafName: kind,
          }),
        ).not.toMatchObject({ status: "ready" });
        await expect(treeBytes(targetDir)).resolves.toEqual(beforeAddition);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
