import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { rustBinPresetProjection } from "./projection.js";

const packageJsonSchema = v.looseObject({
  name: v.string(),
  private: v.optional(v.boolean()),
  version: v.optional(v.string()),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  engines: v.object({ node: v.string() }),
  packageManager: v.optional(v.string()),
  scripts: v.record(v.string(), v.string()),
});
const devcontainerSchema = v.looseObject({
  name: v.string(),
  build: v.object({
    dockerfile: v.string(),
    args: v.record(v.string(), v.string()),
  }),
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: v.record(v.string(), v.unknown()),
    }),
  }),
  features: v.optional(v.unknown()),
  mounts: v.array(v.string()),
});

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return v.parse(
    schema,
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
  );
}

async function generatedFilePaths(
  root: string,
  current = ".",
): Promise<string[]> {
  const entries = await readdir(path.join(root, current), {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return generatedFilePaths(root, relativePath);
      }

      return [relativePath.replaceAll(path.sep, "/")];
    }),
  );

  return paths.flat().toSorted();
}

async function renderRustBinProject(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "rust-bin-behavior-"));
  const targetDir = path.join(workspace, "Demo Rust!");
  const blueprint = rustBinPresetProjection.blueprint({ targetDir });
  const context = assembleGenerationContext({
    blueprint,
    targetDir,
    toolchain: {
      diagnostics: [],
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
      source: "online",
    },
  });

  const plan = rustBinPresetProjection.project(context);
  await rustBinPresetProjection.render({ plan, targetDir });

  return targetDir;
}

async function renderRustBinProjectAt(targetDir: string): Promise<void> {
  const blueprint = rustBinPresetProjection.blueprint({ targetDir });
  const context = assembleGenerationContext({
    blueprint,
    targetDir,
    toolchain: {
      diagnostics: [],
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
      source: "online",
    },
  });

  const plan = rustBinPresetProjection.project(context);
  await rustBinPresetProjection.render({ plan, targetDir });
}

describe("rust-bin Preset Source behavior", () => {
  it("projects a native Rust package with Rust toolchain infrastructure", async () => {
    const targetDir = await renderRustBinProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const rustPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/demo-rust/package.json"),
      packageJsonSchema,
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const cargoToml = await readFile(
      path.join(targetDir, "packages/demo-rust/Cargo.toml"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const dependabot = await readFile(
      path.join(targetDir, ".github/dependabot.yml"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);

    expect(rootPackageJson).toMatchObject({
      name: "demo-rust",
      engines: { node: "24" },
      packageManager: "pnpm@11.2.3",
      devDependencies: { turbo: "catalog:" },
    });
    expect(rootPackageJson.scripts).toMatchObject({
      check:
        "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
      "check:boundaries": "turbo boundaries --no-color",
      fix: "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
    });
    expect(rustPackageJson).toEqual({
      name: "demo-rust-native",
      version: "0.0.0",
      private: true,
      scripts: {
        "format:check:run": "cargo fmt --all -- --check",
        "format:write:run": "cargo fmt --all",
        "lint:run": "cargo clippy --workspace --all-targets -- -D warnings",
        "test:run": "cargo test --workspace",
      },
      engines: { node: "24" },
    });
    expect(cargoToml).toContain('name = "demo-rust"');
    expect(cargoToml).toContain('anyhow = "1.0.100"');
    expect(files).toContain("rust-toolchain.toml");
    expect(files).toContain("packages/demo-rust/src/main.rs");
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("packages/demo-rust/behavior.test.ts");

    expect(devcontainer.name).toBe("Demo Rust!");
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
        RUST_TOOLCHAIN: "stable",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.mounts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("target=/usr/local/cargo/registry"),
        expect.stringContaining("target=/usr/local/cargo/git"),
        expect.stringContaining("target=${containerWorkspaceFolder}/target"),
      ]),
    );
    expect(devcontainer.customizations.vscode.extensions).toEqual([
      "rust-lang.rust-analyzer",
      "tamasfe.even-better-toml",
    ]);
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG RUST_TOOLCHAIN");
    expect(dockerfile).toContain(
      "rustup toolchain install ${RUST_TOOLCHAIN} --profile minimal --component rustfmt --component clippy",
    );
    expect(dockerfile).toContain("gcc");
    expect(dockerfile).toContain("libc6-dev");
    expect(dockerfile).not.toContain("typescript-node");
    expect(dockerfile).not.toMatch(
      /\b(build-essential|pkg-config|libssl-dev)\b/,
    );
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: rust-toolchain");
  });

  it("normalizes directory names into Cargo-safe package names", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rust-bin-name-"));
    const targetDir = path.join(workspace, 'My demo.app "quoted"');

    await renderRustBinProjectAt(targetDir);

    const cargoToml = await readFile(
      path.join(targetDir, "packages/my-demo-app-quoted/Cargo.toml"),
      "utf8",
    );
    const cargoLock = await readFile(
      path.join(targetDir, "packages/my-demo-app-quoted/Cargo.lock"),
      "utf8",
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );

    expect(cargoToml).toContain('name = "my-demo-app-quoted"');
    expect(cargoToml).toContain('anyhow = "1.0.100"');
    expect(cargoLock).toContain('name = "my-demo-app-quoted"');
    expect(devcontainer.name).toBe('My demo.app "quoted"');
  });
});
