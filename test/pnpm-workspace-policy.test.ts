import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtInPresetRegistry,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderGeneratedPnpmWorkspaceYaml } from "@ykdz/template-core/dependency-catalog";
import type { GenerationContext } from "@ykdz/template-core/preset-definition";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";

const packageManagerPin = "pnpm@11.11.0";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function definitionForPnpmPolicy(context: GenerationContext) {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const contributions = planGeneratedRepositoryInitialization({
      definition: candidate,
      context,
    }).packageContributions;
    return contributions.every(
      (contribution) => contribution.foundation.toolchains.rust === undefined,
    );
  });
  if (definition === undefined) {
    throw new Error(
      "The pnpm Workspace Policy check requires a Node-only Built-in Preset Definition",
    );
  }
  return definition;
}

async function generateNodeOnlyProject(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(workspace, "demo-lib");
  const context = {
    targetDir: projectDir,
    repositoryName: "demo-lib",
    defaultPackageScope: "demo-lib",
    foundationPackages: {
      typescriptConfiguration: { name: "@demo-lib/typescript-config" },
    },
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin,
      // 直接规划新建初始化会派生新建公开 ts-cli 候选，需要发版快照的精确三段版本。
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  } satisfies GenerationContext;

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      definitionForPnpmPolicy(context).metadata.name,
      "--yes",
    ],
    { cwd: repoRoot },
  );
  return projectDir;
}

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerIsAvailable();

describe("pnpm Workspace Policy", () => {
  it("renders only explicitly requested dependency overrides", () => {
    const workspace = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      overrides: { "example>peer": "-" },
    });

    expect(workspace).toContain('"example>peer": "-"');
    expect(workspace).toContain(
      'minimumReleaseAgeExclude:\n  - "@ykdz/template"',
    );
    expect(workspace).toContain("injectWorkspacePackages: false");
    expect(workspace).not.toContain("valibot>typescript");
    expect(workspace).not.toContain("pnpmfile");
  });

  it("keeps the template CLI out of generated repository maturity delays", async () => {
    const projectDir = await generateNodeOnlyProject("pnpm-template-cli-age-");
    const workspace = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(workspace).toContain(
      'minimumReleaseAgeExclude:\n  - "@ykdz/template"',
    );
    expect(workspace).toContain("preferSymlinkedExecutables: true");
  });

  it("selects a Node-only Definition by contribution semantics", () => {
    const context = {
      targetDir: "/tmp/pnpm-policy-definition",
      repositoryName: "pnpm-policy-definition",
      defaultPackageScope: "pnpm-policy-definition",
      foundationPackages: {
        typescriptConfiguration: {
          name: "@pnpm-policy-definition/typescript-config",
        },
      },
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin,
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    } satisfies GenerationContext;
    const definition = definitionForPnpmPolicy(context);
    const contributions = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions;

    expect(
      contributions.every(
        (contribution) => contribution.foundation.toolchains.rust === undefined,
      ),
    ).toBe(true);
  });

  it("installs an injected workspace dependency from a frozen lockfile and synchronizes its build output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pnpm-workspace-policy-"));
    const provider = path.join(root, "packages/provider");
    const consumer = path.join(root, "packages/consumer");

    await Promise.all([
      mkdir(path.join(provider, "dist"), { recursive: true }),
      mkdir(consumer, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify({ private: true, packageManager: packageManagerPin })}\n`,
      ),
      writeFile(
        path.join(root, "pnpm-workspace.yaml"),
        renderGeneratedPnpmWorkspaceYaml({
          dependencies: [],
          packages: ["packages/*"],
        }),
      ),
      writeFile(
        path.join(provider, "package.json"),
        `${JSON.stringify({
          name: "@fixture/provider",
          version: "0.0.0",
          scripts: {
            build:
              "node -e \"require('node:fs').copyFileSync('source.txt', 'dist/version.txt')\"",
          },
        })}\n`,
      ),
      writeFile(path.join(provider, "source.txt"), "before\n"),
      writeFile(path.join(provider, "dist/version.txt"), "before\n"),
      writeFile(
        path.join(consumer, "package.json"),
        `${JSON.stringify({
          name: "@fixture/consumer",
          version: "0.0.0",
          dependencies: { "@fixture/provider": "workspace:*" },
          dependenciesMeta: {
            "@fixture/provider": { injected: true },
          },
        })}\n`,
      ),
    ]);

    const environment = { ...process.env, CI: "1" };
    await execa("corepack", ["pnpm@11.11.0", "install", "--lockfile-only"], {
      cwd: root,
      env: environment,
    });
    await execa(
      "corepack",
      [
        "pnpm@11.11.0",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      { cwd: root, env: environment },
    );

    const injectedProvider = path.join(
      consumer,
      "node_modules/@fixture/provider",
    );
    expect((await lstat(injectedProvider)).isSymbolicLink()).toBe(true);
    const injectedTarget = await readlink(injectedProvider);
    expect(injectedTarget).toContain("node_modules/.pnpm/");
    expect(injectedTarget).not.toContain("packages/provider");
    await writeFile(path.join(provider, "source.txt"), "after\n");
    await execa(
      "corepack",
      ["pnpm@11.11.0", "--filter", "@fixture/provider", "run", "build"],
      { cwd: root, env: environment },
    );

    await expect(
      readFile(path.join(injectedProvider, "dist/version.txt"), "utf8"),
    ).resolves.toBe("after\n");
  }, 30_000);

  it("installs a real rendered Preset from its frozen pnpm 11 lockfile", async () => {
    const projectDir = await generateNodeOnlyProject("pnpm-rendered-preset-");
    const environment = { ...process.env, CI: "1" };

    await execa(
      "corepack",
      [
        releaseToolchainSnapshot.packageManagerPin,
        "install",
        "--lockfile-only",
        "--prefer-offline",
      ],
      { cwd: projectDir, env: environment },
    );
    await execa(
      "corepack",
      [
        releaseToolchainSnapshot.packageManagerPin,
        "install",
        "--offline",
        "--frozen-lockfile",
      ],
      { cwd: projectDir, env: environment },
    );
    await execa(
      "corepack",
      [releaseToolchainSnapshot.packageManagerPin, "run", "typecheck"],
      {
        cwd: projectDir,
        env: environment,
      },
    );
  }, 120_000);

  it("resolves the generated root packageManager at runtime for root and non-root users via the native Corepack cache", async (context) => {
    if (!hasDocker) {
      context.skip();
      return;
    }

    const projectDir = await generateNodeOnlyProject("pnpm-corepack-users-");
    // 期望的 pnpm / node 版本都取自*生成*的根 manifest 与 M1 槽位，不新增版本常量。
    const generatedRootManifestText = await readFile(
      path.join(projectDir, "package.json"),
      "utf8",
    );
    const generatedRootManifest = JSON.parse(generatedRootManifestText) as {
      packageManager?: string;
      engines?: { node?: string };
    };
    const generatedPackageManager = generatedRootManifest.packageManager;
    if (generatedPackageManager === undefined) {
      throw new Error("generated root manifest is missing packageManager");
    }
    const expectedPnpmVersion = generatedPackageManager.replace(/^pnpm@/u, "");
    // 根 engines.node 是 Node 版本的真源，容器内实际 node --version 必须与它一致。
    const enginesNode = generatedRootManifest.engines?.node;
    if (enginesNode === undefined) {
      throw new Error("generated root manifest is missing engines.node");
    }
    const devcontainerConfig = JSON.parse(
      await readFile(
        path.join(projectDir, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ) as { build?: { args?: Record<string, string> } };
    const nodeBuildArg = devcontainerConfig.build?.args?.NODE_VERSION;
    if (nodeBuildArg === undefined) {
      throw new Error(
        "generated devcontainer is missing build.args.NODE_VERSION",
      );
    }
    // M1 的 build arg 也必须等于根 engines.node，不把潜在漂移当作 expected 真源。
    expect(nodeBuildArg).toBe(enginesNode);

    // 只用本测试独占、唯一命名的资源——绝不对共享 image id 用 --force，也绝不 prune。
    const stamp = `${process.pid}-${Date.now()}`;
    const imageTag = `t25-pnpm-corepack-users:${stamp}`;
    const containerName = `t25-pnpm-corepack-users-run-${stamp}`;

    try {
      // 不再传 PACKAGE_MANAGER_PIN build arg：devcontainer 已不烘焙 pnpm pin；
      // pnpm 版本在运行时从挂载进来的根 manifest 解析（M3 已取消）。
      await execa(
        "docker",
        [
          "build",
          "-t",
          imageTag,
          "--build-arg",
          `NODE_VERSION=${nodeBuildArg}`,
          "--file",
          ".devcontainer/Dockerfile",
          ".",
        ],
        { cwd: projectDir },
      );

      await execa(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          "-w",
          "/workspace",
          imageTag,
          "sleep",
          "infinity",
        ],
        { cwd: projectDir },
      );
      await execa(
        "docker",
        [
          "exec",
          "--user",
          "root",
          containerName,
          "bash",
          "-c",
          "install -d -o node -g node /workspace",
        ],
        { cwd: projectDir },
      );
      // 通过 docker cp 供应 workspace——客户端/守护进程的 bind 路径未证实同构。
      const supplyRootManifest = async (contents: string): Promise<void> => {
        const transfer = path.join(projectDir, ".root-manifest-transfer.json");
        await writeFile(transfer, contents);
        await execa("docker", [
          "cp",
          transfer,
          `${containerName}:/workspace/package.json`,
        ]);
        await execa(
          "docker",
          [
            "exec",
            "--user",
            "root",
            containerName,
            "chown",
            "node:node",
            "/workspace/package.json",
          ],
          { cwd: projectDir },
        );
      };
      await supplyRootManifest(generatedRootManifestText);

      // 先在容器内真实观测一次 node --version：Node 运行时版本必须与根 engines.node 一致，
      // 不能只用 build arg 文本代替。
      const nodeRuntime = await execa(
        "docker",
        [
          "exec",
          "--user",
          "node",
          containerName,
          "bash",
          "-c",
          "node --version",
        ],
        { cwd: projectDir },
      );
      expect(nodeRuntime.stdout.trim().replace(/^v/u, "")).toBe(enginesNode);

      // ★ 非 root 冷态先跑——移除全局 COREPACK_HOME 后 node 用自己的可写 home 缓存；
      // 在任何 root pnpm 调用之前先跑 node，避免 root 预先下载掩盖非 root 冷态的权限失败。
      const nodeCold = await execa(
        "docker",
        [
          "exec",
          "--user",
          "node",
          containerName,
          "bash",
          "-c",
          "cd /workspace && pnpm --version",
        ],
        { cwd: projectDir },
      );
      expect(nodeCold.stdout.trim()).toBe(expectedPnpmVersion);

      // ★ root 独立冷态——每个用户各自从自己的原生缓存解析。
      const rootCold = await execa(
        "docker",
        [
          "exec",
          "--user",
          "root",
          containerName,
          "bash",
          "-c",
          "cd /workspace && pnpm --version",
        ],
        { cwd: projectDir },
      );
      expect(rootCold.stdout.trim()).toBe(expectedPnpmVersion);

      // ★ 版本从当前根 manifest 读取、并非烘焙：不重建镜像，改指向一个有限的旧夹具 pin。
      await supplyRootManifest(
        JSON.stringify({
          ...generatedRootManifest,
          packageManager: packageManagerPin,
        }),
      );
      const nodeRepointed = await execa(
        "docker",
        [
          "exec",
          "--user",
          "node",
          containerName,
          "bash",
          "-c",
          "cd /workspace && pnpm --version",
        ],
        { cwd: projectDir },
      );
      expect(nodeRepointed.stdout.trim()).toBe(
        packageManagerPin.replace(/^pnpm@/u, ""),
      );

      // 共享工具层对两个用户都保持完好（系统 git 默认分支、TLS 证书库）。
      for (const user of ["node", "root"]) {
        const sanity = await execa(
          "docker",
          [
            "exec",
            "--user",
            user,
            containerName,
            "bash",
            "-c",
            "test -s /etc/ssl/certs/ca-certificates.crt && cd $(mktemp -d) && git init --quiet && git branch --show-current",
          ],
          { cwd: projectDir },
        );
        expect(sanity.stdout.trim()).toBe("main");
      }
    } finally {
      await execa("docker", ["rm", "-f", containerName], { reject: false });
      await execa("docker", ["rmi", imageTag], { reject: false });
    }
  }, 300_000);
});
