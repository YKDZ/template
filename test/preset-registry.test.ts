import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("Preset Registry", () => {
  it("projects a ts-lib Generated Repository through the Preset Projection contract", async () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    expect(projection?.metadata).toMatchObject({
      name: "ts-lib",
      title: "TypeScript library",
      generation: "supported",
    });

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "demo-lib");
    const blueprint = projection!.blueprint({ targetDir });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual(["typescript-typecheck", "oxc-lint", "oxc-format-check"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );

    const packageJson = await readJson<{
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const generationRecord = await readJson<{
      command: string;
      toolchain: { nodeLtsMajor: string; packageManagerPin: string };
    }>(path.join(targetDir, ".template/generated-by.json"));

    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(generationRecord).toMatchObject({
      command: "template init --preset ts-lib",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.2.3" },
    });
  });

  it.each(["hono-api", "vue-app", "vue-hono-app"] as const)(
    "projects %s package metadata from the Generation Context toolchain",
    async (preset) => {
      const projection = findBuiltInPresetProjection(preset);
      expect(projection?.metadata).toMatchObject({
        name: preset,
        generation: "supported",
      });

      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-preset-registry-"),
      );
      const targetDir = path.join(workspace, `demo-${preset}`);
      const blueprint = projection!.blueprint({
        targetDir,
        scope: "acme",
      });
      const context = assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      });

      const plan = projection!.project(context);
      await projection!.render({ targetDir, plan });

      const packageJson = await readJson<{
        engines: { node: string };
        packageManager: string;
      }>(path.join(targetDir, "package.json"));
      const generationRecord = await readJson<{
        toolchain: { nodeLtsMajor: string; packageManagerPin: string };
      }>(path.join(targetDir, ".template/generated-by.json"));
      const devcontainer = await readJson<{
        features: Record<string, { version: string }>;
      }>(path.join(targetDir, ".devcontainer/devcontainer.json"));

      expect(packageJson.engines.node).toBe("24");
      expect(packageJson.packageManager).toBe("pnpm@11.2.3");
      expect(generationRecord.toolchain).toEqual({
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.2.3",
        source: "online",
      });
      expect(
        devcontainer.features["ghcr.io/devcontainers/features/node:1"].version,
      ).toBe("24");
    },
  );

  it("projects rust-bin Generated Repository behavior through the Preset Projection contract", async () => {
    const projection = findBuiltInPresetProjection("rust-bin");
    expect(projection?.metadata).toMatchObject({
      name: "rust-bin",
      title: "Rust binary",
      generation: "supported",
    });

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-registry-"),
    );
    const targetDir = path.join(workspace, "Demo Rust!");
    const blueprint = projection!.blueprint({ targetDir });
    const context = assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const plan = projection!.project(context);
    await projection!.render({ targetDir, plan });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual(["rustfmt-check", "cargo-clippy", "cargo-test"]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "rustfmt-write",
    ]);
    expect(plan.packageScripts).toEqual({
      check:
        "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
      fix: "cargo fmt --all",
    });
    expect(plan.dependencyMaintenancePolicy.ecosystems).toEqual([
      "npm",
      "cargo",
      "github-actions",
    ]);

    const packageJson = await readJson<{
      name: string;
      engines: { node: string };
      packageManager: string;
      scripts: Record<string, string>;
    }>(path.join(targetDir, "package.json"));
    const generationRecord = await readJson<{
      command: string;
      toolchain: { nodeLtsMajor: string; packageManagerPin: string };
    }>(path.join(targetDir, ".template/generated-by.json"));
    const devcontainer = await readJson<{
      image: string;
      features: Record<string, { version: string }>;
    }>(path.join(targetDir, ".devcontainer/devcontainer.json"));
    const cargoToml = await readFile(
      path.join(targetDir, "Cargo.toml"),
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

    expect(packageJson.name).toBe("demo-rust");
    expect(packageJson.scripts).toEqual(plan.packageScripts);
    expect(packageJson.engines.node).toBe("24");
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(generationRecord).toMatchObject({
      command: "template init --preset rust-bin",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.2.3" },
    });
    expect(cargoToml).toContain('name = "demo-rust"');
    expect(devcontainer.image).toContain("devcontainers/rust");
    expect(
      devcontainer.features["ghcr.io/devcontainers/features/node:1"].version,
    ).toBe("24");
    expect(checkWorkflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(checkWorkflow).toContain("uses: Swatinem/rust-cache@v2");
    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: cargo");
    expect(dependabot).toContain("package-ecosystem: github-actions");
  });
});
