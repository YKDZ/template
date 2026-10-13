import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

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
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

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
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-packing-hook-"),
      );
      const targetDir = path.join(workspace, "project");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      });
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
        const initialTsconfig = JSON.parse(
          await readFile(path.join(targetDir, "tsconfig.json"), "utf8"),
        ) as Record<string, unknown>;
        const initialCompilerOptions = initialTsconfig.compilerOptions;
        const initialIncludes = initialTsconfig.include;
        const alreadyIncludesPnpmfile =
          typeof initialCompilerOptions === "object" &&
          initialCompilerOptions !== null &&
          Object.hasOwn(initialTsconfig, "compilerOptions") &&
          Object.hasOwn(initialCompilerOptions, "allowJs") &&
          (initialCompilerOptions as Record<string, unknown>).allowJs ===
            true &&
          Object.hasOwn(initialCompilerOptions, "checkJs") &&
          (initialCompilerOptions as Record<string, unknown>).checkJs ===
            true &&
          Object.hasOwn(initialTsconfig, "include") &&
          Array.isArray(initialIncludes) &&
          initialIncludes.includes(".pnpmfile.mjs");
        assert.ok(!alreadyIncludesPnpmfile);

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
        for (const expectedAction of [
          { path: ".pnpmfile.mjs", driver: "text", action: "create" },
          { path: "tsconfig.json", driver: "structured", action: "update" },
        ]) {
          assert.ok(
            result.actions.some((action) =>
              isDeepStrictEqual(action, expectedAction),
            ),
          );
        }
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
        const localDevelopmentDependency = Object.entries(
          (sourceManifest.devDependencies ?? {}) as Record<string, unknown>,
        ).find(([, specifier]) =>
          typeof specifier === "string" ? specifier.startsWith("link:") : false,
        );
        assert.notStrictEqual(localDevelopmentDependency, undefined);
        const provider = addition.blueprint.packages.find(
          (definition) => definition.name === localDevelopmentDependency![0],
        );
        assert.notStrictEqual(provider, undefined);
        assert.strictEqual(
          path.posix.normalize(
            path.posix.join(
              addedPackage!.path,
              (localDevelopmentDependency![1] as string).slice("link:".length),
            ),
          ),
          provider!.path,
        );
        const addedTsconfig = JSON.parse(
          await readFile(path.join(targetDir, "tsconfig.json"), "utf8"),
        ) as Record<string, unknown>;
        assert.partialDeepStrictEqual(addedTsconfig, {
          compilerOptions: { allowJs: true, checkJs: true },
        });
        assert.deepStrictEqual(addedTsconfig.files, [".pnpmfile.mjs"]);
        assert.deepStrictEqual(addedTsconfig.include, [
          "*.config.ts",
          "scripts/**/*.ts",
        ]);

        await execa("pnpm", ["install"], { cwd: targetDir });
        const packDestination = path.join(workspace, "packs");
        await mkdir(packDestination);
        await execa("pnpm", ["pack", "--pack-destination", packDestination], {
          cwd: path.join(targetDir, addedPackage!.path),
        });
        const archives = (await readdir(packDestination)).filter((file) =>
          file.endsWith(".tgz"),
        );
        assert.strictEqual(archives.length, 1);
        const packedManifest = await execa("tar", [
          "-xOf",
          path.join(packDestination, archives[0]!),
          "package/package.json",
        ]).then(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>);
        assert.ok(!Object.hasOwn(packedManifest, "devDependencies"));
        assert.ok(!JSON.stringify(packedManifest).includes("link:"));
        assert.ok(!JSON.stringify(packedManifest).includes("workspace:"));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
