import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

afterEach(() => mock.restoreAll());

const toolchain = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.21.0",
} as const;

type FixedTopologyDefinition = Exclude<
  BuiltInPresetDefinition,
  { readonly initialPrimaryPackage: object }
>;

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
    .find(
      (candidate): candidate is FixedTopologyDefinition =>
        candidate.initialPrimaryPackage === undefined &&
        candidate.blueprint(context).packages.length > 2,
    );
  if (definition === undefined) {
    throw new Error("Expected a multi-Package Definition");
  }
  return definition;
}

async function initializedRepository(
  selectDefinition: (
    context: BuiltInGenerationContext,
  ) => BuiltInPresetDefinition = requireSharedLibraryAdditionDefinition,
  contextToolchain: BuiltInGenerationContext["toolchain"] = toolchain,
) {
  const parent = await mkdtemp(path.join(tmpdir(), "template-metadata-"));
  const repositoryRoot = path.join(parent, "recorded-repository");
  const context = createGenerationContext({
    targetDir: repositoryRoot,
    defaultPackageScope: "recorded-scope",
    toolchain: contextToolchain,
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
  const replaySpy = mock.method(
    initialized.definition.packageContributionReplayAdapters[0]!,
    "replay",
  );
  try {
    assert.throws(
      () => loadLocalTemplateMetadata(initialized.repositoryRoot),
      (error: unknown) =>
        error instanceof Error && error.message.includes(message),
    );
    assert.strictEqual(replaySpy.mock.callCount(), 0);
    assert.strictEqual(
      await readFile(
        path.join(initialized.repositoryRoot, ".template/blueprint.json"),
        "utf8",
      ),
      metadataBeforeLoad.blueprint,
    );
    assert.strictEqual(
      await readFile(generationPath, "utf8"),
      metadataBeforeLoad.generation,
    );
  } finally {
    replaySpy.mock.restore();
  }
}

void describe("Local Template Metadata", () => {
  void it("assigns deterministic opaque Package Definition IDs during initialization", async () => {
    const initialized = await initializedRepository();
    const repeatedPlan = planGeneratedRepositoryInitialization({
      definition: initialized.definition,
      context: initialized.context,
    });
    const blueprintIds = initialized.plan.blueprint.packages.map(
      (definition) => definition.packageDefinitionId,
    );

    for (const packageDefinitionId of blueprintIds) {
      assert.ok(/^package-[a-f0-9]{64}$/u.test(packageDefinitionId));
    }
    assert.strictEqual(new Set(blueprintIds).size, blueprintIds.length);
    assert.deepStrictEqual(repeatedPlan.blueprint, initialized.plan.blueprint);
    assert.deepStrictEqual(
      initialized.plan.generationRecord.packages
        .map((record) => ({
          packageDefinitionId: record.packageDefinitionId,
          path: record.path,
        }))
        .toSorted((left, right) =>
          left.packageDefinitionId.localeCompare(right.packageDefinitionId),
        ),
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

  void it("keeps deterministic Package Definition IDs independent of Preset plan ordering", () => {
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

    assert.deepStrictEqual(idsByPath(reordered), idsByPath(original));
  });

  void it("rebuilds Generation Context from persisted repository facts after the directory is renamed", async () => {
    const initialized = await initializedRepository();
    const renamedRoot = path.join(initialized.parent, "renamed-directory");
    await rename(initialized.repositoryRoot, renamedRoot);

    const metadata = loadLocalTemplateMetadata(renamedRoot);

    assert.deepStrictEqual(metadata.blueprint, initialized.plan.blueprint);
    assert.deepStrictEqual(metadata.context, {
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

  void it("uses controlled Package Definition name, path, role, and provenance changes as the source of truth for the next addition", async () => {
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
    assert.deepStrictEqual(
      addition.blueprint.packages.find(
        ({ packageDefinitionId }) =>
          packageDefinitionId === newDefinition.packageDefinitionId,
      ),
      newDefinition,
    );
    assert.ok(
      addition.blueprint.packages.some(
        (definition) =>
          Object.hasOwn(definition, "name") &&
          definition.name === "@recorded-scope/utilities" &&
          Object.hasOwn(definition, "path") &&
          definition.path === "packages/utilities",
      ),
    );
  });

  for (const role of ["cli-tool", "native-package"] as const) {
    void it(`replays persisted ${role} provenance without consulting current Preset defaults`, async () => {
      // cli-tool 探测会直接规划新建公开 ts-cli 候选，初始化上下文需要快照精确值；
      // 持久化记录仍只含大版本，加包 replay 保持缺省兼容。
      const initialized = await initializedRepository(
        (context) => {
          const definition = builtInPresetRegistry.all().find((candidate) => {
            const contributions = planGeneratedRepositoryInitialization({
              definition: candidate,
              context,
            }).packageContributions;
            return (
              contributions.length === 1 &&
              contributions[0]?.definition.role === role
            );
          });
          if (definition === undefined) {
            throw new Error(`Expected a single-Package ${role} Definition`);
          }
          return definition;
        },
        role === "cli-tool"
          ? {
              ...toolchain,
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            }
          : toolchain,
      );
      if (initialized.definition.initialPrimaryPackage === undefined) {
        throw new Error(`Expected configurable ${role} Definition`);
      }
      const defaultReplay = mock.method(
        initialized.definition.initialPrimaryPackage,
        "planInitialContribution",
        () => {
          throw new Error("current Preset default must not be replayed");
        },
      );
      try {
        assert.doesNotThrow(() =>
          planGeneratedRepositoryPackageAddition({
            definition: requireSharedLibraryAdditionDefinition(
              initialized.context,
            ),
            localTemplateMetadata: loadLocalTemplateMetadata(
              initialized.repositoryRoot,
            ),
            packageLeafName: `after-${role}`,
          }),
        );
      } finally {
        defaultReplay.mock.restore();
      }
    });
  }

  void it("replays persisted multi-Package provenance without consulting current Preset defaults", async () => {
    const initialized = await initializedRepository((context) => {
      const definition = builtInPresetRegistry
        .all()
        .find(
          (candidate) =>
            candidate.initialPrimaryPackage === undefined &&
            candidate.blueprint(context).packages.length > 2,
        );
      if (definition === undefined) {
        throw new Error("Expected a multi-Package Definition");
      }
      return definition;
    });
    mock.method(
      initialized.definition as unknown as {
        planInitialization: Function;
      },
      "planInitialization",
      () => {
        throw new Error("current Preset default must not be replayed");
      },
    );
    mock.method(
      initialized.definition as unknown as {
        planInitializationContributions: Function;
      },
      "planInitializationContributions",
      () => {
        throw new Error("current Preset default set must not be replayed");
      },
    );
    try {
      assert.doesNotThrow(() =>
        planGeneratedRepositoryPackageAddition({
          definition: requireSharedLibraryAdditionDefinition(
            initialized.context,
          ),
          localTemplateMetadata: loadLocalTemplateMetadata(
            initialized.repositoryRoot,
          ),
          packageLeafName: "after-multi-package",
        }),
      );
    } finally {
      mock.restoreAll();
    }
  });

  void it("replays every persisted multi-Package contribution exactly once after preflight", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const replaySpies =
      initialized.definition.packageContributionReplayAdapters.map((adapter) =>
        mock.method(adapter, "replay"),
      );

    try {
      loadLocalTemplateMetadata(initialized.repositoryRoot);

      for (const replaySpy of replaySpies) {
        assert.strictEqual(replaySpy.mock.callCount(), 1);
        assert.ok(
          !Object.hasOwn(
            (replaySpy.mock.calls[0]!.arguments[0]!.packageDefinition ??
              {}) as object,
            "packageDefinitionId",
          ),
        );
      }
    } finally {
      for (const replaySpy of replaySpies) replaySpy.mock.restore();
    }
  });

  void it("keeps opaque IDs stable across reload and no-op while repeated adapter additions receive unique IDs", async () => {
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
    assert.strictEqual(libraryIds.length, 3);
    assert.strictEqual(new Set(libraryIds).size, libraryIds.length);
    assert.deepStrictEqual(reloaded.blueprint, latestPlan.blueprint);

    const noOp = planGeneratedRepositoryPackageAddition({
      definition: initialized.definition,
      localTemplateMetadata: reloaded,
      packageLeafName: "second-library",
    });
    assert.deepStrictEqual(noOp.operations, []);
    assert.deepStrictEqual(noOp.blueprint, latestPlan.blueprint);
    assert.deepStrictEqual(noOp.generationRecord, latestPlan.generationRecord);
  });

  void it("replays the persisted Foundation Package instead of a current scope-derived default", async () => {
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

    assert.ok(
      addition.blueprint.packages.some(
        (definition) =>
          Object.hasOwn(definition, "name") &&
          definition.name === "@recorded-scope/typescript-config" &&
          Object.hasOwn(definition, "path") &&
          definition.path === "packages/typescript-config",
      ),
    );
    assert.ok(
      addition.blueprint.packages.some(
        (definition) =>
          Object.hasOwn(definition, "name") &&
          definition.name === "@future-scope/after-foundation-default-change",
      ),
    );
    const typescriptConfigReplacementValues = addition.operations.flatMap(
      (operation) =>
        operation.kind === "writeTextTemplate" &&
        Object.hasOwn(operation.replacements, "TYPESCRIPT_CONFIG_PACKAGE")
          ? [operation.replacements.TYPESCRIPT_CONFIG_PACKAGE]
          : [],
    );
    assert.ok(
      !typescriptConfigReplacementValues.includes(
        "@future-scope/typescript-config",
      ),
    );
    assert.ok(
      typescriptConfigReplacementValues.includes(
        "@recorded-scope/typescript-config",
      ),
    );
  });

  void it("uses the persisted Foundation Package name before replay constructs TypeScript package operations", async () => {
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
    const replaySpy = mock.method(
      replayAdapter,
      "replay",
      (options: Parameters<typeof replayAdapter.replay>[0]) => {
        const contribution = replay(options);
        replayedReplacement = contribution.operations.flatMap((operation) =>
          operation.kind === "writeTextTemplate" &&
          typeof operation.replacements.TYPESCRIPT_CONFIG_PACKAGE === "string"
            ? [operation.replacements.TYPESCRIPT_CONFIG_PACKAGE]
            : [],
        )[0];
        return contribution;
      },
    );
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

      assert.strictEqual(replayedReplacement, persistedPackageName);
      assert.deepStrictEqual(metadata.context.foundationPackages, {
        typescriptConfiguration: { name: persistedPackageName },
      });
      assert.partialDeepStrictEqual(originalPackage.devDependencies, {
        [persistedPackageName]: "workspace:*",
      });
    } finally {
      replaySpy.mock.restore();
    }
  });

  void it("rejects missing Foundation package-name facts before replay", async () => {
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

  void it("rejects contradictory Foundation package-name facts before replay", async () => {
    await expectFoundationProvenanceRejection(
      (record) => ({
        ...record,
        contributionIdentity: "future-typescript-config",
      }),
      "Foundation TypeScript Configuration Package provenance must use contribution identity typescript-config",
    );
  });

  void it("rejects a second Foundation planning record before any Preset replay", async () => {
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
        mock.method(adapter, "replay"),
      );

    try {
      assert.throws(
        () => loadLocalTemplateMetadata(initialized.repositoryRoot),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Package Addition requires exactly one Foundation Package Planning Provenance record; found 2",
          ),
      );
      for (const replaySpy of replaySpies) {
        assert.strictEqual(replaySpy.mock.callCount(), 0);
      }
      assert.deepStrictEqual(
        await workspaceByteSnapshot(initialized.repositoryRoot),
        before,
      );
    } finally {
      for (const replaySpy of replaySpies) replaySpy.mock.restore();
    }
  });

  for (const scenario of [
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
  ]) {
    void it(`rejects ${scenario.name} before any persisted Package replay`, async () => {
      const { mutate, message } = scenario;
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
          (adapter) => mock.method(adapter, "replay"),
        );

      try {
        let caught: unknown;
        try {
          loadLocalTemplateMetadata(initialized.repositoryRoot);
        } catch (error) {
          caught = error;
        }
        for (const replaySpy of replaySpies) {
          assert.strictEqual(replaySpy.mock.callCount(), 0);
        }
        assert.ok(caught instanceof Error);
        assert.ok((caught as Error).message.includes(message));
        assert.deepStrictEqual(
          await workspaceByteSnapshot(initialized.repositoryRoot),
          before,
        );
      } finally {
        for (const replaySpy of replaySpies) replaySpy.mock.restore();
      }
    });
  }

  void it("uses the Foundation replay adapter for unknown persisted contribution diagnostics", async () => {
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

    assert.throws(
      () => loadLocalTemplateMetadata(initialized.repositoryRoot),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "unknown Package Contribution replay adapter future-library; expected library",
        ),
    );
  });

  void it("uses stable multi-Package contribution identities when link topology changes", async () => {
    const initialized = await initializedRepository((context) => {
      const definition = builtInPresetRegistry
        .all()
        .find(
          (candidate) =>
            candidate.initialPrimaryPackage === undefined &&
            candidate.blueprint(context).packages.length > 2,
        );
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

    assert.partialDeepStrictEqual(manifestsByName.get("@recorded-scope/db"), {
      scripts: {
        "db:seed:example": "node --conditions=source scripts/seed-example.ts",
      },
    });
    assert.partialDeepStrictEqual(
      manifestsByName.get("@recorded-scope/db-migrations"),
      {
        scripts: {
          "db:migrate": "drizzle-kit migrate",
        },
      },
    );
  });

  void it("rejects changed database preparation leaf commands before Package Addition", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const manifestPath = path.join(
      initialized.repositoryRoot,
      "packages/db-migrations/package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["db:push"] = "drizzle-kit push --force";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await workspaceByteSnapshot(initialized.repositoryRoot);

    assert.throws(
      () =>
        planGeneratedRepositoryPackageAddition({
          definition: requireSharedLibraryAdditionDefinition(
            initialized.context,
          ),
          localTemplateMetadata: loadLocalTemplateMetadata(
            initialized.repositoryRoot,
          ),
          packageLeafName: "after-command-change",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Database Preparation requires exact @recorded-scope/db-migrations script db:push",
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      before,
    );
  });

  void it("rejects a missing database provider ordering edge before Package Addition", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const deploymentCheck = initialized.plan.deploymentCheck;
    if (deploymentCheck === undefined) {
      throw new Error("Expected a deployment-capable multi-Package Definition");
    }
    const taskName = `${deploymentCheck.applicationPackageName}#typecheck`;
    const turboPath = path.join(initialized.repositoryRoot, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    const task = turbo.tasks[taskName];
    if (task === undefined) throw new Error(`Expected Turbo task ${taskName}`);
    task.dependsOn = [];
    await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
    const before = await workspaceByteSnapshot(initialized.repositoryRoot);

    assert.throws(
      () =>
        planGeneratedRepositoryPackageAddition({
          definition: requireSharedLibraryAdditionDefinition(
            initialized.context,
          ),
          localTemplateMetadata: loadLocalTemplateMetadata(
            initialized.repositoryRoot,
          ),
          packageLeafName: "after-turbo-change",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition root Turbo Truth requires Turbo task ${taskName} dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      before,
    );
  });

  void it("rejects capability truth overrides while preserving compatible consumer Turbo customizations", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const deploymentCheck = initialized.plan.deploymentCheck;
    if (deploymentCheck === undefined) {
      throw new Error("Expected a deployment-capable multi-Package Definition");
    }
    const packagePath = (packageName: string) => {
      const definition = initialized.plan.blueprint.packages.find(
        (candidate) => candidate.name === packageName,
      );
      if (definition === undefined) {
        throw new Error(`Expected Package ${packageName}`);
      }
      return definition.path;
    };
    const databaseName = deploymentCheck.databasePackageName;
    const applicationName = deploymentCheck.applicationPackageName;
    const applicationPath = packagePath(applicationName);
    const databasePath = packagePath(databaseName);
    const addPackage = () =>
      planGeneratedRepositoryPackageAddition({
        definition: requireSharedLibraryAdditionDefinition(initialized.context),
        localTemplateMetadata: loadLocalTemplateMetadata(
          initialized.repositoryRoot,
        ),
        packageLeafName: "after-capability-truth-change",
      });

    const applicationTurboPath = path.join(
      initialized.repositoryRoot,
      applicationPath,
      "turbo.json",
    );
    const applicationTurbo = JSON.parse(
      await readFile(applicationTurboPath, "utf8"),
    ) as Record<string, unknown> & { tasks: Record<string, unknown> };
    applicationTurbo.extends = ["//", "../additional-turbo-base"];
    await writeFile(
      applicationTurboPath,
      `${JSON.stringify(applicationTurbo, null, 2)}\n`,
    );
    const packageExtendsBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${applicationName} Turbo Truth requires exact Turbo extends truth`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      packageExtendsBefore,
    );

    applicationTurbo.extends = ["//"];
    applicationTurbo.tasks.typecheck = { extends: false };
    await writeFile(
      applicationTurboPath,
      `${JSON.stringify(applicationTurbo, null, 2)}\n`,
    );
    const turboBefore = await workspaceByteSnapshot(initialized.repositoryRoot);

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${applicationName} Turbo Truth requires Turbo task typecheck dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      turboBefore,
    );

    applicationTurbo.tasks.typecheck = {
      dependsOn: [`${databaseName}#build`, "user:preflight"],
    };
    applicationTurbo.tasks["test:e2e"] = { extends: false };
    await writeFile(
      applicationTurboPath,
      `${JSON.stringify(applicationTurbo, null, 2)}\n`,
    );
    const e2eBefore = await workspaceByteSnapshot(initialized.repositoryRoot);

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${applicationName} Turbo Truth requires Turbo task test:e2e dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      e2eBefore,
    );

    delete applicationTurbo.tasks["test:e2e"];
    await writeFile(
      applicationTurboPath,
      `${JSON.stringify(applicationTurbo, null, 2)}\n`,
    );

    applicationTurbo.tasks["user:report"] = { cache: false };
    await writeFile(
      applicationTurboPath,
      `${JSON.stringify(applicationTurbo, null, 2)}\n`,
    );

    const vitePath = path.join(
      initialized.repositoryRoot,
      applicationPath,
      "vite.config.ts",
    );
    await writeFile(
      vitePath,
      [
        'import { defineConfig } from "vite";',
        "",
        "export default defineConfig({",
        `  ssr: { external: ["${databaseName}"] },`,
        "  ...{ ssr: { noExternal: true } },",
        "});",
        "",
      ].join("\n"),
    );
    const viteBefore = await workspaceByteSnapshot(initialized.repositoryRoot);

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition requires ${applicationPath}/vite.config.ts to externalize ${databaseName} through Vite SSR`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      viteBefore,
    );

    await writeFile(
      vitePath,
      [
        'import { defineConfig } from "vite";',
        "",
        "export default defineConfig({",
        '  ...{ resolve: { conditions: ["source"] } },',
        `  ssr: { external: ["${databaseName}"] },`,
        "});",
        "",
      ].join("\n"),
    );

    const databaseManifestPath = path.join(
      initialized.repositoryRoot,
      databasePath,
      "package.json",
    );
    const databaseManifest = JSON.parse(
      await readFile(databaseManifestPath, "utf8"),
    ) as {
      exports: Record<string, Record<string, string>>;
      imports: Record<string, Record<string, string>>;
    };
    databaseManifest.exports["."] = {
      default: "./dist/index.js",
      source: "./src/index.ts",
      types: "./dist/index.d.ts",
    };
    await writeFile(
      databaseManifestPath,
      `${JSON.stringify(databaseManifest, null, 2)}\n`,
    );
    const exportsBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Database Preparation ${databaseName} exports . must preserve replayed condition order`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      exportsBefore,
    );

    databaseManifest.exports["."] = {
      source: "./src/index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    };
    databaseManifest.imports["#db/*"] = {
      default: "./dist/*.js",
      source: "./src/*.ts",
      types: "./dist/*.d.ts",
    };
    await writeFile(
      databaseManifestPath,
      `${JSON.stringify(databaseManifest, null, 2)}\n`,
    );
    const conditionBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Database Preparation ${databaseName} imports #db/* must preserve replayed condition order`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      conditionBefore,
    );

    databaseManifest.imports["#db/*"] = {
      source: "./src/*.ts",
      types: "./dist/*.d.ts",
      default: "./dist/*.js",
    };
    await writeFile(
      databaseManifestPath,
      `${JSON.stringify(databaseManifest, null, 2)}\n`,
    );
    const acceptedAddition = addPackage();
    assert.partialDeepStrictEqual(
      await reconcileAndApplyProjectProjections({
        targetRoot: initialized.repositoryRoot,
        ...acceptedAddition.projectProjections,
      }),
      { ok: true },
    );
    const updatedTurbo = JSON.parse(
      await readFile(applicationTurboPath, "utf8"),
    ) as {
      tasks: {
        typecheck: { dependsOn: string[] };
        "user:report": { cache: boolean };
      };
    };
    assert.deepStrictEqual(updatedTurbo.tasks.typecheck.dependsOn, [
      `${databaseName}#build`,
      "user:preflight",
    ]);
    assert.partialDeepStrictEqual(updatedTurbo, {
      tasks: { "user:report": { cache: false } },
    });
  });

  void it("在 Package Addition 前拒绝破坏 consumer build 有效数据库排序，同时保留等价定制", async () => {
    const initialized = await initializedRepository(
      requireMultiPackageDefinition,
    );
    const deploymentCheck = initialized.plan.deploymentCheck;
    if (deploymentCheck === undefined) {
      throw new Error("Expected a deployment-capable multi-Package Definition");
    }
    const packagePath = (packageName: string) => {
      const definition = initialized.plan.blueprint.packages.find(
        (candidate) => candidate.name === packageName,
      );
      if (definition === undefined) {
        throw new Error(`Expected Package ${packageName}`);
      }
      return definition.path;
    };
    const databaseName = deploymentCheck.databasePackageName;
    const migrationName = deploymentCheck.migrationPackageName;
    const applicationName = deploymentCheck.applicationPackageName;
    const migrationTurboPath = path.join(
      initialized.repositoryRoot,
      packagePath(migrationName),
      "turbo.json",
    );
    const applicationTurboPath = path.join(
      initialized.repositoryRoot,
      packagePath(applicationName),
      "turbo.json",
    );
    const rootTurboPath = path.join(initialized.repositoryRoot, "turbo.json");
    const addPackage = () =>
      planGeneratedRepositoryPackageAddition({
        definition: requireSharedLibraryAdditionDefinition(initialized.context),
        localTemplateMetadata: loadLocalTemplateMetadata(
          initialized.repositoryRoot,
        ),
        packageLeafName: "after-build-truth-change",
      });
    const readTurbo = async (turboPath: string) =>
      JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<
          string,
          { dependsOn?: string[]; extends?: boolean; outputs?: string[] }
        >;
      };
    const writeTurbo = async (
      turboPath: string,
      turbo: { tasks: Record<string, unknown> },
    ) => writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

    const rootTurbo = await readTurbo(rootTurboPath);
    rootTurbo.tasks.build = { dependsOn: [] };
    await writeTurbo(rootTurboPath, rootTurbo);
    const rootGenericBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${applicationName} Turbo Truth requires Turbo task build dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      rootGenericBefore,
    );

    rootTurbo.tasks.build = { dependsOn: ["^build"] };
    rootTurbo.tasks[`${migrationName}#build`] = { outputs: [] };
    await writeTurbo(rootTurboPath, rootTurbo);
    const migrationTurbo = await readTurbo(migrationTurboPath);
    delete migrationTurbo.tasks.build?.dependsOn;
    await writeTurbo(migrationTurboPath, migrationTurbo);
    const qualifiedBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${migrationName} Turbo Truth requires Turbo task build dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      qualifiedBefore,
    );

    rootTurbo.tasks[`${migrationName}#build`] = {
      dependsOn: [`${databaseName}#build`],
      outputs: [],
    };
    await writeTurbo(rootTurboPath, rootTurbo);
    assert.doesNotThrow(addPackage);

    delete rootTurbo.tasks[`${migrationName}#build`];
    migrationTurbo.tasks.build = { extends: false, outputs: [] };
    await writeTurbo(rootTurboPath, rootTurbo);
    await writeTurbo(migrationTurboPath, migrationTurbo);
    const migrationResetBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${migrationName} Turbo Truth requires Turbo task build dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      migrationResetBefore,
    );

    migrationTurbo.tasks.build = { dependsOn: [] };
    await writeTurbo(rootTurboPath, rootTurbo);
    await writeTurbo(migrationTurboPath, migrationTurbo);
    const migrationOverrideBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${migrationName} Turbo Truth requires Turbo task build dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      migrationOverrideBefore,
    );

    migrationTurbo.tasks.build = {
      dependsOn: [`${databaseName}#build`, "user:preflight"],
      outputs: [],
    };
    const applicationTurbo = await readTurbo(applicationTurboPath);
    applicationTurbo.tasks.build = {
      dependsOn: [],
      outputs: ["dist/**"],
    };
    await writeTurbo(migrationTurboPath, migrationTurbo);
    await writeTurbo(applicationTurboPath, applicationTurbo);
    const applicationOverrideBefore = await workspaceByteSnapshot(
      initialized.repositoryRoot,
    );

    assert.throws(
      addPackage,
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Package Addition ${applicationName} Turbo Truth requires Turbo task build dependsOn`,
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      applicationOverrideBefore,
    );

    applicationTurbo.tasks.build = {
      dependsOn: [`${databaseName}#build`, "user:preflight"],
      outputs: ["dist/**"],
    };
    applicationTurbo.tasks["user:report"] = { outputs: [] };
    await writeTurbo(migrationTurboPath, migrationTurbo);
    await writeTurbo(applicationTurboPath, applicationTurbo);

    const acceptedAddition = addPackage();
    assert.partialDeepStrictEqual(
      await reconcileAndApplyProjectProjections({
        targetRoot: initialized.repositoryRoot,
        ...acceptedAddition.projectProjections,
      }),
      { ok: true },
    );
    assert.ok(
      (await readFile(migrationTurboPath, "utf8")).includes(
        `${databaseName}#build`,
      ),
    );
    assert.ok(
      (await readFile(applicationTurboPath, "utf8")).includes('"user:report"'),
    );
  });

  void it("rejects an added contribution relabeled as initialization without writes", async () => {
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

    assert.throws(
      () => loadLocalTemplateMetadata(initialized.repositoryRoot),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "duplicate initialization contribution identity",
        ),
    );
    assert.deepStrictEqual(
      await workspaceByteSnapshot(initialized.repositoryRoot),
      before,
    );
  });

  for (const scenario of [
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
              ? {
                  ...record,
                  packageDefinitionId: `package-${"f".repeat(64)}`,
                }
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
  ]) {
    void it(`fails closed on ${scenario.name} without rewriting metadata`, async () => {
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
        initialized.definition.packageContributionReplayAdapters.map(
          (adapter) => mock.method(adapter, "replay"),
        );
      try {
        assert.throws(
          () => loadLocalTemplateMetadata(initialized.repositoryRoot),
          (error: unknown) =>
            error instanceof Error && error.message.includes(scenario.message),
        );
        for (const replaySpy of replaySpies) {
          assert.strictEqual(replaySpy.mock.callCount(), 0);
        }
        assert.deepStrictEqual(
          await workspaceByteSnapshot(initialized.repositoryRoot),
          before,
        );
      } finally {
        for (const replaySpy of replaySpies) replaySpy.mock.restore();
      }
    });
  }
});
