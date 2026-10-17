import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  prepareGeneratedRepositoryPackageAddition,
  type PackageAdditionPreparation,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";

import { writeExecutable } from "../../test-support/ts-cli-behavior.ts";
import { createVikeAppDefinition, vikeAppDefinition } from "./definition.ts";
/**
 * 运行夹具：真正渲染并执行生成仓库自身检查的现场必须携带发版快照的精确 Node 事实，
 * 因为该检查要求根 engines.node 是精确三段版本。发版快照是固定副本里的既有真源，
 * 这里不另立版本常量。
 */
void describe("vike-app Built-in Preset Definition behavior", () => {
  void it("registers the complete Vike application Definition", () => {
    assert.partialDeepStrictEqual(
      builtInPresetRegistry.require("vike-app").metadata,
      {
        name: "vike-app",
        title: "Vike 应用",
      },
    );
  });
  void it("declares its browser and ShellCheck Tool Layers", () => {
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
    const shellCheck = byIdentity.get("shellcheck")!;
    assert.ok(byIdentity.has("browser-test"));
    assert.ok(byIdentity.has("shellcheck"));
    assert.partialDeepStrictEqual(shellCheck, {
      requires: ["node-pnpm"],
      probes: [
        {
          identity: "shellcheck",
          command: "shellcheck",
          args: ["--version"],
        },
      ],
    });
    assert.deepStrictEqual(shellCheck.requires, ["node-pnpm"]);
    assert.strictEqual(shellCheck.probes?.length, 1);
    assert.deepStrictEqual(shellCheck.probes?.[0]?.args, ["--version"]);
  });
  void it("keeps source-linked workspaces, isolated browser artifacts, and deploy closures", async () => {
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
    assert.ok(
      dockerfile.includes(
        'pnpm --config.inject-workspace-packages=true --filter "$APPLICATION_PACKAGE_NAME" deploy --prod /runtime-deploy',
      ),
    );
    assert.ok(
      dockerfile.includes(
        'pnpm --config.inject-workspace-packages=true --filter "$MIGRATION_PACKAGE_NAME" deploy --prod /migration-deploy',
      ),
    );
    assert.ok(!dockerfile.includes("--legacy"));
    const playwrightConfig = await readFile(
      path.join(targetDir, "apps/web/playwright.config.ts"),
      "utf8",
    );
    assert.ok(playwrightConfig.includes("availablePort"));
    assert.ok(playwrightConfig.includes("node dist/server/index.mjs"));
    assert.match(
      playwrightConfig,
      /outputDir:\s*usesExternalService\s*\?\s*"test-results\/deployment"\s*:\s*"test-results\/e2e"/u,
    );
    assert.match(
      playwrightConfig,
      /outputFolder:\s*usesExternalService\s*\?\s*"playwright-report\/deployment"\s*:\s*"playwright-report\/e2e"/u,
    );
    assert.match(
      playwrightConfig,
      /\.\.\.\(usesExternalService\s*\?\s*\{\}\s*:\s*\{\s*globalTeardown:\s*"\.\/test\/playwright-teardown\.ts"\s*\}\)/su,
    );
    const workspaceConfiguration = parseYaml(workspace) as {
      readonly injectWorkspacePackages: boolean;
      readonly syncInjectedDepsAfterScripts: readonly string[];
    };
    assert.strictEqual(workspaceConfiguration.injectWorkspacePackages, false);
    assert.deepStrictEqual(
      workspaceConfiguration.syncInjectedDepsAfterScripts,
      ["build"],
    );
  });
  void it("derives cross-package contracts from Package identities instead of sibling paths", async () => {
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
    assert.deepStrictEqual(plan.blueprint.packageLinkIntents, [
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
    ) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.partialDeepStrictEqual(rootManifest.scripts, {
      "database:prepare:dev":
        "DATABASE_PROFILE=dev pnpm --filter @demo/schema-tool run db:push && DATABASE_PROFILE=dev pnpm --filter @demo/data-store run db:seed:example",
      dev: "pnpm run database:prepare:dev && turbo watch dev --filter=@demo/frontend",
    });
    const rootTurboConfiguration = JSON.parse(
      await readFile(path.join(targetDir, "turbo.json"), "utf8"),
    );
    assert.partialDeepStrictEqual(rootTurboConfiguration, {
      tasks: {
        "//#deployment": {
          dependsOn: [
            "@demo/frontend#build",
            "@demo/data-store#build",
            "@demo/schema-tool#build",
          ],
        },
      },
    });
    assert.deepStrictEqual(
      rootTurboConfiguration.tasks["//#deployment"].dependsOn,
      [
        "@demo/frontend#build",
        "@demo/data-store#build",
        "@demo/schema-tool#build",
      ],
    );
    assert.ok(
      !Object.keys(rootTurboConfiguration.tasks).some((taskName) =>
        taskName.startsWith("@demo/"),
      ),
    );
    const webTurboConfiguration = JSON.parse(
      await readFile(
        path.join(targetDir, "services/frontend/turbo.json"),
        "utf8",
      ),
    );
    assert.deepStrictEqual(webTurboConfiguration.tasks["test:e2e"].dependsOn, [
      "//#database:prepare:e2e",
      "@demo/data-store#build",
      "build",
      "browser:prepare",
    ]);
    const migrationsTurboConfiguration = JSON.parse(
      await readFile(
        path.join(targetDir, "tooling/schema-tool/turbo.json"),
        "utf8",
      ),
    );
    assert.deepStrictEqual(
      migrationsTurboConfiguration.tasks.typecheck.dependsOn,
      ["@demo/data-store#build"],
    );
    const dockerfile = await readFile(
      path.join(targetDir, "Dockerfile"),
      "utf8",
    );
    assert.ok(dockerfile.includes("COPY . ."));
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(path.join(targetDir, "deployment.json"), "utf8"),
      ),
      {
        application: { name: "@demo/frontend", path: "services/frontend" },
        database: { name: "@demo/data-store", path: "modules/data-store" },
        migrations: { name: "@demo/schema-tool", path: "tooling/schema-tool" },
      },
    );
    const webManifest = JSON.parse(
      await readFile(
        path.join(targetDir, "services/frontend/package.json"),
        "utf8",
      ),
    );
    const migrationsManifest = JSON.parse(
      await readFile(
        path.join(targetDir, "tooling/schema-tool/package.json"),
        "utf8",
      ),
    );
    assert.equal(webManifest.dependencies["@demo/data-store"], "workspace:*");
    assert.equal(
      migrationsManifest.dependencies["@demo/data-store"],
      "workspace:*",
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "services/frontend/vite.config.ts"),
          "utf8",
        )
      ).includes('from "@demo/data-store/package.json"'),
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "tooling/schema-tool/drizzle.config.ts"),
          "utf8",
        )
      ).includes('from "@demo/data-store/storage"'),
    );
    const userEditedWebTurbo = {
      ...webTurboConfiguration,
      tasks: {
        ...webTurboConfiguration.tasks,
        build: {
          ...webTurboConfiguration.tasks.build,
          inputs: ["$TURBO_DEFAULT$", "user/**"],
        },
      },
    };
    const userEditedWebTurboText = `${JSON.stringify(userEditedWebTurbo, null, 2)}\n`;
    const userEditedWebTurboPath = path.join(
      targetDir,
      "services/frontend/turbo.json",
    );
    await writeFile(userEditedWebTurboPath, userEditedWebTurboText);
    const addition = prepareGeneratedRepositoryPackageAddition({
      repositoryRoot: targetDir,
      preset: "ts-lib",
      packageLeafName: "shared-probe",
    });
    assert.strictEqual(addition.status, "ready");
    if (addition.status !== "ready") {
      throw new Error("预期有效的 Vike 加包方案已就绪");
    }
    for (const packagePath of [
      "services/frontend",
      "modules/data-store",
      "tooling/schema-tool",
      "packages/shared-probe",
    ]) {
      assert.ok(
        addition.plan.blueprint.packages.some(
          (package_) => package_.path === packagePath,
        ),
      );
    }
    const replayed = await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.plan.projectProjections,
    });
    if (!replayed.ok) {
      throw new Error(`预期回放成功，实际结果：${JSON.stringify(replayed)}`);
    }
    assert.ok(!replayed.changedPaths.includes("services/frontend/turbo.json"));
    assert.strictEqual(
      await readFile(userEditedWebTurboPath, "utf8"),
      userEditedWebTurboText,
    );
  });
  void it("SSR 只接受数据库公开 JSON 身份且拒绝错误配置时零写入", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vike-ssr-identity-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      const vitePath = path.join(targetDir, "apps/web/vite.config.ts");
      const nativeConfig = await readFile(vitePath, "utf8");
      const addPackage = () =>
        planGeneratedRepositoryPackageAddition({
          definition: builtInPresetRegistry.require("ts-lib"),
          localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
          packageLeafName: "utility",
        });
      assert.doesNotThrow(addPackage);
      for (const [original, replacement] of [
        ["@demo/db/package.json", "@demo/other/package.json"],
        ['type: "json"', 'type: "text"'],
        ["databaseManifest.name", "databaseManifest.version"],
      ] as const) {
        const changed = nativeConfig.replace(original, replacement);
        assert.notEqual(changed, nativeConfig);
        await writeFile(vitePath, changed);
        const before = await treeFingerprint(workspace);
        assert.throws(
          addPackage,
          /requires apps\/web\/vite.config.ts to externalize @demo\/db through Vite SSR/u,
        );
        assert.strictEqual(await treeFingerprint(workspace), before);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("拒绝失真的 Vike 任务真实性且新增包回放零写入", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-vike-turbo-extends-replay-"),
    );
    try {
      const targetDir = await initVikeRepository(workspace);
      const webTurboPath = path.join(targetDir, "apps/web/turbo.json");
      const webTurbo = JSON.parse(await readFile(webTurboPath, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      const assertReplayRejectedWithoutWrite = async (
        source: string,
        expectedError: RegExp,
      ): Promise<void> => {
        await writeFile(webTurboPath, source);
        const before = await treeFingerprint(workspace);
        assert.throws(
          () =>
            planGeneratedRepositoryPackageAddition({
              definition: builtInPresetRegistry.require("ts-lib"),
              localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
              packageLeafName: "utility",
            }),
          expectedError,
        );
        const preparation = prepareGeneratedRepositoryPackageAddition({
          repositoryRoot: targetDir,
          preset: "ts-lib",
          packageLeafName: "utility",
        });
        assert.strictEqual(preparation.status, "operation-failure");
        if (preparation.status !== "operation-failure") {
          throw new Error("预期错误的包内 Turbo 配置使回放失败");
        }
        assert.strictEqual(preparation.phase, "planning");
        assert.strictEqual(await treeFingerprint(workspace), before);
        assert.strictEqual(await readFile(webTurboPath, "utf8"), source);
      };
      webTurbo.tasks.build!.extends = "invalid";
      await assertReplayRejectedWithoutWrite(
        `${JSON.stringify(webTurbo, null, 2)}\n`,
        /Package Addition @demo\/web Turbo Truth requires Turbo task build extends truth/u,
      );

      delete webTurbo.tasks.build!.extends;
      webTurbo.tasks.dev!.persistent = false;
      assert.deepStrictEqual(webTurbo.tasks.dev!.dependsOn, ["@demo/db#build"]);
      await assertReplayRejectedWithoutWrite(
        `${JSON.stringify(webTurbo, null, 2)}\n`,
        /Package Addition @demo\/web Turbo Truth requires Turbo task dev persistent/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
const deploymentPath = "Dockerfile";
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
async function prepareVikeAddition(targetDir: string): Promise<
  Extract<
    PackageAdditionPreparation,
    {
      readonly status: "ready";
    }
  >
> {
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
void it("部署检查每次读取根 Node 声明，改根与加包保留原生 Dockerfile 定制", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-native-deployment-"),
  );
  try {
    const targetDir = await initVikeRepository(workspace);
    const bin = path.join(workspace, "bin");
    const calls = path.join(workspace, "docker-calls.jsonl");
    await mkdir(bin);
    await writeExecutable(
      path.join(bin, "docker"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(process.argv[2] === "build" ? 1 : 0);
`,
    );
    const dockerfilePath = path.join(targetDir, deploymentPath);
    const original = await readFile(dockerfilePath, "utf8");
    assert.match(original, /^ARG NODE_VERSION$/mu);
    assert.equal(
      original
        .split("\n")
        .filter((line) => line.startsWith("FROM node:${NODE_VERSION}")).length,
      2,
    );
    const customized = `${original}\n# 用户的部署配置说明\n`;
    await writeFile(dockerfilePath, customized);
    for (const version of ["24", additionTargetNode]) {
      await writeVikeRootManifest(targetDir, (manifest) => {
        manifest.engines = { node: version };
        manifest.packageManager = additionTargetPnpm;
      });
      await writeFile(calls, "");
      const result = await execa(
        "node",
        ["scripts/check-standalone-deployment.ts"],
        {
          cwd: targetDir,
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            DOCKER_CALLS: calls,
          },
          reject: false,
        },
      );
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Standalone|standalone/u);
      const build = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .find((args) => args[0] === "build")!;
      for (const argument of [
        `NODE_VERSION=${version}`,
        "APPLICATION_PACKAGE_NAME=@demo/web",
        "APPLICATION_PACKAGE_PATH=apps/web",
        "DATABASE_PACKAGE_NAME=@demo/db",
        "MIGRATION_PACKAGE_NAME=@demo/db-migrations",
      ]) {
        assert.ok(build.includes(argument));
        assert.equal(build[build.indexOf(argument) - 1], "--build-arg");
      }
    }
    const addition = await prepareVikeAddition(targetDir);
    const before = await treeFingerprint(workspace);
    const preview = await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.plan.projectProjections,
      dryRun: true,
    });
    assert.equal(preview.ok, true);
    assert.equal(await treeFingerprint(workspace), before);
    const applied = await reconcileAndApplyProjectProjections({
      targetRoot: targetDir,
      ...addition.plan.projectProjections,
    });
    assert.equal(applied.ok, true);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    assert.ok(!applied.changedPaths.includes(deploymentPath));
    assert.equal(await readFile(dockerfilePath, "utf8"), customized);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
