import assert from "node:assert/strict";
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
import {
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

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

void describe("Non-Destructive Package Addition", () => {
  void it("reconciles the complete Foundation delta while preserving unrelated customization", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-complete-foundation-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        // 该夹具以 ts-cli Definition 直接新建含公开候选的仓库，需要快照精确版本。
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
        packagePath: "services/dashboard",
        linkFrom: [consumerPath],
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      for (const expectedAction of [
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
      ]) {
        assert.ok(
          result.actions.some((action) =>
            isDeepStrictEqual(action, expectedAction),
          ),
        );
      }
      const actionPaths = result.actions.map((action) => action.path);
      assert.ok(
        ![
          ".gitignore",
          ".github/dependabot.yml",
          ".vscode/settings.json",
          "oxlint.config.ts",
          "package.json",
        ].every((expectedPath) => actionPaths.includes(expectedPath)),
      );
      assert.partialDeepStrictEqual(
        await readFile(path.join(targetDir, "package.json"), "utf8").then(
          (source) => JSON.parse(source),
        ),
        { userRoot: { retained: true } },
      );
      assert.partialDeepStrictEqual(
        await readFile(
          path.join(targetDir, consumerPath, "package.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
        {
          userConsumer: { retained: true },
          dependencies: {
            "user-only": "workspace:*",
            "@demo/dashboard": "workspace:*",
          },
        },
      );
      const updatedDevcontainer = JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as Record<string, unknown> & {
        build: { args: Record<string, unknown> };
      };
      assert.partialDeepStrictEqual(updatedDevcontainer, {
        userCustomization: { retained: true },
      });
      assert.ok(Object.hasOwn(updatedDevcontainer, "build"));
      assert.ok(Object.hasOwn(updatedDevcontainer.build, "args"));
      assert.ok(
        Object.hasOwn(updatedDevcontainer.build.args, "PLAYWRIGHT_CLI_PACKAGE"),
      );
      assert.ok(
        typeof updatedDevcontainer.build.args.PLAYWRIGHT_CLI_PACKAGE ===
          "string",
      );
      assert.ok(
        updatedDevcontainer.build.args.PLAYWRIGHT_CLI_PACKAGE.includes(
          "@playwright/test",
        ),
      );
      for (const [relativePath, prefix] of textCustomizations) {
        assert.ok(
          (await readFile(path.join(targetDir, relativePath), "utf8")).includes(
            prefix.trim(),
          ),
        );
      }
      assert.ok(
        (
          await readFile(path.join(targetDir, "pnpm-workspace.yaml"), "utf8")
        ).includes("  - services/*"),
      );
      assert.ok(
        !(
          await readFile(
            path.join(targetDir, ".github/workflows/check.yml"),
            "utf8",
          )
        ).includes("playwright install"),
      );
      const extensions = JSON.parse(
        await readFile(path.join(targetDir, ".vscode/extensions.json"), "utf8"),
      ) as { recommendations: string[] };
      assert.ok(extensions.recommendations.includes("user.first"));
      assert.ok(extensions.recommendations.includes("Vue.volar"));
      const generation = JSON.parse(
        await readFile(
          path.join(targetDir, ".template/generation.json"),
          "utf8",
        ),
      ) as { schemaVersion: number; packages: { path: string }[] };
      assert.strictEqual(generation.schemaVersion, 2);
      assert.strictEqual(generation.packages.length, 3);
      assert.strictEqual(generation.packages[0]?.path, consumerPath);
      assert.strictEqual(
        generation.packages[1]?.path,
        "packages/typescript-config",
      );
      assert.strictEqual(generation.packages[2]?.path, "services/dashboard");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a shared-library link to a runtime-service before workspace mutation", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-invalid-package-role-link-"),
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

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition: additionDefinition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "dashboard",
            packagePath: "services/dashboard",
            linkFrom: [consumerPath],
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `Package Link ${consumerPath} (shared-library) cannot depend on services/dashboard (runtime-service) under Package Role boundaries`,
          ),
      );
      assert.deepStrictEqual(await workspaceByteSnapshot(targetDir), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("uses Current Manifest Truth for links without making it the Before baseline", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-current-link-manifest-truth-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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
          dependenciesMeta?: Record<string, { injected: true }>;
        };

      assert.ok(
        !Object.hasOwn(manifestFrom(before, consumerPath), "dependenciesMeta"),
      );
      assert.deepStrictEqual(
        manifestFrom(after, consumerPath).dependenciesMeta?.["@demo/provider"],
        { injected: true },
      );
      assert.ok(
        !Object.hasOwn(
          manifestFrom(after, consumerPath).dependenciesMeta ?? {},
          "@demo/next-provider",
        ),
      );
      assert.partialDeepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...secondAddition.projectProjections,
        }),
        { ok: true },
      );
      assert.partialDeepStrictEqual(
        await readFile(providerManifestPath, "utf8").then((source) =>
          JSON.parse(source),
        ),
        {
          exports: { ".": { default: "./dist/stale-provider.js" } },
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves a stale root export during an ordinary addition without links", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ordinary-add-stale-export-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "ordinary",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.ok(
        !result.actions
          .map((action) => action.path)
          .includes(`${existingPath}/package.json`),
      );
      assert.partialDeepStrictEqual(
        await readFile(existingManifestPath, "utf8").then((source) =>
          JSON.parse(source),
        ),
        {
          exports: { ".": { default: "./dist/user-maintained.js" } },
        },
      );
      assert.ok(
        (
          await readFile(
            path.join(targetDir, "packages/ordinary/package.json"),
            "utf8",
          )
        ).includes('"name": "@demo/ordinary"'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("does not inspect or restore a missing non-delta Package manifest", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-missing-non-delta-manifest-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "ordinary",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.ok(
        !result.actions
          .map((action) => action.path)
          .includes(`${existingPath}/package.json`),
      );
      await assert.rejects(stat(existingManifestPath), (error) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.ok(Object.hasOwn(error, "code"));
        assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
        return true;
      });
      assert.ok(
        (
          await readFile(
            path.join(targetDir, "packages/ordinary/package.json"),
            "utf8",
          )
        ).includes('"name": "@demo/ordinary"'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("fails closed when an explicitly linked consumer manifest is missing", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-missing-linked-manifest-"),
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
      await unlink(path.join(targetDir, consumerPath, "package.json"));

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
            packageLeafName: "provider",
            linkFrom: [consumerPath],
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `Package Addition requires manifest truth for ${consumerPath}:`,
          ),
      );
      await assert.rejects(
        stat(path.join(targetDir, "packages/provider")),
        (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves Editor members and order while appending a new capability", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-identity-set-addition-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      const updated = JSON.parse(await readFile(extensionsPath, "utf8")) as {
        recommendations: string[];
      };
      assert.deepStrictEqual(updated.recommendations.slice(0, 3), [
        "user.first",
        initialRecommendation,
        "user.last",
      ]);
      assert.deepStrictEqual(updated.recommendations.slice(3), [
        "Vue.volar",
        "bradlc.vscode-tailwindcss",
        "vitest.explorer",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves a custom Turbo task while adding a required structured fact", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-structured-addition-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.ok(result.changedPaths.includes("turbo.json"));
      const updatedTurbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        boundaries: { tags: { app: { dependencies: { allow: string[] } } } };
        tasks: Record<string, unknown>;
      };
      assert.deepStrictEqual(
        updatedTurbo.boundaries.tags.app.dependencies.allow,
        ["app", "library"],
      );
      assert.partialDeepStrictEqual(updatedTurbo, {
        tasks: { "user:report": { cache: false } },
      });

      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: additionDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "dashboard",
      });
      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...repeatedAddition.projectProjections,
        }),
        { ok: true, changedPaths: [], actions: [] },
      );
      const repeatedTurbo = await readFile(turboPath, "utf8");
      const userReportOccurrences = repeatedTurbo.match(/"user:report"/gu);
      assert.ok(userReportOccurrences);
      assert.strictEqual(userReportOccurrences.length, 1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves a user's text policy, creates the package, and repeats as a no-op", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-non-destructive-addition-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "utilities",
        packagePath: "services/utilities",
      });
      assert.deepStrictEqual(
        await materializeProjectProjection(addition.projectProjections.before),
        await materializeProjectProjection({
          operations: initialization.operations,
          reconciliation: initialization.reconciliation,
        }),
      );
      const firstResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(firstResult.ok, true);
      if (!firstResult.ok) return;
      assert.ok(
        firstResult.changedPaths.includes("services/utilities/package.json"),
      );
      assert.ok(
        (await readFile(gitignorePath, "utf8")).includes("private-artifacts/"),
      );
      assert.ok(
        (
          await readFile(
            path.join(targetDir, "services/utilities/package.json"),
            "utf8",
          )
        ).includes('"name": "@demo/utilities"'),
      );
      const workspaceManifest = await readFile(workspaceManifestPath, "utf8");
      assert.ok(workspaceManifest.includes("  - services/*"));
      assert.ok(workspaceManifest.includes("# private workspace policy"));

      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "utilities",
        packagePath: "services/utilities",
      });
      const repeatedResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeatedAddition.projectProjections,
      });

      assert.deepStrictEqual(repeatedResult, {
        ok: true,
        changedPaths: [],
        actions: [],
      });
      const gitignore = await readFile(gitignorePath, "utf8");
      const privateArtifactsEntries = gitignore.match(
        /^private-artifacts\/$/gmu,
      );
      assert.ok(privateArtifactsEntries);
      assert.strictEqual(privateArtifactsEntries.length, 1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects tool-owned metadata that changes after planning with zero workspace writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-stale-foundation-metadata-"),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
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

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.conflicts.length, 1);
      const conflict = result.conflicts[0]!;
      assert.ok(Object.hasOwn(conflict, "path"));
      assert.strictEqual(conflict.path, ".template/generation.json");
      assert.ok(Object.hasOwn(conflict, "driver"));
      assert.strictEqual(conflict.driver, "canonical");
      assert.ok(Object.hasOwn(conflict, "reason"));
      assert.strictEqual(conflict.reason, "Current tool-owned state is stale");
      assert.deepStrictEqual(await workspaceByteSnapshot(targetDir), before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects unknown Generation Record fields instead of accepting historical snapshots", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generation-record-validation-"),
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

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "utilities",
          }),
        (error: unknown) =>
          error instanceof Error &&
          /^Generation Record contains unknown field: historicalFiles; historicalFiles: contains unknown Generation Record field$/u.test(
            error.message,
          ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects unknown persisted Environment Need fields before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-environment-metadata-validation-"),
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

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "utilities",
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Package Addition requires valid Environment Need metadata in .template/environment-needs.json: $ contains unknown field: inferredFromWorkspace",
          ),
      );
      await assert.rejects(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
        (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects unknown fields nested in persisted Environment Need facts before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-nested-environment-metadata-validation-"),
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
      assert.ok(metadata.check.length > 0);
      metadata.check[0]!.inferredFromTaskGraph = true;
      await writeFile(metadataPath, JSON.stringify(metadata));

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "utilities",
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Package Addition requires valid Environment Need metadata in .template/environment-needs.json: check[0] contains unknown field: inferredFromTaskGraph",
          ),
      );
      await assert.rejects(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
        (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects missing, invalid, and unsupported Local Template Metadata before projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-required-metadata-validation-"),
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
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "utilities",
        });

      await rm(generationPath);
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes("requires valid Generation Record facts"),
      );
      await writeFile(generationPath, "{");
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes("requires valid Generation Record facts"),
      );
      await writeFile(
        generationPath,
        JSON.stringify({
          ...(JSON.parse(generation) as Record<string, unknown>),
          schemaVersion: 3,
        }),
      );
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Unsupported Generation Record schema version 3; expected 2",
          ),
      );
      await writeFile(generationPath, generation);

      await rm(environmentPath);
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "requires explicit Check Environment Need facts",
          ),
      );
      await writeFile(environmentPath, "{");
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes("requires valid Check Environment Need facts"),
      );
      await writeFile(
        environmentPath,
        JSON.stringify({
          schemaVersion: 1,
          check: [{ kind: "inferred-task" }],
          deployment: [],
        }),
      );
      assert.throws(
        plan,
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "requires valid Environment Need metadata in .template/environment-needs.json: check[0] has unsupported kind: inferred-task",
          ),
      );
      await writeFile(environmentPath, environment);

      assert.doesNotThrow(plan);
      await assert.rejects(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
        (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a Generation Record preset that conflicts with initial provenance and Blueprint", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generation-preset-consistency-"),
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
    const definition = requireAddableDefinitionForRole(
      context,
      "shared-library",
    );
    const conflictingDefinition = builtInPresetRegistry.all().find(
      (candidate) =>
        candidate.metadata.name !== definition.metadata.name &&
        planGeneratedRepositoryInitialization({
          definition: candidate,
          context,
        }).blueprint.packages.some((item) => item.role === "native-package"),
    );
    if (conflictingDefinition === undefined) {
      throw new Error(
        "Expected an incompatible initial Definition for Generation Record validation",
      );
    }
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

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "utilities",
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `Package Addition Generation Record preset ${conflictingDefinition.metadata.name} conflicts with initial Package provenance ${definition.metadata.name} for Blueprint package ${initialization.blueprint.packages[0]!.path}`,
          ),
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
      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "utilities",
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `Package Planning Provenance ${conflictingDefinition.metadata.name}:library (planInitialization) at ${initialization.blueprint.packages[0]!.path} failed: unknown Package Contribution replay adapter library; expected binary for ${conflictingDefinition.metadata.name}`,
          ),
      );
      await assert.rejects(
        readFile(path.join(targetDir, "packages/utilities/package.json")),
        (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual((error as { code?: unknown }).code, "ENOENT");
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
