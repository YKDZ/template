import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import { materializeProjectProjection } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.11.0",
} as const;

describe("Generated Repository Node manifest publication policy", () => {
  it("omits versions from every initially private package", () => {
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

      expect(rootManifest).toEqual(
        expect.objectContaining({ name: repositoryName, private: true }),
      );
      for (const manifest of plan.manifests) {
        if (manifest.private === true) {
          expect(manifest).not.toHaveProperty("version");
          continue;
        }
        expect(manifest).toEqual(
          expect.objectContaining({
            name: expect.any(String),
            version: expect.stringMatching(/^\d+\.\d+\.\d+(?:[-+].+)?$/u),
          }),
        );
        publicManifestNames.add(manifest.name as string);
      }
      const foundationRecord = plan.generationRecord.packages.find(
        (record) => record.planningContribution === "foundationPlan",
      );
      const configurationDefinition = plan.blueprint.packages.find(
        (packageDefinition) =>
          packageDefinition.packageDefinitionId ===
          foundationRecord?.packageDefinitionId,
      );
      expect(configurationDefinition).toBeDefined();
      let requiresPackingHook = false;

      for (const packageDefinition of plan.blueprint.packages) {
        const manifest = plan.manifests.find(
          (candidate) => candidate.name === packageDefinition.name,
        );
        expect(manifest).toBeDefined();
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
        requiresPackingHook ||= isPublicDevelopmentEdge;
        expect(dependencyEntry.specifier).toBe(
          isPublicDevelopmentEdge
            ? `link:${path.posix.relative(
                packageDefinition.path,
                configurationDefinition!.path,
              )}`
            : "workspace:*",
        );
      }
      const packingHookOperations = plan.operations.filter(
        (operation) =>
          operation.kind === "copyFile" && operation.to === ".pnpmfile.mjs",
      );
      expect(packingHookOperations).toHaveLength(requiresPackingHook ? 1 : 0);
      expect(
        plan.operations.find(
          (operation) =>
            operation.kind === "copyFile" && operation.to === "tsconfig.json",
        ),
      ).toEqual(expect.objectContaining({ from: "tsconfig.json" }));
      expect(
        plan.operations.filter(
          (operation) =>
            operation.kind === "mergeJsonTemplate" &&
            operation.to === "tsconfig.json" &&
            operation.from === "tsconfig.packing-hook.json",
        ),
      ).toHaveLength(requiresPackingHook ? 1 : 0);
      expect(plan.reconciliation).toContainEqual({
        path: "tsconfig.json",
        driver: "structured",
      });
      expect(
        plan.operations.filter(
          (operation) => "to" in operation && operation.to === "tsconfig.json",
        ),
      ).toHaveLength(requiresPackingHook ? 2 : 1);
      expect(plan.generationRecord.templateVersion).toBe("0.0.0");
    }

    expect(publicManifestNames).toEqual(new Set());
  });

  it("preserves the policy in every complete Package Addition after projection", async () => {
    const definitions = builtInPresetRegistry.all();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    expect(definitions).not.toHaveLength(0);
    expect(addableDefinitions).not.toHaveLength(0);

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
          await expect(
            readFile(
              path.join(targetDir, nativePackage.path, "Cargo.toml"),
              "utf8",
            ),
          ).resolves.toContain('version = "0.1.0"');
          await expect(
            readFile(
              path.join(targetDir, nativePackage.path, "Cargo.lock"),
              "utf8",
            ),
          ).resolves.toContain(
            `name = "${nativePackage.name.slice(nativePackage.name.lastIndexOf("/") + 1)}"\nversion = "0.1.0"`,
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
            expect({ manifestPath, found: entry !== undefined }).toEqual({
              manifestPath,
              found: true,
            });
            const manifest = JSON.parse(
              new TextDecoder().decode(entry!.content),
            ) as Record<string, unknown>;
            if (manifest.private === true) {
              expect({
                manifestPath,
                hasVersion: Object.hasOwn(manifest, "version"),
              }).toEqual({ manifestPath, hasVersion: false });
              expect({
                manifestPath,
                leadingKeys: Object.keys(manifest).slice(0, 2),
              }).toEqual({ manifestPath, leadingKeys: ["name", "private"] });
            } else {
              expect({
                manifestPath,
                leadingKeys: Object.keys(manifest).slice(0, 2),
              }).toEqual({ manifestPath, leadingKeys: ["name", "version"] });
            }
          }
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });
});
