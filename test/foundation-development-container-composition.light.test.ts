import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createGenerationContext,
  builtInPresetRegistry,
  planGeneratedRepositoryInitialization,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryPackageAddition,
  type BuiltInPresetDefinition,
} from "@ykdz/template-builtin-presets";
import type { PackageContribution } from "@ykdz/template-core/package-contribution";
import {
  definePackageContributionReplayAdapter,
  type PackageContributionReplayAdapter,
  type PlannedPackageContribution,
} from "@ykdz/template-core/preset-definition";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import {
  createTemplateSourceHandle,
  renderNewProject,
} from "@ykdz/template-core/renderer";
import type { DevelopmentContainerToolLayer } from "@ykdz/template-environment/development-container-tool-layer";

const fixtureSource = createTemplateSourceHandle(
  path.join(process.cwd(), "test/fixtures/development-container-tool-layers"),
);

function builtInContributions(
  definition: BuiltInPresetDefinition,
  context: ReturnType<typeof createGenerationContext>,
): readonly PlannedPackageContribution[] {
  return planGeneratedRepositoryInitialization({
    definition,
    context,
  }).packageContributions;
}

function requireBuiltInDefinition(
  context: ReturnType<typeof createGenerationContext>,
  predicate: (
    definition: BuiltInPresetDefinition,
    contributions: readonly PackageContribution[],
  ) => boolean,
): BuiltInPresetDefinition {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) =>
      predicate(candidate, builtInContributions(candidate, context)),
    );
  if (definition === undefined) {
    throw new Error("Expected a Built-in Preset matching the capability query");
  }
  return definition;
}

function requireBuiltInContribution(
  context: ReturnType<typeof createGenerationContext>,
  predicate: (contribution: PackageContribution) => boolean,
): PlannedPackageContribution {
  const contribution = builtInPresetRegistry
    .all()
    .flatMap((definition) => builtInContributions(definition, context))
    .find(predicate);
  if (contribution === undefined) {
    throw new Error(
      "Expected a Built-in Package Contribution matching the capability query",
    );
  }
  return contribution;
}

function fixtureReplayAdapter(
  identity: string,
): PackageContributionReplayAdapter {
  return definePackageContributionReplayAdapter({
    identity,
    replay: () => {
      throw new Error(`Fixture replay is not exercised for ${identity}`);
    },
  });
}

function fixtureContribution(options: {
  readonly name: string;
  readonly packagePath: string;
  readonly layer: DevelopmentContainerToolLayer;
}): PackageContribution {
  const packageName = `@example/${options.name}`;
  return {
    definition: {
      name: packageName,
      path: options.packagePath,
      role: "shared-library",
    },
    manifest: {
      name: packageName,
      version: "0.0.0",
      private: true,
      type: "module",
    },
    exposure: { exports: {}, imports: {} },
    operations: [
      {
        kind: "writeJson",
        to: `${options.packagePath}/package.json`,
        value: {
          name: packageName,
          version: "0.0.0",
          private: true,
          type: "module",
        },
      },
    ],
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: {
        ecosystems: ["npm"],
        interval: "weekly",
      },
      developmentContainerToolLayers: [options.layer],
    },
    environmentNeeds: [],
  };
}

void describe("Foundation Development Container composition", () => {
  void it("plans GitHub CLI as a default source-backed Tool Layer", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context: createGenerationContext({
          targetDir: path.join("/tmp", definition.metadata.name),
          defaultPackageScope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        }),
      });

      const githubCliLayer = plan.developmentContainer.toolLayers.find(
        (layer) => layer.identity === "github-cli",
      );
      assert.ok(githubCliLayer !== undefined);
      assert.partialDeepStrictEqual(githubCliLayer, {
        kind: "optional",
        dockerfile: { from: "github-cli.Dockerfile" },
        requires: ["node-pnpm"],
        probes: [
          {
            identity: "github-cli",
            command: "gh",
            args: ["--version"],
          },
        ],
      });
      assert.strictEqual(githubCliLayer.requires?.length, 1);
      assert.strictEqual(githubCliLayer.probes?.length, 1);
      assert.strictEqual(githubCliLayer.probes?.[0]?.args?.length, 1);
    }
  });

  void it("renders the official stable GitHub CLI package without credential automation", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-github-cli-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const plan = planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir,
            defaultPackageScope: "example",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          }),
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        const dockerfile = await readFile(
          path.join(targetDir, ".devcontainer/Dockerfile"),
          "utf8",
        );
        const devcontainer = await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        );

        assert.ok(
          dockerfile.includes("https://cli.github.com/packages stable main"),
        );
        assert.ok(
          dockerfile.includes("apt-get install -y --no-install-recommends gh"),
        );
        assert.doesNotMatch(
          `${dockerfile}\n${devcontainer}`,
          /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b|\.config\/gh|\bgh\s+auth\b|\bauth\s+setup-git\b/u,
        );
        assert.ok(
          !plan.nextStepInstructions.some((instruction) =>
            /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b|\.config\/gh|\bgh\s+auth\b|\bauth\s+setup-git\b/iu.test(
              instruction.display,
            ),
          ),
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps every generated pnpm store in a persistent volume outside the workspace", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-pnpm-store-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          defaultPackageScope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        });
        const plan = planGeneratedRepositoryInitialization({
          definition,
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        const devcontainer = JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ) as {
          mounts: {
            type: string;
            source: string;
            target: string;
          }[];
        };
        const pnpmStoreMount = devcontainer.mounts.find(
          (mount) => mount.source === "${devcontainerId}-pnpm-store",
        );
        assert.deepStrictEqual(pnpmStoreMount, {
          type: "volume",
          source: "${devcontainerId}-pnpm-store",
          target: "/pnpm/store",
        });
        assert.ok(
          !pnpmStoreMount?.target.includes("${containerWorkspaceFolder}"),
        );
        await assert.rejects(
          access(path.join(targetDir, ".pnpm-store")),
          (error) => {
            return (
              typeof error === "object" &&
              error !== null &&
              Object.hasOwn(error, "code") &&
              (error as { readonly code?: unknown }).code === "ENOENT"
            );
          },
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("derives one browser tool layer from native Package Contribution environment needs", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("/tmp", definition.metadata.name),
        defaultPackageScope: "example",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      const needsBrowser = plan.packageContributions.some((contribution) =>
        contribution.environmentNeeds.some(
          (need) => need.kind === "playwright-browser-assets",
        ),
      );
      if (needsBrowser) {
        assert.equal(
          plan.developmentContainer.toolLayers.filter(
            (layer) => layer.identity === "browser-test",
          ).length,
          1,
        );
      }
    }
  });

  void it("does not prepare migrated Development Container tools in generated host workflows", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-workflow-tool-layers-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          defaultPackageScope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        });
        const contributions = builtInContributions(definition, context);
        const migratedNeeds = contributions
          .flatMap((contribution) => contribution.environmentNeeds)
          .filter((need) =>
            [
              "playwright-browser-assets",
              "rust-toolchain",
              "shellcheck-command",
            ].includes(need.kind),
          );
        if (migratedNeeds.length === 0) continue;

        const plan = planGeneratedRepositoryInitialization({
          definition,
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        const workflow = await readFile(
          path.join(targetDir, ".github/workflows/check.yml"),
          "utf8",
        );
        assert.doesNotMatch(
          workflow,
          /dtolnay\/rust-toolchain|Swatinem\/rust-cache|playwright install|apt-get install -y shellcheck/u,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("does not present migrated Development Container tools as host install next steps", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("/tmp", definition.metadata.name),
        defaultPackageScope: "example",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });

      assert.doesNotMatch(
        plan.nextStepInstructions.map((step) => step.display).join("\n"),
        /rustup toolchain install|playwright install|apt-get install -y shellcheck/u,
      );
    }
  });

  void it("composes Rust and browser build arguments from their Package Contributions", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-rust-browser-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    });
    const rust = requireBuiltInContribution(
      context,
      (contribution) => contribution.foundation.toolchains.rust !== undefined,
    );
    const browser = requireBuiltInContribution(
      context,
      (contribution) =>
        contribution.referenceBindings?.["@ykdz/reference-vike-db"] ===
          undefined &&
        contribution.environmentNeeds.some(
          (need) => need.kind === "playwright-browser-assets",
        ),
    );
    const { deploymentCheck: _deploymentCheck, ...browserFoundation } =
      browser.foundation;
    const browserTooling = {
      ...browser,
      foundation: browserFoundation,
    };
    const rustReplayAdapter = fixtureReplayAdapter(rust.definition.path);
    const browserReplayAdapter = fixtureReplayAdapter(
      browserTooling.definition.path,
    );
    const definition: BuiltInPresetDefinition = {
      metadata: {
        name: "rust-browser-fixture",
        title: "Rust browser fixture",
        description: "Rust and browser Tool Layer composition fixture",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      packageContributionReplayAdapters: [
        rustReplayAdapter,
        browserReplayAdapter,
      ],
      blueprint: () => ({
        schemaVersion: 3,
        packages: [rust.definition, browserTooling.definition],
      }),
      planInitialization: () => ({
        ...rust,
        planningIdentity: rustReplayAdapter.identity,
      }),
      planInitializationContributions: () => [
        { ...rust, planningIdentity: rustReplayAdapter.identity },
        {
          ...browserTooling,
          planningIdentity: browserReplayAdapter.identity,
        },
      ],
    };

    try {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      const devcontainer = JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { build: { args: Record<string, string> } };
      assert.strictEqual(devcontainer.build.args.RUST_TOOLCHAIN, "stable");
      assert.match(
        devcontainer.build.args.PLAYWRIGHT_CLI_PACKAGE ?? "",
        /^@playwright\/test@/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("composes a source-backed Tool Layer contributed by a Package Contribution", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const replayAdapter = fixtureReplayAdapter("fixture");
    const definition: BuiltInPresetDefinition = {
      metadata: {
        name: "fixture",
        title: "Fixture",
        description: "Foundation Tool Layer fixture",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      packageContributionReplayAdapters: [replayAdapter],
      blueprint: () => ({
        schemaVersion: 3,
        packages: [
          {
            name: "@example/fixture",
            path: "packages/fixture",
            role: "shared-library",
          },
        ],
      }),
      planInitialization: () => ({
        planningIdentity: replayAdapter.identity,
        definition: {
          name: "@example/fixture",
          path: "packages/fixture",
          role: "shared-library",
        },
        manifest: {
          name: "@example/fixture",
          version: "0.0.0",
          private: true,
          type: "module",
        },
        exposure: { exports: {}, imports: {} },
        operations: [
          {
            kind: "writeJson",
            to: "packages/fixture/package.json",
            value: {
              name: "@example/fixture",
              version: "0.0.0",
              private: true,
              type: "module",
            },
          },
        ],
        foundation: {
          toolchains: {},
          editorCapabilities: [],
          dependencyMaintenance: {
            ecosystems: ["npm"],
            interval: "weekly",
          },
          developmentContainerToolLayers: [
            {
              identity: "fixture-tool",
              dockerfile: {
                source: fixtureSource,
                from: "rust.Dockerfile",
              },
              requires: ["node-pnpm"],
              buildArguments: [
                { name: "RUST_TOOLCHAIN", value: "fixture-value" },
              ],
              mounts: [
                {
                  identity: "fixture-cache",
                  type: "volume",
                  source: "${devcontainerId}-fixture",
                  target: "/var/cache/fixture",
                },
              ],
            },
          ],
        },
        environmentNeeds: [],
      }),
    };

    try {
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      const toolLayerReconciliation = plan.reconciliation.find(
        (entry) =>
          entry.path === ".devcontainer/devcontainer.json" &&
          entry.driver === "structured",
      );
      assert.ok(
        toolLayerReconciliation !== undefined &&
          toolLayerReconciliation.driver === "structured",
      );
      assert.strictEqual(toolLayerReconciliation.identitySets?.length, 1);
      const mountIdentitySet = toolLayerReconciliation.identitySets?.[0];
      assert.ok(mountIdentitySet !== undefined);
      assert.strictEqual(mountIdentitySet.location, "/mounts");
      assert.strictEqual(mountIdentitySet.identity.kind, "projection");
      assert.deepStrictEqual(
        mountIdentitySet.identity.members.map(({ identity }) => identity),
        ["pnpm-store", "fixture-cache"],
      );
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      const dockerfile = await readFile(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.match(dockerfile, /ARG RUST_TOOLCHAIN/iu);
      const renderedDevcontainer = JSON.parse(
        await readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      );
      assert.partialDeepStrictEqual(renderedDevcontainer, {
        build: {
          args: {
            RUST_TOOLCHAIN: "fixture-value",
          },
        },
        mounts: [
          {
            type: "volume",
            source: "${devcontainerId}-pnpm-store",
            target: "/pnpm/store",
          },
          {
            type: "volume",
            source: "${devcontainerId}-fixture",
            target: "/var/cache/fixture",
          },
        ],
      });
      assert.strictEqual(renderedDevcontainer.mounts.length, 2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("preserves unrelated Dockerfile, build argument, and mount customizations during Package Addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    });
    const initialDefinition = requireBuiltInDefinition(
      context,
      (_definition, contributions) =>
        contributions.every(
          (contribution) =>
            (contribution.foundation.developmentContainerToolLayers?.length ??
              0) === 0,
        ),
    );
    const additionReplayAdapter = fixtureReplayAdapter("fixture-addition");
    const addedDefinition: BuiltInPresetDefinition = {
      metadata: {
        name: "fixture-addition",
        title: "Fixture Addition",
        description: "Adds a fixture Tool Layer",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      packageContributionReplayAdapters: [additionReplayAdapter],
      blueprint: () => ({ schemaVersion: 3, packages: [] }),
      planInitialization: () => {
        throw new Error("Fixture Addition is addition-only");
      },
      planPackageAddition: ({ packageLeafName, packagePath }) => ({
        planningIdentity: additionReplayAdapter.identity,
        definition: {
          name: `@example/${packageLeafName}`,
          path: packagePath,
          role: "native-package",
        },
        manifest: {
          name: `@example/${packageLeafName}`,
          version: "0.0.0",
          private: true,
          type: "module",
        },
        exposure: { exports: {}, imports: {} },
        operations: [
          {
            kind: "writeJson",
            to: `${packagePath}/package.json`,
            value: {
              name: `@example/${packageLeafName}`,
              version: "0.0.0",
              private: true,
              type: "module",
            },
          },
        ],
        foundation: {
          toolchains: {},
          editorCapabilities: [],
          dependencyMaintenance: {
            ecosystems: ["npm"],
            interval: "weekly",
          },
          developmentContainerToolLayers: [
            {
              identity: "fixture-native-tool",
              dockerfile: {
                source: fixtureSource,
                from: "rust.Dockerfile",
              },
              buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
              mounts: [
                {
                  identity: "fixture-registry",
                  type: "volume",
                  source: "${devcontainerId}-fixture-registry",
                  target: "/usr/local/cargo/registry",
                },
                {
                  identity: "fixture-git",
                  type: "volume",
                  source: "${devcontainerId}-fixture-git",
                  target: "/usr/local/cargo/git",
                },
                {
                  identity: "fixture-target",
                  type: "volume",
                  source: "${devcontainerId}-fixture-target",
                  target: "${containerWorkspaceFolder}/target",
                },
              ],
            },
          ],
        },
        environmentNeeds: [],
      }),
    };

    try {
      const initialization = planGeneratedRepositoryInitialization({
        definition: initialDefinition,
        context,
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });

      const dockerfilePath = path.join(targetDir, ".devcontainer/Dockerfile");
      const customizedDockerfile = `# user container policy\n${await readFile(
        dockerfilePath,
        "utf8",
      )}`;
      await writeFile(dockerfilePath, customizedDockerfile);
      const devcontainerPath = path.join(
        targetDir,
        ".devcontainer/devcontainer.json",
      );
      const devcontainer = JSON.parse(
        await readFile(devcontainerPath, "utf8"),
      ) as {
        build: { args: Record<string, string> };
        mounts?: unknown[];
      };
      devcontainer.build.args.USER_BUILD_ARGUMENT = "retained";
      devcontainer.mounts = [
        {
          type: "bind",
          source: "${localEnv:HOME}/.fixture",
          target: "/usr/local/cargo/registry",
        },
      ];
      await writeFile(
        devcontainerPath,
        `${JSON.stringify(devcontainer, null, 2)}\n`,
      );

      const addition = planGeneratedRepositoryPackageAddition({
        definition: addedDefinition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName: "native",
        packagePath: "packages/native",
      });
      const conflictingResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(conflictingResult.ok, false);
      assert.strictEqual(conflictingResult.conflicts.length, 1);
      const conflict = conflictingResult.conflicts[0];
      assert.ok(conflict !== undefined);
      assert.partialDeepStrictEqual(conflict, {
        path: ".devcontainer/devcontainer.json",
        driver: "structured",
      });
      assert.ok(typeof conflict.location === "string");
      assert.match(conflict.location, /^\/mounts\/0\//u);
      await assert.rejects(
        access(path.join(targetDir, "packages/native/package.json")),
        (error) => {
          return (
            typeof error === "object" &&
            error !== null &&
            Object.hasOwn(error, "code") &&
            (error as { readonly code?: unknown }).code === "ENOENT"
          );
        },
      );
      assert.strictEqual(
        await readFile(dockerfilePath, "utf8"),
        customizedDockerfile,
      );

      devcontainer.mounts = [
        {
          type: "bind",
          source: "${localEnv:HOME}/.fixture",
          target: "/var/cache/user-fixture",
        },
      ];
      await writeFile(
        devcontainerPath,
        `${JSON.stringify(devcontainer, null, 2)}\n`,
      );
      const result = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.ok(
        (await readFile(dockerfilePath, "utf8")).includes(
          "# user container policy",
        ),
      );
      const updated = JSON.parse(await readFile(devcontainerPath, "utf8")) as {
        build: { args: Record<string, string> };
        mounts: { target: string }[];
      };
      assert.partialDeepStrictEqual(updated.build.args, {
        USER_BUILD_ARGUMENT: "retained",
        RUST_TOOLCHAIN: "stable",
      });
      const updatedMountTargets = updated.mounts.map((mount) => mount.target);
      assert.ok(updatedMountTargets.includes("/var/cache/user-fixture"));
      assert.ok(updatedMountTargets.includes("/usr/local/cargo/registry"));
      assert.ok(updatedMountTargets.includes("/usr/local/cargo/git"));
      assert.ok(
        updatedMountTargets.includes("${containerWorkspaceFolder}/target"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("generates equivalent Development Container output independent of contribution order", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-order-"),
    );
    const alpha = fixtureContribution({
      name: "alpha",
      packagePath: "packages/alpha",
      layer: {
        identity: "alpha-tool",
        dockerfile: { source: fixtureSource, from: "run-only.Dockerfile" },
        mounts: [
          {
            identity: "alpha-cache",
            type: "volume",
            source: "${devcontainerId}-alpha",
            target: "/var/cache/alpha",
          },
        ],
      },
    });
    const omega = fixtureContribution({
      name: "omega",
      packagePath: "packages/omega",
      layer: {
        identity: "omega-tool",
        dockerfile: { source: fixtureSource, from: "rust.Dockerfile" },
        buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
        mounts: [
          {
            identity: "omega-cache",
            type: "volume",
            source: "${devcontainerId}-omega",
            target: "/var/cache/omega",
          },
        ],
      },
    });

    const definition = (
      contributions: readonly PackageContribution[],
    ): BuiltInPresetDefinition => {
      const adapters = contributions.map((contribution) =>
        fixtureReplayAdapter(contribution.definition.path),
      );
      const identify = (
        contribution: PackageContribution,
      ): PlannedPackageContribution => ({
        ...contribution,
        planningIdentity: contribution.definition.path,
      });
      return {
        metadata: {
          name: "fixture-order",
          title: "Fixture Order",
          description: "Contribution order fixture",
        },
        source: fixtureSource,
        plannerSourceFile: import.meta.filename,
        packageContributionReplayAdapters: adapters,
        blueprint: () => ({
          schemaVersion: 3,
          packages: [alpha.definition, omega.definition],
        }),
        planInitialization: () => identify(contributions[0]!),
        planInitializationContributions: () => contributions.map(identify),
      };
    };
    const outputs: {
      readonly dockerfile: string;
      readonly devcontainer: unknown;
    }[] = [];

    try {
      for (const [directory, contributions] of [
        ["first/project", [alpha, omega]],
        ["second/project", [omega, alpha]],
      ] as const) {
        const targetDir = path.join(workspace, directory);
        const context = createGenerationContext({
          targetDir,
          defaultPackageScope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        });
        const plan = planGeneratedRepositoryInitialization({
          definition: definition(contributions),
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });
        outputs.push({
          dockerfile: await readFile(
            path.join(targetDir, ".devcontainer/Dockerfile"),
            "utf8",
          ),
          devcontainer: JSON.parse(
            await readFile(
              path.join(targetDir, ".devcontainer/devcontainer.json"),
              "utf8",
            ),
          ),
        });
      }

      assert.strictEqual(outputs[1]!.dockerfile, outputs[0]!.dockerfile);
      assert.deepStrictEqual(
        outputs[1]!.devcontainer,
        outputs[0]!.devcontainer,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("generates equivalent Development Container output independent of initialization and addition order", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-addition-order-"),
    );
    const outputs: {
      readonly dockerfile: string;
      readonly devcontainer: unknown;
    }[] = [];
    const selectionContext = createGenerationContext({
      targetDir: path.join(workspace, "selection"),
      defaultPackageScope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    });
    const plainDefinition = requireBuiltInDefinition(
      selectionContext,
      (definition, contributions) =>
        definition.planPackageAddition !== undefined &&
        contributions.every(
          (contribution) =>
            (contribution.foundation.developmentContainerToolLayers?.length ??
              0) === 0,
        ),
    );
    const browserDefinition = requireBuiltInDefinition(
      selectionContext,
      (definition, contributions) =>
        definition.planPackageAddition !== undefined &&
        contributions.some((contribution) =>
          contribution.environmentNeeds.some(
            (need) => need.kind === "playwright-browser-assets",
          ),
        ),
    );
    const orderings = [
      {
        directory: "first/project",
        initialDefinition: plainDefinition,
        addedDefinition: browserDefinition,
      },
      {
        directory: "second/project",
        initialDefinition: browserDefinition,
        addedDefinition: plainDefinition,
      },
    ] as const;

    try {
      for (const {
        directory,
        initialDefinition,
        addedDefinition,
      } of orderings) {
        const targetDir = path.join(workspace, directory);
        const context = createGenerationContext({
          targetDir,
          defaultPackageScope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        });
        const initialization = planGeneratedRepositoryInitialization({
          definition: initialDefinition,
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...initialization.operations],
        });
        const packageLeafName = "added";
        const packagePath = addedDefinition.defaultPackagePath?.({
          context,
          packageLeafName,
        });
        if (packagePath === undefined) {
          throw new Error("Expected the selected Preset to be addable");
        }
        const addition = planGeneratedRepositoryPackageAddition({
          definition: addedDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
          packageLeafName,
          packagePath,
        });
        const result = await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        });
        assert.strictEqual(result.ok, true);

        outputs.push({
          dockerfile: await readFile(
            path.join(targetDir, ".devcontainer/Dockerfile"),
            "utf8",
          ),
          devcontainer: JSON.parse(
            await readFile(
              path.join(targetDir, ".devcontainer/devcontainer.json"),
              "utf8",
            ),
          ),
        });
      }

      assert.strictEqual(outputs[1]!.dockerfile, outputs[0]!.dockerfile);
      assert.deepStrictEqual(
        outputs[1]!.devcontainer,
        outputs[0]!.devcontainer,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
