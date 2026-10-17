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
import { parse } from "yaml";

import { rootInstalledIntegrationSignal } from "../test-support/root-installed-integration-signal.ts";
import { preserveRootIntegrationFailure } from "../test-support/root-integration-failure.ts";

void describe("Built-in Preset Package Addition universality", () => {
  const toolchain = {
    nodeLtsMajor: "24",
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  };
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

  void it(
    "adds a package after pnpm has created package-local node_modules symlinks",
    { timeout: 300000 },
    async (testContext) => {
      const signal = rootInstalledIntegrationSignal(testContext.signal);
      if (signal.aborted) {
        const reason = signal.reason;
        testContext.skip(
          reason instanceof Error ? reason.message : String(reason),
        );
        return;
      }
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-with-node-modules-"),
      );
      let completed = false;
      try {
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

        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        await execa("pnpm", ["install"], {
          cwd: targetDir,
          cancelSignal: signal,
        });
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
          cancelSignal: signal,
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
        completed = true;
      } catch (error) {
        await preserveRootIntegrationFailure(
          workspace,
          "adds a package after pnpm has created package-local node_modules symlinks",
          error,
        );
        throw error;
      } finally {
        if (completed) await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "adds custom Package Roots only through pnpm workspace membership",
    { timeout: 300000 },
    async (testContext) => {
      const signal = rootInstalledIntegrationSignal(testContext.signal);
      if (signal.aborted) {
        const reason = signal.reason;
        testContext.skip(
          reason instanceof Error ? reason.message : String(reason),
        );
        return;
      }
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-custom-package-root-"),
      );
      let completed = false;
      try {
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
        await renderNewProject({
          targetRoot: context.targetDir,
          operations: [...initialization.operations],
        });
        const rootManifestPath = path.join(context.targetDir, "package.json");
        const initialManifest = JSON.parse(
          await readFile(rootManifestPath, "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const addition = planGeneratedRepositoryPackageAddition({
          definition: base,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "custom",
          packagePath: "services/custom",
        });
        const result = await reconcileAndApplyProjectProjections({
          targetRoot: context.targetDir,
          ...addition.projectProjections,
        });
        assert.equal(result.ok, true);
        const workspaceConfig = parse(
          await readFile(
            path.join(context.targetDir, "pnpm-workspace.yaml"),
            "utf8",
          ),
        ) as { readonly packages: readonly string[] };
        assert.ok(workspaceConfig.packages.includes("services/*"));
        const addedManifest = JSON.parse(
          await readFile(rootManifestPath, "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        for (const task of ["check", "fix"])
          assert.equal(
            addedManifest.scripts[task],
            initialManifest.scripts[task],
          );
        await execa("pnpm", ["install"], {
          cwd: context.targetDir,
          cancelSignal: signal,
        });
        const customManifest = JSON.parse(
          await readFile(
            path.join(context.targetDir, "services/custom/package.json"),
            "utf8",
          ),
        ) as {
          readonly name: string;
          readonly scripts: Readonly<Record<string, string>>;
        };
        const members = await execa(
          "pnpm",
          ["list", "-r", "--depth=-1", "--json"],
          {
            cwd: context.targetDir,
            cancelSignal: signal,
          },
        ).then(
          ({ stdout }) =>
            JSON.parse(stdout) as readonly {
              readonly name: string;
              readonly path: string;
            }[],
        );
        assert.ok(
          members.some(
            (member) =>
              member.name === customManifest.name &&
              member.path === path.join(context.targetDir, "services/custom"),
          ),
        );
        const customTurbo = JSON.parse(
          await readFile(
            path.join(context.targetDir, "services/custom/turbo.json"),
            "utf8",
          ),
        ) as { readonly tasks: Readonly<Record<string, unknown>> };
        const taskName = Object.keys(customTurbo.tasks).find((name) =>
          Object.hasOwn(customManifest.scripts, name),
        );
        assert.notStrictEqual(taskName, undefined);
        const dryRun = await execa(
          "pnpm",
          [
            "exec",
            "turbo",
            "run",
            taskName!,
            `--filter=${customManifest.name}`,
            "--dry-run=json",
          ],
          { cwd: context.targetDir, cancelSignal: signal },
        );
        const customTask = (
          JSON.parse(dryRun.stdout) as {
            tasks: readonly {
              taskId: string;
              directory: string;
              command: string;
            }[];
          }
        ).tasks.find(
          (task) => task.taskId === `${customManifest.name}#${taskName}`,
        );
        assert.notStrictEqual(customTask, undefined);
        assert.strictEqual(customTask!.directory, "services/custom");
        assert.notStrictEqual(customTask!.command, "<NONEXISTENT>");
        completed = true;
      } catch (error) {
        await preserveRootIntegrationFailure(
          workspace,
          "adds custom Package Roots only through pnpm workspace membership",
          error,
        );
        throw error;
      } finally {
        if (completed) await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
