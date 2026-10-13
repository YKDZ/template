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

import {
  arrayContaining,
  assertContains,
  assertDoesNotMatch,
  assertDoesNotContain,
  assertLacksProperty,
  assertMatches,
  assertMatchesPartial,
  objectContaining,
  stringContaining,
} from "../../test-support/assertions.ts";
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
    assertMatchesPartial(
      contribution?.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.from === "Cargo.toml",
      ),
      {
        to: "packages/worker/Cargo.toml",
        replacements: { CARGO_PACKAGE_NAME: "worker" },
      },
    );
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
    assertMatchesPartial(contribution.manifest, {
      name: "@demo/app",
      scripts: {
        "format:check":
          "cargo fmt --all -- --check && oxfmt --list-different --no-error-on-unmatched-pattern package.json tsconfig.scripts.json turbo.json scripts",
        lint: "cargo clippy --workspace --all-targets -- -D warnings && oxlint --quiet --format=unix scripts",
        test: "node --conditions=source scripts/run-rust-tests.ts",
        typecheck: "tsc -p tsconfig.scripts.json --noEmit --pretty false",
      },
    });
    assertMatches(
      contribution.operations,
      arrayContaining([
        objectContaining({
          kind: "copyFile",
          from: "src/main.rs",
          to: "packages/app/src/main.rs",
        }),
        objectContaining({
          kind: "copyFile",
          from: "rustfmt.toml",
          to: "packages/app/rustfmt.toml",
        }),
        objectContaining({
          kind: "copyFile",
          from: "scripts/run-rust-tests.ts",
          to: "packages/app/scripts/run-rust-tests.ts",
        }),
      ]),
    );
    assertLacksProperty(contribution, "checks");
    assertLacksProperty(contribution, "fixes");
    assertLacksProperty(contribution, "foundationOperations");
    assertMatchesPartial(contribution.foundation, {
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
    assertMatchesPartial(layer, {
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

    assertMatchesPartial(
      await execa("git", ["check-ignore", "--no-index", artifactPath], {
        cwd: targetDir,
      }),
      { stdout: artifactPath },
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
      assertMatchesPartial(rootToolchainOperation, {
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

  void it(
    "orders one Rustup preparation before generated Cargo tasks",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-rust-check-"),
      );
      cleanupDirectories.push(workspace);
      const targetDir = path.join(workspace, "demo-rust");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: renderToolchain,
      });
      const plan = planGeneratedRepositoryInitialization({
        definition: rustBinDefinition,
        context,
      });

      assertLacksProperty(plan, "checks");
      assertLacksProperty(plan, "fixes");

      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      assertContains(
        await readFile(path.join(targetDir, "packages/app/Cargo.toml"), "utf8"),
        'name = "app"',
      );
      assertContains(
        await readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
        `channel = "${renderToolchain.rustVersion}"`,
      );
      const devcontainerDockerfile = await readFile(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assertContains(
        devcontainerDockerfile,
        '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
      );
      assertContains(
        devcontainerDockerfile,
        'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
      );
      assertContains(
        devcontainerDockerfile,
        'corepack enable --install-directory "$PNPM_HOME"',
      );
      assertDoesNotContain(devcontainerDockerfile, "corepack prepare");
      assertDoesNotContain(devcontainerDockerfile, "PACKAGE_MANAGER_PIN");
      assertDoesNotContain(devcontainerDockerfile, "COREPACK_HOME");
      assertContains(
        devcontainerDockerfile,
        "git config --system init.defaultBranch main",
      );
      assertMatchesPartial(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ),
        {
          build: { args: { RUST_TOOLCHAIN: renderToolchain.rustVersion } },
          mounts: [
            {
              type: "volume",
              source: "${devcontainerId}-pnpm-store",
              target: "/pnpm/store",
            },
            {
              type: "volume",
              source: "${devcontainerId}-cargo-git",
              target: "/usr/local/cargo/git",
            },
            {
              type: "volume",
              source: "${devcontainerId}-cargo-registry",
              target: "/usr/local/cargo/registry",
            },
          ],
        },
      );
      assertDoesNotMatch(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ).mounts,
        arrayContaining([
          objectContaining({
            target: stringContaining("${containerWorkspaceFolder}"),
          }),
        ]),
      );
      assertContains(
        await readFile(path.join(targetDir, ".gitignore"), "utf8"),
        ".pnpm-store/",
      );
      assertContains(
        await readFile(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
        'directory: "/packages/app"',
      );
      assertMatchesPartial(
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ),
        {
          scripts: {
            check: stringContaining("quality-gates.ts check"),
            fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
            "toolchain:prepare": "cargo --version",
          },
        },
      );
      assertMatchesPartial(
        JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
        {
          globalPassThroughEnv: [
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
          ],
          tasks: { "//#toolchain:prepare": { cache: false } },
        },
      );

      await mkdir(path.join(targetDir, "apps/discovered"), { recursive: true });
      await writeFile(
        path.join(targetDir, "apps/discovered/package.json"),
        JSON.stringify({
          name: "@demo/discovered",
          private: true,
          scripts: {
            lint: 'node --eval "process.exit(0)"',
            build: 'node --eval "process.exit(0)"',
            test: 'node --eval "process.exit(0)"',
            "test:e2e": 'node --eval "process.exit(0)"',
          },
        }),
      );

      await execa("pnpm", ["install"], { cwd: targetDir });
      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "format:check",
          "lint",
          "typecheck",
          "build",
          "test",
          "test:e2e",
          "format:write",
          "--dry-run=json",
        ],
        { cwd: targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly {
            taskId: string;
            dependencies: readonly string[];
            resolvedTaskDefinition: { cache: boolean };
          }[];
        }
      ).tasks;
      const taskIds = tasks.map((task) => task.taskId);
      assertMatches(
        taskIds,
        arrayContaining([
          "//#format:check",
          "//#lint",
          "//#typecheck",
          "//#toolchain:prepare",
          "@demo/app#format:check",
          "@demo/app#format:write",
          "@demo/app#lint",
          "@demo/app#test",
          "@demo/discovered#lint",
          "@demo/discovered#build",
          "@demo/discovered#test",
          "@demo/discovered#test:e2e",
        ]),
      );
      assertDoesNotContain(
        tasks.find((task) => task.taskId === "@demo/discovered#test")
          ?.dependencies,
        "@demo/discovered#build",
      );
      assert.strictEqual(
        tasks.find((task) => task.taskId === "@demo/discovered#lint")
          ?.resolvedTaskDefinition.cache,
        true,
      );
      assert.strictEqual(
        tasks.find((task) => task.taskId === "@demo/discovered#test:e2e")
          ?.resolvedTaskDefinition.cache,
        false,
      );
      assert.strictEqual(
        tasks.filter((task) => task.taskId === "//#toolchain:prepare").length,
        1,
      );
      assert.strictEqual(
        tasks.find((task) => task.taskId === "//#toolchain:prepare")
          ?.resolvedTaskDefinition.cache,
        false,
      );
      for (const taskId of [
        "@demo/app#format:check",
        "@demo/app#lint",
        "@demo/app#test",
        "@demo/app#format:write",
      ]) {
        assertContains(
          tasks.find((task) => task.taskId === taskId)?.dependencies,
          "//#toolchain:prepare",
        );
      }
      assertContains(
        tasks.find((task) => task.taskId === "//#format:write")?.dependencies,
        "//#lint:fix",
      );
      assertDoesNotContain(taskIds, "@demo/app#lint:fix");
      const cargoHome = path.join(workspace, "cargo-home");
      const rustupHome = path.join(workspace, "rustup-home");
      const fakeBin = path.join(workspace, "fake-bin");
      await mkdir(fakeBin, { recursive: true });
      // 用临时 Cargo 记录器跳过工具链下载，只验证生成完整门禁的真实任务顺序。
      await writeFile(
        path.join(fakeBin, "cargo"),
        `#!/bin/sh
set -eu
state="${"$"}{CARGO_HOME:?}/template-cargo-calls"
prepared="${"$"}{CARGO_HOME:?}/template-toolchain-prepared"
mkdir -p "${"$"}{CARGO_HOME}"
if [ "${"$"}#" -eq 1 ] && [ "${"$"}1" = "--version" ]; then
  if [ -e "${"$"}prepared" ]; then
    printf '%s\\n' 'toolchain preparation ran more than once' >&2
    exit 91
  fi
  : > "${"$"}prepared"
  printf '%s\\n' "${"$"}*" >> "${"$"}state"
  exit 0
fi
if [ ! -e "${"$"}prepared" ]; then
  printf '%s\\n' 'Cargo task ran before toolchain preparation' >&2
  exit 90
fi
printf '%s\\n' "${"$"}*" >> "${"$"}state"
if [ "${"$"}1" = "test" ]; then
  printf '%s\\n' 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
fi
`,
        { mode: 0o755 },
      );
      await execa("pnpm", ["run", "check:full"], {
        cwd: targetDir,
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          CARGO_HOME: cargoHome,
          RUSTUP_HOME: rustupHome,
        },
      });
      const cargoCalls = (
        await readFile(path.join(cargoHome, "template-cargo-calls"), "utf8")
      )
        .trim()
        .split("\n");
      assert.strictEqual(
        cargoCalls.filter((call) => call === "--version").length,
        1,
      );
      assertMatches(
        cargoCalls,
        arrayContaining([
          "fmt --all -- --check",
          "clippy --workspace --all-targets -- -D warnings",
          "test --workspace",
        ]),
      );
    },
  );

  void it(
    "uses the generated Cargo entrypoint and rejects empty or fully ignored suites",
    { timeout: 300_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-rust-zero-tests-"),
      );
      cleanupDirectories.push(workspace);
      const targetDir = path.join(workspace, "demo-rust");
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

      const packageDir = path.join(targetDir, "packages/app");
      const run = () =>
        execa("pnpm", ["run", "test"], {
          cwd: packageDir,
          env: {
            ...process.env,
            PATH: [path.dirname(process.execPath), process.env.PATH]
              .filter((entry) => entry !== undefined)
              .join(path.delimiter),
          },
          reject: false,
        });

      const passing = await run();
      assert.strictEqual(
        passing.exitCode,
        0,
        `${passing.stdout}\n${passing.stderr}`,
      );

      const sourcePath = path.join(packageDir, "src/main.rs");
      await writeFile(sourcePath, "fn main() {}\n");
      const empty = await run();
      assert.strictEqual(empty.exitCode, 1, `${empty.stdout}\n${empty.stderr}`);
      assertContains(
        `${empty.stdout}\n${empty.stderr}`,
        "Cargo 未执行任何业务测试用例",
      );

      await writeFile(
        sourcePath,
        [
          "fn main() {}",
          "#[cfg(test)]",
          "mod tests {",
          '    #[test] #[ignore = "external dependency"] fn ignored() {}',
          "}",
          "",
        ].join("\n"),
      );
      const ignored = await run();
      assert.strictEqual(
        ignored.exitCode,
        1,
        `${ignored.stdout}\n${ignored.stderr}`,
      );
      assertContains(
        `${ignored.stdout}\n${ignored.stderr}`,
        "Cargo 未执行任何业务测试用例",
      );

      await writeFile(
        sourcePath,
        [
          "fn main() {}",
          "#[cfg(test)]",
          "mod tests {",
          "    #[test] fn executed() {}",
          '    #[test] #[ignore = "external dependency"] fn ignored() {}',
          "}",
          "",
        ].join("\n"),
      );
      const mixed = await run();
      assert.strictEqual(mixed.exitCode, 0, `${mixed.stdout}\n${mixed.stderr}`);

      await writeFile(
        sourcePath,
        [
          "fn main() {}",
          "#[cfg(test)]",
          "mod tests {",
          '    #[test] fn failing() { assert!(false, "native failure"); }',
          "}",
          "",
        ].join("\n"),
      );
      const failing = await run();
      assert.strictEqual(
        failing.exitCode,
        101,
        `${failing.stdout}\n${failing.stderr}`,
      );
      assertContains(`${failing.stdout}\n${failing.stderr}`, "native failure");
    },
  );

  void it(
    "discovers a manual package and runs source tests independently of failed builds",
    { timeout: 180_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-rust-discovery-")),
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
      await mkdir(path.join(targetDir, "apps/controlled"), { recursive: true });
      await writeFile(
        path.join(targetDir, "apps/controlled/package.json"),
        JSON.stringify({
          name: "@demo/controlled",
          private: true,
          scripts: {
            build:
              "node --eval \"console.error('BUILD_FAIL'); process.exit(1)\"",
            lint: "node --eval \"console.error('LINT_FAIL'); process.exit(1)\"",
            test: "node --eval \"require('node:fs').writeFileSync('TEST_EXECUTED', 'yes')\"",
          },
        }),
      );
      await execa("pnpm", ["install"], { cwd: targetDir });

      const failure = await execa("pnpm", ["run", "check:full"], {
        cwd: targetDir,
        reject: false,
      });

      assert.notStrictEqual(failure.exitCode, 0);
      assertContains(
        `${failure.stdout}\n${failure.stderr}`,
        "@demo/controlled#build",
      );
      assertContains(
        `${failure.stdout}\n${failure.stderr}`,
        "@demo/controlled#lint",
      );
      assertContains(`${failure.stdout}\n${failure.stderr}`, "BUILD_FAIL");
      assertContains(`${failure.stdout}\n${failure.stderr}`, "LINT_FAIL");
      assert.strictEqual(
        await readFile(
          path.join(targetDir, "apps/controlled/TEST_EXECUTED"),
          "utf8",
        ),
        "yes",
      );
    },
  );

  void it(
    "keeps root-owned formatting inputs separate from package pollution",
    { timeout: 180_000 },
    async () => {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-rust-root-scope-")),
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
      await writeFile(path.join(targetDir, "TODO.md"), "# root\n\n-   text\n");
      await writeFile(
        path.join(targetDir, ".devcontainer/devcontainer.json"),
        '{"name":"root-owned","image":"node:24"}\n',
      );
      await writeFile(
        path.join(targetDir, "packages/app/package.json"),
        '{"name":"@demo/package-pollution"}\n',
      );
      await execa("pnpm", ["install"], { cwd: targetDir });

      const rootFormat = await execa(
        "pnpm",
        ["exec", "turbo", "run", "format:check", "--filter=//"],
        { cwd: targetDir, reject: false },
      );
      const output = `${rootFormat.stdout}\n${rootFormat.stderr}`;

      assert.notStrictEqual(rootFormat.exitCode, 0);
      assertContains(output, "TODO.md");
      assertContains(output, ".devcontainer/devcontainer.json");
      assertDoesNotContain(output, "packages/app/package.json");

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "format:write", "--filter=//"],
        { cwd: targetDir },
      );
      assertDoesNotContain(
        await readFile(path.join(targetDir, "TODO.md"), "utf8"),
        "-   text",
      );
      assert.strictEqual(
        await readFile(
          path.join(targetDir, "packages/app/package.json"),
          "utf8",
        ),
        '{"name":"@demo/package-pollution"}\n',
      );
    },
  );
});
