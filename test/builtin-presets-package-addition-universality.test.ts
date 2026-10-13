import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import {
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import {
  any,
  arrayContaining,
  assertContainsEqual,
  assertDeepStrictEqualWithMatchers,
  assertLength,
  assertNotLength,
  assertPartialDeepStrictEqual,
  hasProperty,
  objectContaining,
  stringContaining,
} from "./assertions.ts";

void describe("Built-in Preset Package Addition universality", () => {
  type FixedTopologyDefinition = Exclude<
    BuiltInPresetDefinition,
    { readonly initialPrimaryPackage: object }
  >;
  const toolchain = { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" };
  // 直接新建初始化会派生新建公开 ts-cli 候选，需要发版快照中与 major 一致的精确三段版本。
  const initializationToolchain = {
    ...toolchain,
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
  } as const;

  function firstAddableDefinition() {
    const definition = builtInPresetRegistry
      .all()
      .find((candidate) => candidate.planPackageAddition !== undefined);
    if (definition === undefined) {
      throw new Error("Expected an addable Built-in Preset Definition");
    }
    return definition;
  }

  function rustAddableDefinition() {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "rust-addition-selection"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const packageLeafName = "rust-probe";
    const definition = builtInPresetRegistry.all().find((candidate) => {
      const packagePath = candidate.defaultPackagePath?.({
        context,
        packageLeafName,
      });
      return (
        packagePath !== undefined &&
        candidate.planPackageAddition?.({
          context,
          packageLeafName,
          packagePath,
        }).foundation.toolchains.rust !== undefined
      );
    });
    if (definition === undefined) {
      throw new Error("Expected an addable Definition with a Rust toolchain");
    }
    return definition;
  }

  function definitionWithPackagePath(packagePath: string) {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "package-path-selection"),
      defaultPackageScope: "demo",
      toolchain: initializationToolchain,
    });
    const definition = builtInPresetRegistry.all().find((candidate) =>
      planGeneratedRepositoryInitialization({
        definition: candidate,
        context,
      }).blueprint.packages.some((pkg) => pkg.path === packagePath),
    );
    if (definition === undefined) {
      throw new Error(
        `Expected a Built-in Preset Definition with package path ${packagePath}`,
      );
    }
    return definition;
  }

  void it("initializes every Project Shape with both Standard Package Roots", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join(
            "generated-repository",
            definition.metadata.name,
          ),
          defaultPackageScope: "demo",
          toolchain: initializationToolchain,
        }),
      });
      const workspace = plan.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml",
      );

      assertPartialDeepStrictEqual(workspace, {
        replacements: objectContaining({
          WORKSPACE_PACKAGE_GLOBS: stringContaining(
            "  - apps/*\n  - packages/*",
          ),
        }),
      });
    }
  });

  void it("rejects reserved workspace collections from initialization and explicit Package Addition planning", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-reserved-package-path-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "generated-repository"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const definition = builtInPresetRegistry
      .all()
      .find(
        (candidate): candidate is FixedTopologyDefinition =>
          candidate.initialPrimaryPackage === undefined &&
          candidate.planPackageAddition !== undefined,
      );
    if (definition === undefined) {
      throw new Error("Expected an addable fixed-topology Definition");
    }
    const invalidInitializationDefinition = {
      ...definition,
      blueprint(planningContext: Parameters<typeof definition.blueprint>[0]) {
        const blueprint = definition.blueprint(planningContext);
        return {
          ...blueprint,
          packages: blueprint.packages.map((pkg, index) =>
            index === 0 ? { ...pkg, path: "dist/evil" } : pkg,
          ),
        };
      },
    };

    assert.throws(
      () =>
        planGeneratedRepositoryInitialization({
          definition: invalidInitializationDefinition,
          context,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          ".packages[0].path: Package Path dist/evil uses reserved workspace collection dist",
        ),
    );

    const initialization = planGeneratedRepositoryInitialization({
      definition,
      context,
    });
    await renderNewProject({
      targetRoot: context.targetDir,
      operations: [...initialization.operations],
    });
    assert.throws(
      () =>
        planGeneratedRepositoryPackageAddition({
          definition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "evil",
          packagePath: "target/evil",
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          `Package Path target/evil uses reserved workspace collection target`,
        ),
    );
  });

  void it("reconstructs every base contribution from durable generated state before an addition", async () => {
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
          defaultPackageScope: "demo",
          toolchain: initializationToolchain,
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
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: `durable-${additionDefinition.metadata.name}`,
          });
          const [initializationProjection, preAdditionProjection] =
            await Promise.all([
              materializeProjectProjection({
                operations: initialization.operations,
                reconciliation: initialization.reconciliation,
              }),
              materializeProjectProjection(addition.projectProjections.before),
            ]);

          assert.ok(!hasProperty(addition, "checks"));
          assert.ok(!hasProperty(initialization, "checks"));
          assert.ok(!hasProperty(addition, "fixes"));
          assert.ok(!hasProperty(initialization, "fixes"));
          assertDeepStrictEqualWithMatchers(
            addition.environmentNeeds,
            arrayContaining([...initialization.environmentNeeds]),
          );
          assert.ok(!hasProperty(addition, "deploymentChecks"));
          assert.ok(!hasProperty(initialization, "deploymentChecks"));
          assert.deepStrictEqual(
            preAdditionProjection,
            initializationProjection,
          );
          assertDeepStrictEqualWithMatchers(
            addition.dependencyMaintenancePolicy.ecosystems,
            arrayContaining(
              initialization.dependencyMaintenancePolicy.ecosystems,
            ),
          );
          assertPartialDeepStrictEqual(
            addition.dependencyMaintenancePolicy.directories,
            initialization.dependencyMaintenancePolicy.directories ?? {},
          );
          assertPartialDeepStrictEqual(
            addition.operations.find(
              (operation) =>
                operation.kind === "writeJson" &&
                operation.to === "package.json",
            ),
            {
              value: {
                scripts: objectContaining({
                  check: any(String),
                  ...(initialization.manifests.some(
                    (manifest) =>
                      (
                        manifest.scripts as Record<string, unknown> | undefined
                      )?.["check:deployment"] !== undefined,
                  )
                    ? { "check:deployment": any(String) }
                    : {}),
                }),
              },
            },
          );
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
    }
  });

  void it("plans every supported Package Addition for every registered initialization Definition", async () => {
    const definitions = builtInPresetRegistry.all();
    const addableDefinitions = definitions.filter(
      (definition) => definition.planPackageAddition !== undefined,
    );

    assertNotLength(addableDefinitions, 0);

    for (const baseDefinition of definitions) {
      const targetDir = path.join(
        await mkdtemp(path.join(tmpdir(), "template-universality-")),
        baseDefinition.metadata.name,
      );
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain: initializationToolchain,
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

        for (const additionDefinition of addableDefinitions) {
          const packageLeafName = `${additionDefinition.metadata.name}-addition`;
          const addition = planGeneratedRepositoryPackageAddition({
            definition: additionDefinition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName,
          });
          const addedDefinition = addition.blueprint.packages.find(
            (definition) => definition.name === `@demo/${packageLeafName}`,
          );

          assert.notStrictEqual(addedDefinition, undefined);
          assertContainsEqual(
            addition.operations,
            objectContaining({
              kind: "writeJson",
              to: `${addedDefinition?.path}/package.json`,
              value: objectContaining({
                name: `@demo/${packageLeafName}`,
              }),
              provenance: objectContaining({
                definitionName: additionDefinition.metadata.name,
                planningContribution: "planPackageAddition",
              }),
            }),
          );
          await reconcileAndApplyProjectProjections({
            targetRoot: targetDir,
            ...addition.projectProjections,
          });
        }
      } finally {
        await rm(path.dirname(targetDir), { recursive: true, force: true });
      }
    }
  });

  void it("rejects conflicting Rust toolchain facts before repository writes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-toolchain-conflict-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "demo"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const rustDefinition = rustAddableDefinition();
    const initialization = planGeneratedRepositoryInitialization({
      definition: rustDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const dockerfilePath = path.join(
        context.targetDir,
        ".devcontainer/Dockerfile",
      );
      const dockerfileBefore = await readFile(dockerfilePath, "utf8");
      const conflictingDefinition = {
        ...rustDefinition,
        planPackageAddition(
          options: Parameters<
            NonNullable<typeof rustDefinition.planPackageAddition>
          >[0],
        ) {
          const contribution = rustDefinition.planPackageAddition!(options);
          const rust = contribution.foundation.toolchains.rust;
          if (rust === undefined) {
            throw new Error("Expected the Rust Preset to declare a toolchain");
          }
          return {
            ...contribution,
            foundation: {
              ...contribution.foundation,
              toolchains: {
                rust: {
                  ...rust,
                  toolchain: "nightly",
                  components: ["rustfmt", "clippy"] as const,
                },
              },
            },
          };
        },
      };

      assert.throws(
        () =>
          planGeneratedRepositoryPackageAddition({
            definition: conflictingDefinition,
            localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
            packageLeafName: "worker",
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Foundation requires compatible Rust toolchain facts",
          ),
      );
      assert.strictEqual(
        await readFile(dockerfilePath, "utf8"),
        dockerfileBefore,
      );
      await assert.rejects(
        readFile(
          path.join(context.targetDir, "packages/worker/Cargo.toml"),
          "utf8",
        ),
        (error) => {
          assertPartialDeepStrictEqual(error, { code: "ENOENT" });
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("adds Rust to Rust with one coordinated toolchain and both Cargo package directories", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-to-rust-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "demo"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const rustDefinition = rustAddableDefinition();
    const initialization = planGeneratedRepositoryInitialization({
      definition: rustDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: context.targetDir,
        operations: [...initialization.operations],
      });
      const addition = planGeneratedRepositoryPackageAddition({
        definition: rustDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "worker",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });

      assert.ok(
        (
          await readFile(
            path.join(context.targetDir, "packages/worker/Cargo.toml"),
            "utf8",
          )
        ).includes('name = "worker"'),
      );
      const dockerfile = await readFile(
        path.join(context.targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assertLength(dockerfile.match(/^ARG RUST_TOOLCHAIN$/gmu), 1);
      assertLength(
        dockerfile.match(
          /"\$\{CARGO_HOME\}\/bin\/rustup" toolchain install \$\{RUST_TOOLCHAIN\}/gu,
        ),
        1,
      );
      assert.ok(
        dockerfile.includes(
          '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
        ),
      );
      const devcontainer = JSON.parse(
        await readFile(
          path.join(context.targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { readonly mounts: readonly { readonly target: string }[] };
      assertLength(
        devcontainer.mounts.filter(
          (mount) => mount.target === "/usr/local/cargo/registry",
        ),
        1,
      );
      const dependabot = await readFile(
        path.join(context.targetDir, ".github/dependabot.yml"),
        "utf8",
      );
      const initialRustPackagePath = initialization.blueprint.packages.find(
        (definition) => definition.role === "native-package",
      )!.path;
      assert.ok(dependabot.includes(`directory: "/${initialRustPackagePath}"`));
      assert.ok(dependabot.includes('directory: "/packages/worker"'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps the target root Rust declaration as the version owner across a real addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-root-owned-channel-"),
    );
    const targetDir = path.join(workspace, "demo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        ...toolchain,
        rustVersion: releaseToolchainSnapshot.rustVersion,
      },
    });
    const rustDefinition = rustAddableDefinition();
    const initialization = planGeneratedRepositoryInitialization({
      definition: rustDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const targetRootDeclaration = `[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n`;
      await writeFile(
        path.join(targetDir, "rust-toolchain.toml"),
        targetRootDeclaration,
      );
      assert.notStrictEqual(releaseToolchainSnapshot.rustVersion, "1.98.0");

      const addition = planGeneratedRepositoryPackageAddition({
        definition: rustDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
        packageLeafName: "worker",
      });
      assertContainsEqual(addition.developmentContainer.buildArguments, {
        name: "RUST_TOOLCHAIN",
        value: "1.98.0",
      });

      const reconciliation = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      if (!reconciliation.ok) {
        throw new Error(
          `Package Addition produced conflicts: ${JSON.stringify(reconciliation.conflicts)}`,
        );
      }
      assert.ok(
        !reconciliation.actions
          .map((action) => action.path)
          .includes("rust-toolchain.toml"),
      );
      assert.strictEqual(
        await readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
        targetRootDeclaration,
      );
      assert.ok(
        (
          await readFile(
            path.join(targetDir, "packages/worker/Cargo.toml"),
            "utf8",
          )
        ).includes('name = "worker"'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("still creates the default root declaration when a repository first adds Rust", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-first-rust-addition-"),
    );
    const targetDir = path.join(workspace, "demo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: initializationToolchain,
    });
    const baseDefinition = builtInPresetRegistry.all().find((candidate) =>
      planGeneratedRepositoryInitialization({
        definition: candidate,
        context,
      }).operations.every(
        (operation) =>
          !("to" in operation && operation.to === "rust-toolchain.toml"),
      ),
    );
    if (baseDefinition === undefined) {
      throw new Error(
        "Expected a Built-in Preset Definition without a root Rust declaration",
      );
    }
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
        definition: rustAddableDefinition(),
        localTemplateMetadata: loadLocalTemplateMetadata(targetDir),
        packageLeafName: "native",
      });
      const rootDeclarationOperation = addition.operations.find(
        (operation) =>
          "to" in operation && operation.to === "rust-toolchain.toml",
      );

      assertPartialDeepStrictEqual(rootDeclarationOperation, {
        kind: "writeTextTemplate",
        replacements: { RUST_TOOLCHAIN: "stable" },
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      assert.strictEqual(
        await readFile(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
        '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt", "clippy"]\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps default-root task entrypoints stable while Turbo discovers added scripts", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-natural-addition-"),
    );
    const targetDir = path.join(workspace, "demo");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "natural",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...packageAddition.projectProjections,
      });
      const rootScriptsAfter = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;

      for (const script of ["check", "fix", "check:deployment"] as const) {
        assert.strictEqual(rootScriptsAfter[script], rootScriptsBefore[script]);
      }

      const repeatedAddition = planGeneratedRepositoryPackageAddition({
        definition: addition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "natural-repeat",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...repeatedAddition.projectProjections,
      });
      const rootScriptsAfterRepeat = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;
      for (const script of ["check", "fix", "check:deployment"] as const) {
        assert.strictEqual(
          rootScriptsAfterRepeat[script],
          rootScriptsBefore[script],
        );
      }

      await execa("pnpm", ["install"], { cwd: targetDir });
      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
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
      assert.ok(!taskIds.includes("//#boundaries"));
      const addedManifest = JSON.parse(
        await readFile(
          path.join(targetDir, "packages/natural/package.json"),
          "utf8",
        ),
      ) as { scripts: Record<string, string> };

      for (const task of Object.keys(addedManifest.scripts).filter((name) =>
        ["format:check", "lint", "typecheck", "build", "test"].includes(name),
      )) {
        assert.ok(taskIds.includes(`@demo/natural#${task}`));
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves native preparation and composes browser preparation for a Rust-to-Vue addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-rust-vue-environment-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "rust-vue"),
      defaultPackageScope: "demo",
      toolchain,
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.all().find((definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context,
        }).packageContributions.some((contribution) =>
          contribution.environmentNeeds.some(
            (need) => need.kind === "rust-toolchain",
          ),
        ),
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "web",
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
      });

      const devcontainer = await readFile(
        path.join(context.targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.ok(
        devcontainer.includes(
          '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
        ),
      );
      assert.ok(
        devcontainer.includes("playwright install --with-deps chromium"),
      );
      assertDeepStrictEqualWithMatchers(
        addition.environmentNeeds,
        arrayContaining([
          objectContaining({ kind: "rust-toolchain" }),
          objectContaining({ kind: "playwright-browser-assets" }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it(
    "adds a package after pnpm has created package-local node_modules symlinks",
    { timeout: 300000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-add-with-node-modules-"),
      );
      const targetDir = path.join(workspace, "digital");
      const context = createGenerationContext({
        targetDir,
        defaultPackageScope: "demo",
        toolchain,
      });
      const initialization = planGeneratedRepositoryInitialization({
        definition: definitionWithPackagePath("packages/db"),
        context,
      });

      try {
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        await execa("pnpm", ["install"], { cwd: targetDir });
        await mkdir(path.join(targetDir, ".pnpm-store/v11/files"), {
          recursive: true,
        });
        await writeFile(
          path.join(targetDir, ".pnpm-store/v11/files/staged-copy-sentinel"),
          "store content must stay outside staging\n",
        );
        assert.strictEqual(
          (
            await lstat(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );

        const addition = planGeneratedRepositoryPackageAddition({
          definition: firstAddableDefinition(),
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName: "domain",
          packagePath: "packages/domain",
        });
        const installedTargetsBefore = await Promise.all([
          realpath(path.join(targetDir, "node_modules/.bin/oxfmt")),
          realpath(
            path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
          ),
        ]);
        assertPartialDeepStrictEqual(
          await reconcileAndApplyProjectProjections({
            targetRoot: targetDir,
            ...addition.projectProjections,
          }),
          { ok: true },
        );

        assert.deepStrictEqual(
          await Promise.all([
            realpath(path.join(targetDir, "node_modules/.bin/oxfmt")),
            realpath(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            ),
          ]),
          installedTargetsBefore,
        );
        assert.strictEqual(
          await readFile(
            path.join(targetDir, ".pnpm-store/v11/files/staged-copy-sentinel"),
            "utf8",
          ),
          "store content must stay outside staging\n",
        );
        await execa("pnpm", ["exec", "oxfmt", "--version"], {
          cwd: targetDir,
        });

        assert.ok(
          (
            await readFile(
              path.join(targetDir, "packages/domain/package.json"),
              "utf8",
            )
          ).includes('"name": "@demo/domain"'),
        );
        assert.strictEqual(
          (
            await lstat(
              path.join(targetDir, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("recovers preparation only from persisted Environment Need facts, never task script text", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-explicit-environment-needs-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "explicit-needs"),
      defaultPackageScope: "demo",
      toolchain: initializationToolchain,
    });
    const base = builtInPresetRegistry.all().find((candidate) => {
      const packageLeafName = "environment-probe";
      const packagePath = candidate.defaultPackagePath?.({
        context,
        packageLeafName,
      });
      const contribution =
        packagePath === undefined
          ? undefined
          : candidate.planPackageAddition?.({
              context,
              packageLeafName,
              packagePath,
            });
      return (
        contribution !== undefined &&
        contribution.environmentNeeds.length === 0 &&
        contribution.foundation.deploymentCheck === undefined
      );
    });
    if (base === undefined) {
      throw new Error(
        "Expected an addable Built-in Preset without Environment Needs",
      );
    }
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "another-library",
      });

      assert.deepStrictEqual(addition.environmentNeeds, []);
      assert.deepStrictEqual(addition.deploymentEnvironmentNeeds, []);
      assertPartialDeepStrictEqual(
        addition.operations.find(
          (operation) =>
            operation.kind === "writeJson" &&
            operation.to === ".template/environment-needs.json",
        ),
        {
          value: { schemaVersion: 1, check: [], deployment: [] },
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("adds custom Package Roots only through pnpm workspace membership", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-custom-package-root-"),
    );
    const context = createGenerationContext({
      targetDir: path.join(workspace, "custom-package-root"),
      defaultPackageScope: "demo",
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
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "custom",
        packagePath: "services/custom",
      });
      const workspaceRefresh = addition.operations.find(
        (operation) =>
          operation.kind === "writeTextTemplate" &&
          operation.to === "pnpm-workspace.yaml",
      );

      assertPartialDeepStrictEqual(workspaceRefresh, {
        replacements: objectContaining({
          WORKSPACE_PACKAGE_GLOBS: stringContaining("  - services/*"),
        }),
      });
      assertDeepStrictEqualWithMatchers(
        addition.operations.filter(
          (operation) =>
            operation.kind === "writeJson" && operation.to === "package.json",
        ),
        arrayContaining([
          objectContaining({
            value: objectContaining({
              scripts: objectContaining({
                check: rootScripts(initialization),
                fix: rootFix(initialization),
              }),
            }),
          }),
        ]),
      );
      await reconcileAndApplyProjectProjections({
        targetRoot: context.targetDir,
        ...addition.projectProjections,
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
      assertDeepStrictEqualWithMatchers(
        taskIds,
        arrayContaining(["@demo/custom#build", "@demo/custom#test"]),
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
