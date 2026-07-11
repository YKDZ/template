import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import {
  blueprintForPresetSourcePreset,
  projectPresetSourcePreset,
} from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { parse } from "yaml";

import {
  resolveToolchainBaseline,
  updateToolchainBaselineMaterials,
} from "../packages/builtin-source/templates/shared/toolchain-maintenance/update-toolchain-baseline.ts";

describe("Generated Repository Toolchain Baseline maintenance", () => {
  it("selects the latest official LTS with the newest compatible pnpm older than 24 hours", async () => {
    const resolved = await resolveToolchainBaseline(
      [
        { version: "v25.2.0", lts: false },
        { version: "v24.4.0", lts: "Krypton" },
        { version: "v22.9.0", lts: "Jod" },
      ],
      {
        versions: {
          "11.9.0": { engines: { node: ">=20" } },
          "11.10.0": { engines: { node: ">=24" } },
          "11.11.0": { engines: { node: ">=24" } },
          "12.0.0": { engines: { node: ">=26" } },
        },
        time: {
          "11.9.0": "2026-07-08T00:00:00.000Z",
          "11.10.0": "2026-07-09T11:59:59.999Z",
          "11.11.0": "2026-07-09T12:00:00.001Z",
          "12.0.0": "2026-07-08T00:00:00.000Z",
        },
      },
      new Date("2026-07-10T12:00:00.000Z"),
    );

    expect(resolved).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.10.0",
    });
  });

  it("projects one offline-testable single-flight updater into every maintained Project Shape", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const maintainedPresets = manifest.presets.filter(
      (preset) =>
        preset.generation === "supported" &&
        preset.features.includes("github-actions"),
    );

    expect(maintainedPresets.length).toBeGreaterThan(0);

    for (const preset of maintainedPresets) {
      const targetDir = await mkdtemp(
        path.join(tmpdir(), `generated-toolchain-${preset.name}-`),
      );
      const blueprint = blueprintForPresetSourcePreset(preset, { targetDir });
      const context = assembleGenerationContext({
        blueprint,
        targetDir,
        toolchain: {
          diagnostics: [],
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.11.0",
          },
          source: "online",
        },
      });
      const plan = projectPresetSourcePreset({
        preset,
        context,
        sourceRoots: builtInPresetProjectionSourceRoots(),
      });
      await renderNewProject({
        sourceRoot: plan.sourceRoot,
        sourceRoots: plan.sourceRoots,
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      const workflow = parse(
        await readFile(
          path.join(
            targetDir,
            ".github/workflows/toolchain-baseline-update.yml",
          ),
          "utf8",
        ),
      ) as {
        permissions: Record<string, string>;
        concurrency: { group: string; "cancel-in-progress": boolean };
        jobs: { update: { steps: Array<{ run?: string }> } };
      };
      expect(workflow.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
      });
      expect(workflow.concurrency).toEqual({
        group: "toolchain-baseline-update",
        "cancel-in-progress": false,
      });
      expect(JSON.stringify(workflow)).not.toContain("merge");

      const rootPackageJson = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        devDependencies: Record<string, string>;
      };
      expect(rootPackageJson.devDependencies).toMatchObject({
        "@types/semver": "catalog:",
        semver: "catalog:",
      });
      expect(
        await readFile(path.join(targetDir, "tsconfig.config.json"), "utf8"),
      ).toContain('"scripts/**/*.ts"');
      const dependabot = await readFile(
        path.join(targetDir, ".github/dependabot.yml"),
        "utf8",
      );
      expect(dependabot).toContain("package-ecosystem: npm");
      expect(dependabot).toContain("package-ecosystem: github-actions");
      expect(dependabot).toContain('dependency-name: "pnpm"');

      const fixturePath = path.join(targetDir, "toolchain-fixture.json");
      await writeFile(
        fixturePath,
        `${JSON.stringify({
          current: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
          desired: {
            nodeLtsMajor: "26",
            packageManagerPin: "pnpm@12.1.0",
          },
          candidate: {
            pullRequest: { kind: "absent" },
            remoteBranch: { kind: "absent" },
          },
        })}\n`,
      );
      const result = await execa(
        "node",
        ["scripts/update-toolchain-baseline.ts", "--plan-fixture", fixturePath],
        { cwd: targetDir },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        kind: "update",
        mode: "create",
        desired: {
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        },
      });

      if (preset.name === "vike-app") {
        await updateToolchainBaselineMaterials(targetDir, {
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        });
        for (const manifestPath of [
          "package.json",
          "apps/web/package.json",
          "packages/db/package.json",
        ]) {
          const manifest = JSON.parse(
            await readFile(path.join(targetDir, manifestPath), "utf8"),
          ) as { engines: { node: string }; packageManager?: string };
          expect(manifest.engines.node).toBe("26");
          expect(manifest.packageManager).toBe(
            manifestPath === "packages/db/package.json"
              ? undefined
              : "pnpm@12.1.0",
          );
        }
        const devcontainer = JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ) as { build: { args: Record<string, string> } };
        expect(devcontainer.build.args).toMatchObject({
          NODE_VERSION: "26",
          PACKAGE_MANAGER_PIN: "pnpm@12.1.0",
        });
        const generationRecord = JSON.parse(
          await readFile(
            path.join(targetDir, ".template/generated-by.json"),
            "utf8",
          ),
        ) as { toolchain: Record<string, string> };
        expect(generationRecord.toolchain).toMatchObject({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        });
        const dockerfile = await readFile(
          path.join(targetDir, "apps/web/Dockerfile"),
          "utf8",
        );
        expect(dockerfile).toContain("FROM node:26-bookworm-slim");
        expect(dockerfile).toContain('ARG PACKAGE_MANAGER_PIN="pnpm@12.1.0"');
        expect(dockerfile).not.toContain("FROM node:24-");
      }
    }
  });
});
