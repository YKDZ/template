import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { execa } from "execa";
import { describe, expect, it } from "vitest";

describe("Built-in Preset Package Addition universality", () => {
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };

  function firstAddableDefinition() {
    const definition = builtInPresetRegistry
      .all()
      .find((candidate) => candidate.planPackageAddition !== undefined);
    if (definition === undefined) {
      throw new Error("Expected an addable Built-in Preset Definition");
    }
    return definition;
  }

  it("initializes every Project Shape with both Standard Package Roots", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join(
            "generated-repository",
            definition.metadata.name,
          ),
          scope: "demo",
          toolchain,
        }),
      });
      const workspace = plan.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml",
      );

      expect(workspace).toMatchObject({
        replacements: expect.objectContaining({
          WORKSPACE_PACKAGE_GLOBS: expect.stringContaining(
            "  - apps/*\n  - packages/*",
          ),
        }),
      });
    }
  });

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

          expect(addition).not.toHaveProperty("checks");
          expect(initialization).not.toHaveProperty("checks");
          expect(addition).not.toHaveProperty("fixes");
          expect(initialization).not.toHaveProperty("fixes");
          expect(addition.environmentNeeds).toEqual(
            expect.arrayContaining([...initialization.environmentNeeds]),
          );
          expect(addition).not.toHaveProperty("deploymentChecks");
          expect(initialization).not.toHaveProperty("deploymentChecks");
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
                ...(initialization.manifests.some(
                  (manifest) =>
                    (manifest.scripts as Record<string, unknown> | undefined)?.[
                      "check:deployment"
                    ] !== undefined,
                )
                  ? { "check:deployment": expect.any(String) }
                  : {}),
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

  it("keeps default-root task entrypoints stable while Turbo discovers added scripts", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-natural-addition-"),
    );
    const targetDir = path.join(workspace, "demo");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
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
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "natural",
      });
      await renderProjectAtomically({
        targetRoot: targetDir,
        operations: [...packageAddition.operations],
      });
      const rootScriptsAfter = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;

      for (const script of ["check", "fix", "check:deployment"] as const) {
        expect(rootScriptsAfter[script]).toBe(rootScriptsBefore[script]);
      }

      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: addition,
        context,
        blueprint: packageAddition.blueprint,
        packageLeafName: "natural-repeat",
      });
      await renderProjectAtomically({
        targetRoot: targetDir,
        operations: [...repeatedAddition.operations],
      });
      const rootScriptsAfterRepeat = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;
      for (const script of ["check", "fix", "check:deployment"] as const) {
        expect(rootScriptsAfterRepeat[script]).toBe(rootScriptsBefore[script]);
      }

      await execa("pnpm", ["install"], { cwd: targetDir });
      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "boundaries",
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
      const addedManifest = JSON.parse(
        await readFile(
          path.join(targetDir, "packages/natural/package.json"),
          "utf8",
        ),
      ) as { scripts: Record<string, string> };

      for (const task of Object.keys(addedManifest.scripts).filter((name) =>
        ["format:check", "lint", "typecheck", "build", "test"].includes(name),
      )) {
        expect(taskIds).toContain(`@demo/natural#${task}`);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves native preparation and composes browser preparation for a Rust-to-Vue addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-vue-environment-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "rust-vue"),
      scope: "demo",
      toolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry
        .all()
        .find((definition) =>
          definition
            .planInitialization(context)
            .environmentNeeds.some((need) => need.kind === "rust-toolchain"),
        )!,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: builtInPresetRegistry.all().find(
          (definition) =>
            definition
              .planPackageAddition?.({
                context,
                packageLeafName: "web",
                packagePath: "apps/web",
              })
              .environmentNeeds.some(
                (need) => need.kind === "playwright-browser-assets",
              ) ?? false,
        )!,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "web",
      });
      await renderProjectAtomically({
        targetRoot: context.targetDir,
        operations: [...addition.operations],
      });

      const devcontainer = await readFile(
        path.join(context.targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      expect(devcontainer).toContain(
        "rustup toolchain install ${RUST_TOOLCHAIN}",
      );
      expect(devcontainer).toContain("playwright install-deps chromium");
      expect(addition.environmentNeeds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "rust-toolchain" }),
          expect.objectContaining({ kind: "playwright-browser-assets" }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("recovers preparation only from persisted Environment Need facts, never task script text", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-explicit-environment-needs-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "explicit-needs"),
      scope: "demo",
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
      const packageManifestPath = path.join(
        context.targetDir,
        initialization.blueprint.packages[0]!.path,
        "package.json",
      );
      const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      await writeFile(
        packageManifestPath,
        JSON.stringify({
          ...packageManifest,
          scripts: {
            ...packageManifest.scripts,
            "test:e2e": "playwright test",
            lint: "shellcheck scripts/check.sh",
            deployment: "docker build .",
          },
        }),
      );

      const addition = planGeneratedRepositoryPackageAddition({
        definition: base,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "another-library",
      });

      expect(addition.environmentNeeds).toEqual([]);
      expect(addition.deploymentEnvironmentNeeds).toEqual([]);
      expect(
        addition.operations.find(
          (operation) =>
            operation.kind === "writeJson" &&
            operation.to === ".template/environment-needs.json",
        ),
      ).toMatchObject({
        value: { schemaVersion: 1, check: [], deployment: [] },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("adds custom Package Roots only through pnpm workspace membership", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-custom-package-root-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "custom-package-root"),
      scope: "demo",
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
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "custom",
        packagePath: "services/custom",
      });
      const workspaceRefresh = addition.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml",
      );

      expect(workspaceRefresh).toMatchObject({
        replacements: expect.objectContaining({
          WORKSPACE_PACKAGE_GLOBS: expect.stringContaining("  - services/*"),
        }),
      });
      expect(
        addition.operations.filter(
          (operation) =>
            operation.kind === "writeJson" && operation.to === "package.json",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              scripts: expect.objectContaining({
                check: rootScripts(initialization),
                fix: rootFix(initialization),
              }),
            }),
          }),
        ]),
      );
      await renderProjectAtomically({
        targetRoot: context.targetDir,
        operations: [...addition.operations],
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
      expect(taskIds).toEqual(
        expect.arrayContaining(["@demo/custom#build", "@demo/custom#test"]),
      );
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
