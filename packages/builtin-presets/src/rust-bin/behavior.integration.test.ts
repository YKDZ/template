import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  preserveInstalledGeneratedRepositoryFailure,
  removeWithRetry,
  type InstalledGeneratedRepository,
} from "../../test-support/installed-generated-repository.ts";
import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "../../test-support/installed-integration-signal.ts";
import { rustBinDefinition } from "./definition.ts";

/** Preset 必须投影上下文提供的 Rust 事实，而不是自带版本常量。 */

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
type RustGeneratedRepository = InstalledGeneratedRepository & {
  readonly plan: ReturnType<typeof planGeneratedRepositoryInitialization>;
  readonly cancelSignal: AbortSignal;
};

async function withInstalledRustRepository<T>(options: {
  readonly scenario: string;
  readonly workspacePrefix: string;
  readonly cancelSignal: AbortSignal;
  readonly run: (repository: RustGeneratedRepository) => Promise<T>;
}): Promise<T> {
  throwIfInstalledIntegrationWasCancelled();
  const workspace = await mkdtemp(path.join(tmpdir(), options.workspacePrefix));
  const targetDir = path.join(workspace, "demo-rust");
  const repository = { workspace, targetDir };

  try {
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
    throwIfInstalledIntegrationWasCancelled();
    const result = await options.run({
      ...repository,
      plan,
      cancelSignal: options.cancelSignal,
    });
    await removeWithRetry(workspace);
    return result;
  } catch (cause) {
    const retained = await preserveInstalledGeneratedRepositoryFailure({
      label: "Rust Bin",
      scenario: options.scenario,
      repository,
      cause,
    });
    if (retained !== undefined) {
      try {
        await removeWithRetry(workspace);
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          `Rust Bin ${options.scenario} 失败且无法清理临时工作区 ${workspace}`,
          { cause },
        );
      }
    }
    throw cause;
  }
}

void describe("rust-bin Built-in Preset Definition behavior", () => {
  void it(
    "orders one Rustup preparation before generated Cargo tasks",
    { timeout: 180_000 },
    async (testContext) => {
      await withInstalledRustRepository({
        scenario: "rustup-preparation-order",
        workspacePrefix: "template-rust-check-",
        cancelSignal: installedIntegrationSignal(testContext.signal),
        run: async ({ workspace, targetDir, plan, cancelSignal }) => {
          assert.ok(!("checks" in plan));
          assert.ok(!("fixes" in plan));

          assert.ok(
            (
              await readFile(
                path.join(targetDir, "packages/app/Cargo.toml"),
                "utf8",
              )
            ).includes('name = "app"'),
          );
          assert.ok(
            (
              await readFile(
                path.join(targetDir, "rust-toolchain.toml"),
                "utf8",
              )
            ).includes(`channel = "${renderToolchain.rustVersion}"`),
          );

          const devcontainerDockerfile = await readFile(
            path.join(targetDir, ".devcontainer/Dockerfile"),
            "utf8",
          );
          assert.ok(
            devcontainerDockerfile.includes(
              '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
            ),
          );
          assert.ok(
            devcontainerDockerfile.includes(
              'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
            ),
          );
          assert.ok(
            devcontainerDockerfile.includes(
              'corepack enable --install-directory "$PNPM_HOME"',
            ),
          );
          assert.ok(!devcontainerDockerfile.includes("corepack prepare"));
          assert.ok(!devcontainerDockerfile.includes("PACKAGE_MANAGER_PIN"));
          assert.ok(!devcontainerDockerfile.includes("COREPACK_HOME"));
          assert.ok(
            devcontainerDockerfile.includes(
              "git config --system init.defaultBranch main",
            ),
          );
          const devcontainer = JSON.parse(
            await readFile(
              path.join(targetDir, ".devcontainer/devcontainer.json"),
              "utf8",
            ),
          );
          assert.partialDeepStrictEqual(devcontainer, {
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
          });
          assert.strictEqual(devcontainer.mounts.length, 3);
          assert.ok(
            !devcontainer.mounts.some((mount: { readonly target: string }) =>
              mount.target.includes("${containerWorkspaceFolder}"),
            ),
          );
          assert.ok(
            (
              await readFile(path.join(targetDir, ".gitignore"), "utf8")
            ).includes(".pnpm-store/"),
          );
          assert.ok(
            (
              await readFile(
                path.join(targetDir, ".github/dependabot.yml"),
                "utf8",
              )
            ).includes('directory: "/packages/app"'),
          );
          const rootManifest = JSON.parse(
            await readFile(path.join(targetDir, "package.json"), "utf8"),
          );
          assert.strictEqual(
            rootManifest.scripts.check,
            "node --conditions=source scripts/quality-gates.ts check",
          );
          assert.strictEqual(
            rootManifest.scripts["check:heavy"],
            "node --conditions=source scripts/quality-gates.ts check:heavy",
          );
          assert.strictEqual(
            rootManifest.scripts["check:full"],
            "node --conditions=source scripts/quality-gates.ts check:full",
          );
          assert.strictEqual(
            rootManifest.scripts.fix,
            "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
          );
          assert.strictEqual(
            rootManifest.scripts["toolchain:prepare"],
            "cargo --version",
          );
          const turboConfig = JSON.parse(
            await readFile(path.join(targetDir, "turbo.json"), "utf8"),
          );
          assert.partialDeepStrictEqual(turboConfig, {
            globalPassThroughEnv: [
              "CARGO_HOME",
              "RUSTUP_HOME",
              "RUSTUP_TOOLCHAIN",
            ],
            tasks: { "//#toolchain:prepare": { cache: false } },
          });
          assert.deepStrictEqual(turboConfig.globalPassThroughEnv, [
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
          ]);

          await mkdir(path.join(targetDir, "apps/discovered"), {
            recursive: true,
          });
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

          await execa("pnpm", ["install"], { cwd: targetDir, cancelSignal });
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
            { cwd: targetDir, cancelSignal },
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
          for (const taskId of [
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
          ]) {
            assert.ok(taskIds.includes(taskId));
          }
          const discoveredTest = tasks.find(
            (task) => task.taskId === "@demo/discovered#test",
          );
          assert.ok(discoveredTest !== undefined);
          assert.ok(
            !discoveredTest.dependencies.includes("@demo/discovered#build"),
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
            tasks.filter((task) => task.taskId === "//#toolchain:prepare")
              .length,
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
            const task = tasks.find((candidate) => candidate.taskId === taskId);
            assert.ok(task !== undefined);
            assert.ok(task.dependencies.includes("//#toolchain:prepare"));
          }
          const formatWrite = tasks.find(
            (task) => task.taskId === "//#format:write",
          );
          assert.ok(formatWrite !== undefined);
          assert.ok(formatWrite.dependencies.includes("//#lint:fix"));
          assert.ok(!taskIds.includes("@demo/app#lint:fix"));
          const cargoHome = path.join(workspace, "cargo-home");
          const rustupHome = path.join(workspace, "rustup-home");
          const fakeBin = path.join(workspace, "fake-bin");
          await mkdir(fakeBin, { recursive: true });
          // 用临时 Cargo 记录器跳过工具链下载，只验证生成 Root Check 的真实任务顺序。
          await writeFile(
            path.join(fakeBin, "cargo"),
            `#!/bin/sh
set -eu
state="\${CARGO_HOME:?}/template-cargo-calls"
prepared="\${CARGO_HOME:?}/template-toolchain-prepared"
mkdir -p "\${CARGO_HOME}"
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  if [ -e "$prepared" ]; then
    printf '%s\\n' 'toolchain preparation ran more than once' >&2
    exit 91
  fi
  : > "$prepared"
  printf '%s\\n' "$*" >> "$state"
  exit 0
fi
if [ ! -e "$prepared" ]; then
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
          await execa("pnpm", ["run", "check"], {
            cwd: targetDir,
            cancelSignal,
            env: {
              ...process.env,
              PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
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
          assert.ok(cargoCalls.includes("fmt --all -- --check"));
          assert.ok(
            cargoCalls.includes(
              "clippy --workspace --all-targets -- -D warnings",
            ),
          );
          assert.ok(cargoCalls.includes("test --workspace"));
        },
      });
    },
  );

  void it(
    "discovers a manual package and runs source tests independently of failed builds",
    { timeout: 180_000 },
    async (testContext) => {
      await withInstalledRustRepository({
        scenario: "manual-package-independent-tests",
        workspacePrefix: "template-rust-discovery-",
        cancelSignal: installedIntegrationSignal(testContext.signal),
        run: async ({ targetDir, cancelSignal }) => {
          await mkdir(path.join(targetDir, "apps/controlled"), {
            recursive: true,
          });
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
          await execa("pnpm", ["install"], { cwd: targetDir, cancelSignal });

          const failure = await execa("pnpm", ["run", "check:full"], {
            cwd: targetDir,
            cancelSignal,
            reject: false,
          });

          assert.notStrictEqual(failure.exitCode, 0);
          const failureOutput = `${failure.stdout}\n${failure.stderr}`;
          assert.ok(failureOutput.includes("@demo/controlled#build"));
          assert.ok(failureOutput.includes("@demo/controlled#lint"));
          assert.ok(failureOutput.includes("BUILD_FAIL"));
          assert.ok(failureOutput.includes("LINT_FAIL"));
          assert.strictEqual(
            await readFile(
              path.join(targetDir, "apps/controlled/TEST_EXECUTED"),
              "utf8",
            ),
            "yes",
          );
        },
      });
    },
  );

  void it(
    "keeps root-owned formatting inputs separate from package pollution",
    { timeout: 180_000 },
    async (testContext) => {
      await withInstalledRustRepository({
        scenario: "root-owned-format-inputs",
        workspacePrefix: "template-rust-root-scope-",
        cancelSignal: installedIntegrationSignal(testContext.signal),
        run: async ({ targetDir, cancelSignal }) => {
          await writeFile(
            path.join(targetDir, "TODO.md"),
            "# root\n\n-   text\n",
          );
          await writeFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            '{"name":"root-owned","image":"node:24"}\n',
          );
          await writeFile(
            path.join(targetDir, "packages/app/package.json"),
            '{"name":"@demo/package-pollution"}\n',
          );
          await execa("pnpm", ["install"], { cwd: targetDir, cancelSignal });

          const rootFormat = await execa(
            "pnpm",
            ["exec", "turbo", "run", "format:check", "--filter=//"],
            { cwd: targetDir, cancelSignal, reject: false },
          );
          const output = `${rootFormat.stdout}\n${rootFormat.stderr}`;

          assert.notStrictEqual(rootFormat.exitCode, 0);
          assert.ok(output.includes("TODO.md"));
          assert.ok(output.includes(".devcontainer/devcontainer.json"));
          assert.ok(!output.includes("packages/app/package.json"));

          await execa(
            "pnpm",
            ["exec", "turbo", "run", "format:write", "--filter=//"],
            { cwd: targetDir, cancelSignal },
          );
          assert.ok(
            !(await readFile(path.join(targetDir, "TODO.md"), "utf8")).includes(
              "-   text",
            ),
          );
          assert.strictEqual(
            await readFile(
              path.join(targetDir, "packages/app/package.json"),
              "utf8",
            ),
            '{"name":"@demo/package-pollution"}\n',
          );
        },
      });
    },
  );
});
