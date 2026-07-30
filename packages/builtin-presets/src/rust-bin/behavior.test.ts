import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  renderNewProject,
  resolveTemplateSource,
} from "#template-core/renderer";

import { rustBinDefinition } from "./definition.ts";

describe("rust-bin Built-in Preset Definition behavior", () => {
  it("adds worker as @scope/worker with matching Cargo name and default path", () => {
    const context = {
      targetDir: "/tmp/demo",
      projectName: "demo",
      scope: "scope",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };
    const packagePath = rustBinDefinition.defaultPackagePath?.({
      context,
      packageLeafName: "worker",
    });
    const contribution = rustBinDefinition.planPackageAddition?.({
      context,
      packageLeafName: "worker",
      packagePath: packagePath!,
    });

    expect(packagePath).toBe("packages/worker");
    expect(contribution?.definition).toEqual({
      name: "@scope/worker",
      path: "packages/worker",
      role: "native-package",
    });
    expect(
      contribution?.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.from === "Cargo.toml",
      ),
    ).toMatchObject({
      to: "packages/worker/Cargo.toml",
      replacements: { CARGO_PACKAGE_NAME: "worker" },
    });
  });

  it("keeps initialization and Package Addition Rust contributions aligned", () => {
    const context = {
      targetDir: "/tmp/worker",
      projectName: "worker",
      scope: "scope",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };
    const initialization = rustBinDefinition.planInitialization(context);
    const addition = rustBinDefinition.planPackageAddition?.({
      context,
      packageLeafName: "worker",
      packagePath: "packages/worker",
    });

    expect(addition).toEqual(initialization);
  });

  it("owns a native package contribution with conventional scripts, fixes, and toolchain maintenance", () => {
    const context = {
      targetDir: "/tmp/Demo Rust!",
      projectName: "Demo Rust!",
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    };

    const contribution = rustBinDefinition.planInitialization(context);

    expect(rustBinDefinition.metadata).toEqual({
      name: "rust-bin",
      title: "Rust binary",
      description:
        "Rust native binary workspace with rustfmt, clippy, and cargo tests.",
    });
    expect(contribution.definition).toEqual({
      name: "@demo/demo-rust",
      path: "packages/demo-rust",
      role: "native-package",
    });
    expect(contribution.manifest).toMatchObject({
      name: "@demo/demo-rust",
      scripts: {
        "format:check": "cargo fmt --all -- --check",
        lint: "cargo clippy --workspace --all-targets -- -D warnings",
        test: "cargo test --workspace",
      },
    });
    expect(contribution.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "copyFile",
          from: "src/main.rs",
          to: "packages/demo-rust/src/main.rs",
        }),
        expect.objectContaining({
          kind: "copyFile",
          from: "rustfmt.toml",
          to: "packages/demo-rust/rustfmt.toml",
        }),
      ]),
    );
    expect(contribution).not.toHaveProperty("checks");
    expect(contribution).not.toHaveProperty("fixes");
    expect(contribution).not.toHaveProperty("foundationOperations");
    expect(contribution.foundation).toMatchObject({
      toolchains: {
        rust: { toolchain: "stable", components: ["rustfmt", "clippy"] },
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

  it("declares its source-backed Rust Development Container Tool Layer", () => {
    const contribution = rustBinDefinition.planInitialization({
      targetDir: "/tmp/demo-rust",
      projectName: "demo-rust",
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const [layer] =
      contribution.foundation.developmentContainerToolLayers ?? [];

    expect(layer).toMatchObject({
      identity: "rust",
      requires: ["node-pnpm"],
      buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
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
    expect(
      resolveTemplateSource(layer!.dockerfile.source, layer!.dockerfile.from),
    ).toBe(
      path.resolve(
        import.meta.dirname,
        "../../templates/rust-bin/devcontainer/rust.Dockerfile",
      ),
    );
  });

  it("ignores package-local Cargo target output in generated repositories", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-rust-ignore-")),
      "demo-rust",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: rustBinDefinition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
    const artifactPath = "packages/demo-rust/target/debug/demo-rust";
    await mkdir(path.join(targetDir, path.dirname(artifactPath)), {
      recursive: true,
    });
    await writeFile(path.join(targetDir, artifactPath), "generated");
    await execa("git", ["init", "--quiet"], { cwd: targetDir });

    await expect(
      execa("git", ["check-ignore", "--no-index", artifactPath], {
        cwd: targetDir,
      }),
    ).resolves.toMatchObject({ stdout: artifactPath });
  });

  it("generates a Rust repository whose Root Check runs native formatting, linting, and tests", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-rust-")),
      "demo-rust",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    });
    const plan = planGeneratedRepositoryInitialization({
      definition: rustBinDefinition,
      context,
    });

    expect(plan).not.toHaveProperty("checks");
    expect(plan).not.toHaveProperty("fixes");

    await renderNewProject({
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    expect(
      await readFile(
        path.join(targetDir, "packages/demo-rust/Cargo.toml"),
        "utf8",
      ),
    ).toContain('name = "demo-rust"');
    expect(
      await readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
    ).toContain('channel = "stable"');
    const devcontainerDockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    expect(devcontainerDockerfile).toContain(
      '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
    );
    expect(devcontainerDockerfile).toContain(
      "apt-get install -y --no-install-recommends ca-certificates git",
    );
    expect(devcontainerDockerfile).toContain(
      'ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"',
    );
    expect(devcontainerDockerfile).toContain(
      'corepack prepare "${PACKAGE_MANAGER_PIN}" --activate',
    );
    expect(devcontainerDockerfile).toContain("    git \\");
    expect(devcontainerDockerfile).toContain(
      "git config --system init.defaultBranch main",
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      build: { args: { RUST_TOOLCHAIN: "stable" } },
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
    expect(
      JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ).mounts,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.stringContaining("${containerWorkspaceFolder}"),
        }),
      ]),
    );
    expect(
      await readFile(path.join(targetDir, ".gitignore"), "utf8"),
    ).toContain(".pnpm-store/");
    expect(
      await readFile(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
    ).toContain('directory: "/packages/demo-rust"');
    expect(
      JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")),
    ).toMatchObject({
      scripts: {
        check: expect.stringContaining("test"),
        fix: "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
      },
    });
    expect(
      JSON.parse(await readFile(path.join(targetDir, "turbo.json"), "utf8")),
    ).toMatchObject({
      globalPassThroughEnv: ["CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"],
    });

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
        "boundaries",
        "format:check",
        "lint",
        "typecheck",
        "build",
        "test",
        "test:e2e",
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
    expect(taskIds).toEqual(
      expect.arrayContaining([
        "//#boundaries",
        "//#format:check",
        "//#lint",
        "//#typecheck",
        "@demo/demo-rust#format:check",
        "@demo/demo-rust#lint",
        "@demo/demo-rust#test",
        "@demo/discovered#lint",
        "@demo/discovered#build",
        "@demo/discovered#test",
        "@demo/discovered#test:e2e",
      ]),
    );
    expect(
      tasks.find((task) => task.taskId === "@demo/discovered#test")
        ?.dependencies,
    ).not.toContain("@demo/discovered#build");
    expect(
      tasks.find((task) => task.taskId === "@demo/discovered#lint")
        ?.resolvedTaskDefinition.cache,
    ).toBe(true);
    expect(
      tasks.find((task) => task.taskId === "@demo/discovered#test:e2e")
        ?.resolvedTaskDefinition.cache,
    ).toBe(false);
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 180_000);

  it("discovers a manual package and runs source tests independently of failed builds", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-rust-discovery-")),
      "demo-rust",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
          build: "node --eval \"console.error('BUILD_FAIL'); process.exit(1)\"",
          lint: "node --eval \"console.error('LINT_FAIL'); process.exit(1)\"",
          test: "node --eval \"require('node:fs').writeFileSync('TEST_EXECUTED', 'yes')\"",
        },
      }),
    );
    await execa("pnpm", ["install"], { cwd: targetDir });

    const failure = await execa("pnpm", ["run", "check"], {
      cwd: targetDir,
      reject: false,
    });

    expect(failure.exitCode).not.toBe(0);
    expect(`${failure.stdout}\n${failure.stderr}`).toContain(
      "@demo/controlled#build",
    );
    expect(`${failure.stdout}\n${failure.stderr}`).toContain(
      "@demo/controlled#lint",
    );
    expect(`${failure.stdout}\n${failure.stderr}`).toContain("BUILD_FAIL");
    expect(`${failure.stdout}\n${failure.stderr}`).toContain("LINT_FAIL");
    await expect(
      readFile(path.join(targetDir, "apps/controlled/TEST_EXECUTED"), "utf8"),
    ).resolves.toBe("yes");
  }, 180_000);

  it("keeps root-owned formatting inputs separate from package pollution", async () => {
    const targetDir = path.join(
      await mkdtemp(path.join(tmpdir(), "template-rust-root-scope-")),
      "demo-rust",
    );
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
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
      path.join(targetDir, "packages/demo-rust/package.json"),
      '{"name":"@demo/package-pollution"}\n',
    );
    await execa("pnpm", ["install"], { cwd: targetDir });

    const rootFormat = await execa(
      "pnpm",
      ["exec", "turbo", "run", "format:check", "--filter=//"],
      { cwd: targetDir, reject: false },
    );
    const output = `${rootFormat.stdout}\n${rootFormat.stderr}`;

    expect(rootFormat.exitCode).not.toBe(0);
    expect(output).toContain("TODO.md");
    expect(output).toContain(".devcontainer/devcontainer.json");
    expect(output).not.toContain("packages/demo-rust/package.json");

    await execa(
      "pnpm",
      ["exec", "turbo", "run", "format:write", "--filter=//"],
      { cwd: targetDir },
    );
    expect(
      await readFile(path.join(targetDir, "TODO.md"), "utf8"),
    ).not.toContain("-   text");
    await expect(
      readFile(path.join(targetDir, "packages/demo-rust/package.json"), "utf8"),
    ).resolves.toBe('{"name":"@demo/package-pollution"}\n');
  }, 180_000);
});
