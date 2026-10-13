import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import {
  reconcileAndApplyProjectProjections,
  type ProjectProjectionAction,
} from "@ykdz/template-core/project-projection";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { parse as parseYaml } from "yaml";

import { createVikeAppDefinition, vikeAppDefinition } from "./definition.ts";
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
    const browser = byIdentity.get("browser-test")!;
    const shellCheck = byIdentity.get("shellcheck")!;
    assert.ok(byIdentity.has("browser-test"));
    assert.ok(byIdentity.has("shellcheck"));
    assert.strictEqual(
      resolveTemplateSource(browser.dockerfile.source, browser.dockerfile.from),
      path.resolve(
        import.meta.dirname,
        "../../templates/shared/devcontainer/browser-test.Dockerfile",
      ),
    );
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
    assert.strictEqual(
      resolveTemplateSource(
        shellCheck.dockerfile.source,
        shellCheck.dockerfile.from,
      ),
      path.resolve(
        import.meta.dirname,
        "../../templates/vike-app/devcontainer/shellcheck.Dockerfile",
      ),
    );
  });
  void it("owns its Vike Template Source and deployment fragments through real handles", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.require("vike-app"),
      context: createGenerationContext({
        targetDir: "/tmp/vike-template-source",
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
      }),
    });
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.from === "web/Dockerfile" &&
          operation.to === "Dockerfile",
      ),
    );
    assert.ok(
      plan.operations.some(
        (operation) =>
          operation.kind === "writeTextFromFragments" &&
          operation.to === ".devcontainer/Dockerfile" &&
          operation.fragments.some(
            (fragment) => fragment.from === "browser-test.Dockerfile",
          ) &&
          operation.fragments.some(
            (fragment) =>
              fragment.from === "devcontainer/shellcheck.Dockerfile",
          ),
      ),
    );
  });
  void it("keeps source-linked workspaces while injecting pnpm 11 deploy closures", async () => {
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
        "pnpm --config.inject-workspace-packages=true --filter @demo/web deploy --prod /runtime-deploy",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "pnpm --config.inject-workspace-packages=true --filter @demo/db-migrations deploy --prod /migration-deploy",
      ),
    );
    assert.ok(!dockerfile.includes("--legacy"));
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
    const turboConfiguration = JSON.parse(
      await readFile(path.join(targetDir, "turbo.json"), "utf8"),
    );
    assert.partialDeepStrictEqual(turboConfiguration, {
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
    assert.deepStrictEqual(
      turboConfiguration.tasks["//#deployment"].dependsOn,
      [
        "@demo/frontend#build",
        "@demo/data-store#build",
        "@demo/schema-tool#build",
      ],
    );
    assert.deepStrictEqual(
      turboConfiguration.tasks["@demo/frontend#test:e2e"].dependsOn,
      ["//#database:prepare:e2e", "@demo/data-store#build", "build"],
    );
    const dockerfile = await readFile(
      path.join(targetDir, "Dockerfile"),
      "utf8",
    );
    assert.ok(
      dockerfile.includes(
        "COPY services/frontend/package.json services/frontend/package.json",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY modules/data-store/package.json modules/data-store/package.json",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "COPY tooling/schema-tool/package.json tooling/schema-tool/package.json",
      ),
    );
    assert.ok(
      dockerfile.includes(
        "pnpm exec turbo prune @demo/frontend @demo/schema-tool --docker",
      ),
    );
    assert.ok(!dockerfile.includes("apps/web"));
    assert.ok(!dockerfile.includes("packages/db"));
    expectPrunerWorkspaceManifests(
      dockerfile,
      plan.blueprint.packages.map((package_) => package_.path),
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "services/frontend/vite.config.ts"),
          "utf8",
        )
      ).includes('external: ["@demo/data-store"]'),
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "tooling/schema-tool/drizzle.config.ts"),
          "utf8",
        )
      ).includes('from "@demo/data-store/storage"'),
    );
    assert.ok(
      (
        await readFile(
          path.join(targetDir, "services/frontend/server/app.ts"),
          "utf8",
        )
      ).includes('from "@demo/data-store"'),
    );
    const addition = planGeneratedRepositoryPackageAddition({
      definition: builtInPresetRegistry.require("ts-lib"),
      localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
      packageLeafName: "shared-probe",
    });
    for (const packagePath of [
      "services/frontend",
      "modules/data-store",
      "tooling/schema-tool",
      "packages/shared-probe",
    ]) {
      assert.ok(
        addition.blueprint.packages.some(
          (package_) => package_.path === packagePath,
        ),
      );
    }
  });
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
void describe("Package Addition 协调部署 Dockerfile 根工具链静态镜像槽位", () => {
  void it("初始化的 M2 由锚定 ARG 驱动两处 FROM，取根 engines.node 原文且无烘焙副本", async () => {
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
      ) as {
        engines?: {
          node?: string;
        };
      };
      const rootDeclaration = rootManifest.engines?.node;
      assert.notStrictEqual(rootDeclaration, undefined);
      // M2 与根声明取同一 rootNodeDeclaration，不另作真源。
      assert.strictEqual(anchoredArgValue(dockerfile), rootDeclaration);
      assert.deepStrictEqual(mirrorRegionContent(dockerfile), [
        `ARG NODE_VERSION="${rootDeclaration}"`,
      ]);
      assert.strictEqual(dockerfile.match(/@template-mirror/gu)?.length, 1);
      assert.strictEqual(dockerfile.match(/@end-template-mirror/gu)?.length, 1);
      // 两处 FROM 都由同一个锚定 ARG 驱动。
      const fromLines = dockerfile
        .split("\n")
        .filter((line) => line.startsWith("FROM node:"));
      assert.strictEqual(fromLines.length, 2);
      for (const fromLine of fromLines) {
        assert.ok(fromLine.includes("${NODE_VERSION}"));
      }
      assert.ok(!dockerfile.includes("PACKAGE_MANAGER_PIN"));
      // base stage 首次 pnpm 调用之前把根 manifest 复制到 workspace 外固定位置。
      assert.ok(dockerfile.includes("COPY package.json /root-manifest.json"));
      const baseRun = baseStageRunBlock(dockerfile);
      // 原生读取 packageManager 交给现有 prepare 重试，并在同条 RUN 内删除复制文件。
      assert.ok(baseRun.includes("corepack enable --install-directory"));
      assert.ok(
        baseRun.includes("require('/root-manifest.json').packageManager"),
      );
      assert.ok(baseRun.includes("rm /root-manifest.json"));
      assert.ok(baseRun.includes('corepack prepare "$package_manager"'));
      assert.ok(!baseRun.includes("PACKAGE_MANAGER_PIN"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("改根后加包把漂移的锚点协调回根原文，区域外用户字节保留且 dry-run 与执行一致", async () => {
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
      assert.strictEqual(dryRun.ok, true);
      assert.deepStrictEqual(actionsFor(dryRun.actions, deploymentPath), [
        { path: deploymentPath, driver: "text", action: "update" },
      ]);
      assert.strictEqual(await treeFingerprint(workspace), treeBeforeDryRun);
      assert.strictEqual(await readFile(dockerfilePath, "utf8"), drifted);
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.plan.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(applied.actions, dryRun.actions);
      assert.deepStrictEqual(applied.changedPaths, dryRun.changedPaths);
      const reconciled = await readFile(dockerfilePath, "utf8");
      // 锚点协调回根 engines.node 原文，而不是用户漂移值。
      assert.strictEqual(anchoredArgValue(reconciled), additionTargetNode);
      assert.deepStrictEqual(mirrorRegionContent(reconciled), [
        `ARG NODE_VERSION="${additionTargetNode}"`,
      ]);
      // 区域外的用户字节逐行保留。
      assert.strictEqual(
        maskAnchoredArg(reconciled, additionTargetNode),
        maskAnchoredArg(drifted, "999"),
      );
      // 重复加包不再触碰已对齐的锚点。
      const replayed = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...(await prepareVikeAddition(targetDir)).plan.projectProjections,
      });
      if (!replayed.ok) throw new Error(JSON.stringify(replayed));
      assert.strictEqual(replayed.ok, true);
      assert.deepStrictEqual(actionsFor(replayed.actions, deploymentPath), []);
      assert.ok(!replayed.changedPaths.includes(deploymentPath));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("锚点已等于根原文时加包对部署 Dockerfile 零写入", async () => {
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
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(actionsFor(applied.actions, deploymentPath), []);
      assert.ok(!applied.changedPaths.includes(deploymentPath));
      assert.strictEqual(await readFile(dockerfilePath, "utf8"), aligned);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("只删成对标记保留承载 ARG 时整次加包在写入前原子失败且零半成品", async () => {
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
      assert.strictEqual(applied.ok, false);
      if (applied.ok) throw new Error("unreachable");
      const conflict = applied.conflicts.find(
        (candidate) => candidate.path === deploymentPath,
      );
      if (conflict === undefined)
        throw new Error(JSON.stringify(applied.conflicts));
      assert.notStrictEqual(conflict, undefined);
      assert.strictEqual(conflict?.driver, "text");
      assert.match(
        conflict?.reason,
        /anchor could not be located while the "NODE_VERSION" carrier or reference remains/u,
      );
      assert.strictEqual(await treeFingerprint(workspace), before);
      assert.strictEqual(await readFile(dockerfilePath, "utf8"), corrupted);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("连标记、承载 ARG 与引用一并删除时加包成功且绝不重新加回", async () => {
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
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(actionsFor(applied.actions, deploymentPath), []);
      assert.ok(!applied.changedPaths.includes(deploymentPath));
      const after = await readFile(dockerfilePath, "utf8");
      assert.strictEqual(after, removed);
      assert.ok(!after.includes("@template-mirror"));
      assert.ok(!after.includes("ARG NODE_VERSION"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  void it("改变根声明只影响部署 Dockerfile，生成的 dependabot.yml 逐字不变", async () => {
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
      assert.strictEqual(anchoredArgValue(dockerfileA), "24");
      assert.strictEqual(anchoredArgValue(dockerfileB), "22");
      assert.strictEqual(dependabotA, dependabotB);
      assert.doesNotMatch(
        dependabotA,
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
