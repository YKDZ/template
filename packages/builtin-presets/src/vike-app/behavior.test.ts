import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  prepareGeneratedRepositoryPackageAddition,
  type PackageAdditionPreparation,
} from "@ykdz/template-builtin-presets";
import {
  reconcileAndApplyProjectProjections,
  type ProjectProjectionAction,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { createVikeAppDefinition, vikeAppDefinition } from "./definition.ts";

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

// 冻结安装按 lockfile 的 importer 逐项校验，pruner 声明的包 manifest 集合必须恰好覆盖全部 workspace 成员。
function expectPrunerWorkspaceManifests(
  dockerfile: string,
  packagePaths: readonly string[],
): void {
  expect(new Set(prunerManifestCopyInputs(dockerfile))).toEqual(
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

describe("vike-app Built-in Preset Definition behavior", () => {
  it("registers the complete Vike application Definition", () => {
    expect(builtInPresetRegistry.require("vike-app").metadata).toMatchObject({
      name: "vike-app",
      title: "Vike 应用",
    });
  });

  it("declares its browser and ShellCheck Tool Layers", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: vikeAppDefinition,
      context: createGenerationContext({
        targetDir: "/tmp/demo-vike",
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    const layers = plan.developmentContainer.toolLayers;
    const byIdentity = new Map(layers.map((layer) => [layer.identity, layer]));
    const browser = byIdentity.get("browser-test")!;
    const shellCheck = byIdentity.get("shellcheck")!;

    expect([...byIdentity.keys()]).toEqual(
      expect.arrayContaining(["browser-test", "shellcheck"]),
    );
    expect(
      resolveTemplateSource(browser.dockerfile.source, browser.dockerfile.from),
    ).toBe(
      path.resolve(
        import.meta.dirname,
        "../../templates/shared/devcontainer/browser-test.Dockerfile",
      ),
    );
    expect(shellCheck).toMatchObject({
      requires: ["node-pnpm"],
      probes: [
        {
          identity: "shellcheck",
          command: "shellcheck",
          args: ["--version"],
        },
      ],
    });
    expect(
      resolveTemplateSource(
        shellCheck.dockerfile.source,
        shellCheck.dockerfile.from,
      ),
    ).toBe(
      path.resolve(
        import.meta.dirname,
        "../../templates/vike-app/devcontainer/shellcheck.Dockerfile",
      ),
    );
  });

  it("owns its Vike Template Source and deployment fragments through real handles", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("vike-app"),
      context: createGenerationContext({
        targetDir: "/tmp/vike-template-source",
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "web/Dockerfile",
          to: "Dockerfile",
        }),
        expect.objectContaining({
          kind: "writeTextFromFragments",
          to: ".devcontainer/Dockerfile",
          fragments: expect.arrayContaining([
            expect.objectContaining({ from: "browser-test.Dockerfile" }),
            expect.objectContaining({
              from: "devcontainer/shellcheck.Dockerfile",
            }),
          ]),
        }),
      ]),
    );
  });

  it("keeps source-linked workspaces while injecting pnpm 11 deploy closures", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vike-deploy-policy-")),
      "demo-vike",
    );
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("vike-app"),
      context: createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const [workspace, dockerfile] = await Promise.all([
      readFile(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      readFile(path.join(targetDir, "Dockerfile"), "utf8"),
    ]);

    expect(dockerfile).toContain(
      "pnpm --config.inject-workspace-packages=true --filter @demo/web deploy --prod /runtime-deploy",
    );
    expect(dockerfile).toContain(
      "pnpm --config.inject-workspace-packages=true --filter @demo/db-migrations deploy --prod /migration-deploy",
    );
    expect(dockerfile).not.toContain("--legacy");
    expect(workspace).toContain("injectWorkspacePackages: false");
    expect(workspace).toContain("syncInjectedDepsAfterScripts:\n  - build");
  });

  it("derives cross-package contracts from Package identities instead of sibling paths", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vike-relocated-")),
      "demo-vike",
    );
    const definition = createVikeAppDefinition((context) => ({
      web: {
        name: `@${context.defaultPackageScope}/frontend`,
        path: "services/frontend",
        role: "runtime-service",
      },
      db: {
        name: `@${context.defaultPackageScope}/data-store`,
        path: "modules/data-store",
        role: "shared-library",
      },
      migrations: {
        name: `@${context.defaultPackageScope}/schema-tool`,
        path: "tooling/schema-tool",
        role: "shared-library",
      },
    }));
    const plan = planGeneratedRepositoryInitialization({
      definition,
      context: createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    expect(plan.blueprint.packageLinkIntents).toEqual([
      {
        consumerPackagePath: "services/frontend",
        providerPackagePath: "modules/data-store",
      },
      {
        consumerPackagePath: "tooling/schema-tool",
        providerPackagePath: "modules/data-store",
      },
    ]);
    const rootManifest = JSON.parse(
      await readFile(path.join(targetDir, "package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(rootManifest.scripts).toMatchObject({
      "database:prepare:dev":
        "DATABASE_PROFILE=dev pnpm --filter @demo/schema-tool run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/data-store run db:seed:example",
      dev: "pnpm run database:prepare:dev && turbo watch dev --filter=@demo/frontend",
    });
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      tasks: {
        "//#deployment": {
          dependsOn: [
            "@demo/frontend#build",
            "@demo/data-store#build",
            "@demo/schema-tool#build",
          ],
        },
        "@demo/frontend#test:e2e": {
          dependsOn: [
            "//#database:prepare:e2e",
            "@demo/data-store#build",
            "build",
          ],
        },
      },
    });
    const dockerfile = await readFile(
      path.join(targetDir, "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "COPY services/frontend/package.json services/frontend/package.json",
    );
    expect(dockerfile).toContain(
      "COPY modules/data-store/package.json modules/data-store/package.json",
    );
    expect(dockerfile).toContain(
      "COPY tooling/schema-tool/package.json tooling/schema-tool/package.json",
    );
    expect(dockerfile).toContain(
      "pnpm exec turbo prune @demo/frontend @demo/schema-tool --docker",
    );
    expect(dockerfile).not.toContain("apps/web");
    expect(dockerfile).not.toContain("packages/db");
    expectPrunerWorkspaceManifests(
      dockerfile,
      plan.blueprint.packages.map((package_) => package_.path),
    );
    await expect(
      readFile(
        path.join(targetDir, "services/frontend/vite.config.ts"),
        "utf8",
      ),
    ).resolves.toContain('external: ["@demo/data-store"]');
    await expect(
      readFile(
        path.join(targetDir, "tooling/schema-tool/drizzle.config.ts"),
        "utf8",
      ),
    ).resolves.toContain('from "@demo/data-store/storage"');
    await expect(
      readFile(path.join(targetDir, "services/frontend/server/app.ts"), "utf8"),
    ).resolves.toContain('from "@demo/data-store"');

    const addition = planGeneratedRepositoryPackageAddition({
      definition: builtInPresetRegistry.require("ts-lib"),
      localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
      packageLeafName: "shared-probe",
    });
    expect(addition.blueprint.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "services/frontend" }),
        expect.objectContaining({ path: "modules/data-store" }),
        expect.objectContaining({ path: "tooling/schema-tool" }),
        expect.objectContaining({ path: "packages/shared-probe" }),
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
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      }),
    });

    expect(plan.blueprint).toMatchObject({
      schemaVersion: 3,
      packages: [
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
      packageLinkIntents: [
        { consumerPackagePath: "apps/web", providerPackagePath: "packages/db" },
        {
          consumerPackagePath: "packages/db-migrations",
          providerPackagePath: "packages/db",
        },
      ],
    });
    expect(plan).not.toHaveProperty("deploymentChecks");
    expect(plan.deploymentEnvironmentNeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "docker-engine" }),
      ]),
    );
    expect(plan.nextStepInstructions.map((step) => step.display)).toEqual([
      "pnpm install",
      "pnpm run fix",
      "pnpm run check",
    ]);

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    await expect(
      stat(path.join(targetDir, ".pnpmfile.cts")),
    ).rejects.toMatchObject({ code: "ENOENT" });

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
      exports: { "./types": { types: "./dist/types.d.ts" } },
    });
    const webManifest = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(webManifest.scripts).toMatchObject({
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
    expect(dbManifest.scripts.test).toBe(
      "DATABASE_PROFILE=test NODE_OPTIONS=--conditions=source vitest run --reporter=agent --silent=passed-only",
    );
    expect(dbManifest.scripts["db:reset"]).toBe(
      "node --conditions=source scripts/reset.ts",
    );
    expect(dbManifest.scripts["db:seed:example"]).toBe(
      "node --conditions=source scripts/seed-example.ts",
    );
    const migrationsManifest = JSON.parse(
      await readFile(
        path.join(targetDir, "packages/db-migrations/package.json"),
        "utf8",
      ),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(migrationsManifest.scripts["db:push"]).toBe(
      "NODE_OPTIONS=--conditions=source drizzle-kit push",
    );
    expect(migrationsManifest.scripts["db:generate"]).toBe(
      "DATABASE_PROFILE=dev NODE_OPTIONS=--conditions=source drizzle-kit generate",
    );
    expect(migrationsManifest.scripts).not.toHaveProperty("db:prepare:dev");
    expect(migrationsManifest.scripts).not.toHaveProperty("db:prepare:test");
    const playwrightConfig = await readFile(
      path.join(targetDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    expect(playwrightConfig).toContain("availablePort");
    expect(playwrightConfig).toContain("node dist/server/index.mjs");
    expect(playwrightConfig).toContain("globalTeardown");
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).toContain("vike");
    expect(viteConfig).toContain('external: ["@demo/db"]');
    expect(viteConfig).not.toContain("externalConditions");
    const drizzleConfig = await readFile(
      path.join(targetDir, "packages/db-migrations/drizzle.config.ts"),
      "utf8",
    );
    expect(drizzleConfig).toContain("mkdirSync");
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
    const webNodeConfig = JSON.parse(
      await readFile(
        path.join(targetDir, "apps/web/tsconfig.node.json"),
        "utf8",
      ),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    expect(webNodeConfig.compilerOptions).not.toHaveProperty("paths");
    expect(webNodeConfig.compilerOptions).not.toHaveProperty(
      "customConditions",
    );
    expect(webNodeConfig.compilerOptions).toMatchObject({
      erasableSyntaxOnly: true,
    });
    const databaseConfig = JSON.parse(
      await readFile(path.join(targetDir, "packages/db/tsconfig.json"), "utf8"),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    expect(databaseConfig.compilerOptions).not.toHaveProperty("paths");
    expect(databaseConfig.compilerOptions).toMatchObject({
      customConditions: ["source"],
      erasableSyntaxOnly: true,
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/tsconfig.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ compilerOptions: { erasableSyntaxOnly: true } });
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
      expect(config.compilerOptions).not.toHaveProperty("paths");
      expect(config.compilerOptions).not.toHaveProperty("customConditions");
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
          path.join(targetDir, "packages/db/tsconfig.build.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      compilerOptions: {
        customConditions: ["source"],
        tsBuildInfoFile: "./dist/tsconfig.build.tsbuildinfo",
      },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, "packages/db-migrations/tsconfig.build.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ compilerOptions: { customConditions: [] } });
    expect(
      await readFile(path.join(targetDir, "apps/web/vite.config.ts"), "utf8"),
    ).not.toContain("alias:");
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      tasks: {
        "@demo/web#test:e2e": {
          dependsOn: ["//#database:prepare:e2e", "@demo/db#build", "build"],
          cache: false,
        },
      },
    });
    const dockerfile = await readFile(
      path.join(targetDir, "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "pnpm exec turbo prune @demo/web @demo/db-migrations --docker",
    );
    expectPrunerWorkspaceManifests(
      dockerfile,
      plan.blueprint.packages.map((package_) => package_.path),
    );
    expect(dockerfile).toContain(
      "COPY --from=pruner /repo/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh",
    );
    expect(dockerfile).not.toContain(".pnpmfile.cts");
    expect(dockerfile).not.toContain("DATABASE_PACKAGE_NAME");
    expect(dockerfile).toContain("for attempt in 1 2 3; do");
    expect(dockerfile).toContain('ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"');
    expect(
      await readFile(
        path.join(targetDir, "scripts/container-entrypoint.sh"),
        "utf8",
      ),
    ).toContain("cd /migration");
    const deploymentCheckScript = await readFile(
      path.join(targetDir, "scripts/check-standalone-deployment.ts"),
      "utf8",
    );
    expect(deploymentCheckScript).toContain('"0.0.0.0::3000"');
    expect(deploymentCheckScript).toContain("dockerHostGatewayAddress");
    expect(deploymentCheckScript).toContain("return baseUrl;");
    await execa("pnpm", ["install", "--lockfile-only"], { cwd: targetDir });
    await assertDockerCopyInputsExist(targetDir, dockerfile);
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    expect(devcontainerDockerfile).toContain(
      'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
    );
    expect(devcontainerDockerfile).toContain(
      'install -d -m 0755 "$PNPM_HOME" "$PNPM_HOME/bin"',
    );
    expect(devcontainerDockerfile).not.toContain("COREPACK_HOME");
    expect(devcontainerDockerfile).toContain(
      "apt-get install -y --no-install-recommends ca-certificates git",
    );
    expect(devcontainerDockerfile).toContain(
      "git config --system init.defaultBranch main",
    );
    expect(devcontainerDockerfile).toContain(
      "playwright install --with-deps chromium",
    );
    expect(devcontainerDockerfile).toContain(
      "install -y --no-install-recommends shellcheck",
    );
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
      mounts: [
        {
          type: "volume",
          source: "${devcontainerId}-pnpm-store",
          target: "/pnpm/store",
        },
      ],
    });
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    expect(dependabot).toContain("package-ecosystem: npm\n    directory: /");
    expect(dependabot).toContain("directory: /.devcontainer");
    expect(dependabot).toContain("package-ecosystem: docker\n    directory: /");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain(".pnpm-store/");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain("playwright-report");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain("test-results");
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain(".template/");
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    expect(checkWorkflow).toContain("capability: deployment");
    expect(checkWorkflow).toContain("job_name: Deployment Check");
    expect(checkWorkflow).toContain("timeout_minutes: 45");
    expect(checkWorkflow).toContain(
      "uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1",
    );
    expect(checkWorkflow).toContain("if: matrix.requires_docker");
    expect(checkWorkflow).toContain("name: Stage Root Check diagnostics");
    expect(checkWorkflow).toContain(
      "DIAGNOSTIC_OWNER_PATHS: |-\n            apps/web",
    );
    expect(checkWorkflow).toContain(
      "for diagnostic_directory in test-results playwright-report; do",
    );
    expect(checkWorkflow).toContain("path: .template-ci-diagnostics");
    expect(
      JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")),
    ).toMatchObject({
      scripts: {
        deployment:
          "node --conditions=source scripts/check-standalone-deployment.ts",
        "check:deployment":
          "turbo run deployment --output-logs=errors-only --log-order=grouped --log-prefix=task",
        "database:prepare:dev":
          "DATABASE_PROFILE=dev pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/db run db:seed:example",
        "database:prepare:test":
          "DATABASE_PROFILE=test pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=test pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=test pnpm --filter @demo/db run db:seed:example",
        "database:prepare:e2e":
          "DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:reset && DATABASE_PROFILE=e2e pnpm --filter @demo/db-migrations run db:push && DATABASE_PROFILE=e2e pnpm --filter @demo/db run db:seed:example",
        dev: "pnpm run database:prepare:dev && turbo watch dev --filter=@demo/web",
        lint: "shellcheck scripts/container-entrypoint.sh && oxlint --quiet --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts",
        check:
          "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
        fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
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
        defaultPackageScope: "demo",
        toolchain: runtimeToolchain,
      }),
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    for (const [packagePath, label] of [
      ["apps/web", "web"],
      ["packages/db", "db"],
      ["packages/db-migrations", "db-migrations"],
    ] as const) {
      const scriptsPath = path.join(targetDir, packagePath, "scripts");
      await mkdir(scriptsPath, { recursive: true });
      await writeFile(
        path.join(scriptsPath, "automation-helper.ts"),
        `export const automationOwner = ${JSON.stringify(label)};\n`,
      );
      await writeFile(
        path.join(scriptsPath, "automation-probe.ts"),
        'import { automationOwner } from "./automation-helper.ts";\n\nconsole.log(automationOwner);\n',
      );
    }

    await execa("pnpm", ["install"], { cwd: targetDir });
    const resolveDatabaseStorage = (args: readonly string[] = []) =>
      execa(
        "node",
        [
          ...args,
          "--input-type=module",
          "--eval",
          'console.log(import.meta.resolve("@demo/db/storage"));',
        ],
        { cwd: path.join(targetDir, "apps/web") },
      ).then(({ stdout }) => stdout);
    await expect(resolveDatabaseStorage()).resolves.toMatch(
      /\/dist\/storage\.js$/u,
    );
    await expect(
      resolveDatabaseStorage(["--conditions=source"]),
    ).resolves.toMatch(/\/src\/storage\.ts$/u);
    for (const [packagePath, label] of [
      ["apps/web", "web"],
      ["packages/db", "db"],
      ["packages/db-migrations", "db-migrations"],
    ] as const) {
      await expect(
        execa("node", ["--conditions=source", "scripts/automation-probe.ts"], {
          cwd: path.join(targetDir, packagePath),
        }).then(({ stdout }) => stdout),
      ).resolves.toBe(label);
    }
    await execa("pnpm", ["--filter", "./packages/db", "run", "typecheck"], {
      cwd: targetDir,
    });
    for (const packagePath of ["apps/web", "packages/db-migrations"] as const) {
      await expect(
        execa("pnpm", ["--filter", `./${packagePath}`, "run", "typecheck"], {
          cwd: targetDir,
        }),
      ).rejects.toMatchObject({ stdout: expect.stringContaining("TS2307") });
    }
    await execa("pnpm", ["exec", "turbo", "run", "typecheck"], {
      cwd: targetDir,
    });
    const deploymentDryRun = JSON.parse(
      (
        await execa(
          "pnpm",
          ["exec", "turbo", "run", "deployment", "--dry-run=json"],
          { cwd: targetDir },
        )
      ).stdout,
    ) as {
      readonly tasks: readonly {
        readonly taskId: string;
        readonly dependencies: readonly string[];
      }[];
    };
    const deploymentTask = deploymentDryRun.tasks.find(
      (task) => task.taskId === "//#deployment",
    );
    expect(deploymentTask?.dependencies).toHaveLength(3);
    expect(deploymentTask?.dependencies).toEqual(
      expect.arrayContaining([
        "@demo/db#build",
        "@demo/db-migrations#build",
        "@demo/web#build",
      ]),
    );
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

const deploymentPath = "Dockerfile";
const mirrorStartMarker = "# @template-mirror NODE_VERSION";
const mirrorEndMarker = "# @end-template-mirror";
const additionTargetNode = "22.2.2";
const additionTargetPnpm = "pnpm@10.9.0";

async function initVikeRepository(
  workspace: string,
  nodeLtsMajor = "24",
): Promise<string> {
  const targetDir = path.join(workspace, "project");
  const plan = planGeneratedRepositoryInitialization({
    definition: builtInPresetRegistry.require("vike-app"),
    context: createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: { nodeLtsMajor, packageManagerPin: "pnpm@11.11.0" },
    }),
  });
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...plan.operations],
  });
  return targetDir;
}

function mirrorRegionContent(text: string): readonly string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === mirrorStartMarker);
  if (start === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === mirrorEndMarker,
  );
  if (end === -1) return [];
  return lines.slice(start + 1, end);
}

function anchoredArgValue(text: string): string | undefined {
  const [line] = mirrorRegionContent(text);
  const match =
    line === undefined ? undefined : /^ARG NODE_VERSION="([^"]*)"$/.exec(line);
  return match?.[1];
}

function maskAnchoredArg(text: string, value: string): string {
  return text.replace(
    `ARG NODE_VERSION="${value}"`,
    'ARG NODE_VERSION="«masked»"',
  );
}

function baseStageRunBlock(text: string): string {
  const baseIndex = text.indexOf("AS base");
  const runIndex = text.indexOf("RUN ", baseIndex);
  const nextFrom = text.indexOf("\nFROM ", runIndex);
  return text.slice(runIndex, nextFrom === -1 ? undefined : nextFrom);
}

function actionsFor(
  actions: readonly ProjectProjectionAction[],
  targetPath: string,
): readonly ProjectProjectionAction[] {
  return actions.filter((action) => action.path === targetPath);
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    const entries = (
      await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map(
          async (entry) =>
            entry.isDirectory()
              ? { kind: "dir" as const, name: entry.name }
              : {
                  kind: "file" as const,
                  name: entry.name,
                  digest: createHash("sha256")
                    .update(await readFile(path.join(directory, entry.name)))
                    .digest("hex"),
                },
        ),
      )
    ).toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.kind === "dir") {
        hash.update(`dir:${entry.name}\n`);
        await walk(path.join(directory, entry.name));
        continue;
      }
      hash.update(`file:${entry.name}:${entry.digest}\n`);
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function writeVikeRootManifest(
  targetDir: string,
  patch: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  patch(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function prepareVikeAddition(
  targetDir: string,
): Promise<Extract<PackageAdditionPreparation, { readonly status: "ready" }>> {
  const preparation = prepareGeneratedRepositoryPackageAddition({
    repositoryRoot: targetDir,
    preset: "ts-lib",
    packageLeafName: "utility",
  });
  if (preparation.status !== "ready") {
    throw new Error(
      `Expected ready Package Addition, received ${JSON.stringify(preparation)}`,
    );
  }
  return preparation;
}

describe("Package Addition 协调部署 Dockerfile 根工具链静态镜像槽位", () => {
  it("初始化的 M2 由锚定 ARG 驱动两处 FROM，取根 engines.node 原文且无烘焙副本", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-init-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      const dockerfile = await readFile(
        path.join(targetDir, deploymentPath),
        "utf8",
      );
      const rootManifest = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as { engines?: { node?: string } };
      const rootDeclaration = rootManifest.engines?.node;
      expect(rootDeclaration).toBeDefined();
      // M2 与根声明取同一 rootNodeDeclaration，不另作真源。
      expect(anchoredArgValue(dockerfile)).toBe(rootDeclaration);
      expect(mirrorRegionContent(dockerfile)).toEqual([
        `ARG NODE_VERSION="${rootDeclaration}"`,
      ]);
      expect(dockerfile.match(/@template-mirror/gu)).toHaveLength(1);
      expect(dockerfile.match(/@end-template-mirror/gu)).toHaveLength(1);
      // 两处 FROM 都由同一个锚定 ARG 驱动。
      const fromLines = dockerfile
        .split("\n")
        .filter((line) => line.startsWith("FROM node:"));
      expect(fromLines).toHaveLength(2);
      for (const fromLine of fromLines) {
        expect(fromLine).toContain("${NODE_VERSION}");
      }
      expect(dockerfile).not.toContain("PACKAGE_MANAGER_PIN");
      // base stage 首次 pnpm 调用之前把根 manifest 复制到 workspace 外固定位置。
      expect(dockerfile).toContain("COPY package.json /root-manifest.json");
      const baseRun = baseStageRunBlock(dockerfile);
      // 原生读取 packageManager 交给现有 prepare 重试，并在同条 RUN 内删除复制文件。
      expect(baseRun).toContain("corepack enable --install-directory");
      expect(baseRun).toContain(
        "require('/root-manifest.json').packageManager",
      );
      expect(baseRun).toContain("rm /root-manifest.json");
      expect(baseRun).toContain('corepack prepare "$package_manager"');
      expect(baseRun).not.toContain("PACKAGE_MANAGER_PIN");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("改根后加包把漂移的锚点协调回根原文，区域外用户字节保留且 dry-run 与执行一致", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-reconcile-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      await writeVikeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
        manifest.packageManager = additionTargetPnpm;
      });
      const dockerfilePath = path.join(targetDir, deploymentPath);
      const initial = await readFile(dockerfilePath, "utf8");
      const rootDeclaration = anchoredArgValue(initial);
      if (rootDeclaration === undefined) {
        throw new Error("Expected an anchored ARG value");
      }
      // 用户把锚点漂移到无关值，并在区域外加入自己的注释与 ENV。
      const drifted = initial
        .replace(
          mirrorStartMarker,
          `# 用户在区域外留下的注释\n${mirrorStartMarker}`,
        )
        .replace(
          `ARG NODE_VERSION="${rootDeclaration}"`,
          'ARG NODE_VERSION="999"',
        )
        .replace(
          "WORKDIR /repo",
          'WORKDIR /repo\nENV USER_EXTRA_ENV="keep-me"',
        );
      await writeFile(dockerfilePath, drifted);

      const addition = await prepareVikeAddition(targetDir);
      const treeBeforeDryRun = await treeFingerprint(workspace);
      const dryRun = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
        dryRun: true,
      });
      if (!dryRun.ok) throw new Error(JSON.stringify(dryRun));
      expect(dryRun.ok).toBe(true);
      expect(actionsFor(dryRun.actions, deploymentPath)).toEqual([
        { path: deploymentPath, driver: "text", action: "update" },
      ]);
      expect(await treeFingerprint(workspace)).toBe(treeBeforeDryRun);
      expect(await readFile(dockerfilePath, "utf8")).toBe(drifted);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      expect(applied.ok).toBe(true);
      expect(applied.actions).toEqual(dryRun.actions);
      expect(applied.changedPaths).toEqual(dryRun.changedPaths);

      const reconciled = await readFile(dockerfilePath, "utf8");
      // 锚点协调回根 engines.node 原文，而不是用户漂移值。
      expect(anchoredArgValue(reconciled)).toBe(additionTargetNode);
      expect(mirrorRegionContent(reconciled)).toEqual([
        `ARG NODE_VERSION="${additionTargetNode}"`,
      ]);
      // 区域外的用户字节逐行保留。
      expect(maskAnchoredArg(reconciled, additionTargetNode)).toBe(
        maskAnchoredArg(drifted, "999"),
      );

      // 重复加包不再触碰已对齐的锚点。
      const replayed = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareVikeAddition(targetDir)).plan.projectProjections,
      });
      if (!replayed.ok) throw new Error(JSON.stringify(replayed));
      expect(replayed.ok).toBe(true);
      expect(actionsFor(replayed.actions, deploymentPath)).toEqual([]);
      expect(replayed.changedPaths).not.toContain(deploymentPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("锚点已等于根原文时加包对部署 Dockerfile 零写入", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-noop-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      await writeVikeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
        manifest.packageManager = additionTargetPnpm;
      });
      const dockerfilePath = path.join(targetDir, deploymentPath);
      const initial = await readFile(dockerfilePath, "utf8");
      const rootDeclaration = anchoredArgValue(initial);
      if (rootDeclaration === undefined) {
        throw new Error("Expected an anchored ARG value");
      }
      // 用户已把锚点手动对齐到根原文，此后应与 After 逐字相等。
      await writeFile(
        dockerfilePath,
        initial.replace(
          `ARG NODE_VERSION="${rootDeclaration}"`,
          `ARG NODE_VERSION="${additionTargetNode}"`,
        ),
      );
      const aligned = await readFile(dockerfilePath, "utf8");

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareVikeAddition(targetDir)).plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      expect(applied.ok).toBe(true);
      expect(actionsFor(applied.actions, deploymentPath)).toEqual([]);
      expect(applied.changedPaths).not.toContain(deploymentPath);
      expect(await readFile(dockerfilePath, "utf8")).toBe(aligned);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("只删成对标记保留承载 ARG 时整次加包在写入前原子失败且零半成品", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-atomic-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      await writeVikeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: additionTargetNode };
        manifest.packageManager = additionTargetPnpm;
      });
      const dockerfilePath = path.join(targetDir, deploymentPath);
      const corrupted = (await readFile(dockerfilePath, "utf8"))
        .split("\n")
        .filter(
          (line) =>
            line.trim() !== mirrorStartMarker &&
            line.trim() !== mirrorEndMarker,
        )
        .join("\n");
      await writeFile(dockerfilePath, corrupted);
      const before = await treeFingerprint(workspace);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareVikeAddition(targetDir)).plan.projectProjections,
      });
      expect(applied.ok).toBe(false);
      if (applied.ok) throw new Error("unreachable");
      const conflict = applied.conflicts.find(
        (candidate) => candidate.path === deploymentPath,
      );
      if (conflict === undefined)
        throw new Error(JSON.stringify(applied.conflicts));
      expect(conflict).toBeDefined();
      expect(conflict?.driver).toBe("text");
      expect(conflict?.reason).toMatch(
        /anchor could not be located while the "NODE_VERSION" carrier or reference remains/u,
      );
      expect(await treeFingerprint(workspace)).toBe(before);
      expect(await readFile(dockerfilePath, "utf8")).toBe(corrupted);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("连标记、承载 ARG 与引用一并删除时加包成功且绝不重新加回", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-carrier-gone-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      const dockerfilePath = path.join(targetDir, deploymentPath);
      const initial = await readFile(dockerfilePath, "utf8");
      const rootDeclaration = anchoredArgValue(initial);
      if (rootDeclaration === undefined) {
        throw new Error("Expected an anchored ARG value");
      }
      const removed = initial
        .split("\n")
        .filter(
          (line) =>
            line.trim() !== mirrorStartMarker &&
            line.trim() !== mirrorEndMarker &&
            line.trim() !== `ARG NODE_VERSION="${rootDeclaration}"`,
        )
        .join("\n")
        .replaceAll("${NODE_VERSION}", "20-slim");
      await writeFile(dockerfilePath, removed);

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareVikeAddition(targetDir)).plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      expect(applied.ok).toBe(true);
      expect(actionsFor(applied.actions, deploymentPath)).toEqual([]);
      expect(applied.changedPaths).not.toContain(deploymentPath);
      const after = await readFile(dockerfilePath, "utf8");
      expect(after).toBe(removed);
      expect(after).not.toContain("@template-mirror");
      expect(after).not.toContain("ARG NODE_VERSION");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("改变根声明只影响部署 Dockerfile，生成的 dependabot.yml 逐字不变", async () => {
    const workspaceA = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-dep-a-"),
    );
    const workspaceB = await mkdtemp(
      path.join(tmpdir(), "template-mirror2-dep-b-"),
    );
    try {
      const targetDirA = await initVikeRepository(workspaceA, "24");
      const targetDirB = await initVikeRepository(workspaceB, "22");
      const [dependabotA, dependabotB] = await Promise.all([
        readFile(path.join(targetDirA, ".github/dependabot.yml"), "utf8"),
        readFile(path.join(targetDirB, ".github/dependabot.yml"), "utf8"),
      ]);
      const [dockerfileA, dockerfileB] = await Promise.all([
        readFile(path.join(targetDirA, deploymentPath), "utf8"),
        readFile(path.join(targetDirB, deploymentPath), "utf8"),
      ]);
      // 静态镜像输入（根 Node 声明）改变会驱动 Dockerfile 锚点，但绝不进入 Dependabot 投影。
      expect(anchoredArgValue(dockerfileA)).toBe("24");
      expect(anchoredArgValue(dockerfileB)).toBe("22");
      expect(dependabotA).toBe(dependabotB);
      expect(dependabotA).not.toMatch(
        /NODE_VERSION|PACKAGE_MANAGER_PIN|corepack/u,
      );
    } finally {
      await Promise.all([
        rm(workspaceA, { recursive: true, force: true }),
        rm(workspaceB, { recursive: true, force: true }),
      ]);
    }
  });
});
