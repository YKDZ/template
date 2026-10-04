import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  checkTemplateToolchainVersions,
  readTemplateToolchainVersionFacts,
} from "../scripts/check-template-toolchain-versions.ts";

const verifiedBaseline = {
  rootNodeEngine: "24.16.0",
  packageManagerDeclaration: "pnpm@12.8.1",
  cliNodeEngine: "^24.16.0",
  runningNodeVersion: "24.16.0",
  runningPnpmVersion: "12.8.1",
  devcontainerNodeVersion: "24.16.0",
  rustToolchainChannel: "1.97.1",
  runningRustVersion: "1.97.1",
  releaseSnapshotNodeVersion: "24.16.0",
  releaseSnapshotPackageManagerPin: "pnpm@12.8.1",
  releaseSnapshotRustVersion: "1.97.1",
};

// 入口点 fixture 若交给脚本真实运行，必须从实际加载的 Core 发版快照派生三版本，只暴露 fixture 自设的故意漂移
const liveFixtureBaseline = {
  node: releaseToolchainSnapshot.nodeVersion,
  packageManager: releaseToolchainSnapshot.packageManagerPin,
  pnpmVersion: releaseToolchainSnapshot.packageManagerPin.slice("pnpm@".length),
  rust: releaseToolchainSnapshot.rustVersion,
};
const raisedRootNode = liveFixtureBaseline.node.replace(
  /\.\d+$/u,
  (tail) => `.${Number(tail.slice(1)) + 1}`,
);

async function writeFixtureRepository(
  root: string,
  manifest: {
    readonly root: Record<string, unknown>;
    readonly cli: Record<string, unknown>;
    readonly rustToolchain?: string;
    readonly devcontainerDockerfile?: string;
  },
): Promise<void> {
  await mkdir(path.join(root, "packages/cli"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(manifest.root, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "packages/cli/package.json"),
    `${JSON.stringify(manifest.cli, null, 2)}\n`,
  );
  if (manifest.rustToolchain !== undefined) {
    await writeFile(
      path.join(root, "rust-toolchain.toml"),
      manifest.rustToolchain,
    );
  }
  await mkdir(path.join(root, ".devcontainer"), { recursive: true });
  await writeFile(
    path.join(root, ".devcontainer/Dockerfile"),
    manifest.devcontainerDockerfile ??
      `FROM node:${liveFixtureBaseline.node}-bookworm\n`,
  );
}

describe("Template toolchain version authority", () => {
  it("accepts the real template manifests against the running toolchain", async () => {
    const facts = await readTemplateToolchainVersionFacts({
      repositoryRoot: path.resolve(import.meta.dirname, ".."),
    });

    expect(releaseToolchainSnapshot).toEqual({
      nodeVersion: facts.rootNodeEngine,
      packageManagerPin: facts.packageManagerDeclaration,
      rustVersion: facts.rustToolchainChannel,
    });
    expect(checkTemplateToolchainVersions(facts)).toEqual([]);
  });

  it("rejects the superseded Node major-only declaration as the root source", () => {
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        rootNodeEngine: ">=24.0.0",
      }),
    ).toEqual([
      expect.stringContaining(
        "根 engines.node 必须声明精确的已测 Node patch 版本",
      ),
    ]);
  });

  it("rejects a second handwritten pnpm source that is not one exact pin", () => {
    for (const packageManagerDeclaration of [
      "pnpm@^11.0.0",
      "pnpm@11.21.0+sha512abc",
      "npm@10.0.0",
    ]) {
      expect(
        checkTemplateToolchainVersions({
          ...verifiedBaseline,
          packageManagerDeclaration,
        }),
      ).toEqual([
        expect.stringContaining("根 packageManager 必须是唯一精确 pnpm 固定值"),
      ]);
    }
  });

  it("rejects published CLI Node ranges that drift from the derived same-LTS caret", () => {
    for (const cliNodeEngine of [
      ">=24.0.0",
      "^24.0.0",
      "^26.0.0",
      "^25.0.0",
      "24.17.0",
    ]) {
      expect(
        checkTemplateToolchainVersions({
          ...verifiedBaseline,
          cliNodeEngine,
        }),
      ).toEqual([
        expect.stringContaining(
          "公开 CLI engines.node 必须是根精确 Node 24.16.0 派生的同 LTS caret 范围 ^24.16.0",
        ),
      ]);
    }
  });

  it("rejects a running toolchain that mismatches the declared baseline", () => {
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        runningNodeVersion: "24.15.0",
      }),
    ).toEqual([expect.stringContaining("实际运行 Node 24.15.0")]);
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        runningPnpmVersion: "11.20.0",
      }),
    ).toEqual([expect.stringContaining("实际 pnpm 11.20.0")]);
  });

  it("rejects floating or imprecise root Rust toolchain declarations", () => {
    for (const rustToolchainChannel of [
      "stable",
      "beta",
      "nightly",
      "1.97",
      ">=1.97.0",
    ]) {
      expect(
        checkTemplateToolchainVersions({
          ...verifiedBaseline,
          rustToolchainChannel,
        }),
      ).toEqual([
        expect.stringContaining(
          "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本",
        ),
      ]);
    }
  });

  it("rejects a running Rust toolchain that mismatches the declared channel", () => {
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        runningRustVersion: "1.96.0",
      }),
    ).toEqual([expect.stringContaining("实际 Rust 1.96.0")]);
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        rustToolchainChannel: "(缺失 rust-toolchain.toml 的 channel)",
      }),
    ).toEqual([
      expect.stringContaining(
        "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本",
      ),
    ]);
  });

  it("fails the root check entry point on an isolated Rust mismatch fixture", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t17-rust-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: `^${liveFixtureBaseline.node}` } },
        rustToolchain: '[toolchain]\nchannel = "1.96.0"\n',
      });

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        {
          reject: false,
          env: { ...process.env, RUSTUP_TOOLCHAIN: liveFixtureBaseline.rust },
        },
      );
      expect(entry.exitCode).toBe(1);
      expect(entry.stderr).toContain(`实际 Rust ${liveFixtureBaseline.rust}`);
      expect(entry.stderr).toContain(
        "根 rust-toolchain.toml 声明的 1.96.0 不一致",
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("fails the root check entry point on a floating stable declaration fixture", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t17-float-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: `^${liveFixtureBaseline.node}` } },
        rustToolchain: '[toolchain]\nchannel = "stable"\n',
      });

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        {
          reject: false,
          env: { ...process.env, RUSTUP_TOOLCHAIN: liveFixtureBaseline.rust },
        },
      );
      expect(entry.exitCode).toBe(1);
      expect(entry.stderr).toContain(
        "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本（形如 1.97.1，不接受 stable、beta、nightly 或范围）",
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("rejects a dev container Node base image that is not the projected exact copy", () => {
    for (const devcontainerNodeVersion of ["24", "24.15.0", "24.17.0"]) {
      expect(
        checkTemplateToolchainVersions({
          ...verifiedBaseline,
          devcontainerNodeVersion,
        }),
      ).toEqual([
        expect.stringContaining(
          "开发容器 .devcontainer/Dockerfile 的 Node 基础镜像必须是根精确 Node 24.16.0 投影的静态副本",
        ),
      ]);
    }
  });

  it("fails the root check entry point on a floating dev container base image", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t18-docker-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: `^${liveFixtureBaseline.node}` } },
        rustToolchain: `[toolchain]\nchannel = "${liveFixtureBaseline.rust}"\n`,
        devcontainerDockerfile: "FROM node:24-bookworm\n",
      });

      const facts = await readTemplateToolchainVersionFacts({
        repositoryRoot,
        readRunningPnpmVersion: async () => liveFixtureBaseline.pnpmVersion,
      });
      expect(facts.devcontainerNodeVersion).toBe("24");
      expect(checkTemplateToolchainVersions(facts)).toEqual([
        expect.stringContaining("当前为 24"),
      ]);

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        { reject: false },
      );
      expect(entry.exitCode).toBe(1);
      expect(entry.stderr).toContain(
        `开发容器 .devcontainer/Dockerfile 的 Node 基础镜像必须是根精确 Node ${liveFixtureBaseline.node} 投影的静态副本（形如 node:${liveFixtureBaseline.node}-bookworm，不接受浮动 tag 或漂移版本），当前为 24`,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("passes the root check entry point on an exact projected dev container base image", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t18-exact-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: `^${liveFixtureBaseline.node}` } },
        rustToolchain: `[toolchain]\nchannel = "${liveFixtureBaseline.rust}"\n`,
      });

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        {
          reject: false,
          env: { ...process.env, RUSTUP_TOOLCHAIN: liveFixtureBaseline.rust },
        },
      );
      expect(entry.exitCode).toBe(0);
      expect(entry.stdout).toContain("模板工具链版本真源一致");
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("fails the root check entry point on an isolated drifted CLI manifest copy", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t16-drift-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: ">=24.0.0" } },
        rustToolchain: `[toolchain]\nchannel = "${liveFixtureBaseline.rust}"\n`,
      });

      const facts = await readTemplateToolchainVersionFacts({
        repositoryRoot,
        readRunningPnpmVersion: async () => liveFixtureBaseline.pnpmVersion,
      });
      expect(checkTemplateToolchainVersions(facts)).toEqual([
        expect.stringContaining("当前为 >=24.0.0"),
      ]);

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        { reject: false },
      );
      expect(entry.exitCode).toBe(1);
      expect(entry.stderr).toContain(
        `同 LTS caret 范围 ^${liveFixtureBaseline.node}`,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("rejects a release snapshot whose copied values drift from the root sources", () => {
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        releaseSnapshotNodeVersion: "24.15.0",
      }),
    ).toEqual([
      expect.stringContaining(
        "Core 发版快照的 Node 副本 24.15.0 与根真源 24.16.0 漂移",
      ),
    ]);
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        releaseSnapshotPackageManagerPin: "pnpm@11.20.0",
      }),
    ).toEqual([
      expect.stringContaining(
        "Core 发版快照的 pnpm 副本 pnpm@11.20.0 与根真源 pnpm@12.8.1 漂移",
      ),
    ]);
    expect(
      checkTemplateToolchainVersions({
        ...verifiedBaseline,
        releaseSnapshotRustVersion: "1.96.0",
      }),
    ).toEqual([
      expect.stringContaining(
        "Core 发版快照的 Rust 副本 1.96.0 与根真源 1.97.1 漂移",
      ),
    ]);
  });

  it("fails the root check entry point when a raised root Node source is not projected into the snapshot", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t20-snapshot-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: raisedRootNode },
          packageManager: liveFixtureBaseline.packageManager,
        },
        cli: { engines: { node: `^${raisedRootNode}` } },
        rustToolchain: `[toolchain]\nchannel = "${liveFixtureBaseline.rust}"\n`,
        devcontainerDockerfile: `FROM node:${raisedRootNode}-bookworm\n`,
      });

      const entry = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/check-template-toolchain-versions.ts",
          ),
          "--repository-root",
          repositoryRoot,
        ],
        {
          reject: false,
          env: { ...process.env, RUSTUP_TOOLCHAIN: liveFixtureBaseline.rust },
        },
      );
      expect(entry.exitCode).toBe(1);
      expect(entry.stderr).toContain(
        `Core 发版快照的 Node 副本 ${releaseToolchainSnapshot.nodeVersion} 与根真源 ${raisedRootNode} 漂移`,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
