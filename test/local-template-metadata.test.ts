import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "#template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.21.0",
} as const;

function requireSharedLibraryAdditionDefinition(
  context: BuiltInGenerationContext,
) {
  const definition = builtInPresetRegistry.all().find(
    (candidate) =>
      candidate.planPackageAddition?.({
        context,
        packageLeafName: "probe",
        packagePath: "packages/probe",
      }).definition.role === "shared-library",
  );
  if (definition === undefined) {
    throw new Error("Expected an addable shared-library Definition");
  }
  return definition;
}

function requireMultiPackageDefinition(context: BuiltInGenerationContext) {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.blueprint(context).packages.length > 2);
  if (definition === undefined) {
    throw new Error("Expected a multi-Package Definition");
  }
  return definition;
}

async function initializedRepository(
  selectDefinition: (
    context: BuiltInGenerationContext,
  ) => BuiltInPresetDefinition = requireSharedLibraryAdditionDefinition,
) {
  const parent = await mkdtemp(path.join(tmpdir(), "template-metadata-"));
  const repositoryRoot = path.join(parent, "recorded-repository");
  const context = createGenerationContext({
    targetDir: repositoryRoot,
    defaultPackageScope: "recorded-scope",
    toolchain,
  });
  const definition = selectDefinition(context);
  const plan = planGeneratedRepositoryInitialization({
    definition,
    context,
  });
  await renderNewProject({
    targetRoot: repositoryRoot,
    operations: [...plan.operations],
  });
  return { parent, repositoryRoot, context, definition, plan };
}

async function workspaceByteSnapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceByteSnapshot(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function expectFoundationProvenanceRejection(
  mutate: (
    record: Record<string, unknown>,
    definition: BuiltInPresetDefinition,
  ) => Record<string, unknown>,
  message: string,
) {
  const initialized = await initializedRepository();
  const generationPath = path.join(
    initialized.repositoryRoot,
    ".template/generation.json",
  );
  const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
    packages: Record<string, unknown>[];
  } & Record<string, unknown>;
  generation.packages = generation.packages.map((record) =>
    record.planningContribution === "foundationPlan"
      ? mutate(record, initialized.definition)
      : record,
  );
  await writeFile(generationPath, `${JSON.stringify(generation, null, 2)}\n`);
  const metadataBeforeLoad = {
    blueprint: await readFile(
      path.join(initialized.repositoryRoot, ".template/blueprint.json"),
      "utf8",
    ),
    generation: await readFile(generationPath, "utf8"),
  };
  const replaySpy = vi.spyOn(
    initialized.definition.packageContributionReplayAdapters[0]!,
    "replay",
  );
  try {
    expect(() => loadLocalTemplateMetadata(initialized.repositoryRoot)).toThrow(
      message,
    );
    expect(replaySpy).not.toHaveBeenCalled();
    await expect(
      readFile(
        path.join(initialized.repositoryRoot, ".template/blueprint.json"),
        "utf8",
      ),
    ).resolves.toBe(metadataBeforeLoad.blueprint);
    await expect(readFile(generationPath, "utf8")).resolves.toBe(
      metadataBeforeLoad.generation,
    );
  } finally {
    replaySpy.mockRestore();
  }
}

describe("Local Template Metadata", () => {
  it("assigns deterministic opaque Package Definition IDs during initialization", async () => {
    const initialized = await initializedRepository();
    const repeatedPlan = planGeneratedRepositoryInitialization({
      definition: initialized.definition,
      context: initialized.context,
    });
    const blueprintIds = initialized.plan.blueprint.packages.map(
      (definition) => definition.packageDefinitionId,
    );

    expect(blueprintIds).toEqual(
      blueprintIds.map(() => expect.stringMatching(/^package-[a-f0-9]{64}$/)),
    );
    expect(new Set(blueprintIds).size).toBe(blueprintIds.length);
    expect(repeatedPlan.blueprint).toEqual(initialized.plan.blueprint);
    expect(
      initialized.plan.generationRecord.packages
        .map((record) => ({
          packageDefinitionId: record.packageDefinitionId,
          path: record.path,
        }))
        .toSorted((left, right) =>
          left.packageDefinitionId.localeCompare(right.packageDefinitionId),
        ),
    ).toEqual(
      initialized.plan.blueprint.packages
        .map((definition) => ({
          packageDefinitionId: definition.packageDefinitionId,
          path: definition.path,
        }))
        .toSorted((left, right) =>
          left.packageDefinitionId.localeCompare(right.packageDefinitionId),
        ),
    );
  });

  it("keeps deterministic Package Definition IDs independent of Preset plan ordering", () => {
    const context = createGenerationContext({
      targetDir: "/tmp/reordered-package-plans",
      defaultPackageScope: "recorded-scope",
      toolchain,
    });
    const definition = requireMultiPackageDefinition(context);
    const reorderedDefinition: BuiltInPresetDefinition = {
      ...definition,
      blueprint(generationContext) {
        const blueprint = definition.blueprint(generationContext);
        return { ...blueprint, packages: [...blueprint.packages].reverse() };
      },
      planInitializationContributions(generationContext) {
        return [
          ...definition.planInitializationContributions!(generationContext),
        ].reverse();
      },
    };

    const original = planGeneratedRepositoryInitialization({
      definition,
      context,
    });
    const reordered = planGeneratedRepositoryInitialization({
      definition: reorderedDefinition,
      context,
    });
    const idsByPath = (plan: typeof original) =>
      plan.blueprint.packages
        .map((item) => [item.path, item.packageDefinitionId] as const)
        .toSorted(([left], [right]) => left.localeCompare(right));

    expect(idsByPath(reordered)).toEqual(idsByPath(original));
  });

  it("rebuilds Generation Context from persisted repository facts after the directory is renamed", async () => {
    const initialized = await initializedRepository();
    const renamedRoot = path.join(initialized.parent, "renamed-directory");
    await rename(initialized.repositoryRoot, renamedRoot);

    const metadata = loadLocalTemplateMetadata(renamedRoot);

    expect(metadata.blueprint).toEqual(initialized.plan.blueprint);
    expect(metadata.context).toEqual({
      targetDir: renamedRoot,
      repositoryName: "recorded-repository",
      defaultPackageScope: "recorded-scope",
      foundationPackages: {
        typescriptConfiguration: {
          name: "@recorded-scope/typescript-config",
        },
      },
      toolchain,
    });
  });

  it("uses controlled Package Definition name, path, role, and provenance changes as the source of truth for the next addition", async () => {
    const initialized = await initializedRepository();
    const oldDefinition = initialized.plan.blueprint.packages.find(
      (definition) => definition.role === "shared-library",
    )!;
    const newDefinition = {
      name: "renamed-library",
      packageDefinitionId: oldDefinition.packageDefinitionId,
      path: "packages/renamed-library",
      role: "cli-tool" as const,
    };
    await rename(
      path.join(initialized.repositoryRoot, oldDefinition.path),
      path.join(initialized.repositoryRoot, newDefinition.path),
    );
    const manifestPath = path.join(
      initialized.repositoryRoot,
      newDefinition.path,
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, name: newDefinition.name }, null, 2)}\n`,
    );
    const blueprintPath = path.join(
      initialized.repositoryRoot,
      ".template/blueprint.json",
    );
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          packages: initialized.plan.blueprint.packages.map((definition) => {
            const persisted =
              definition.path === oldDefinition.path
                ? newDefinition
                : definition;
            return {
              name: persisted.name,
              packageDefinitionId: persisted.packageDefinitionId,
              path: persisted.path,
              role: persisted.role,
            };
          }),
          schemaVersion: 3,
        },
        null,
        2,
      )}\n`,
    );
    const generationPath = path.join(
      initialized.repositoryRoot,
      ".template/generation.json",
    );
    const generationRecord = JSON.parse(
      await readFile(generationPath, "utf8"),
    ) as {
      packages: { path: string }[];
    } & Record<string, unknown>;
    await writeFile(
      generationPath,
      `${JSON.stringify(
        {
          ...generationRecord,
          packages: generationRecord.packages.map((record) =>
            record.path === oldDefinition.path
              ? { ...record, path: newDefinition.path }
              : record,
          ),
        },
        null,
        2,
      )}\n`,
    );

    const addition = planGeneratedRepositoryPackageAddition({
      definition: requireSharedLibraryAdditionDefinition(initialized.context),
      localTemplateMetadata: loadLocalTemplateMetadata(
        initialized.repositoryRoot,
      ),
      packageLeafName: "utilities",
    });
    const result = await reconcileAndApplyProjectProjections({
      targetRoot: initialized.repositoryRoot,
      ...addition.projectProjections,
    });

    if (!result.ok) throw new Error(JSON.stringify(result, null, 2));
    expect(addition.blueprint.packages).toEqual(
      expect.arrayContaining([
        newDefinition,
        expect.objectContaining({
          name: "@recorded-scope/utilities",
          path: "packages/utilities",
        }),
      ]),
    );
  });

  it.each(["cli-tool", "native-package"] as const)(
    "replays persisted %s provenance without consulting current Preset defaults",
    async (role) => {
      const initialized = await initializedRepository((context) => {
        const definition = builtInPresetRegistry.all().find((candidate) => {
          const blueprint = candidate.blueprint(context);
          return (
            blueprint.packages.length === 1 &&
            blueprint.packages[0]?.role === role
          );
        });
        if (definition === undefined) {
          throw new Error(`Expected a single-Package ${role} Definition`);
        }
        return definition;
      });
      const defaultReplay = vi
        .spyOn(initialized.definition, "planInitialization")
        .mockImplementation(() => {
          throw new Error("current Preset default must not be replayed");
        });
      try {
        expect(() =>
          planGeneratedRepositoryPackageAddition({
            definition: requireSharedLibraryAdditionDefinition(
              initialized.context,
            ),
            localTemplateMetadata: loadLocalTemplateMetadata(
              initialized.repositoryRoot,
            ),
            packageLeafName: `after-${role}`,
          }),
        ).not.toThrow();
      } finally {
        defaultReplay.mockRestore();
      }
    },
  );

  it("replays persisted multi-Package provenance without consulting current Preset defaults", async () => {
    const initialized = await initializedRepository((context) => {
      const definition = builtInPresetRegistry
        .all()
        .find((candidate) => candidate.blueprint(context).packages.length > 2);
      if (definition === undefined) {
        throw new Error("Expected a multi-Package Definition");
      }
      return definition;
    });
    const defaultReplay = vi
      .spyOn(initialized.definition, "planInitialization")
      .mockImplementation(() => {
        throw new Error("current Preset default must not be replayed");
      });
    const defaultReplaySet = vi
      .spyOn(initialized.definition, "planInitializationContributions")
      .mockImplementation(() => {
        throw new Error("current Preset default set must not be replayed");
      });
    try {
      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition: requireSharedLibraryAdditionDefinition(
            initialized.context,
          ),
          localTemplateMetadata: loadLocalTemplateMetadata(
            initialized.repositoryRoot,
          ),
          packageLeafName: "after-multi-package",
        }),
      ).not.toThrow();
    } finally {
      defaultReplay.mockRestore();
      defaultReplaySet.mockRestore();
    }
  });

  it("replays every persisted multi-Package contribution exactly once after preflight", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const replaySpies =
      initialized.definition.packageContributionReplayAdapters.map((adapter) =>
        vi.spyOn(adapter, "replay"),
      );

    try {
      loadLocalTemplateMetadata(initialized.repositoryRoot);

      for (const replaySpy of replaySpies) {
        expect(replaySpy).toHaveBeenCalledTimes(1);
        expect(
          replaySpy.mock.calls[0]![0].packageDefinition,
        ).not.toHaveProperty("packageDefinitionId");
      }
    } finally {
      for (const replaySpy of replaySpies) replaySpy.mockRestore();
    }
  });

  it("keeps opaque IDs stable across reload and no-op while repeated adapter additions receive unique IDs", async () => {
    const initialized = await initializedRepository();
    let latestPlan = initialized.plan;
    for (const packageLeafName of ["first-library", "second-library"]) {
      const addition = planGeneratedRepositoryPackageAddition({
        definition: initialized.definition,
        localTemplateMetadata: loadLocalTemplateMetadata(
          initialized.repositoryRoot,
        ),
        packageLeafName,
      });
      const applied = await reconcileAndApplyProjectProjections({
        targetRoot: initialized.repositoryRoot,
        ...addition.projectProjections,
      });
      if (!applied.ok) throw new Error(JSON.stringify(applied, null, 2));
      latestPlan = addition;
    }

    const reloaded = loadLocalTemplateMetadata(initialized.repositoryRoot);
    const libraryIds = latestPlan.generationRecord.packages
      .filter((record) => record.contributionIdentity === "library")
      .map((record) => record.packageDefinitionId);
    expect(libraryIds).toHaveLength(3);
    expect(new Set(libraryIds).size).toBe(libraryIds.length);
    expect(reloaded.blueprint).toEqual(latestPlan.blueprint);

    const noOp = planGeneratedRepositoryPackageAddition({
      definition: initialized.definition,
      localTemplateMetadata: reloaded,
      packageLeafName: "second-library",
    });
    expect(noOp.operations).toEqual([]);
    expect(noOp.blueprint).toEqual(latestPlan.blueprint);
    expect(noOp.generationRecord).toEqual(latestPlan.generationRecord);
  });

  it("replays the persisted Foundation Package instead of a current scope-derived default", async () => {
    const initialized = await initializedRepository();
    const generationPath = path.join(
      initialized.repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(
      await readFile(generationPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      generationPath,
      `${JSON.stringify(
        { ...generation, defaultPackageScope: "future-scope" },
        null,
        2,
      )}\n`,
    );

    const addition = planGeneratedRepositoryPackageAddition({
      definition: requireSharedLibraryAdditionDefinition({
        ...initialized.context,
        defaultPackageScope: "future-scope",
      }),
      localTemplateMetadata: loadLocalTemplateMetadata(
        initialized.repositoryRoot,
      ),
      packageLeafName: "after-foundation-default-change",
    });

    expect(addition.blueprint.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@recorded-scope/typescript-config",
          path: "packages/typescript-config",
        }),
        expect.objectContaining({
          name: "@future-scope/after-foundation-default-change",
        }),
      ]),
    );
    const typescriptConfigReplacementValues = addition.operations.flatMap(
      (operation) =>
        operation.kind === "writeTextTemplate" &&
        Object.hasOwn(operation.replacements, "TYPESCRIPT_CONFIG_PACKAGE")
          ? [operation.replacements.TYPESCRIPT_CONFIG_PACKAGE]
          : [],
    );
    expect(typescriptConfigReplacementValues).not.toContain(
      "@future-scope/typescript-config",
    );
    expect(typescriptConfigReplacementValues).toContain(
      "@recorded-scope/typescript-config",
    );
  });

  it("uses the persisted Foundation Package name before replay constructs TypeScript package operations", async () => {
    const initialized = await initializedRepository();
    const blueprintPath = path.join(
      initialized.repositoryRoot,
      ".template/blueprint.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      packages: Record<string, unknown>[];
    } & Record<string, unknown>;
    const foundationPackage = blueprint.packages.find(
      (item) => item.path === "packages/typescript-config",
    )!;
    const persistedPackageName = "@recorded-scope/project-typescript-config";
    foundationPackage.name = persistedPackageName;
    await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
    const foundationManifestPath = path.join(
      initialized.repositoryRoot,
      "packages/typescript-config/package.json",
    );
    const foundationManifest = JSON.parse(
      await readFile(foundationManifestPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      foundationManifestPath,
      `${JSON.stringify(
        { ...foundationManifest, name: persistedPackageName },
        null,
        2,
      )}\n`,
    );

    const replayAdapter =
      initialized.definition.packageContributionReplayAdapters[0]!;
    const replay = replayAdapter.replay.bind(replayAdapter);
    let replayedReplacement: string | undefined;
    const replaySpy = vi
      .spyOn(replayAdapter, "replay")
      .mockImplementation((options) => {
        const contribution = replay(options);
        replayedReplacement = contribution.operations.flatMap((operation) =>
          operation.kind === "writeTextTemplate" &&
          typeof operation.replacements.TYPESCRIPT_CONFIG_PACKAGE === "string"
            ? [operation.replacements.TYPESCRIPT_CONFIG_PACKAGE]
            : [],
        )[0];
        return contribution;
      });
    try {
      const metadata = loadLocalTemplateMetadata(initialized.repositoryRoot);
      const addition = planGeneratedRepositoryPackageAddition({
        definition: requireSharedLibraryAdditionDefinition(metadata.context),
        localTemplateMetadata: metadata,
        packageLeafName: "after-foundation-rename",
      });
      const originalPackage = addition.manifests.find(
        (manifest) =>
          manifest.name === initialized.plan.blueprint.packages[0]!.name,
      )!;

      expect(replayedReplacement).toBe(persistedPackageName);
      expect(metadata.context.foundationPackages).toEqual({
        typescriptConfiguration: { name: persistedPackageName },
      });
      expect(originalPackage.devDependencies).toMatchObject({
        [persistedPackageName]: "workspace:*",
      });
    } finally {
      replaySpy.mockRestore();
    }
  });

  it("rejects missing Foundation package-name facts before replay", async () => {
    await expectFoundationProvenanceRejection(
      (record, definition) => ({
        ...record,
        definitionName: definition.metadata.name,
        planningContribution: "planInitialization",
        contributionIdentity: "second-library",
      }),
      "requires exactly one Foundation Package Planning Provenance record; found 0",
    );
  });

  it("rejects contradictory Foundation package-name facts before replay", async () => {
    await expectFoundationProvenanceRejection(
      (record) => ({
        ...record,
        contributionIdentity: "future-typescript-config",
      }),
      "Foundation TypeScript Configuration Package provenance must use contribution identity typescript-config",
    );
  });

  it("rejects a second Foundation planning record before any Preset replay", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const generationPath = path.join(
      initialized.repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: Record<string, unknown>[];
    } & Record<string, unknown>;
    const nonFoundationRecord = generation.packages.find(
      (record) => record.planningContribution !== "foundationPlan",
    )!;
    nonFoundationRecord.planningContribution = "foundationPlan";
    nonFoundationRecord.contributionIdentity = "typescript-config";
    await writeFile(generationPath, `${JSON.stringify(generation, null, 2)}\n`);
    const before = await workspaceByteSnapshot(initialized.repositoryRoot);
    const replaySpies =
      initialized.definition.packageContributionReplayAdapters.map((adapter) =>
        vi.spyOn(adapter, "replay"),
      );

    try {
      expect(() =>
        loadLocalTemplateMetadata(initialized.repositoryRoot),
      ).toThrow(
        "Package Addition requires exactly one Foundation Package Planning Provenance record; found 2",
      );
      for (const replaySpy of replaySpies) {
        expect(replaySpy).not.toHaveBeenCalled();
      }
      expect(await workspaceByteSnapshot(initialized.repositoryRoot)).toEqual(
        before,
      );
    } finally {
      for (const replaySpy of replaySpies) replaySpy.mockRestore();
    }
  });

  it.each([
    {
      name: "a Record-only Foundation/web path swap",
      mutate: (packages: Record<string, unknown>[]) => {
        const foundation = packages.find(
          (record) => record.planningContribution === "foundationPlan",
        )!;
        const web = packages.find(
          (record) => record.contributionIdentity === "web",
        )!;
        const foundationPath = foundation.path;
        foundation.path = web.path;
        web.path = foundationPath;
      },
      message: "Generation Record path witness",
    },
    {
      name: "a late unknown Definition name",
      mutate: (packages: Record<string, unknown>[]) => {
        const record = packages.findLast(
          (candidate) => candidate.planningContribution !== "foundationPlan",
        )!;
        record.planningContribution = "planPackageAddition";
        record.definitionName = "future-preset";
      },
      message: "references unknown Built-in Preset future-preset",
    },
    {
      name: "a late unknown contribution identity",
      mutate: (packages: Record<string, unknown>[]) => {
        const record = packages.findLast(
          (candidate) => candidate.planningContribution !== "foundationPlan",
        )!;
        record.contributionIdentity = "future-contribution";
      },
      message:
        "unknown Package Contribution replay adapter future-contribution",
    },
  ])(
    "rejects $name before any persisted Package replay",
    async ({ mutate, message }) => {
      const initialized = await initializedRepository(
        requireMultiPackageDefinition,
      );
      const generationPath = path.join(
        initialized.repositoryRoot,
        ".template/generation.json",
      );
      const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
        packages: Record<string, unknown>[];
      } & Record<string, unknown>;
      mutate(generation.packages);
      await writeFile(
        generationPath,
        `${JSON.stringify(generation, null, 2)}\n`,
      );
      const before = await workspaceByteSnapshot(initialized.repositoryRoot);
      const replaySpies =
        initialized.definition.packageContributionReplayAdapters.map(
          (adapter) => vi.spyOn(adapter, "replay"),
        );

      try {
        let caught: unknown;
        try {
          loadLocalTemplateMetadata(initialized.repositoryRoot);
        } catch (error) {
          caught = error;
        }
        for (const replaySpy of replaySpies) {
          expect(replaySpy).not.toHaveBeenCalled();
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain(message);
        expect(await workspaceByteSnapshot(initialized.repositoryRoot)).toEqual(
          before,
        );
      } finally {
        for (const replaySpy of replaySpies) replaySpy.mockRestore();
      }
    },
  );

  it("uses the Foundation replay adapter for unknown persisted contribution diagnostics", async () => {
    const initialized = await initializedRepository();
    const generationPath = path.join(
      initialized.repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: Record<string, unknown>[];
    } & Record<string, unknown>;
    const packageRecord = generation.packages.find(
      (record) => record.planningContribution !== "foundationPlan",
    )!;
    packageRecord.contributionIdentity = "future-library";
    await writeFile(generationPath, `${JSON.stringify(generation, null, 2)}\n`);

    expect(() => loadLocalTemplateMetadata(initialized.repositoryRoot)).toThrow(
      "unknown Package Contribution replay adapter future-library; expected library",
    );
  });

  it("uses stable multi-Package contribution identities when link topology changes", async () => {
    const initialized = await initializedRepository((context) => {
      const definition = builtInPresetRegistry
        .all()
        .find((candidate) => candidate.blueprint(context).packages.length > 2);
      if (definition === undefined)
        throw new Error("Expected multi-Package Definition");
      return definition;
    });
    const blueprintPath = path.join(
      initialized.repositoryRoot,
      ".template/blueprint.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      packageLinkIntents: {
        consumerPackagePath: string;
        providerPackagePath: string;
      }[];
    } & Record<string, unknown>;
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          ...blueprint,
          packageLinkIntents: [],
        },
        null,
        2,
      )}\n`,
    );

    const addition = planGeneratedRepositoryPackageAddition({
      definition: requireSharedLibraryAdditionDefinition(initialized.context),
      localTemplateMetadata: loadLocalTemplateMetadata(
        initialized.repositoryRoot,
      ),
      packageLeafName: "after-topology-change",
    });
    const manifestsByName = new Map(
      addition.manifests.flatMap((manifest) =>
        typeof manifest.name === "string" ? [[manifest.name, manifest]] : [],
      ),
    );

    expect(manifestsByName.get("@recorded-scope/db")).toMatchObject({
      scripts: {
        "db:seed:example": "node --conditions=source scripts/seed-example.ts",
      },
    });
    expect(manifestsByName.get("@recorded-scope/db-migrations")).toMatchObject({
      scripts: {
        "db:migrate":
          "DATABASE_PACKAGE_NAME=@recorded-scope/db drizzle-kit migrate",
      },
    });
  });

  it("rejects an added contribution relabeled as initialization without writes", async () => {
    const initialized = await initializedRepository();
    const addition = planGeneratedRepositoryPackageAddition({
      definition: requireSharedLibraryAdditionDefinition(initialized.context),
      localTemplateMetadata: loadLocalTemplateMetadata(
        initialized.repositoryRoot,
      ),
      packageLeafName: "added-before-tamper",
    });
    const applied = await reconcileAndApplyProjectProjections({
      targetRoot: initialized.repositoryRoot,
      ...addition.projectProjections,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    const generationPath = path.join(
      initialized.repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: Record<string, unknown>[];
    } & Record<string, unknown>;
    generation.packages.at(-1)!.planningContribution = "planInitialization";
    await writeFile(generationPath, `${JSON.stringify(generation, null, 2)}\n`);
    const before = await workspaceByteSnapshot(initialized.repositoryRoot);

    expect(() => loadLocalTemplateMetadata(initialized.repositoryRoot)).toThrow(
      "duplicate initialization contribution identity",
    );
    expect(await workspaceByteSnapshot(initialized.repositoryRoot)).toEqual(
      before,
    );
  });

  it.each([
    {
      name: "the previous Blueprint schema",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        schemaVersion: 2,
      }),
      message: "expected 3",
    },
    {
      name: "the previous Generation Record schema",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        schemaVersion: 1,
      }),
      message: "expected 2",
    },
    {
      name: "a missing repository identity",
      file: "generation" as const,
      mutate: ({
        repositoryName: _removed,
        ...value
      }: Record<string, unknown>) => value,
      message: "repositoryName must be a non-empty string",
    },
    {
      name: "a whitespace repository identity",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        repositoryName: " invalid ",
      }),
      message: "repositoryName must be a non-empty string",
    },
    {
      name: "a missing preset",
      file: "generation" as const,
      mutate: ({ preset: _removed, ...value }: Record<string, unknown>) =>
        value,
      message: "preset must be a non-empty string",
    },
    {
      name: "a missing template version",
      file: "generation" as const,
      mutate: ({
        templateVersion: _removed,
        ...value
      }: Record<string, unknown>) => value,
      message: "templateVersion must be 0.0.0",
    },
    {
      name: "an invalid Node major",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        toolchain: {
          ...(value.toolchain as Record<string, unknown>),
          nodeLtsMajor: "current",
        },
      }),
      message: "toolchain.nodeLtsMajor must be a numeric Node major",
    },
    {
      name: "a missing package-manager pin",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => {
        const { packageManagerPin: _removed, ...toolchain } =
          value.toolchain as Record<string, unknown>;
        return { ...value, toolchain };
      },
      message: "toolchain.packageManagerPin must be an exact pnpm version pin",
    },
    {
      name: "a missing package Definition name",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) => {
            if (index !== 0) return record;
            const { definitionName: _removed, ...rest } = record;
            return rest;
          },
        ),
      }),
      message: "packages[0].definitionName must be a non-empty string",
    },
    {
      name: "a missing Generation Record Package Definition ID",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) => {
            if (index !== 0) return record;
            const { packageDefinitionId: _removed, ...rest } = record;
            return rest;
          },
        ),
      }),
      message:
        "packages[0].packageDefinitionId must use the package-<sha256> format",
    },
    {
      name: "an invalid Generation Record Package Definition ID",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) =>
            index === 0
              ? { ...record, packageDefinitionId: "package-short" }
              : record,
        ),
      }),
      message:
        "packages[0].packageDefinitionId must use the package-<sha256> format",
    },
    {
      name: "a missing packages collection",
      file: "generation" as const,
      mutate: ({ packages: _removed, ...value }: Record<string, unknown>) =>
        value,
      message: "packages must be an array",
    },
    {
      name: "a missing provenance path",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) => {
            if (index !== 0) return record;
            const { path: _removed, ...rest } = record;
            return rest;
          },
        ),
      }),
      message: "packages[0].path must be a non-empty string",
    },
    {
      name: "a missing provenance kind",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) => {
            if (index !== 0) return record;
            const { planningContribution: _removed, ...rest } = record;
            return rest;
          },
        ),
      }),
      message: "packages[0].planningContribution is unsupported",
    },
    {
      name: "a missing contribution identity",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) => {
            if (index !== 0) return record;
            const { contributionIdentity: _removed, ...rest } = record;
            return rest;
          },
        ),
      }),
      message: "packages[0].contributionIdentity must be a non-empty string",
    },
    {
      name: "an unknown Generation Record field",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        inferredFromWorkspace: true,
      }),
      message: "contains unknown field: inferredFromWorkspace",
    },
    {
      name: "an unknown nested toolchain field",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        toolchain: {
          ...(value.toolchain as Record<string, unknown>),
          inferredFromManifest: true,
        },
      }),
      message:
        "toolchain.inferredFromManifest: contains unknown Generation Record field",
    },
    {
      name: "an unknown nested provenance field",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) =>
            index === 0 ? { ...record, inferredFromWorkspace: true } : record,
        ),
      }),
      message:
        "packages[0].inferredFromWorkspace: contains unknown Generation Record field",
    },
    {
      name: "an unknown Generation Record Package Definition ID field",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) =>
            index === 0
              ? { ...record, packageDefinitionIdentity: "legacy-id" }
              : record,
        ),
      }),
      message:
        "packages[0].packageDefinitionIdentity: contains unknown Generation Record field",
    },
    {
      name: "an unknown Blueprint field",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        inferredFromManifest: true,
      }),
      message: "Unknown Blueprint v3 field",
    },
    {
      name: "a missing Blueprint Package Definition ID",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (definition, index) => {
            if (index !== 0) return definition;
            const { packageDefinitionId: _removed, ...rest } = definition;
            return rest;
          },
        ),
      }),
      message: "Package Definition ID must use the package-<sha256> format",
    },
    {
      name: "an invalid Blueprint Package Definition ID",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (definition, index) =>
            index === 0
              ? { ...definition, packageDefinitionId: "package-short" }
              : definition,
        ),
      }),
      message: "Package Definition ID must use the package-<sha256> format",
    },
    {
      name: "an unknown Blueprint Package Definition ID field",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (definition, index) =>
            index === 0
              ? { ...definition, packageDefinitionIdentity: "legacy-id" }
              : definition,
        ),
      }),
      message: ".packages[0].packageDefinitionIdentity",
    },
    {
      name: "duplicate Blueprint Package Definitions",
      file: "blueprint" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: [
          ...((value.packages as readonly Record<string, unknown>[]) ?? []),
          (value.packages as readonly Record<string, unknown>[])[0],
        ],
      }),
      message: "Package Definition ID must be unique",
    },
    {
      name: "duplicate Package Planning Provenance",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: [
          ...((value.packages as readonly Record<string, unknown>[]) ?? []),
          (value.packages as readonly Record<string, unknown>[])[0],
        ],
      }),
      message: "packages packageDefinitionId must be unique",
    },
    {
      name: "a Blueprint and Generation Record Package Definition ID set mismatch",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) =>
            index === 0
              ? { ...record, packageDefinitionId: `package-${"f".repeat(64)}` }
              : record,
        ),
      }),
      message: "has no matching Project Blueprint Package Definition",
    },
    {
      name: "a Blueprint and Generation Record Package Definition ID-only swap",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => {
        const packages = [
          ...(value.packages as readonly Record<string, unknown>[]),
        ];
        const firstId = packages[0]!.packageDefinitionId;
        packages[0] = {
          ...packages[0],
          packageDefinitionId: packages[1]!.packageDefinitionId,
        };
        packages[1] = {
          ...packages[1],
          packageDefinitionId: firstId,
        };
        return { ...value, packages };
      },
      message: "Generation Record path witness",
    },
    {
      name: "Blueprint and provenance path mismatch",
      file: "generation" as const,
      mutate: (value: Record<string, unknown>) => ({
        ...value,
        packages: (value.packages as readonly Record<string, unknown>[]).map(
          (record, index) =>
            index === 0 ? { ...record, path: "packages/missing" } : record,
        ),
      }),
      message: "Generation Record path witness",
    },
  ])("fails closed on $name without rewriting metadata", async (scenario) => {
    const initialized = await initializedRepository();
    const filePath = path.join(
      initialized.repositoryRoot,
      ".template",
      `${scenario.file}.json`,
    );
    const value = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      filePath,
      `${JSON.stringify(scenario.mutate(value), null, 2)}\n`,
    );
    const before = await workspaceByteSnapshot(initialized.repositoryRoot);

    const replaySpies =
      initialized.definition.packageContributionReplayAdapters.map((adapter) =>
        vi.spyOn(adapter, "replay"),
      );
    try {
      expect(() =>
        loadLocalTemplateMetadata(initialized.repositoryRoot),
      ).toThrow(scenario.message);
      for (const replaySpy of replaySpies) {
        expect(replaySpy).not.toHaveBeenCalled();
      }
      expect(await workspaceByteSnapshot(initialized.repositoryRoot)).toEqual(
        before,
      );
    } finally {
      for (const replaySpy of replaySpies) replaySpy.mockRestore();
    }
  });
});
