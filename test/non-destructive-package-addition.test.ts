import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInGenerationContext,
  type BuiltInPresetDefinition,
} from "#template-builtin-presets";
import {
  assertProjectBlueprintV2,
  type PackageRole,
} from "#template-core/project-blueprint-v2";
import {
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
} from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

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

async function workspaceByteSnapshot(
  root: string,
  relative = "",
): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceByteSnapshot(root, child)));
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(root, child);
    files.push({
      path: child.split(path.sep).join("/"),
      mode: (await stat(filePath)).mode & 0o777,
      content: (await readFile(filePath)).toString("base64"),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

describe("Non-Destructive Package Addition", () => {
  it("reconciles the complete Foundation delta while preserving unrelated customization", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-complete-foundation-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const baseDefinition = requireAddableDefinitionForRole(context, "cli-tool");
    const additionDefinition = requireAddableDefinitionForRole(
      context,
      "runtime-service",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const consumerPath = initialization.blueprint.packages[0]!.path;
      const jsonCustomizations = [
        ["package.json", { userRoot: { retained: true } }],
        [
          `${consumerPath}/package.json`,
          {
            userConsumer: { retained: true },
            dependencies: { "user-only": "workspace:*" },
          },
        ],
        [
          ".vscode/extensions.json",
          { recommendations: ["user.first", "dbaeumer.vscode-eslint"] },
        ],
        [".vscode/settings.json", { "user.setting": true }],
        [
          ".devcontainer/devcontainer.json",
          { userCustomization: { retained: true } },
        ],
      ] as const;
      for (const [relativePath, patch] of jsonCustomizations) {
        const filePath = path.join(targetDir, relativePath);
        const current = JSON.parse(await readFile(filePath, "utf8")) as Record<
          string,
          unknown
        >;
        await writeFile(
          filePath,
          `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
        );
      }
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, unknown>;
      };
      turbo.tasks["user:report"] = { cache: false };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
      const textCustomizations = [
        [".gitignore", "private-artifacts/\n"],
        ["pnpm-workspace.yaml", "# user workspace policy\n"],
        [".github/dependabot.yml", "# user dependabot policy\n"],
        [".github/workflows/check.yml", "# user workflow policy\n"],
        [".devcontainer/Dockerfile", "# user container policy\n"],
        ["oxlint.config.ts", "// user oxc policy\n"],
      ] as const;
      for (const [relativePath, prefix] of textCustomizations) {
        const filePath = path.join(targetDir, relativePath);
        await writeFile(
          filePath,
          `${prefix}${await readFile(filePath, "utf8")}`,
        );
      }

      const addition = planGeneratedRepositoryPackageAddition({
        definition: additionDefinition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "dashboard",
        packagePath: "services/dashboard",
        linkFrom: [consumerPath],
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.actions).toEqual(
        expect.arrayContaining([
          {
            path: ".devcontainer/devcontainer.json",
            driver: "structured",
            action: "update",
          },
          {
            path: `${consumerPath}/package.json`,
            driver: "structured",
            action: "update",
          },
          {
            path: "services/dashboard/package.json",
            driver: "structured",
            action: "create",
          },
        ]),
      );
      expect(result.actions.map((action) => action.path)).not.toEqual(
        expect.arrayContaining([
          ".gitignore",
          ".github/dependabot.yml",
          ".vscode/settings.json",
          "oxlint.config.ts",
          "package.json",
        ]),
      );
      await expect(
        readFile(path.join(targetDir, "package.json"), "utf8").then((source) =>
          JSON.parse(source),
        ),
      ).resolves.toMatchObject({ userRoot: { retained: true } });
      await expect(
        readFile(
          path.join(targetDir, consumerPath, "package.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        userConsumer: { retained: true },
        dependencies: {
          "user-only": "workspace:*",
          "@demo/dashboard": "workspace:*",
        },
      });
      await expect(
        readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        userCustomization: { retained: true },
        build: {
          args: {
            PLAYWRIGHT_CLI_PACKAGE: expect.stringContaining("@playwright/test"),
          },
        },
      });
      for (const [relativePath, prefix] of textCustomizations) {
        await expect(
          readFile(path.join(targetDir, relativePath), "utf8"),
        ).resolves.toContain(prefix.trim());
      }
      await expect(
        readFile(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ).resolves.toContain("  - services/*");
      await expect(
        readFile(path.join(targetDir, ".github/workflows/check.yml"), "utf8"),
      ).resolves.not.toContain("playwright install");
      await expect(
        readFile(path.join(targetDir, ".vscode/extensions.json"), "utf8").then(
          (source) => JSON.parse(source),
        ),
      ).resolves.toMatchObject({
        recommendations: expect.arrayContaining(["user.first", "Vue.volar"]),
      });
      await expect(
        readFile(
          path.join(targetDir, ".template/generation.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        schemaVersion: 1,
        packages: [
          expect.objectContaining({ path: consumerPath }),
          expect.objectContaining({ path: "packages/typescript-config" }),
          expect.objectContaining({ path: "services/dashboard" }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a shared-library link to a runtime-service before workspace mutation", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-invalid-package-role-link-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const baseDefinition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );
    const additionDefinition = requireAddableDefinitionForRole(
      context,
      "runtime-service",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const consumerPath = initialization.blueprint.packages[0]!.path;
      const before = await workspaceByteSnapshot(targetDir);

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition: additionDefinition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "dashboard",
          packagePath: "services/dashboard",
          linkFrom: [consumerPath],
        }),
      ).toThrow(
        `Package Link ${consumerPath} (shared-library) cannot depend on services/dashboard (runtime-service) under Package Role boundaries`,
      );
      expect(await workspaceByteSnapshot(targetDir)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses Current Manifest Truth for links without making it the Before baseline", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-current-link-manifest-truth-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const consumerPath = initialization.blueprint.packages[0]!.path;
      const firstAddition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "provider",
        linkFrom: [consumerPath],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...firstAddition.projectProjections,
      });
      const providerPath = "packages/provider";
      const providerManifestPath = path.join(
        targetDir,
        providerPath,
        "package.json",
      );
      const providerManifest = JSON.parse(
        await readFile(providerManifestPath, "utf8"),
      ) as Record<string, unknown>;
      providerManifest.exports = {
        ".": { default: "./dist/stale-provider.js" },
      };
      await writeFile(
        providerManifestPath,
        `${JSON.stringify(providerManifest, null, 2)}\n`,
      );

      const secondAddition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: firstAddition.blueprint,
        packageLeafName: "next-provider",
        linkFrom: [consumerPath],
      });
      const [before, after] = await Promise.all([
        materializeProjectProjection(secondAddition.projectProjections.before),
        materializeProjectProjection(secondAddition.projectProjections.after),
      ]);
      const manifestFrom = (
        projection: Awaited<ReturnType<typeof materializeProjectProjection>>,
        packagePath: string,
      ) =>
        JSON.parse(
          new TextDecoder().decode(
            projection.entries.find(
              (entry) => entry.path === `${packagePath}/package.json`,
            )!.content,
          ),
        ) as {
          dependenciesMeta: Record<string, { injected: boolean }>;
        };

      expect(
        manifestFrom(before, consumerPath).dependenciesMeta["@demo/provider"],
      ).toEqual({ injected: false });
      expect(
        manifestFrom(after, consumerPath).dependenciesMeta["@demo/provider"],
      ).toEqual({ injected: true });
      expect(
        manifestFrom(after, consumerPath).dependenciesMeta[
          "@demo/next-provider"
        ],
      ).toEqual({ injected: false });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...secondAddition.projectProjections,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        readFile(providerManifestPath, "utf8").then((source) =>
          JSON.parse(source),
        ),
      ).resolves.toMatchObject({
        exports: { ".": { default: "./dist/stale-provider.js" } },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a stale root export during an ordinary addition without links", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ordinary-add-stale-export-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const existingPath = initialization.blueprint.packages[0]!.path;
      const existingManifestPath = path.join(
        targetDir,
        existingPath,
        "package.json",
      );
      const existingManifest = JSON.parse(
        await readFile(existingManifestPath, "utf8"),
      ) as Record<string, unknown>;
      existingManifest.exports = {
        ".": { default: "./dist/user-maintained.js" },
      };
      await writeFile(
        existingManifestPath,
        `${JSON.stringify(existingManifest, null, 2)}\n`,
      );

      const addition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "ordinary",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.actions.map((action) => action.path)).not.toContain(
        `${existingPath}/package.json`,
      );
      await expect(
        readFile(existingManifestPath, "utf8").then((source) =>
          JSON.parse(source),
        ),
      ).resolves.toMatchObject({
        exports: { ".": { default: "./dist/user-maintained.js" } },
      });
      await expect(
        readFile(
          path.join(targetDir, "packages/ordinary/package.json"),
          "utf8",
        ),
      ).resolves.toContain('"name": "@demo/ordinary"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not inspect or restore a missing non-delta Package manifest", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-missing-non-delta-manifest-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const existingPath = initialization.blueprint.packages[0]!.path;
      const existingManifestPath = path.join(
        targetDir,
        existingPath,
        "package.json",
      );
      await unlink(existingManifestPath);

      const addition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "ordinary",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.actions.map((action) => action.path)).not.toContain(
        `${existingPath}/package.json`,
      );
      await expect(stat(existingManifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(
          path.join(targetDir, "packages/ordinary/package.json"),
          "utf8",
        ),
      ).resolves.toContain('"name": "@demo/ordinary"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves Editor members and order while appending a new capability", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-identity-set-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const baseDefinition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );
    const additionDefinition = requireAddableDefinitionForRole(
      context,
      "runtime-service",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const extensionsPath = path.join(targetDir, ".vscode/extensions.json");
      const extensions = JSON.parse(await readFile(extensionsPath, "utf8")) as {
        recommendations: string[];
      };
      const initialRecommendation = extensions.recommendations[0]!;
      extensions.recommendations = [
        "user.first",
        initialRecommendation,
        "user.last",
      ];
      await writeFile(
        extensionsPath,
        `${JSON.stringify(extensions, null, 2)}\n`,
      );

      const addition = planGeneratedRepositoryPackageAddition({
        definition: additionDefinition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const updated = JSON.parse(await readFile(extensionsPath, "utf8")) as {
        recommendations: string[];
      };
      expect(updated.recommendations.slice(0, 3)).toEqual([
        "user.first",
        initialRecommendation,
        "user.last",
      ]);
      expect(updated.recommendations.slice(3)).toEqual([
        "Vue.volar",
        "bradlc.vscode-tailwindcss",
        "vitest.explorer",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a custom Turbo task while adding a required structured fact", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-structured-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const baseDefinition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );
    const additionDefinition = requireAddableDefinitionForRole(
      context,
      "runtime-service",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: baseDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const turboPath = path.join(targetDir, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, unknown>;
      };
      turbo.tasks["user:report"] = { cache: false };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);

      const addition = planGeneratedRepositoryPackageAddition({
        definition: additionDefinition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changedPaths).toContain("turbo.json");
      await expect(
        readFile(turboPath, "utf8").then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        boundaries: {
          tags: {
            app: { dependencies: { allow: ["app", "library"] } },
          },
        },
        tasks: { "user:report": { cache: false } },
      });

      const blueprint = assertProjectBlueprintV2(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".template/blueprint.json"),
            "utf8",
          ),
        ),
      );
      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: additionDefinition,
        context,
        blueprint,
        packageLeafName: "dashboard",
      });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeatedAddition.projectProjections,
        }),
      ).resolves.toEqual({ ok: true, changedPaths: [], actions: [] });
      const repeatedTurbo = await readFile(turboPath, "utf8");
      expect(repeatedTurbo.match(/"user:report"/gu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a user's text policy, creates the package, and repeats as a no-op", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-non-destructive-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const gitignorePath = path.join(targetDir, ".gitignore");
      const workspaceManifestPath = path.join(targetDir, "pnpm-workspace.yaml");
      await Promise.all([
        writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" }),
        writeFile(workspaceManifestPath, "# private workspace policy\n", {
          flag: "a",
        }),
      ]);

      const addition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "utilities",
        packagePath: "services/utilities",
      });
      await expect(
        materializeProjectProjection(addition.projectProjections.before),
      ).resolves.toEqual(
        await materializeProjectProjection({
          operations: initialization.operations,
          reconciliation: initialization.reconciliation,
        }),
      );
      const firstResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(firstResult.ok).toBe(true);
      if (!firstResult.ok) return;
      expect(firstResult.changedPaths).toContain(
        "services/utilities/package.json",
      );
      await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
        "private-artifacts/",
      );
      await expect(
        readFile(
          path.join(targetDir, "services/utilities/package.json"),
          "utf8",
        ),
      ).resolves.toContain('"name": "@demo/utilities"');
      const workspaceManifest = await readFile(workspaceManifestPath, "utf8");
      expect(workspaceManifest).toContain("  - services/*");
      expect(workspaceManifest).toContain("# private workspace policy");

      const blueprint = assertProjectBlueprintV2(
        JSON.parse(
          await readFile(
            path.join(targetDir, ".template/blueprint.json"),
            "utf8",
          ),
        ),
      );
      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint,
        packageLeafName: "utilities",
        packagePath: "services/utilities",
      });
      const repeatedResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeatedAddition.projectProjections,
      });

      expect(repeatedResult).toEqual({
        ok: true,
        changedPaths: [],
        actions: [],
      });
      const gitignore = await readFile(gitignorePath, "utf8");
      expect(gitignore.match(/^private-artifacts\/$/gmu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects tool-owned metadata that changes after planning with zero workspace writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-stale-foundation-metadata-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "utilities",
      });
      const generationPath = path.join(targetDir, ".template/generation.json");
      const generation = JSON.parse(
        await readFile(generationPath, "utf8"),
      ) as unknown;
      await writeFile(generationPath, JSON.stringify(generation));
      const before = await workspaceByteSnapshot(targetDir);

      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(result).toEqual({
        ok: false,
        conflicts: [
          expect.objectContaining({
            path: ".template/generation.json",
            driver: "canonical",
            reason: "Current tool-owned state is stale",
          }),
        ],
      });
      expect(await workspaceByteSnapshot(targetDir)).toEqual(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unknown Generation Record fields instead of accepting historical snapshots", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generation-record-validation-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const generationPath = path.join(targetDir, ".template/generation.json");
      const generation = JSON.parse(
        await readFile(generationPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        generationPath,
        JSON.stringify({ ...generation, historicalFiles: {} }),
      );

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        }),
      ).toThrow(
        "Package Addition Generation Record contains unknown field: historicalFiles",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unknown persisted Environment Need fields before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-environment-metadata-validation-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const metadataPath = path.join(
        targetDir,
        ".template/environment-needs.json",
      );
      const metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        metadataPath,
        JSON.stringify({ ...metadata, inferredFromWorkspace: true }),
      );

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        }),
      ).toThrow(
        "Package Addition Environment Need facts contain unknown field: inferredFromWorkspace",
      );
      await expect(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields nested in persisted Environment Need facts before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-nested-environment-metadata-validation-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "runtime-service",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const metadataPath = path.join(
        targetDir,
        ".template/environment-needs.json",
      );
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        check: Record<string, unknown>[];
      };
      expect(metadata.check.length).toBeGreaterThan(0);
      metadata.check[0]!.inferredFromTaskGraph = true;
      await writeFile(metadataPath, JSON.stringify(metadata));

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        }),
      ).toThrow(
        "Package Addition Environment Need check[0] contains unknown field: inferredFromTaskGraph",
      );
      await expect(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects missing, invalid, and unsupported Local Template Metadata before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-required-metadata-validation-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const generationPath = path.join(targetDir, ".template/generation.json");
      const environmentPath = path.join(
        targetDir,
        ".template/environment-needs.json",
      );
      const generation = await readFile(generationPath, "utf8");
      const environment = await readFile(environmentPath, "utf8");
      const plan = () =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        });

      await rm(generationPath);
      expect(plan).toThrow("requires valid Generation Record facts");
      await writeFile(generationPath, "{");
      expect(plan).toThrow("requires valid Generation Record facts");
      await writeFile(
        generationPath,
        JSON.stringify({
          ...(JSON.parse(generation) as Record<string, unknown>),
          schemaVersion: 2,
        }),
      );
      expect(plan).toThrow("requires a supported Generation Record");
      await writeFile(generationPath, generation);

      await rm(environmentPath);
      expect(plan).toThrow("requires explicit Check Environment Need facts");
      await writeFile(environmentPath, "{");
      expect(plan).toThrow("requires valid Check Environment Need facts");
      await writeFile(
        environmentPath,
        JSON.stringify({
          schemaVersion: 1,
          check: [{ kind: "inferred-task" }],
          deployment: [],
        }),
      );
      expect(plan).toThrow("requires supported Check Environment Need facts");
      await writeFile(environmentPath, environment);

      expect(plan).not.toThrow();
      await expect(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a Generation Record preset that conflicts with initial provenance and Blueprint", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generation-preset-consistency-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );
    const conflictingDefinition = builtInPresetRegistry
      .all()
      .find(
        (candidate) =>
          candidate.metadata.name !== definition.metadata.name &&
          candidate
            .blueprint(context)
            .packages.some((item) => item.role === "native-package"),
      );
    if (conflictingDefinition === undefined) {
      throw new Error(
        "Expected an incompatible initial Definition for Generation Record validation",
      );
    }
    const conflictingPackage =
      conflictingDefinition.blueprint(context).packages[0]!;

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const generationPath = path.join(targetDir, ".template/generation.json");
      const generation = JSON.parse(
        await readFile(generationPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        generationPath,
        JSON.stringify({
          ...generation,
          preset: conflictingDefinition.metadata.name,
        }),
      );

      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        }),
      ).toThrow(
        `Package Addition Generation Record preset ${conflictingDefinition.metadata.name} conflicts with initial Package provenance ${definition.metadata.name} for Blueprint package ${initialization.blueprint.packages[0]!.path}`,
      );
      await writeFile(
        generationPath,
        JSON.stringify({
          ...generation,
          preset: conflictingDefinition.metadata.name,
          packages: (
            generation.packages as readonly Record<string, unknown>[]
          ).map((item) => ({
            ...item,
            ...(item.planningContribution === "foundationPlan"
              ? {}
              : { definitionName: conflictingDefinition.metadata.name }),
          })),
        }),
      );
      expect(() =>
        planGeneratedRepositoryPackageAddition({
          definition,
          context,
          blueprint: initialization.blueprint,
          packageLeafName: "utilities",
        }),
      ).toThrow(
        `Package Addition Generation Record preset ${conflictingDefinition.metadata.name} cannot reproduce initial Blueprint Package Definition ${conflictingPackage.name} at ${conflictingPackage.path} (${conflictingPackage.role})`,
      );
      await expect(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
