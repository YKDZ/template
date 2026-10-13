import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

void describe("Built-in Preset Package Addition universality", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };
  // 直接新建初始化会派生新建公开 ts-cli 候选，需要发版快照中与 major 一致的精确三段版本。
  const initializationToolchain = {
    ...toolchain,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  } as const;

  function firstAddableDefinition() {
    const definition = builtInPresetRegistry
      .all()
      .find((candidate) => candidate.planPackageAddition !== undefined);
    if (definition === undefined) {
      throw new Error("Expected an addable Built-in Preset Definition");
    }
    return definition;
  }

  function definitionWithPackagePath(packagePath: string) {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "package-path-selection"),
      defaultPackageScope: "demo",
      toolchain: initializationToolchain,
    });
    const definition = builtInPresetRegistry.all().find((candidate) =>
      planGeneratedRepositoryInitialization({
        definition: candidate,
        context,
      }).blueprint.packages.some((pkg) => pkg.path === packagePath),
    );
    if (definition === undefined) {
      throw new Error(
        `Expected a Built-in Preset Definition with package path ${packagePath}`,
      );
    }
    return definition;
  }

  void it("keeps default-root task entrypoints stable while Turbo discovers added scripts", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-natural-addition-"),
    );
    const targetDir = path.join(workspace, "demo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const base = firstAddableDefinition();
    const addition = firstAddableDefinition();

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: base,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const rootScriptsBefore = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;

      const packageAddition = planGeneratedRepositoryPackageAddition({
        definition: addition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "natural",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...packageAddition.projectProjections,
      });
      const rootScriptsAfter = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;

      for (const script of [
        "check",
        "check:heavy",
        "check:full",
        "fix",
        "deployment",
      ] as const) {
        assert.strictEqual(rootScriptsAfter[script], rootScriptsBefore[script]);
      }

      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: addition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "natural-repeat",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeatedAddition.projectProjections,
      });
      const rootScriptsAfterRepeat = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;
      for (const script of [
        "check",
        "check:heavy",
        "check:full",
        "fix",
        "deployment",
      ] as const) {
        assert.strictEqual(
          rootScriptsAfterRepeat[script],
          rootScriptsBefore[script],
        );
      }

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
          "--dry-run=json",
        ],
        { cwd: targetDir },
      );
      const taskIds = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly { taskId: string }[];
        }
      ).tasks.map((task) => task.taskId);
      assert.ok(!taskIds.includes("//#boundaries"));
      const addedManifest = JSON.parse(
        await readFile(
          path.join(targetDir, "packages/natural/package.json"),
          "utf8",
        ),
      ) as { scripts: Record<string, string> };

      for (const task of Object.keys(addedManifest.scripts).filter((name) =>
        ["format:check", "lint", "typecheck", "build", "test"].includes(name),
      )) {
        assert.ok(taskIds.includes(`@demo/natural#${task}`));
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it(
    "adds a package after pnpm has created package-local node_modules symlinks",
    { timeout: 300000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-with-node-modules-"),
      );
      const targetDir = path.join(workspace, "digital");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: definitionWithPackagePath("packages/db"),
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        await execa("pnpm", ["install"], { cwd: targetDir });
        await mkdir(path.join(targetDir, ".pnpm-store/v11/files"), {
          recursive: true,
        });
        await writeFile(
          path.join(targetDir, ".pnpm-store/v11/files/staged-copy-sentinel"),
          "store content must stay outside staging\n",
        );
        assert.strictEqual(
          (
            await lstat(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );

        const addition = planGeneratedRepositoryPackageAddition({
          definition: firstAddableDefinition(),
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "domain",
          packagePath: "packages/domain",
        });
        const installedTargetsBefore = await Promise.all([
          realpath(path.join(targetDir, "node_modules/.bin/oxfmt")),
          realpath(
            path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
          ),
        ]);
        assert.partialDeepStrictEqual(
          await reconcileAndApplyProjectProjections({
            targetRoot: targetDir,
            ...addition.projectProjections,
          }),
          { ok: true },
        );

        assert.deepStrictEqual(
          await Promise.all([
            realpath(path.join(targetDir, "node_modules/.bin/oxfmt")),
            realpath(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            ),
          ]),
          installedTargetsBefore,
        );
        assert.strictEqual(
          await readFile(
            path.join(targetDir, ".pnpm-store/v11/files/staged-copy-sentinel"),
            "utf8",
          ),
          "store content must stay outside staging\n",
        );
        await execa("pnpm", ["exec", "oxfmt", "--version"], {
          cwd: targetDir,
        });

        assert.ok(
          (
            await readFile(
              path.join(targetDir, "packages/domain/package.json"),
              "utf8",
            )
          ).includes('"name": "@demo/domain"'),
        );
        assert.strictEqual(
          (
            await lstat(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("adds custom Package Roots only through pnpm workspace membership", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-custom-package-root-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "custom-package-root"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const base = firstAddableDefinition();
    const initialization = planGeneratedRepositoryInitialization({
      definition: base,
      context,
    });
    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: base,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "custom",
        packagePath: "services/custom",
      });
      const workspaceRefresh = addition.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml",
      );

      assert.ok(workspaceRefresh?.kind === "writeTextTemplate");
      assert.ok(Object.hasOwn(workspaceRefresh, "replacements"));
      assert.ok(
        Object.hasOwn(workspaceRefresh.replacements, "WORKSPACE_PACKAGE_GLOBS"),
      );
      const packageGlobs =
        workspaceRefresh.replacements.WORKSPACE_PACKAGE_GLOBS;
      assert.ok(typeof packageGlobs === "string");
      assert.ok(packageGlobs.includes("  - services/*"));
      assert.ok(
        addition.operations.some((operation) => {
          if (
            operation.kind !== "writeJson" ||
            operation.to !== "package.json" ||
            !Object.hasOwn(operation, "value") ||
            typeof operation.value !== "object" ||
            operation.value === null ||
            !Object.hasOwn(operation.value, "scripts")
          ) {
            return false;
          }
          const scripts = (operation.value as Record<string, unknown>)
            .scripts as Record<string, unknown>;
          return (
            Object.hasOwn(scripts, "check") &&
            scripts.check === rootScripts(initialization) &&
            Object.hasOwn(scripts, "fix") &&
            scripts.fix === rootFix(initialization)
          );
        }),
      );
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: context.targetDir });
      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "test", "--dry-run=json"],
        { cwd: context.targetDir },
      );
      const taskIds = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly { taskId: string }[];
        }
      ).tasks.map((task) => task.taskId);
      for (const taskId of ["@demo/custom#build", "@demo/custom#test"]) {
        assert.ok(taskIds.includes(taskId));
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function rootScripts(
  plan: ReturnType<typeof planGeneratedRepositoryInitialization>,
): string {
  return rootManifestScripts(plan).check!;
}

function rootFix(
  plan: ReturnType<typeof planGeneratedRepositoryInitialization>,
): string {
  return rootManifestScripts(plan).fix!;
}

function rootManifestScripts(
  plan: ReturnType<typeof planGeneratedRepositoryInitialization>,
): Record<string, string | undefined> {
  const operation = plan.operations.find(
    (item) => item.kind === "writeJson" && item.to === "package.json",
  );
  if (operation?.kind !== "writeJson") {
    throw new Error("Generated Repository Plan is missing the root manifest");
  }
  const manifest = operation.value as {
    scripts: Record<string, string | undefined>;
  };
  return manifest.scripts;
}
