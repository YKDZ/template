import { mkdtemp, readFile } from "node:fs/promises";
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
  it("owns a native package contribution with Rust source, checks, fixes, and toolchain maintenance", () => {
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
        "format:check:run": "cargo fmt --all -- --check",
        "lint:run": "cargo clippy --workspace --all-targets -- -D warnings",
        "test:run": "cargo test --workspace",
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
    expect(contribution.checks.map((check) => check.kind)).toEqual([
      "rustfmt-check",
      "cargo-clippy",
      "cargo-test",
    ]);
    expect(contribution.fixes.map((fix) => fix.kind)).toEqual([
      "rustfmt-write",
    ]);
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

    expect(plan.checks.map((check) => check.kind)).toEqual(
      expect.arrayContaining([
        "oxc-format-check",
        "oxc-lint",
        "typescript-typecheck",
        "rustfmt-check",
        "cargo-clippy",
        "cargo-test",
      ]),
    );
    expect(plan.fixes.map((fix) => fix.kind)).toEqual(
      expect.arrayContaining([
        "oxc-format-write",
        "oxc-lint-fix",
        "rustfmt-write",
      ]),
    );

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
        check: expect.stringContaining("test:run"),
        fix: expect.stringContaining("format:write:run"),
      },
    });

    await execa("pnpm", ["install"], { cwd: targetDir });
    await execa("pnpm", ["run", "check"], { cwd: targetDir });
  }, 180_000);
});
