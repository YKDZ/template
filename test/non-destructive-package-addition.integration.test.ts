import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
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
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import { type PackageRole } from "@ykdz/template-core/project-blueprint";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { rootInstalledIntegrationSignal } from "../test-support/root-installed-integration-signal.ts";
import { preserveRootIntegrationFailure } from "../test-support/root-integration-failure.ts";

function requireAddableDefinitionForRole(
  context: BuiltInGenerationContext,
  role: PackageRole,
): BuiltInPresetDefinition {
  const packageLeafName = "role-probe";
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const packagePath = candidate.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    return (
      candidate.planPackageAddition !== undefined &&
      packagePath !== undefined &&
      candidate.planPackageAddition({
        context,
        packageLeafName,
        packagePath,
      }).definition.role === role
    );
  });
  if (definition === undefined) {
    throw new Error(`Expected an addable Definition for Package Role ${role}`);
  }
  return definition;
}

void describe("Non-Destructive Package Addition", () => {
  void it(
    "adds the checked packing hook when a pre-hook private repository gains a public package",
    { timeout: 180000 },
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
        path.join(tmpdir(), "template-add-packing-hook-"),
      );
      const targetDir = path.join(workspace, "project");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
        },
      });
      let completed = false;
      const privateBaseDefinition = builtInPresetRegistry
        .all()
        .find((definition) => {
          const initialization = planGeneratedRepositoryInitialization({
            definition,
            context,
          });
          return initialization.manifests.every(
            (manifest) => manifest.private === true,
          );
        });
      if (privateBaseDefinition === undefined) {
        throw new Error("Expected a private Built-in Preset base repository");
      }
      const privateLibraryDefinition = requireAddableDefinitionForRole(
        context,
        "shared-library",
      );
      const publicDefinition: BuiltInPresetDefinition = {
        ...privateLibraryDefinition,
        metadata: {
          ...privateLibraryDefinition.metadata,
          name: "synthetic-public-library",
        },
        planPackageAddition(options) {
          const contribution =
            privateLibraryDefinition.planPackageAddition!(options);
          const { private: _private, ...privateManifest } =
            contribution.manifest;
          return {
            ...contribution,
            manifest: { ...privateManifest, version: "1.0.0" },
          };
        },
      };

      try {
        const initialization = planGeneratedRepositoryInitialization({
          definition: privateBaseDefinition,
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        await assert.rejects(
          stat(path.join(targetDir, ".pnpmfile.mjs")),
          (error) => {
            assert.ok(typeof error === "object" && error !== null);
            assert.ok(Object.hasOwn(error, "code"));
            assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
            return true;
          },
        );
        const addition = planGeneratedRepositoryPackageAddition({
          definition: publicDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
          packageLeafName: "release",
        });
        const result = await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        });

        assert.strictEqual(result.ok, true);
        if (!result.ok) return;
        assert.ok(
          result.actions.some(
            (action) =>
              action.path === ".pnpmfile.mjs" && action.action === "create",
          ),
        );
        const addedPackage = addition.blueprint.packages.find(
          (definition) => definition.path === "packages/release",
        );
        assert.notStrictEqual(addedPackage, undefined);
        const sourceManifest = JSON.parse(
          await readFile(
            path.join(targetDir, addedPackage!.path, "package.json"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        assert.equal(sourceManifest.private, undefined);
        assert.equal(sourceManifest.version, "1.0.0");
        const localDevelopmentDependency = Object.entries(
          (sourceManifest.devDependencies ?? {}) as Record<string, unknown>,
        ).find(([, specifier]) =>
          typeof specifier === "string"
            ? specifier.startsWith("workspace:")
            : false,
        );
        assert.notStrictEqual(localDevelopmentDependency, undefined);
        const provider = addition.blueprint.packages.find(
          (definition) => definition.name === localDevelopmentDependency![0],
        );
        assert.notStrictEqual(provider, undefined);
        assert.equal(localDevelopmentDependency![1], "workspace:*");

        await execa("pnpm", ["install"], {
          cwd: targetDir,
          cancelSignal: signal,
        });
        assert.equal(
          await realpath(
            path.join(
              targetDir,
              addedPackage!.path,
              "node_modules",
              provider!.name,
            ),
          ),
          await realpath(path.join(targetDir, provider!.path)),
        );
        await execa("pnpm", ["run", "typecheck"], {
          cwd: targetDir,
          cancelSignal: signal,
        });
        const hookPath = path.join(targetDir, ".pnpmfile.mjs");
        const hookSource = await readFile(hookPath, "utf8");
        await writeFile(
          hookPath,
          `${hookSource}\n/** @type {number} */\nconst packingHookTypeProbe = "invalid";\n`,
        );
        const faultyHookCheck = await execa("pnpm", ["run", "typecheck"], {
          cwd: targetDir,
          cancelSignal: signal,
          reject: false,
        });
        assert.notEqual(faultyHookCheck.exitCode, 0);
        assert.match(
          faultyHookCheck.stdout + faultyHookCheck.stderr,
          /\.pnpmfile\.mjs.*TS2322/u,
        );
        await writeFile(hookPath, hookSource);
        await execa("pnpm", ["run", "typecheck"], {
          cwd: targetDir,
          cancelSignal: signal,
        });
        const packDestination = path.join(workspace, "packs");
        await mkdir(packDestination);
        await execa("pnpm", ["pack", "--pack-destination", packDestination], {
          cwd: path.join(targetDir, addedPackage!.path),
          cancelSignal: signal,
        });
        const archives = (await readdir(packDestination)).filter((file) =>
          file.endsWith(".tgz"),
        );
        assert.strictEqual(archives.length, 1);
        const packedManifest = await execa(
          "tar",
          [
            "-xOf",
            path.join(packDestination, archives[0]!),
            "package/package.json",
          ],
          { cancelSignal: signal },
        ).then(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>);
        assert.ok(!Object.hasOwn(packedManifest, "devDependencies"));
        assert.ok(!JSON.stringify(packedManifest).includes("link:"));
        assert.ok(!JSON.stringify(packedManifest).includes("workspace:"));
        completed = true;
      } catch (error) {
        await preserveRootIntegrationFailure(
          workspace,
          "adds the checked packing hook when a pre-hook private repository gains a public package",
          error,
        );
        throw error;
      } finally {
        if (completed) await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
