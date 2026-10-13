import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  renderNewProject,
  resolveTemplateSource,
} from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { rustBinDefinition } from "./definition.ts";

/** Preset 必须投影上下文提供的 Rust 事实，而不是自带版本常量。 */
const contextToolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.11.0",
  rustVersion: "1.42.3",
} as const;

/** 需要真正执行 Cargo 任务的生成现场使用本机已安装且与发版快照一致的精确 Node、pnpm 与 Rust 事实。 */
const renderToolchain = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
  rustVersion: releaseToolchainSnapshot.rustVersion,
} as const;
const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function requireReadyInitialization(
  preparation: ReturnType<typeof prepareGeneratedRepositoryInitialization>,
): Extract<typeof preparation, { readonly status: "ready" }> {
  if (preparation.status !== "ready") {
    throw new Error(
      `Expected ready initialization, received ${preparation.status}`,
    );
  }
  return preparation;
}

void describe("rust-bin Built-in Preset Definition behavior", () => {
  void it("adds worker as @scope/worker with matching Cargo name and default path", () => {
    assert.strictEqual(
      rustBinDefinition.initialPrimaryPackage.defaultLeafName,
      "app",
    );
    const context = {
      targetDir: "/tmp/demo",
      repositoryName: "demo",
      defaultPackageScope: "scope",
      foundationPackages: {
        typescriptConfiguration: { name: "@scope/typescript-config" },
      },
      toolchain: contextToolchain,
    };
    const packagePath = rustBinDefinition.defaultPackagePath?.({
      context,
      packageLeafName: "worker",
    });
    const contribution = rustBinDefinition.planPackageAddition?.({
      context,
      packageLeafName: "worker",
      packagePath: packagePath,
    });

    assert.strictEqual(packagePath, "packages/worker");
    assert.deepStrictEqual(contribution?.definition, {
      name: "@scope/worker",
      path: "packages/worker",
      role: "native-package",
    });
    const cargoManifestOperation = contribution?.operations.find(
      (operation) =>
        operation.kind === "writeTextTemplate" &&
        operation.from === "Cargo.toml",
    );
    assert.ok(
      cargoManifestOperation !== undefined &&
        cargoManifestOperation.kind === "writeTextTemplate",
    );
    assert.strictEqual(cargoManifestOperation.to, "packages/worker/Cargo.toml");
    assert.deepStrictEqual(cargoManifestOperation.replacements, {
      CARGO_PACKAGE_NAME: "worker",
    });
  });

  void it("keeps initialization and Package Addition Rust contributions aligned", () => {
    const context = {
      targetDir: "/tmp/worker",
      repositoryName: "worker",
      defaultPackageScope: "scope",
      foundationPackages: {
        typescriptConfiguration: { name: "@scope/typescript-config" },
      },
      toolchain: contextToolchain,
    };
    const initialization =
      rustBinDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "app",
          definition: {
            name: "@scope/app",
            path: "packages/app",
            role: "native-package",
          },
        },
      });
    const addition = rustBinDefinition.planPackageAddition?.({
      context,
      packageLeafName: "app",
      packagePath: "packages/app",
    });

    assert.deepStrictEqual(addition, initialization);
  });

  void it("owns a native package contribution with conventional scripts, fixes, and toolchain maintenance", () => {
    const context = {
      targetDir: "/tmp/Demo Rust!",
      repositoryName: "Demo Rust!",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain: contextToolchain,
    };

    const contribution =
      rustBinDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "app",
          definition: {
            name: "@demo/app",
            path: "packages/app",
            role: "native-package",
          },
        },
      });

    assert.deepStrictEqual(rustBinDefinition.metadata, {
      name: "rust-bin",
      title: "Rust 二进制程序",
      description:
        "包含 rustfmt、clippy 和 cargo 测试的 Rust 原生二进制工作区。",
    });
    assert.deepStrictEqual(contribution.definition, {
      name: "@demo/app",
      path: "packages/app",
      role: "native-package",
    });
    assert.partialDeepStrictEqual(contribution.manifest, {
      name: "@demo/app",
      scripts: {
        "format:check":
          "cargo fmt --all -- --check && oxfmt --list-different --no-error-on-unmatched-pattern package.json tsconfig.scripts.json turbo.json scripts",
        lint: "cargo clippy --workspace --all-targets -- -D warnings && oxlint --quiet --format=unix scripts",
        test: "node --conditions=source scripts/run-rust-tests.ts",
        typecheck: "tsc -p tsconfig.scripts.json --noEmit --pretty false",
      },
    });
    assert.ok(
      contribution.operations.some(
        (operation) =>
          operation.kind === "copyFile" &&
          operation.from === "src/main.rs" &&
          operation.to === "packages/app/src/main.rs",
      ),
    );
    assert.ok(
      contribution.operations.some(
        (operation) =>
          operation.kind === "copyFile" &&
          operation.from === "scripts/run-rust-tests.ts" &&
          operation.to === "packages/app/scripts/run-rust-tests.ts",
      ),
    );
    assert.ok(
      contribution.operations.some(
        (operation) =>
          operation.kind === "copyFile" &&
          operation.from === "rustfmt.toml" &&
          operation.to === "packages/app/rustfmt.toml",
      ),
    );
    assert.ok(!("checks" in contribution));
    assert.ok(!("fixes" in contribution));
    assert.ok(!("foundationOperations" in contribution));
    assert.partialDeepStrictEqual(contribution.foundation, {
      toolchains: {
        rust: {
          toolchain: contextToolchain.rustVersion,
          components: ["rustfmt", "clippy"],
        },
      },
      editorCapabilities: ["rust-tooling"],
      dependencyMaintenance: {
        ecosystems: [
          "npm",
          "cargo",
          "github-actions",
          "docker",
          "rust-toolchain",
        ],
      },
    });
    assert.deepStrictEqual(
      contribution.foundation.toolchains.rust?.components,
      ["rustfmt", "clippy"],
    );
    assert.deepStrictEqual(contribution.foundation.editorCapabilities, [
      "rust-tooling",
    ]);
    assert.deepStrictEqual(
      contribution.foundation.dependencyMaintenance.ecosystems,
      ["npm", "cargo", "github-actions", "docker", "rust-toolchain"],
    );
  });

  void it("declares its source-backed Rust Development Container Tool Layer", () => {
    const context = {
      targetDir: "/tmp/demo-rust",
      repositoryName: "demo-rust",
      defaultPackageScope: "demo",
      foundationPackages: {
        typescriptConfiguration: { name: "@demo/typescript-config" },
      },
      toolchain: contextToolchain,
    };
    const contribution =
      rustBinDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "app",
          definition: {
            name: "@demo/app",
            path: "packages/app",
            role: "native-package",
          },
        },
      });
    const [layer] =
      contribution.foundation.developmentContainerToolLayers ?? [];
    const rustChannel = contribution.foundation.toolchains.rust!.toolchain;

    assert.strictEqual(rustChannel, contextToolchain.rustVersion);
    assert.partialDeepStrictEqual(layer, {
      identity: "rust",
      requires: ["node-pnpm"],
      buildArguments: [{ name: "RUST_TOOLCHAIN", value: rustChannel }],
      mounts: [
        {
          identity: "cargo-registry",
          type: "volume",
          source: "${devcontainerId}-cargo-registry",
          target: "/usr/local/cargo/registry",
        },
        {
          identity: "cargo-git",
          type: "volume",
          source: "${devcontainerId}-cargo-git",
          target: "/usr/local/cargo/git",
        },
      ],
      probes: [
        { identity: "cargo", command: "cargo", args: ["--version"] },
        { identity: "rustc", command: "rustc", args: ["--version"] },
      ],
    });
    assert.strictEqual(layer?.requires?.length, 1);
    assert.strictEqual(layer?.buildArguments?.length, 1);
    assert.strictEqual(layer?.mounts?.length, 2);
    assert.strictEqual(layer?.probes?.length, 2);
    assert.strictEqual(layer?.probes?.[0]?.args?.length, 1);
    assert.strictEqual(layer?.probes?.[1]?.args?.length, 1);
    assert.strictEqual(
      resolveTemplateSource(layer!.dockerfile.source, layer!.dockerfile.from),
      path.resolve(
        import.meta.dirname,
        "../../templates/rust-bin/devcontainer/rust.Dockerfile",
      ),
    );
  });

  void it("ignores package-local Cargo target output in generated repositories", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-rust-ignore-")),
      "demo-rust",
    );
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: renderToolchain,
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: rustBinDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
    const artifactPath = "packages/app/target/debug/app";
    await mkdir(path.join(targetDir, path.dirname(artifactPath)), {
      recursive: true,
    });
    await writeFile(path.join(targetDir, artifactPath), "generated");
    await execa("git", ["init", "--quiet"], { cwd: targetDir });

    assert.strictEqual(
      (
        await execa("git", ["check-ignore", "--no-index", artifactPath], {
          cwd: targetDir,
        })
      ).stdout,
      artifactPath,
    );
  });

  void it("建立仓库根 Rust 声明时逐字使用发版快照版本而非浮动 stable", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-snapshot-"),
    );
    const targetDir = path.join(workspace, "demo-rust");
    try {
      const preparation = requireReadyInitialization(
        prepareGeneratedRepositoryInitialization({
          preset: "rust-bin",
          targetDir,
        }),
      );
      const snapshotRustVersion = releaseToolchainSnapshot.rustVersion;
      const rootToolchainOperation = preparation.plan.operations.find(
        (operation) =>
          "to" in operation && operation.to === "rust-toolchain.toml",
      );

      assert.strictEqual(
        preparation.context.toolchain.rustVersion,
        snapshotRustVersion,
      );
      assert.partialDeepStrictEqual(rootToolchainOperation, {
        kind: "writeTextTemplate",
        source: rustBinDefinition.source,
        from: "rust-toolchain.toml",
        replacements: { RUST_TOOLCHAIN: snapshotRustVersion },
      });

      await renderNewProject({
        targetRoot: targetDir,
        operations: [...preparation.plan.operations],
      });

      assert.strictEqual(
        await readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
        `[toolchain]\nchannel = "${snapshotRustVersion}"\ncomponents = ["rustfmt", "clippy"]\n`,
      );
      assert.strictEqual(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ).build.args.RUST_TOOLCHAIN,
        snapshotRustVersion,
      );
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".template/environment-needs.json"),
            "utf8",
          ),
        ).check,
        [
          {
            kind: "rust-toolchain",
            owner: { kind: "package-boundary", path: "packages/app" },
            toolchain: "stable",
          },
        ],
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
