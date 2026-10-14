import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { parse as parseYaml } from "yaml";

function prunerManifestCopyInputs(dockerfile: string): string[] {
  const lines = dockerfile.split("\n");
  const stageStart = lines.indexOf("FROM base AS pruner");
  if (stageStart === -1) {
    throw new Error("部署 Dockerfile 缺少 pruner 阶段");
  }
  const stageEnd = lines.findIndex(
    (line, index) => index > stageStart && line.startsWith("FROM "),
  );
  return lines
    .slice(stageStart, stageEnd === -1 ? lines.length : stageEnd)
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
    .map((line) => line.trim().split(/\s+/u)[1] ?? "")
    .filter((input) => input.endsWith("/package.json"));
}
// pruner 声明的包 manifest 集合必须恰好覆盖全部 workspace 成员。
function expectPrunerWorkspaceManifests(
  dockerfile: string,
  packagePaths: readonly string[],
): void {
  assert.deepStrictEqual(
    new Set(prunerManifestCopyInputs(dockerfile)),
    new Set(packagePaths.map((packagePath) => `${packagePath}/package.json`)),
  );
}
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
void describe("vike-app Built-in Preset Definition behavior", () => {
  void it("projects linked web, database, migration, and deployment boundaries", async (testContext) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-vike-"));
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const targetDir = path.join(workspace, "demo-vike");
    const definition = builtInPresetRegistry.require("vike-app");
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      }),
    });
    assert.strictEqual(plan.blueprint.schemaVersion, 3);
    assert.deepStrictEqual(
      plan.blueprint.packages.map(({ name, path: packagePath, role }) => ({
        name,
        path: packagePath,
        role,
      })),
      [
        { name: "@demo/web", path: "apps/web", role: "runtime-service" },
        { name: "@demo/db", path: "packages/db", role: "shared-library" },
        {
          name: "@demo/db-migrations",
          path: "packages/db-migrations",
          role: "shared-library",
        },
        {
          name: "@demo/typescript-config",
          path: "packages/typescript-config",
          role: "shared-library",
        },
      ],
    );
    assert.deepStrictEqual(plan.blueprint.packageLinkIntents, [
      { consumerPackagePath: "apps/web", providerPackagePath: "packages/db" },
      {
        consumerPackagePath: "packages/db-migrations",
        providerPackagePath: "packages/db",
      },
    ]);
    assert.ok(!("deploymentChecks" in plan));
    assert.ok(
      plan.deploymentEnvironmentNeeds.some(
        (need) => need.kind === "docker-engine",
      ),
    );
    assert.deepStrictEqual(
      plan.nextStepInstructions.map((step) => step.display),
      ["pnpm install", "pnpm run fix", "pnpm run check"],
    );
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
    await assert.rejects(
      stat(path.join(targetDir, ".pnpmfile.cts")),
      (error) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.ok(Object.hasOwn(error, "code"));
        assert.strictEqual(
          (error as { readonly code?: unknown }).code,
          "ENOENT",
        );
        return true;
      },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ),
      {
        dependencies: { "@demo/db": "workspace:*" },
        imports: { "#db/*": { default: "@demo/db/*", types: "@demo/db/*" } },
      },
    );
    assert.ok(
      !(
        "drizzle-orm" in
        (JSON.parse(
          await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
        ).dependencies ?? {})
      ),
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/package.json"),
          "utf8",
        ),
      ).dependencies,
      { "@demo/db": "workspace:*" },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db/package.json"),
          "utf8",
        ),
      ),
      {
        exports: { "./types": { types: "./dist/types.d.ts" } },
      },
    );
    const webManifest = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
    ) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.partialDeepStrictEqual(webManifest.scripts, {
      dev: "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source vike dev",
      preview: "DATABASE_PROFILE=dev vike preview",
      "test:e2e": "DATABASE_PROFILE=e2e playwright test",
    });
    const dbManifest = JSON.parse(
      await readFile(path.join(targetDir, "packages/db/package.json"), "utf8"),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.strictEqual(
      dbManifest.scripts.test,
      "DATABASE_PROFILE=test node --conditions=source --test --test-reporter=spec --test-reporter=./scripts/node-test-count-reporter.ts --test-reporter-destination=stdout --test-reporter-destination=stderr 'test/**/*.test.ts'",
    );
    assert.strictEqual(
      dbManifest.scripts["db:reset"],
      "node --conditions=source scripts/reset.ts",
    );
    assert.strictEqual(
      dbManifest.scripts["db:seed:example"],
      "node --conditions=source scripts/seed-example.ts",
    );
    const migrationsManifest = JSON.parse(
      await readFile(
        path.join(targetDir, "packages/db-migrations/package.json"),
        "utf8",
      ),
    ) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.strictEqual(
      migrationsManifest.scripts["db:push"],
      "NODE_OPTIONS=--conditions=source drizzle-kit push",
    );
    assert.strictEqual(
      migrationsManifest.scripts["db:generate"],
      "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source drizzle-kit generate",
    );
    assert.ok(!("db:prepare:dev" in (migrationsManifest.scripts ?? {})));
    assert.ok(!("db:prepare:test" in (migrationsManifest.scripts ?? {})));
    const playwrightConfig = await readFile(
      path.join(targetDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    assert.ok(playwrightConfig.includes("availablePort"));
    assert.ok(playwrightConfig.includes("node dist/server/index.mjs"));
    assert.ok(playwrightConfig.includes("globalTeardown"));
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    assert.ok(viteConfig.includes("vike"));
    assert.ok(viteConfig.includes('external: ["@demo/db"]'));
    assert.ok(!viteConfig.includes("externalConditions"));
    const drizzleConfig = await readFile(
      path.join(targetDir, "packages/db-migrations/drizzle.config.ts"),
      "utf8",
    );
    assert.ok(drizzleConfig.includes("mkdirSync"));
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "apps/web/pages/index/+Page.vue"),
          "utf8",
        )
      ).includes('import type { Todo } from "#db/types";'),
    );
    assert.ok(
      !(
        await readFile(
          path.join(targetDir, "apps/web/pages/index/+Page.telefunc.ts"),
          "utf8",
        )
      ).includes("export type Todo"),
    );
    const webNodeConfig = JSON.parse(
      await readFile(
        path.join(targetDir, "apps/web/tsconfig.node.json"),
        "utf8",
      ),
    ) as {
      readonly compilerOptions?: Readonly<Record<string, unknown>>;
    };
    assert.ok(!("paths" in (webNodeConfig.compilerOptions ?? {})));
    assert.ok(!("customConditions" in (webNodeConfig.compilerOptions ?? {})));
    assert.partialDeepStrictEqual(webNodeConfig.compilerOptions, {
      erasableSyntaxOnly: true,
    });
    const databaseConfig = JSON.parse(
      await readFile(path.join(targetDir, "packages/db/tsconfig.json"), "utf8"),
    ) as {
      readonly compilerOptions?: Readonly<Record<string, unknown>>;
    };
    assert.ok(!("paths" in (databaseConfig.compilerOptions ?? {})));
    assert.partialDeepStrictEqual(databaseConfig.compilerOptions, {
      customConditions: ["source"],
      erasableSyntaxOnly: true,
    });
    assert.deepStrictEqual(databaseConfig.compilerOptions?.customConditions, [
      "source",
    ]);
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/tsconfig.json"),
          "utf8",
        ),
      ),
      { compilerOptions: { erasableSyntaxOnly: true } },
    );
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
      assert.ok(!("paths" in (config.compilerOptions ?? {})));
      assert.ok(!("customConditions" in (config.compilerOptions ?? {})));
      assert.ok(!("erasableSyntaxOnly" in (config.compilerOptions ?? {})));
      if (configPath.endsWith("tsconfig.app.json")) {
        assert.partialDeepStrictEqual(config.compilerOptions, {
          exactOptionalPropertyTypes: false,
        });
      } else {
        assert.strictEqual(config.extends, "./tsconfig.app.json");
      }
    }
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db/tsconfig.build.json"),
          "utf8",
        ),
      ),
      {
        compilerOptions: {
          customConditions: ["source"],
          tsBuildInfoFile: "./dist/tsconfig.build.tsbuildinfo",
        },
      },
    );
    const databaseBuildConfig = JSON.parse(
      await readFile(
        path.join(targetDir, "packages/db/tsconfig.build.json"),
        "utf8",
      ),
    );
    assert.deepStrictEqual(
      databaseBuildConfig.compilerOptions.customConditions,
      ["source"],
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/tsconfig.build.json"),
          "utf8",
        ),
      ),
      { compilerOptions: { customConditions: [] } },
    );
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/tsconfig.build.json"),
          "utf8",
        ),
      ).compilerOptions.customConditions,
      [],
    );
    assert.ok(
      !(
        await readFile(path.join(targetDir, "apps/web/vite.config.ts"), "utf8")
      ).includes("alias:"),
    );
    const rootTurboConfig = JSON.parse(
      await readFile(path.join(targetDir, "turbo.json"), "utf8"),
    );
    assert.ok(
      !Object.keys(rootTurboConfig.tasks).some((taskName) =>
        taskName.startsWith("@demo/"),
      ),
    );
    const webTurboConfig = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
    );
    assert.deepStrictEqual(webTurboConfig.tags, ["app"]);
    assert.partialDeepStrictEqual(webTurboConfig.tasks["test:e2e"], {
      dependsOn: [
        "//#database:prepare:e2e",
        "@demo/db#build",
        "build",
        "browser:prepare",
      ],
      cache: false,
      tags: ["quality:heavy"],
    });
    const databaseTurboConfig = JSON.parse(
      await readFile(path.join(targetDir, "packages/db/turbo.json"), "utf8"),
    );
    assert.deepStrictEqual(databaseTurboConfig.tags, ["library"]);
    assert.partialDeepStrictEqual(databaseTurboConfig.tasks.test, {
      dependsOn: ["//#database:prepare:test"],
      outputs: [],
      tags: ["quality:light"],
    });
    const migrationsTurboConfig = JSON.parse(
      await readFile(
        path.join(targetDir, "packages/db-migrations/turbo.json"),
        "utf8",
      ),
    );
    assert.deepStrictEqual(migrationsTurboConfig.tags, ["library"]);
    assert.deepStrictEqual(migrationsTurboConfig.tasks.typecheck.dependsOn, [
      "@demo/db#build",
    ]);
    const dockerfile = await readFile(
      path.join(targetDir, "Dockerfile"),
      "utf8",
    );
    assert.ok(
      dockerfile.includes(
        "pnpm exec turbo prune @demo/web @demo/db-migrations --docker",
      ),
    );
    expectPrunerWorkspaceManifests(
      dockerfile,
      plan.blueprint.packages.map((package_) => package_.path),
    );
    assert.ok(
      dockerfile.includes(
        "COPY --from=pruner /repo/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh",
      ),
    );
    assert.ok(!dockerfile.includes(".pnpmfile.cts"));
    assert.ok(!dockerfile.includes("DATABASE_PACKAGE_NAME"));
    assert.ok(dockerfile.includes("for attempt in 1 2 3; do"));
    assert.ok(
      dockerfile.includes('ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"'),
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "scripts/container-entrypoint.sh"),
          "utf8",
        )
      ).includes("cd /migration"),
    );
    const deploymentCheckScript = await readFile(
      path.join(targetDir, "scripts/check-standalone-deployment.ts"),
      "utf8",
    );
    assert.ok(deploymentCheckScript.includes('"0.0.0.0::3000"'));
    assert.ok(deploymentCheckScript.includes("dockerHostGatewayAddress"));
    assert.ok(deploymentCheckScript.includes("return baseUrl;"));
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    assert.ok(
      devcontainerDockerfile.includes(
        'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
      ),
    );
    assert.ok(
      devcontainerDockerfile.includes(
        'install -d -m 0755 "$PNPM_HOME" "$PNPM_HOME/bin"',
      ),
    );
    assert.ok(!devcontainerDockerfile.includes("COREPACK_HOME"));
    assert.ok(
      devcontainerDockerfile.includes(
        "git config --system init.defaultBranch main",
      ),
    );
    assert.ok(
      devcontainerDockerfile.includes(
        "playwright install --with-deps chromium",
      ),
    );
    assert.ok(
      devcontainerDockerfile.includes(
        "install -y --no-install-recommends shellcheck",
      ),
    );
    const devcontainerConfiguration = JSON.parse(
      await readFile(
        path.join(targetDir, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    );
    assert.match(
      devcontainerConfiguration.build.args.PLAYWRIGHT_CLI_PACKAGE,
      /^@playwright\/test@/u,
    );
    assert.partialDeepStrictEqual(devcontainerConfiguration, {
      mounts: [
        {
          type: "volume",
          source: "${devcontainerId}-pnpm-store",
          target: "/pnpm/store",
        },
      ],
    });
    assert.strictEqual(devcontainerConfiguration.mounts.length, 1);
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    const dependabotConfiguration = parseYaml(dependabot) as {
      readonly updates: readonly {
        readonly "package-ecosystem": string;
        readonly directory: string;
      }[];
    };
    for (const [ecosystem, directory] of [
      ["npm", "/"],
      ["docker", "/"],
      ["docker", "/.devcontainer"],
    ] as const) {
      assert.ok(
        dependabotConfiguration.updates.some(
          (update) =>
            update["package-ecosystem"] === ecosystem &&
            update.directory === directory,
        ),
      );
    }
    assert.ok(
      (await readFile(path.join(targetDir, ".gitignore"), "utf8")).includes(
        ".pnpm-store/",
      ),
    );
    assert.ok(
      (await readFile(path.join(targetDir, ".gitignore"), "utf8")).includes(
        "playwright-report",
      ),
    );
    assert.ok(
      (await readFile(path.join(targetDir, ".gitignore"), "utf8")).includes(
        "test-results",
      ),
    );
    assert.ok(
      (await readFile(path.join(targetDir, ".gitignore"), "utf8")).includes(
        ".template/",
      ),
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const workflow = parseYaml(checkWorkflow) as {
      readonly jobs: {
        readonly check: {
          readonly name: string;
          readonly "timeout-minutes": number;
          readonly steps: readonly {
            readonly name?: string;
            readonly uses?: string;
            readonly if?: string;
            readonly env?: Readonly<Record<string, string>>;
            readonly with?: Readonly<Record<string, string>>;
            readonly run?: string;
          }[];
        };
      };
    };
    assert.strictEqual(workflow.jobs.check.name, "Full Check");
    assert.strictEqual(workflow.jobs.check["timeout-minutes"], 45);
    const steps = workflow.jobs.check.steps;
    const lightCheckIndex = steps.findIndex(
      ({ name }) => name === "Run Light Check",
    );
    const buildxSetupIndex = steps.findIndex(({ uses }) =>
      uses?.startsWith("docker/setup-buildx-action@"),
    );
    const heavyCheckIndex = steps.findIndex(
      ({ name }) => name === "Run Heavy Check",
    );
    const buildxSetup = steps[buildxSetupIndex];
    assert.ok(lightCheckIndex >= 0);
    assert.ok(buildxSetupIndex > lightCheckIndex);
    assert.ok(heavyCheckIndex > buildxSetupIndex);
    assert.strictEqual(steps[lightCheckIndex]?.run, "pnpm run check");
    assert.strictEqual(steps[heavyCheckIndex]?.run, "pnpm run check:heavy");
    assert.match(
      buildxSetup?.uses ?? "",
      /^docker\/setup-buildx-action@[a-f0-9]{40}$/u,
    );
    const diagnosticStaging = steps.find(
      ({ name }) => name === "Stage Check diagnostics",
    );
    assert.strictEqual(
      diagnosticStaging?.env?.PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS,
      "apps/web",
    );
    assert.strictEqual(
      diagnosticStaging?.env?.VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS,
      "apps/web",
    );
    assert.ok(
      (diagnosticStaging?.run ?? "").includes(
        "for diagnostic_directory in test-results playwright-report; do",
      ),
    );
    const diagnosticUpload = steps.find(
      ({ name }) => name === "Upload Check diagnostics",
    );
    assert.strictEqual(
      diagnosticUpload?.with?.path,
      ".template-ci-diagnostics",
    );
    assert.partialDeepStrictEqual(
      JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")),
      {
        scripts: {
          deployment:
            "node --conditions=source scripts/check-standalone-deployment.ts",
          check: "node --conditions=source scripts/quality-gates.ts check",
          "check:heavy":
            "node --conditions=source scripts/quality-gates.ts check:heavy",
          "check:full":
            "node --conditions=source scripts/quality-gates.ts check:full",
          "database:prepare:dev":
            "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
          "database:prepare:test":
            "DATABASE_PROFILE=test pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=test pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=test pnpm --filter @demo/db run db:seed:example",
          "database:prepare:e2e":
            "DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=e2e pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:seed:example",
          dev: "pnpm run database:prepare:dev && turbo watch dev --filter=@demo/web",
          lint: "shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts",
          fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
        },
      },
    );
  });
});
