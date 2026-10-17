import assert from "node:assert/strict";
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
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parseDocument, parse as parseYaml } from "yaml";

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

void describe("vue-hono-app Built-in Preset Definition behavior", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  void it("原生 Web、API 和共同包生成同一联合工作区", async (testContext) => {
    assert.deepStrictEqual(
      builtInPresetRegistry.require("vue-hono-app").metadata,
      vueHonoAppDefinition.metadata,
    );
    const workspace = await mkdtemp(path.join(tmpdir(), "template-vue-hono-"));
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: vueHonoAppDefinition,
      context,
    });
    assert.partialDeepStrictEqual(plan.blueprint, {
      packages: [
        { name: "@demo/api", path: "apps/api", role: "runtime-service" },
        { name: "@demo/web", path: "apps/web", role: "runtime-service" },
        {
          name: "@demo/typescript-config",
          path: "packages/typescript-config",
          role: "shared-library",
        },
        {
          name: "@demo/vue-shared",
          path: "packages/vue-shared",
          role: "shared-library",
        },
      ],
      packageLinkIntents: [
        { consumerPackagePath: "apps/web", providerPackagePath: "apps/api" },
      ],
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
    const api = JSON.parse(
      await readFile(path.join(targetDir, "apps/api/package.json"), "utf8"),
    );
    const web = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
    );
    assert.partialDeepStrictEqual(api, {
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
      dependencies: { "@demo/typescript-config": "workspace:*" },
    });
    assert.partialDeepStrictEqual(web, {
      name: "@demo/web",
      dependencies: {
        "@demo/api": "workspace:*",
        "@demo/vue-shared": "workspace:*",
        vue: "catalog:",
        pinia: "catalog:",
      },
      devDependencies: { "@demo/typescript-config": "workspace:*" },
    });
    assert.ok(!("test:e2e" in web.scripts));
    const root = JSON.parse(
      await readFile(path.join(targetDir, "package.json"), "utf8"),
    );
    assert.equal(root.scripts["test:e2e"], "playwright test");
    const turbo = JSON.parse(
      await readFile(path.join(targetDir, "turbo.json"), "utf8"),
    );
    assert.deepStrictEqual(turbo.tasks["//#test:e2e"].dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetDir, "joint-e2e.json"), "utf8"),
      ),
      { apiPackageName: "@demo/api", webPackageName: "@demo/web" },
    );
    const container = JSON.parse(
      await readFile(
        path.join(targetDir, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    );
    assert.match(
      container.build.args.PLAYWRIGHT_CLI_PACKAGE,
      /^@playwright\/test@/u,
    );
  });

  void it("replays the linked API identity through additions without guessing names or collections", async () => {
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

      const environmentPath = path.join(
        targetDir,
        ".template/environment-needs.json",
      );
      const environment = JSON.parse(
        await readFile(environmentPath, "utf8"),
      ) as { check: { owner: { path: string } }[] };
      for (const need of environment.check) {
        if (need.owner.path === "apps/web") need.owner.path = "products/client";
      }
      await writeFile(
        environmentPath,
        `${JSON.stringify(environment, null, 2)}\n`,
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
        tasks: Record<
          string,
          { dependsOn?: string[]; cache?: boolean; tags?: string[] }
        >;
      };
      turbo.tasks["//#test:e2e"] = {
        dependsOn: [
          `${api.name}#build`,
          `${web.name}#build`,
          `${web.name}#browser:prepare`,
        ],
        cache: false,
        tags: ["quality:heavy"],
      };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
      await writeFile(
        path.join(targetDir, "joint-e2e.json"),
        JSON.stringify({ apiPackageName: api.name, webPackageName: web.name }),
      );
      const playwrightConfigPath = path.join(targetDir, "playwright.config.ts");
      const playwrightConfig = await readFile(playwrightConfigPath, "utf8");
      await writeFile(
        playwrightConfigPath,
        playwrightConfig
          .replace("env: { PORT: apiPort }", 'env: { "PORT": apiPort }')
          .replace(
            '  reporter: [["list"], ["html"]],',
            '  metadata: { owner: "customer" },\n  reporter: [["list"], ["html"]],',
          ),
      );
      const workspacePath = path.join(targetDir, "pnpm-workspace.yaml");
      const workspace = parseDocument(await readFile(workspacePath, "utf8"));
      const packages = workspace.toJS().packages as string[];
      workspace.set("packages", [...packages, "services/*", "products/*"]);
      await writeFile(workspacePath, workspace.toString());

      const preparation = prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: targetDir,
        preset: "ts-lib",
        packageLeafName: "shared",
      });
      assert.strictEqual(preparation.status, "ready");
      if (preparation.status !== "ready")
        throw new Error("expected quoted API env key addition to prepare");
      const addition = preparation.plan;
      assert.ok(
        addition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === api.name &&
            packageDefinition.path === api.path &&
            packageDefinition.role === api.role,
        ),
      );
      assert.ok(
        addition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === web.name &&
            packageDefinition.path === web.path &&
            packageDefinition.role === web.role,
        ),
      );
      assert.ok(
        addition.blueprint.packages.some(
          (packageDefinition) =>
            packageDefinition.name === "@demo/shared" &&
            packageDefinition.path === "packages/shared",
        ),
      );
      assert.ok(
        addition.blueprint.packageLinkIntents?.some((intent) =>
          isDeepStrictEqual(intent, {
            consumerPackagePath: "products/client",
            providerPackagePath: "services/backend",
          }),
        ),
      );
      const replayedApplication = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assert.strictEqual(replayedApplication.ok, true);
      const replayedRootManifest = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as { readonly scripts: Readonly<Record<string, string>> };
      assert.deepStrictEqual(
        {
          check: replayedRootManifest.scripts.check,
          "check:heavy": replayedRootManifest.scripts["check:heavy"],
          "check:full": replayedRootManifest.scripts["check:full"],
        },
        {
          check: "node --conditions=source scripts/task-gates.ts check",
          "check:heavy":
            "node --conditions=source scripts/task-gates.ts check:heavy",
          "check:full":
            "node --conditions=source scripts/task-gates.ts check:full",
        },
      );
      const replayedTurbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        readonly tasks: Readonly<
          Record<
            string,
            {
              readonly dependsOn?: readonly string[];
              readonly tags?: readonly string[];
            }
          >
        >;
      };
      assert.deepStrictEqual(replayedTurbo.tasks["//#test:e2e"]?.tags, [
        "quality:heavy",
      ]);
      assert.deepStrictEqual(replayedTurbo.tasks["//#test:e2e"]?.dependsOn, [
        `${api.name}#build`,
        `${web.name}#build`,
        `${web.name}#browser:prepare`,
      ]);
      const replayedPlaywrightConfig = await readFile(
        playwrightConfigPath,
        "utf8",
      );
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(path.join(targetDir, "joint-e2e.json"), "utf8"),
        ),
        { apiPackageName: api.name, webPackageName: web.name },
      );
      assert.ok(replayedPlaywrightConfig.includes('env: { "PORT": apiPort }'));
      const workspaceGlobs = parseYaml(
        await readFile(workspacePath, "utf8"),
      ).packages;
      assert.deepStrictEqual(workspaceGlobs, [
        "apps/*",
        "packages/*",
        "services/*",
        "products/*",
      ]);

      const beforeConflict = await treeBytes(targetDir);
      const conflict = prepareGeneratedRepositoryPackageAddition({
        repositoryRoot: targetDir,
        preset: "ts-lib",
        packageLeafName: "shared",
        packagePath: "libraries/shared",
      });
      assert.strictEqual(conflict.status, "conflict");
      if (conflict.status === "conflict")
        assert.strictEqual(conflict.conflict.kind, "identity");
      assert.deepStrictEqual(await treeBytes(targetDir), beforeConflict);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  for (const kind of [
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
  ] as const) {
    void it(`rejects ${kind} root Playwright truth before a Package Addition writes`, async () => {
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
            path.join(targetDir, "joint-e2e.json"),
            JSON.stringify({
              apiPackageName: "@demo/stale",
              webPackageName: "@demo/web",
            }),
          );
        if (kind === "syntax")
          await writeFile(configPath, "export default defineConfig({");
        if (kind === "dynamic")
          await writeFile(
            configPath,
            `const apiCommand = process.env.CUSTOM_API_COMMAND;\n${config.replace(/command: `pnpm --filter \$\{[^}]+\} --fail-if-no-match run start`/u, "command: apiCommand")}`,
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
        const preparation = prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "ts-lib",
          packageLeafName: kind,
        });
        assert.notStrictEqual(preparation.status, "ready");
        assert.deepStrictEqual(await treeBytes(targetDir), beforeAddition);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});
