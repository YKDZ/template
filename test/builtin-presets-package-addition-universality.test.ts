import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import {
  renderNewProject,
  renderProjectAtomically,
} from "@ykdz/template-core/renderer";
import { describe, expect, it } from "vitest";

describe("Built-in Preset Package Addition universality", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  it("reconstructs every base contribution from durable generated state before an addition", async () => {
    const definitions = builtInPresetRegistry.all();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    for (const baseDefinition of definitions) {
      for (const additionDefinition of addableDefinitions) {
        const workspace = await mkdtemp(
          path.join(tmpdir(), "template-durable-addition-"),
        );
        const targetDir = path.join(workspace, baseDefinition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          scope: "demo",
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
          const addition = planGeneratedRepositoryPackageAddition({
            definition: additionDefinition,
            context,
            blueprint: initialization.blueprint,
            packageLeafName: `durable-${additionDefinition.metadata.name}`,
          });

          expect(addition.checks).toEqual(
            expect.arrayContaining([...initialization.checks]),
          );
          expect(addition.fixes).toEqual(
            expect.arrayContaining([...initialization.fixes]),
          );
          expect(addition.environmentNeeds).toEqual(
            expect.arrayContaining([...initialization.environmentNeeds]),
          );
          expect(addition.deploymentChecks).toEqual(
            expect.arrayContaining([...initialization.deploymentChecks]),
          );
          expect(addition.dependencyMaintenancePolicy.ecosystems).toEqual(
            expect.arrayContaining(
              initialization.dependencyMaintenancePolicy.ecosystems,
            ),
          );
          expect(
            addition.dependencyMaintenancePolicy.directories,
          ).toMatchObject(
            initialization.dependencyMaintenancePolicy.directories ?? {},
          );
          expect(
            addition.operations.find(
              (operation) =>
                operation.kind === "writeJson" &&
                operation.to === "package.json",
            ),
          ).toMatchObject({
            value: {
              scripts: expect.objectContaining({
                check: expect.any(String),
                ...(initialization.deploymentChecks.length === 0
                  ? {}
                  : { "check:deployment": expect.any(String) }),
              }),
            },
          });
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
    }
  });

  it("plans every supported Package Addition for every registered initialization Definition", async () => {
    const definitions = builtInPresetRegistry.all();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    expect(addableDefinitions).not.toHaveLength(0);

    for (const baseDefinition of definitions) {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-universality-")),
        baseDefinition.metadata.name,
      );
      const context = createGenerationContext({
        targetDir,
        scope: "demo",
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

        let currentBlueprint = initialization.blueprint;
        for (const additionDefinition of addableDefinitions) {
          const packageLeafName = `${additionDefinition.metadata.name}-addition`;
          const addition = planGeneratedRepositoryPackageAddition({
            definition: additionDefinition,
            context,
            blueprint: currentBlueprint,
            packageLeafName,
          });
          const addedDefinition = addition.blueprint.packages.find(
            (definition) => definition.name === `@demo/${packageLeafName}`,
          );

          expect(addedDefinition).toBeDefined();
          expect(addition.operations).toContainEqual(
            expect.objectContaining({
              kind: "writeJson",
              to: `${addedDefinition?.path}/package.json`,
              value: expect.objectContaining({
                name: `@demo/${packageLeafName}`,
              }),
              provenance: expect.objectContaining({
                definitionName: additionDefinition.metadata.name,
                planningContribution: "planPackageAddition",
              }),
            }),
          );
          await renderProjectAtomically({
            targetRoot: targetDir,
            operations: [...addition.operations],
          });
          currentBlueprint = addition.blueprint;
        }
      } finally {
        await rm(path.dirname(targetDir), { recursive: true, force: true });
      }
    }
  });
});
