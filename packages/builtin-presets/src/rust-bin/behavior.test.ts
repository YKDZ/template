import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { rustBinDefinition } from "./definition.ts";

describe("rust-bin Built-in Preset Definition behavior", () => {
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
      name: "@demo/demo-rust-native",
      path: "packages/demo-rust",
      role: "native-package",
    });
    expect(contribution.manifest).toMatchObject({
      name: "@demo/demo-rust-native",
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
    expect(
      await readFile(path.join(targetDir, ".devcontainer/Dockerfile"), "utf8"),
    ).toContain("rustup toolchain install ${RUST_TOOLCHAIN}");
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
        "@demo/demo-rust-native#format:check",
        "@demo/demo-rust-native#lint",
        "@demo/demo-rust-native#test",
        "@demo/discovered#lint",
        "@demo/discovered#build",
        "@demo/discovered#test",
        "@demo/discovered#test:e2e",
      ]),
    );
    expect(
      tasks.find((task) => task.taskId === "@demo/discovered#test")
        ?.dependencies,
    ).toContain("@demo/discovered#build");
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

  it("discovers a manual package, continues independent failures, and skips failed-dependency tests", async () => {
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
    ).rejects.toMatchObject({ code: "ENOENT" });
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
