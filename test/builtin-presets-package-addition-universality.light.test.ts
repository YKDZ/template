import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import {
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
} from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

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

      assert.ok(workspace?.kind === "writeTextTemplate");
      assert.ok(Object.hasOwn(workspace, "replacements"));
      assert.ok(
        Object.hasOwn(workspace.replacements, "WORKSPACE_PACKAGE_GLOBS"),
      );
      const packageGlobs = workspace.replacements.WORKSPACE_PACKAGE_GLOBS;
      assert.ok(typeof packageGlobs === "string");
      assert.ok(packageGlobs.includes("  - apps/*\n  - packages/*"));
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

          assert.ok(!Object.hasOwn(addition, "checks"));
          assert.ok(!Object.hasOwn(initialization, "checks"));
          assert.ok(!Object.hasOwn(addition, "fixes"));
          assert.ok(!Object.hasOwn(initialization, "fixes"));
          for (const expectedNeed of initialization.environmentNeeds) {
            assert.ok(
              addition.environmentNeeds.some((need) =>
                isDeepStrictEqual(need, expectedNeed),
              ),
            );
          }
          assert.ok(!Object.hasOwn(addition, "deploymentChecks"));
          assert.ok(!Object.hasOwn(initialization, "deploymentChecks"));
          assert.deepStrictEqual(
            preAdditionProjection,
            initializationProjection,
          );
          for (const ecosystem of initialization.dependencyMaintenancePolicy
            .ecosystems) {
            assert.ok(
              addition.dependencyMaintenancePolicy.ecosystems.includes(
                ecosystem,
              ),
            );
          }
          const expectedDirectories =
            initialization.dependencyMaintenancePolicy.directories;
          if (
            expectedDirectories !== undefined &&
            Object.keys(expectedDirectories).length > 0
          ) {
            assert.partialDeepStrictEqual(
              addition.dependencyMaintenancePolicy.directories,
              expectedDirectories,
            );
          }
          const rootManifestOperation = addition.operations.find(
            (operation) =>
              operation.kind === "writeJson" && operation.to === "package.json",
          );
          assert.ok(rootManifestOperation);
          assert.ok(rootManifestOperation.kind === "writeJson");
          assert.ok(Object.hasOwn(rootManifestOperation, "value"));
          const value = rootManifestOperation.value;
          assert.ok(typeof value === "object" && value !== null);
          assert.ok(Object.hasOwn(value, "scripts"));
          const scripts = (value as Record<string, unknown>).scripts as Record<
            string,
            unknown
          >;
          assert.ok(Object.hasOwn(scripts, "check"));
          assert.ok(
            typeof scripts.check === "string" ||
              scripts.check instanceof String,
          );
          if (
            initialization.manifests.some(
              (manifest) =>
                (manifest.scripts as Record<string, unknown> | undefined)?.[
                  "check:deployment"
                ] !== undefined,
            )
          ) {
            assert.ok(Object.hasOwn(scripts, "check:deployment"));
            assert.ok(
              typeof scripts["check:deployment"] === "string" ||
                scripts["check:deployment"] instanceof String,
            );
          }
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

    assert.notStrictEqual(addableDefinitions.length, 0);

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

          assert.ok(addedDefinition);
          const packageManifestOperation = addition.operations.find(
            (operation) =>
              operation.kind === "writeJson" &&
              operation.to === `${addedDefinition.path}/package.json`,
          );
          assert.ok(packageManifestOperation);
          assert.ok(packageManifestOperation.kind === "writeJson");
          assert.ok(Object.hasOwn(packageManifestOperation, "value"));
          assert.ok(Object.hasOwn(packageManifestOperation, "provenance"));
          assert.partialDeepStrictEqual(packageManifestOperation.value, {
            name: `@demo/${packageLeafName}`,
          });
          assert.partialDeepStrictEqual(packageManifestOperation.provenance, {
            definitionName: additionDefinition.metadata.name,
            planningContribution: "planPackageAddition",
          });
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
      const rustToolchainArguments =
        dockerfile.match(/^ARG RUST_TOOLCHAIN$/gmu);
      assert.ok(rustToolchainArguments);
      assert.strictEqual(rustToolchainArguments.length, 1);
      const rustupInstalls = dockerfile.match(
        /"\$\{CARGO_HOME\}\/bin\/rustup" toolchain install \$\{RUST_TOOLCHAIN\}/gu,
      );
      assert.ok(rustupInstalls);
      assert.strictEqual(rustupInstalls.length, 1);
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
      assert.strictEqual(
        devcontainer.mounts.filter(
          (mount) => mount.target === "/usr/local/cargo/registry",
        ).length,
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
      assert.ok(
        addition.developmentContainer.buildArguments.some((argument) =>
          isDeepStrictEqual(argument, {
            name: "RUST_TOOLCHAIN",
            value: "1.98.0",
          }),
        ),
      );

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

      assert.partialDeepStrictEqual(rootDeclarationOperation, {
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
      for (const kind of ["rust-toolchain", "playwright-browser-assets"]) {
        assert.ok(
          addition.environmentNeeds.some(
            (need) => Object.hasOwn(need, "kind") && need.kind === kind,
          ),
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
      const environmentNeedsOperation = addition.operations.find(
        (operation) =>
          operation.kind === "writeJson" &&
          operation.to === ".template/environment-needs.json",
      );
      assert.ok(environmentNeedsOperation);
      assert.ok(environmentNeedsOperation.kind === "writeJson");
      assert.ok(Object.hasOwn(environmentNeedsOperation, "value"));
      const environmentNeeds = environmentNeedsOperation.value as {
        schemaVersion: number;
        check: readonly unknown[];
        deployment: readonly unknown[];
      };
      assert.strictEqual(environmentNeeds.schemaVersion, 1);
      assert.deepStrictEqual(environmentNeeds.check, []);
      assert.deepStrictEqual(environmentNeeds.deployment, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
