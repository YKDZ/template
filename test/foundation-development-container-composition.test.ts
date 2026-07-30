import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createGenerationContext,
  builtInPresetRegistry,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  type BuiltInPresetDefinition,
} from "#template-builtin-presets";
import type { DevelopmentContainerToolLayer } from "#template-core/development-container-tool-layer";
import type { PackageContribution } from "#template-core/package-contribution";
import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import {
  createTemplateSourceHandle,
  renderNewProject,
} from "#template-core/renderer";

const fixtureSource = createTemplateSourceHandle(
  path.join(process.cwd(), "test/fixtures/development-container-tool-layers"),
);

function builtInContributions(
  definition: BuiltInPresetDefinition,
  context: ReturnType<typeof createGenerationContext>,
): readonly PackageContribution[] {
  return (
    definition.planInitializationContributions?.(context) ?? [
      definition.planInitialization(context),
    ]
  );
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
): PackageContribution {
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

describe("Foundation Development Container composition", () => {
  it("keeps every generated pnpm store in a persistent volume outside the workspace", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-pnpm-store-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          scope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
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
        expect(pnpmStoreMount).toEqual({
          type: "volume",
          source: "${devcontainerId}-pnpm-store",
          target: "/pnpm/store",
        });
        expect(pnpmStoreMount?.target).not.toContain(
          "${containerWorkspaceFolder}",
        );
        await expect(
          access(path.join(targetDir, ".pnpm-store")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps built-in devcontainer capability facts on Package Contributions", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("/tmp", definition.metadata.name),
        scope: "example",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      });
      const contributions = builtInContributions(definition, context);

      for (const contribution of contributions) {
        const layerIdentities = new Set(
          (contribution.foundation.developmentContainerToolLayers ?? []).map(
            (layer) => layer.identity,
          ),
        );
        if (
          contribution.environmentNeeds.some(
            (need) => need.kind === "playwright-browser-assets",
          )
        ) {
          expect(layerIdentities).toContain("browser-test");
        }
        if (
          contribution.environmentNeeds.some(
            (need) => need.kind === "shellcheck-command",
          )
        ) {
          expect(layerIdentities).toContain("shellcheck");
        }
        if (
          (contribution.deploymentEnvironmentNeeds ?? []).some(
            (need) => need.kind === "docker-engine",
          )
        ) {
          expect(layerIdentities).toContain("docker-client");
        }
      }
    }
  });

  it("does not prepare migrated Development Container tools in generated host workflows", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-workflow-tool-layers-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          scope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
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
        expect(workflow).not.toMatch(
          /dtolnay\/rust-toolchain|Swatinem\/rust-cache|playwright install|apt-get install -y shellcheck/u,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not present migrated Development Container tools as host install next steps", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("/tmp", definition.metadata.name),
        scope: "example",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });

      expect(
        plan.nextStepInstructions.map((step) => step.display).join("\n"),
      ).not.toMatch(
        /rustup toolchain install|playwright install|apt-get install -y shellcheck/u,
      );
    }
  });

  it("composes Rust and browser build arguments from their Package Contributions", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-rust-browser-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const rust = requireBuiltInContribution(
      context,
      (contribution) => contribution.foundation.toolchains.rust !== undefined,
    );
    const browser = requireBuiltInContribution(context, (contribution) =>
      contribution.environmentNeeds.some(
        (need) => need.kind === "playwright-browser-assets",
      ),
    );
    const definition: BuiltInPresetDefinition = {
      metadata: {
        name: "rust-browser-fixture",
        title: "Rust browser fixture",
        description: "Rust and browser Tool Layer composition fixture",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      blueprint: () => ({
        schemaVersion: 2,
        packages: [rust.definition, browser.definition],
      }),
      planInitialization: () => rust,
      planInitializationContributions: () => [rust, browser],
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
      expect(devcontainer.build.args).toMatchObject({
        RUST_TOOLCHAIN: "stable",
        PLAYWRIGHT_CLI_PACKAGE: expect.stringMatching(/^@playwright\/test@/u),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("projects Docker client authority only for repositories with deployment Docker needs", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-deployment-tools-"),
    );

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetDir = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir,
          scope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        });
        const contributions = builtInContributions(definition, context);
        const needsDocker = contributions.some((contribution) =>
          (contribution.deploymentEnvironmentNeeds ?? []).some(
            (need) => need.kind === "docker-engine",
          ),
        );
        const hasDockerClientLayer = contributions.some((contribution) =>
          (contribution.foundation.developmentContainerToolLayers ?? []).some(
            (layer) => layer.identity === "docker-client",
          ),
        );

        const plan = planGeneratedRepositoryInitialization({
          definition,
          context,
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        const dockerfile = await readFile(
          path.join(targetDir, ".devcontainer/Dockerfile"),
          "utf8",
        );
        const devcontainer = JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ) as {
          mounts: { type: string; source: string; target: string }[];
        };
        const dockerSocketMounts = devcontainer.mounts.filter(
          (mount) =>
            mount.source === "/var/run/docker.sock" ||
            mount.target === "/var/run/docker.sock",
        );

        expect(hasDockerClientLayer).toBe(needsDocker);
        expect(
          dockerfile.includes("install -y --no-install-recommends docker.io"),
        ).toBe(needsDocker);
        expect(dockerSocketMounts).toEqual(
          needsDocker
            ? [
                {
                  type: "bind",
                  source: "/var/run/docker.sock",
                  target: "/var/run/docker.sock",
                },
              ]
            : [],
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("plans ordered Docker capability probes only for deployment-capable repositories", () => {
    for (const definition of builtInPresetRegistry.all()) {
      const context = createGenerationContext({
        targetDir: path.join("/tmp", definition.metadata.name),
        scope: "example",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      });
      const plan = planGeneratedRepositoryInitialization({
        definition,
        context,
      });
      const needsDocker = plan.deploymentEnvironmentNeeds.some(
        (need) => need.kind === "docker-engine",
      );
      const dockerProbes = plan.developmentContainer.probes.filter(
        (probe) => probe.command === "docker",
      );

      expect(dockerProbes).toEqual(
        needsDocker
          ? [
              {
                identity: "docker-cli",
                command: "docker",
                args: ["--version"],
                failureMessage:
                  "Docker CLI is unavailable; rebuild the Development Container to install the Docker Client Tool Layer.",
              },
              {
                identity: "docker-daemon",
                command: "docker",
                args: ["version"],
                failureMessage:
                  "Docker daemon is inaccessible through /var/run/docker.sock; verify the host daemon is running and the standard socket is accessible.",
              },
            ]
          : [],
      );
    }
  });

  it("composes a source-backed Tool Layer contributed by a Package Contribution", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const definition: BuiltInPresetDefinition = {
      metadata: {
        name: "fixture",
        title: "Fixture",
        description: "Foundation Tool Layer fixture",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      blueprint: () => ({
        schemaVersion: 2,
        packages: [
          {
            name: "@example/fixture",
            path: "packages/fixture",
            role: "shared-library",
          },
        ],
      }),
      planInitialization: () => ({
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
      expect(
        plan.reconciliation.find(
          (entry) =>
            entry.path === ".devcontainer/devcontainer.json" &&
            entry.driver === "structured",
        ),
      ).toMatchObject({
        identitySets: [
          {
            location: "/mounts",
            identity: {
              kind: "projection",
              members: [
                expect.objectContaining({ identity: "pnpm-store" }),
                expect.objectContaining({ identity: "fixture-cache" }),
              ],
            },
          },
        ],
      });
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      const dockerfile = await readFile(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toMatch(/ARG RUST_TOOLCHAIN/iu);
      await expect(
        readFile(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves unrelated Dockerfile, build argument, and mount customizations during Package Addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-addition-"),
    );
    const targetDir = path.join(workspace, "project");
    const context = createGenerationContext({
      targetDir,
      scope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
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
    const addedDefinition: BuiltInPresetDefinition = {
      metadata: {
        name: "fixture-addition",
        title: "Fixture Addition",
        description: "Adds a fixture Tool Layer",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      blueprint: () => ({ schemaVersion: 2, packages: [] }),
      planInitialization: () => {
        throw new Error("Fixture Addition is addition-only");
      },
      planPackageAddition: ({ packageLeafName, packagePath }) => ({
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
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "native",
        packagePath: "packages/native",
      });
      const conflictingResult = await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });

      expect(conflictingResult).toMatchObject({
        ok: false,
        conflicts: [
          {
            path: ".devcontainer/devcontainer.json",
            driver: "structured",
            location: expect.stringMatching(/^\/mounts\/0\//u),
          },
        ],
      });
      await expect(
        access(path.join(targetDir, "packages/native/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(dockerfilePath, "utf8")).resolves.toBe(
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

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(readFile(dockerfilePath, "utf8")).resolves.toContain(
        "# user container policy",
      );
      const updated = JSON.parse(await readFile(devcontainerPath, "utf8")) as {
        build: { args: Record<string, string> };
        mounts: { target: string }[];
      };
      expect(updated.build.args).toMatchObject({
        USER_BUILD_ARGUMENT: "retained",
        RUST_TOOLCHAIN: "stable",
      });
      expect(updated.mounts.map((mount) => mount.target)).toEqual(
        expect.arrayContaining([
          "/var/cache/user-fixture",
          "/usr/local/cargo/registry",
          "/usr/local/cargo/git",
          "${containerWorkspaceFolder}/target",
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("generates equivalent Development Container output independent of contribution order", async () => {
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
    ): BuiltInPresetDefinition => ({
      metadata: {
        name: "fixture-order",
        title: "Fixture Order",
        description: "Contribution order fixture",
      },
      source: fixtureSource,
      plannerSourceFile: import.meta.filename,
      blueprint: () => ({
        schemaVersion: 2,
        packages: [alpha.definition, omega.definition],
      }),
      planInitialization: () => contributions[0]!,
      planInitializationContributions: () => contributions,
    });
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
          scope: "example",
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

      expect(outputs[1]!.dockerfile).toBe(outputs[0]!.dockerfile);
      expect(outputs[1]!.devcontainer).toEqual(outputs[0]!.devcontainer);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("generates equivalent Development Container output independent of initialization and addition order", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-foundation-tool-layer-addition-order-"),
    );
    const outputs: {
      readonly dockerfile: string;
      readonly devcontainer: unknown;
    }[] = [];
    const selectionContext = createGenerationContext({
      targetDir: path.join(workspace, "selection"),
      scope: "example",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
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
          scope: "example",
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
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
          context,
          blueprint: initialization.blueprint,
          packageLeafName,
          packagePath,
        });
        const result = await reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        });
        expect(result.ok).toBe(true);

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

      expect(outputs[1]!.dockerfile).toBe(outputs[0]!.dockerfile);
      expect(outputs[1]!.devcontainer).toEqual(outputs[0]!.devcontainer);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
