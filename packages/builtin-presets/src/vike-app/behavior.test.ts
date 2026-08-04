import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  renderNewProject,
  resolveTemplateSource,
} from "#template-core/renderer";

import { vikeAppDefinition } from "./definition.ts";

function deploymentObserverCommand(taskIdentity: string): string {
  const source = [
    "import { writeFile } from 'node:fs/promises';",
    `await writeFile('deployment.sentinel', ${JSON.stringify(`${taskIdentity}\n`)});`,
    `console.log(${JSON.stringify(taskIdentity)});`,
  ].join(" ");
  return `node --input-type=module --eval ${JSON.stringify(source)}`;
}

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

  it("declares its browser, ShellCheck, and Docker Client Tool Layers", () => {
    const contribution = vikeAppDefinition.planInitialization({
      targetDir: "/tmp/demo-vike",
      projectName: "demo-vike",
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const layers = contribution.foundation.developmentContainerToolLayers ?? [];
    const byIdentity = new Map(layers.map((layer) => [layer.identity, layer]));
    const browser = byIdentity.get("browser-test")!;
    const shellCheck = byIdentity.get("shellcheck")!;
    const dockerClient = byIdentity.get("docker-client")!;

    expect([...byIdentity.keys()].toSorted()).toEqual([
      "browser-test",
      "docker-client",
      "shellcheck",
    ]);
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
    expect(dockerClient).toMatchObject({
      requires: ["node-pnpm"],
      mounts: [
        {
          identity: "docker-socket",
          type: "bind",
          source: "/var/run/docker.sock",
          target: "/var/run/docker.sock",
        },
      ],
      probes: [
        {
          identity: "docker-cli",
          command: "docker",
          args: ["--version"],
          failureMessage:
            "Docker CLI is unavailable; rebuild the Development Container to install the Docker Client Tool Layer.",
        },
        {
          identity: "docker-daemon",
          command: "docker",
          args: ["version"],
          failureMessage:
            "Docker daemon is inaccessible through /var/run/docker.sock; verify the host daemon is running and the standard socket is accessible.",
        },
      ],
    });
    expect(
      resolveTemplateSource(
        dockerClient.dockerfile.source,
        dockerClient.dockerfile.from,
      ),
    ).toBe(
      path.resolve(
        import.meta.dirname,
        "../../templates/vike-app/devcontainer/docker-client.Dockerfile",
      ),
    );
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
            expect.objectContaining({
              from: "devcontainer/shellcheck.Dockerfile",
            }),
            expect.objectContaining({
              from: "devcontainer/docker-client.Dockerfile",
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
        scope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const [workspace, dockerfile] = await Promise.all([
      readFile(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      readFile(path.join(targetDir, "apps/web/Dockerfile"), "utf8"),
    ]);

    expect(dockerfile).toContain(
      "pnpm --config.inject-workspace-packages=true --filter ./apps/web deploy --prod /runtime-deploy",
    );
    expect(dockerfile).toContain(
      "pnpm --config.inject-workspace-packages=true --filter ./packages/db-migrations deploy --prod /migration-deploy",
    );
    expect(dockerfile).not.toContain("--legacy");
    expect(workspace).toContain("injectWorkspacePackages: false");
    expect(workspace).toContain("syncInjectedDepsAfterScripts:\n  - build");
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
      exports: { "./types": { types: "./src/types.d.ts" } },
    });
    const webManifest = JSON.parse(
      await readFile(path.join(targetDir, "apps/web/package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(webManifest.scripts).toMatchObject({
      dev: "vike dev",
      preview: "vike preview",
      "test:e2e": "playwright test",
    });
    const dbManifest = JSON.parse(
      await readFile(path.join(targetDir, "packages/db/package.json"), "utf8"),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(dbManifest.scripts.test).toBe(
      "vitest run --reporter=agent --silent=passed-only",
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
      "DATABASE_PACKAGE_NAME=@demo/db drizzle-kit push",
    );
    expect(migrationsManifest.scripts).not.toHaveProperty("db:prepare:dev");
    expect(migrationsManifest.scripts).not.toHaveProperty("db:prepare:test");
    for (const configPath of [
      "apps/web/playwright.config.ts",
      "apps/web/vite.config.ts",
      "apps/web/test/playwright-teardown.ts",
      "packages/db/vitest.config.ts",
      "packages/db/test/global-setup.ts",
    ]) {
      await expect(
        stat(path.join(targetDir, configPath)),
      ).resolves.toBeDefined();
    }
    for (const removedPath of [
      "apps/web/scripts/run-playwright.ts",
      "packages/db-migrations/scripts/prepare-database.ts",
    ]) {
      await expect(
        stat(path.join(targetDir, removedPath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    const playwrightConfig = await readFile(
      path.join(targetDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    expect(playwrightConfig).toContain("availablePort");
    expect(playwrightConfig).toContain("db:push");
    expect(playwrightConfig).toContain("node dist/server/index.mjs");
    expect(playwrightConfig).toContain("globalTeardown");
    const viteConfig = await readFile(
      path.join(targetDir, "apps/web/vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).toContain("database-preparation");
    expect(viteConfig).toContain("db:seed:example");
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
    for (const configPath of [
      "apps/web/tsconfig.node.json",
      "packages/db/tsconfig.json",
      "packages/db-migrations/tsconfig.json",
    ]) {
      const config = JSON.parse(
        await readFile(path.join(targetDir, configPath), "utf8"),
      ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
      expect(config.compilerOptions).not.toHaveProperty("paths");
      expect(config.compilerOptions).toMatchObject({
        customConditions: ["source"],
        erasableSyntaxOnly: true,
      });
    }
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
    for (const configPath of [
      "packages/db/tsconfig.build.json",
      "packages/db-migrations/tsconfig.build.json",
    ]) {
      expect(
        JSON.parse(await readFile(path.join(targetDir, configPath), "utf8")),
      ).toMatchObject({ compilerOptions: { customConditions: [] } });
    }
    expect(
      await readFile(path.join(targetDir, "apps/web/vite.config.ts"), "utf8"),
    ).not.toContain("alias:");
    expect(
      JSON.parse(
        await readFile(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
      ),
    ).toMatchObject({
      tasks: {
        deployment: { dependsOn: ["build"], cache: false },
        "test:e2e": { dependsOn: ["build"], cache: false },
      },
    });
    const dockerfile = await readFile(
      path.join(targetDir, "apps/web/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "pnpm exec turbo prune @demo/web @demo/db-migrations --docker",
    );
    expect(dockerfile).not.toContain(".pnpmfile.cts");
    expect(dockerfile).toContain('ENV DATABASE_PACKAGE_NAME="@demo/db"');
    expect(dockerfile).toContain("for attempt in 1 2 3; do");
    expect(dockerfile).toContain('ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"');
    expect(
      await readFile(
        path.join(targetDir, "apps/web/scripts/container-entrypoint.sh"),
        "utf8",
      ),
    ).toContain("cd /migration");
    const deploymentCheckScript = await readFile(
      path.join(targetDir, "apps/web/scripts/check-standalone-deployment.ts"),
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
      'install -d -m 0755 "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_HOME/bin"',
    );
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
    expect(devcontainerDockerfile).toContain(
      "install -y --no-install-recommends docker.io",
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
        {
          type: "bind",
          source: "/var/run/docker.sock",
          target: "/var/run/docker.sock",
        },
      ],
    });
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    expect(dependabot).toContain("package-ecosystem: npm\n    directory: /");
    expect(dependabot).toContain("directory: /.devcontainer");
    expect(dependabot).toContain("directory: /apps/web");
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
      "uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3",
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
        "check:deployment":
          "turbo run deployment --output-logs=errors-only --log-order=grouped --log-prefix=task",
        check:
          "turbo run boundaries format:check lint typecheck build test test:e2e --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
        fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
      },
    });
  });

  it("discovers multiple deployment packages through the owner-free entrypoint", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-vike-deployment-discovery-")),
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
    const webManifestPath = path.join(targetDir, "apps/web/package.json");
    const webManifest = JSON.parse(await readFile(webManifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    webManifest.scripts.deployment = deploymentObserverCommand(
      "@demo/web#deployment",
    );
    await writeFile(webManifestPath, JSON.stringify(webManifest));
    await mkdir(path.join(targetDir, "packages/deployment-observer"), {
      recursive: true,
    });
    await writeFile(
      path.join(targetDir, "packages/deployment-observer/package.json"),
      JSON.stringify({
        name: "@demo/deployment-observer",
        private: true,
        scripts: {
          deployment: deploymentObserverCommand(
            "@demo/deployment-observer#deployment",
          ),
        },
      }),
    );
    await execa("pnpm", ["install"], { cwd: targetDir });

    const rootManifest = JSON.parse(
      await readFile(path.join(targetDir, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(rootManifest.scripts["check:deployment"]).toBe(
      "turbo run deployment --output-logs=errors-only --log-order=grouped --log-prefix=task",
    );
    const dryRun = await execa(
      "pnpm",
      ["exec", "turbo", "run", "deployment", "--dry-run=json"],
      { cwd: targetDir },
    );
    const taskIds = (
      JSON.parse(dryRun.stdout) as {
        tasks: readonly { command: string; taskId: string }[];
      }
    ).tasks
      .filter((task) => task.command !== "<NONEXISTENT>")
      .map((task) => task.taskId);
    expect(taskIds).toEqual(
      expect.arrayContaining([
        "@demo/web#deployment",
        "@demo/deployment-observer#deployment",
      ]),
    );
    const deploymentRun = await execa("pnpm", ["run", "check:deployment"], {
      cwd: targetDir,
    });
    expect(deploymentRun.stdout).toContain("Tasks:    4 successful, 4 total");
    await expect(
      readFile(path.join(targetDir, "apps/web/deployment.sentinel"), "utf8"),
    ).resolves.toBe("@demo/web#deployment\n");
    await expect(
      readFile(
        path.join(
          targetDir,
          "packages/deployment-observer/deployment.sentinel",
        ),
        "utf8",
      ),
    ).resolves.toBe("@demo/deployment-observer#deployment\n");
    await expect(
      readFile(
        path.join(targetDir, "apps/web/.turbo/turbo-deployment.log"),
        "utf8",
      ),
    ).resolves.toContain("@demo/web#deployment");
    await expect(
      readFile(
        path.join(
          targetDir,
          "packages/deployment-observer/.turbo/turbo-deployment.log",
        ),
        "utf8",
      ),
    ).resolves.toContain("@demo/deployment-observer#deployment");
  }, 180_000);

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
