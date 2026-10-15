import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { execa } from "execa";

import {
  checkTemplateToolchainVersions,
  readTemplateToolchainVersionFacts,
} from "../scripts/check-template-toolchain-versions.ts";
import { readTemplateToolchainDeclarations } from "../scripts/template-toolchain-declarations.ts";
const verifiedBaseline = {
  rootNodeEngine: "24.16.0",
  packageManagerDeclaration: "pnpm@12.8.1",
  runningNodeVersion: "24.16.0",
  runningPnpmVersion: "12.8.1",
  rustToolchainChannel: "1.97.1",
  runningRustVersion: "1.97.1",
};

const liveDeclarations = await readTemplateToolchainDeclarations(
  path.resolve(import.meta.dirname, ".."),
);
const liveFixtureBaseline = {
  node: liveDeclarations.rootNodeEngine,
  packageManager: liveDeclarations.packageManagerDeclaration,
  rust: liveDeclarations.rustToolchainChannel,
};

async function writeFixtureRepository(
  root: string,
  manifest: {
    readonly root: Record<string, unknown>;
    readonly rustToolchain?: string;
  },
): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(manifest.root, null, 2)}\n`,
  );
  if (manifest.rustToolchain !== undefined) {
    await writeFile(
      path.join(root, "rust-toolchain.toml"),
      manifest.rustToolchain,
    );
  }
}

void describe("模板工具链版本真源", () => {
  void it("实际工具链符合源码仓库根声明", async () => {
    const facts = await readTemplateToolchainVersionFacts({
      repositoryRoot: path.resolve(import.meta.dirname, ".."),
    });

    assert.deepStrictEqual(checkTemplateToolchainVersions(facts), []);
  });

  void it("拒绝根 Node 版本范围声明", () => {
    const diagnostics = checkTemplateToolchainVersions({
      ...verifiedBaseline,
      rootNodeEngine: ">=24.0.0",
    });
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(
      diagnostics[0]?.includes(
        "根 engines.node 必须声明精确的已测 Node patch 版本",
      ),
    );
  });

  void it("拒绝非精确 pnpm 固定值", () => {
    for (const packageManagerDeclaration of [
      "pnpm@^11.0.0",
      "pnpm@11.21.0+sha512abc",
      "npm@10.0.0",
    ]) {
      const diagnostics = checkTemplateToolchainVersions({
        ...verifiedBaseline,
        packageManagerDeclaration,
      });
      assert.strictEqual(diagnostics.length, 1);
      assert.ok(
        diagnostics[0]?.includes(
          "根 packageManager 必须是唯一精确 pnpm 固定值",
        ),
      );
    }
  });

  void it("拒绝与根声明不一致的实际 Node 或 pnpm 版本", () => {
    const nodeDiagnostics = checkTemplateToolchainVersions({
      ...verifiedBaseline,
      runningNodeVersion: "24.15.0",
    });
    assert.strictEqual(nodeDiagnostics.length, 1);
    assert.ok(nodeDiagnostics[0]?.includes("实际运行 Node 24.15.0"));
    const pnpmDiagnostics = checkTemplateToolchainVersions({
      ...verifiedBaseline,
      runningPnpmVersion: "11.20.0",
    });
    assert.strictEqual(pnpmDiagnostics.length, 1);
    assert.ok(pnpmDiagnostics[0]?.includes("实际 pnpm 11.20.0"));
  });

  void it("拒绝浮动或不精确的根 Rust 声明", () => {
    for (const rustToolchainChannel of [
      "stable",
      "beta",
      "nightly",
      "1.97",
      ">=1.97.0",
    ]) {
      const diagnostics = checkTemplateToolchainVersions({
        ...verifiedBaseline,
        rustToolchainChannel,
      });
      assert.strictEqual(diagnostics.length, 1);
      assert.ok(
        diagnostics[0]?.includes(
          "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本",
        ),
      );
    }
  });

  void it("拒绝实际 Rust 版本漂移或缺失的根声明", () => {
    const rustDiagnostics = checkTemplateToolchainVersions({
      ...verifiedBaseline,
      runningRustVersion: "1.96.0",
    });
    assert.strictEqual(rustDiagnostics.length, 1);
    assert.ok(rustDiagnostics[0]?.includes("实际 Rust 1.96.0"));
    const missingRustDiagnostics = checkTemplateToolchainVersions({
      ...verifiedBaseline,
      rustToolchainChannel: "(缺失 rust-toolchain.toml 的 channel)",
    });
    assert.strictEqual(missingRustDiagnostics.length, 1);
    assert.ok(
      missingRustDiagnostics[0]?.includes(
        "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本",
      ),
    );
  });

  void it("实际 Rust 版本漂移时公共检查入口失败", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t17-rust-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
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
      assert.strictEqual(entry.exitCode, 1);
      assert.ok(entry.stderr.includes(`实际 Rust ${liveFixtureBaseline.rust}`));
      assert.ok(
        entry.stderr.includes("根 rust-toolchain.toml 声明的 1.96.0 不一致"),
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  void it("根 Rust 声明浮动时公共检查入口失败", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t17-float-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
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
      assert.strictEqual(entry.exitCode, 1);
      assert.ok(
        entry.stderr.includes(
          "根 rust-toolchain.toml 必须声明精确的已测 Rust 版本（形如 1.97.1，不接受 stable、beta、nightly 或范围）",
        ),
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  void it("根声明与实际工具链一致时公共检查入口成功", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t18-exact-"));
    try {
      await writeFixtureRepository(repositoryRoot, {
        root: {
          engines: { node: liveFixtureBaseline.node },
          packageManager: liveFixtureBaseline.packageManager,
        },
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
      assert.strictEqual(entry.exitCode, 0, entry.stderr);
      assert.ok(entry.stdout.includes("模板工具链版本真源一致"));
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
