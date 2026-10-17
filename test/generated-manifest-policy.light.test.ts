import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { materializeProjectProjection } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

// 直接规划新建初始化会派生新建公开 ts-cli 候选，需要发版快照的精确三段版本。
const toolchain = {
  nodeLtsMajor: "24",
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
  packageManagerPin: "pnpm@11.11.0",
} as const;

void describe("Generated Repository Node manifest publication policy", () => {
  void it("derives root lint fixer paths from root-owned joint E2E", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const repositoryName = `manifest-lint-fix-${definition.metadata.name}`;
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join("generated-repository", repositoryName),
          defaultPackageScope: "manifest-policy",
          toolchain,
        }),
      });
      const rootManifest = plan.manifests.find(
        (manifest) => manifest.name === repositoryName,
      ) as { readonly scripts?: Readonly<Record<string, string>> } | undefined;
      const rootAutomationPaths =
        plan.vueHonoJointE2e === undefined ? "scripts" : "scripts test";

      assert.strictEqual(
        rootManifest?.scripts?.["lint:fix"],
        `oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs ${rootAutomationPaths} --fix`,
      );
    }
  });

  void it("preserves private package isolation and the native shared provider version", async () => {
    const nativeConfigurationManifest = JSON.parse(
      await readFile(
        new URL(
          import.meta
            .resolve("@ykdz/reference-typescript-config/assets/package.json"),
        ),
        "utf8",
      ),
    ) as { readonly version: string };
    const publicManifestNames = new Set<string>();
    for (const definition of builtInPresetRegistry.all()) {
      const repositoryName = `manifest-policy-${definition.metadata.name}`;
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join("generated-repository", repositoryName),
          defaultPackageScope: "manifest-policy",
          toolchain,
        }),
      });
      const rootManifest = plan.manifests.find(
        (manifest) => manifest.name === repositoryName,
      );

      assert.ok(rootManifest !== undefined);
      assert.strictEqual(rootManifest.name, repositoryName);
      assert.strictEqual(rootManifest.private, true);
      for (const manifest of plan.manifests) {
        if (manifest.private === true) {
          if (manifest.version !== undefined) {
            assert.equal(typeof manifest.version, "string");
            assert.match(
              manifest.version as string,
              /^\d+\.\d+\.\d+(?:[-+].+)?$/u,
            );
          }
          continue;
        }
        const publicName = manifest.name;
        const publicVersion = manifest.version;
        assert.ok(typeof publicName === "string");
        assert.ok(typeof publicVersion === "string");
        assert.match(publicVersion, /^\d+\.\d+\.\d+(?:[-+].+)?$/u);
        publicManifestNames.add(publicName);
      }
      const foundationRecord = plan.generationRecord.packages.find(
        (record) => record.planningContribution === "foundationPlan",
      );
      const configurationDefinition = plan.blueprint.packages.find(
        (packageDefinition) =>
          packageDefinition.packageDefinitionId ===
          foundationRecord?.packageDefinitionId,
      );
      assert.notStrictEqual(configurationDefinition, undefined);
      const configurationManifest = plan.manifests.find(
        (manifest) => manifest.name === configurationDefinition!.name,
      )!;
      assert.equal(configurationManifest.private, true);
      assert.equal(
        configurationManifest.version,
        nativeConfigurationManifest.version,
      );
      let requiresPackingHook = false;

      for (const packageDefinition of plan.blueprint.packages) {
        const manifest = plan.manifests.find(
          (candidate) => candidate.name === packageDefinition.name,
        );
        assert.notStrictEqual(manifest, undefined);
        const dependencyEntry = [
          ...Object.entries(
            (manifest?.dependencies ?? {}) as Record<string, unknown>,
          ).map(([name, specifier]) => ({
            field: "dependencies",
            name,
            specifier,
          })),
          ...Object.entries(
            (manifest?.devDependencies ?? {}) as Record<string, unknown>,
          ).map(([name, specifier]) => ({
            field: "devDependencies",
            name,
            specifier,
          })),
        ].find((entry) => entry.name === configurationDefinition!.name);
        if (dependencyEntry === undefined) continue;

        const isPublicDevelopmentEdge =
          manifest?.private !== true &&
          dependencyEntry.field === "devDependencies";
        const isNativeLink =
          typeof dependencyEntry.specifier === "string" &&
          dependencyEntry.specifier.startsWith("link:");
        requiresPackingHook ||=
          isPublicDevelopmentEdge ||
          (isNativeLink && dependencyEntry.field === "devDependencies");
        if (isNativeLink) {
          assert.equal(
            path.posix.normalize(
              path.posix.join(
                packageDefinition.path,
                (dependencyEntry.specifier as string).slice("link:".length),
              ),
            ),
            configurationDefinition!.path,
          );
        } else {
          assert.equal(dependencyEntry.specifier, "workspace:*");
        }
      }
      const packingHookOperations = plan.operations.filter(
        (operation) =>
          operation.kind === "copyFile" && operation.to === ".pnpmfile.mjs",
      );
      assert.strictEqual(
        packingHookOperations.length,
        requiresPackingHook ? 1 : 0,
      );
      const projection = await materializeProjectProjection({
        operations: plan.operations,
      });
      const tsconfigEntry = projection.entries.find(
        (entry) => entry.path === "tsconfig.json",
      )!;
      const tsconfig = JSON.parse(
        new TextDecoder().decode(tsconfigEntry.content),
      ) as {
        include: string[];
        allowJs?: boolean;
        compilerOptions?: { allowJs?: boolean };
      };
      assert.ok(tsconfig.include.includes("scripts/**/*.ts"));
      assert.equal(
        tsconfig.compilerOptions?.allowJs,
        requiresPackingHook ? true : undefined,
      );
      assert.ok(
        plan.reconciliation.some((entry) =>
          isDeepStrictEqual(entry, {
            path: "tsconfig.json",
            driver: "structured",
          }),
        ),
      );
      assert.strictEqual(plan.generationRecord.templateVersion, "0.0.0");
    }

    assert.deepStrictEqual(publicManifestNames, new Set());
  });

  void it("preserves the policy in every complete Package Addition after projection", async () => {
    const definitions = builtInPresetRegistry.all();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    assert.notStrictEqual(definitions.length, 0);
    assert.notStrictEqual(addableDefinitions.length, 0);

    for (const baseDefinition of definitions) {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-manifest-policy-"),
      );
      const targetDir = path.join(workspace, baseDefinition.metadata.name);
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "manifest-policy",
        toolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        const nativePackage = initialization.blueprint.packages.find(
          (definition) => definition.role === "native-package",
        );
        if (nativePackage !== undefined) {
          assert.ok(
            (
              await readFile(
                path.join(targetDir, nativePackage.path, "Cargo.toml"),
                "utf8",
              )
            ).includes('version = "0.1.0"'),
          );
          assert.ok(
            (
              await readFile(
                path.join(targetDir, nativePackage.path, "Cargo.lock"),
                "utf8",
              )
            ).includes(
              `name = "${nativePackage.name.slice(nativePackage.name.lastIndexOf("/") + 1)}"\nversion = "0.1.0"`,
            ),
          );
        }
        const localTemplateMetadata = loadLocalTemplateMetadata(targetDir);

        for (const additionDefinition of addableDefinitions) {
          const addition = planGeneratedRepositoryPackageAddition({
            definition: additionDefinition,
            localTemplateMetadata,
            packageLeafName: `${additionDefinition.metadata.name}-addition`,
          });
          const projection = await materializeProjectProjection(
            addition.projectProjections.after,
          );
          const manifestPaths = [
            "package.json",
            ...addition.blueprint.packages.map(
              (definition) => `${definition.path}/package.json`,
            ),
          ];

          for (const manifestPath of manifestPaths) {
            const entry = projection.entries.find(
              (candidate) => candidate.path === manifestPath,
            );
            assert.deepStrictEqual(
              { manifestPath, found: entry !== undefined },
              {
                manifestPath,
                found: true,
              },
            );
            const manifest = JSON.parse(
              new TextDecoder().decode(entry!.content),
            ) as Record<string, unknown>;
            const plannedManifest = addition.manifests.find(
              (candidate) => candidate.name === manifest.name,
            );
            assert.ok(plannedManifest);
            assert.equal(manifest.private, plannedManifest.private);
            assert.equal(manifest.version, plannedManifest.version);
            if (manifest.private !== true) {
              assert.equal(typeof manifest.version, "string");
              assert.match(
                manifest.version as string,
                /^\d+\.\d+\.\d+(?:[-+].+)?$/u,
              );
            }
          }
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });
});
