import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PresetSourceManifest } from "@ykdz/template-builtin-source";
import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import {
  errorForFailedGeneratedScenario,
  fixtureConcurrency,
  generatedScenarioChildProcessEnv,
  generatedScenarioEnvironmentNeedSteps,
  generatedScenarioId,
  generatedScenarioQualityGateSteps,
  generatedScenarioRequiresSerializedRootCheck,
  packageLeafNameForAddedPreset,
  runGeneratedScenarioSet,
  runGeneratedScenariosConcurrently,
  selectGeneratedScenarios,
} from "@ykdz/template-core/generated-scenarios";
import { playwrightBrowserAssetsEnvironmentNeed } from "@ykdz/template-core/module-graph";
import { PackageAdditionSupport } from "@ykdz/template-shared";

function matrixPairKey(input: {
  readonly basePreset: string;
  readonly addedPreset: string;
}): string {
  return `${input.basePreset}\0${input.addedPreset}`;
}

function minimalManifest(): PresetSourceManifest {
  return {
    schemaVersion: 1,
    name: "test-source",
    sharedResources: [],
    presets: [
      {
        name: "base",
        title: "Base",
        description: "Base preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Unsupported,
        features: ["root-check"],
      },
      {
        name: "addon",
        title: "Addon",
        description: "Addon preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Supported,
        features: ["root-check"],
      },
      {
        name: "blocked",
        title: "Blocked",
        description: "Blocked preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Unsupported,
        features: ["root-check"],
      },
    ],
  };
}

function manifestWithoutFixtureMatrix(): PresetSourceManifest {
  const manifest = minimalManifest();

  return {
    ...manifest,
    presets: [
      ...manifest.presets,
      {
        name: "future",
        title: "Future",
        description: "Future preset.",
        generation: "future",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Unsupported,
        features: ["root-check"],
      },
    ],
  };
}

function manifestWithLinkableProductionFacts(): PresetSourceManifest {
  return {
    schemaVersion: 1,
    name: "test-source",
    sharedResources: [],
    presets: [
      {
        name: "web-workspace",
        title: "Web workspace",
        description: "Workspace with a web package.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Unsupported,
        features: ["root-check"],
        projection: {
          capabilities: [
            {
              kind: "workspace-node-packages",
              workspacePackageGlob: "apps/*",
              packages: [
                {
                  kind: "vue-app",
                  path: "apps/web",
                  sourceFiles: ["src/main.ts"],
                },
              ],
            },
          ],
        },
      },
      {
        name: "library",
        title: "Library",
        description: "Addable TypeScript library.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Supported,
        features: ["root-check"],
        projection: {
          capabilities: [
            {
              kind: "workspace-library-package",
              workspacePackageGlob: "packages/*",
              packageRole: "shared-library",
              packageSourcePreset: "ts-lib",
              sourceFiles: ["src/index.ts"],
            },
          ],
        },
      },
    ],
  };
}

function manifestWithApiConsumerProductionFacts(): PresetSourceManifest {
  return {
    schemaVersion: 1,
    name: "test-source",
    sharedResources: [],
    presets: [
      {
        name: "api-workspace",
        title: "API workspace",
        description: "Workspace with an API package.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Unsupported,
        features: ["root-check"],
        projection: {
          capabilities: [
            {
              kind: "workspace-node-packages",
              workspacePackageGlob: "apps/*",
              packages: [
                {
                  kind: "hono-api",
                  path: "apps/api",
                  sourceFiles: ["src/server.ts"],
                },
              ],
            },
          ],
        },
      },
      {
        name: "library",
        title: "Library",
        description: "Addable TypeScript library.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: PackageAdditionSupport.Supported,
        features: ["root-check"],
        projection: {
          capabilities: [
            {
              kind: "workspace-library-package",
              workspacePackageGlob: "packages/*",
              packageRole: "shared-library",
              packageSourcePreset: "ts-lib",
              sourceFiles: ["src/index.ts"],
            },
          ],
        },
      },
    ],
  };
}

describe("generated scenarios", () => {
  it("does not pass conflicting color environment variables to child checks", () => {
    const env = generatedScenarioChildProcessEnv({
      FORCE_COLOR: "1",
      NO_COLOR: "1",
    });

    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });

  it("derives the init-only scenario set from supported production Presets", () => {
    expect(
      selectGeneratedScenarios(manifestWithoutFixtureMatrix(), "init"),
    ).toEqual({
      runnable: [
        {
          set: "init",
          basePreset: "base",
          id: "base",
          label: "base",
        },
        {
          set: "init",
          basePreset: "addon",
          id: "addon",
          label: "addon",
        },
        {
          set: "init",
          basePreset: "blocked",
          id: "blocked",
          label: "blocked",
        },
      ],
      skipped: [],
    });
  });

  it("automatically gives new supported initialization Presets init scenario coverage", () => {
    const manifest = minimalManifest();
    const before = selectGeneratedScenarios(manifest, "init").runnable.map(
      (scenario) => scenario.id,
    );

    manifest.presets.push({
      name: "new-init-preset",
      title: "New init preset",
      description: "A new supported initialization preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: PackageAdditionSupport.Unsupported,
      features: ["root-check"],
    });

    const after = selectGeneratedScenarios(manifest, "init").runnable.map(
      (scenario) => scenario.id,
    );

    expect(before).not.toContain("new-init-preset");
    expect(after).toEqual([...before, "new-init-preset"]);
  });

  it("derives Package Addition matrix scenarios from supported initialization Presets crossed with addable Presets", () => {
    expect(
      selectGeneratedScenarios(
        manifestWithoutFixtureMatrix(),
        "package-addition-matrix",
      ),
    ).toEqual({
      runnable: [
        {
          set: "package-addition-matrix",
          basePreset: "base",
          addedPreset: "addon",
          id: "base-add-addon",
          label: "base + addon",
        },
        {
          set: "package-addition-matrix",
          basePreset: "addon",
          addedPreset: "addon",
          id: "addon-add-addon",
          label: "addon + addon",
        },
        {
          set: "package-addition-matrix",
          basePreset: "blocked",
          addedPreset: "addon",
          id: "blocked-add-addon",
          label: "blocked + addon",
        },
      ],
      skipped: [],
    });
  });

  it("automatically gives new addable Presets Package Addition matrix coverage", () => {
    const manifest = minimalManifest();
    const before = new Set(
      selectGeneratedScenarios(
        manifest,
        "package-addition-matrix",
      ).runnable.map((scenario) =>
        matrixPairKey({
          basePreset: scenario.basePreset,
          addedPreset: scenario.addedPreset!,
        }),
      ),
    );

    manifest.presets.push({
      name: "new-addable-preset",
      title: "New addable preset",
      description: "A new supported addable preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: PackageAdditionSupport.Supported,
      features: ["root-check"],
    });

    const after = new Set(
      selectGeneratedScenarios(
        manifest,
        "package-addition-matrix",
      ).runnable.map((scenario) =>
        matrixPairKey({
          basePreset: scenario.basePreset,
          addedPreset: scenario.addedPreset!,
        }),
      ),
    );

    expect(before).not.toContain(
      matrixPairKey({
        basePreset: "base",
        addedPreset: "new-addable-preset",
      }),
    );
    expect(after).toEqual(
      new Set([
        ...before,
        matrixPairKey({
          basePreset: "base",
          addedPreset: "new-addable-preset",
        }),
        matrixPairKey({
          basePreset: "addon",
          addedPreset: "new-addable-preset",
        }),
        matrixPairKey({
          basePreset: "blocked",
          addedPreset: "new-addable-preset",
        }),
        matrixPairKey({
          basePreset: "new-addable-preset",
          addedPreset: "addon",
        }),
        matrixPairKey({
          basePreset: "new-addable-preset",
          addedPreset: "new-addable-preset",
        }),
      ]),
    );
  });

  it("derives link-focused Package Addition scenarios from production package facts", () => {
    expect(
      selectGeneratedScenarios(
        manifestWithLinkableProductionFacts(),
        "package-addition-matrix",
      ),
    ).toEqual({
      runnable: expect.arrayContaining([
        {
          set: "focused",
          basePreset: "web-workspace",
          addedPreset: "library",
          linkFrom: ["apps/web"],
          id: "web-workspace-add-library-link-from-apps-web",
          label: "web-workspace + library linked from apps/web",
        },
      ]),
      skipped: [],
    });
  });

  it("derives focused Package Link Intent consumers through production link planning", () => {
    expect(
      selectGeneratedScenarios(
        manifestWithApiConsumerProductionFacts(),
        "package-addition-matrix",
      ),
    ).toEqual({
      runnable: expect.arrayContaining([
        {
          set: "focused",
          basePreset: "api-workspace",
          addedPreset: "library",
          linkFrom: ["apps/api"],
          id: "api-workspace-add-library-link-from-apps-api",
          label: "api-workspace + library linked from apps/api",
        },
      ]),
      skipped: [],
    });
  });

  it("does not need built-in Fixture Matrix link entries for Package Link Intent coverage", () => {
    const manifest = loadBuiltInPresetSourceManifest();

    expect(Object.hasOwn(manifest, "fixtureMatrix")).toBe(false);
    expect(
      selectGeneratedScenarios(manifest, "package-addition-matrix"),
    ).toEqual({
      runnable: expect.arrayContaining([
        {
          set: "focused",
          basePreset: "vue-hono-app",
          addedPreset: "ts-lib",
          linkFrom: ["apps/web"],
          id: "vue-hono-app-add-ts-lib-link-from-apps-web",
          label: "vue-hono-app + ts-lib linked from apps/web",
        },
      ]),
      skipped: [],
    });
  });

  it("excludes init-only scenarios from the Package Addition matrix", () => {
    const selection = selectGeneratedScenarios(
      minimalManifest(),
      "package-addition-matrix",
    );

    expect(selection.runnable.every((scenario) => scenario.addedPreset)).toBe(
      true,
    );
    expect(selection.runnable.map((scenario) => scenario.id)).not.toContain(
      "base",
    );
  });

  it("derives deterministic Package Addition leaf names from the added Preset", () => {
    expect(
      packageLeafNameForAddedPreset(manifestWithoutFixtureMatrix(), "addon"),
    ).toBe("fixture-addon");
  });

  it("runs fixture scenarios with existing bounded parallelism by default", () => {
    const previous = process.env.TEMPLATE_FIXTURE_CONCURRENCY;

    try {
      delete process.env.TEMPLATE_FIXTURE_CONCURRENCY;
      expect(fixtureConcurrency(20)).toBe(2);

      process.env.TEMPLATE_FIXTURE_CONCURRENCY = "8";
      expect(fixtureConcurrency(20)).toBe(8);
      expect(fixtureConcurrency(3)).toBe(3);
    } finally {
      if (previous === undefined) {
        delete process.env.TEMPLATE_FIXTURE_CONCURRENCY;
      } else {
        process.env.TEMPLATE_FIXTURE_CONCURRENCY = previous;
      }
    }
  });

  it("keeps generated scenario serialization on environment need kind metadata", () => {
    expect(
      generatedScenarioRequiresSerializedRootCheck([
        {
          id: "prepare-browser-assets",
          command: "pnpm",
          args: ["exec", "playwright", "install", "chromium"],
          cwd: "/project",
          display: "pnpm exec playwright install chromium",
          environmentNeedKind: "playwright-browser-assets",
        },
      ]),
    ).toBe(true);

    expect(
      generatedScenarioRequiresSerializedRootCheck([
        {
          id: "install-apps-web-playwright-browsers",
          command: "pnpm",
          args: ["run", "check"],
          cwd: "/project",
          display: "pnpm run check",
        },
      ]),
    ).toBe(false);
  });

  it("only turns machine-verifiable environment needs into generated scenario steps", () => {
    const steps = generatedScenarioEnvironmentNeedSteps(
      [
        playwrightBrowserAssetsEnvironmentNeed({
          browser: "chromium",
          owner: { kind: "package-boundary", path: "apps/web" },
          id: "prepare-browser-assets",
          label: "Prepare browser assets",
          machineVerifiable: true,
        }),
        playwrightBrowserAssetsEnvironmentNeed({
          browser: "chromium",
          owner: { kind: "package-boundary", path: "apps/admin" },
          id: "manual-browser-assets",
          label: "Manually prepare browser assets",
          machineVerifiable: false,
        }),
      ],
      "/project",
    );

    expect(steps).toEqual([
      {
        id: "prepare-browser-assets",
        command: "pnpm",
        args: [
          "--filter",
          "./apps/web",
          "exec",
          "playwright",
          "install",
          "chromium",
        ],
        cwd: "/project",
        display: "pnpm --filter ./apps/web exec playwright install chromium",
        environmentNeedKind: "playwright-browser-assets",
      },
    ]);
  });

  it("derives generated scenario browser preparation from generated Check Plans instead of fixture manifest fields", () => {
    const manifest = loadBuiltInPresetSourceManifest();

    expect(Object.hasOwn(manifest, "fixtureMatrix")).toBe(false);

    const selectedScenarios = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    );
    expect(selectedScenarios.runnable.length).toBeGreaterThan(0);

    const scenario = selectedScenarios.runnable.find(
      (candidate) =>
        candidate.basePreset === "ts-lib" &&
        candidate.addedPreset === "vue-app",
    );

    if (!scenario) {
      throw new Error("Expected ts-lib + vue-app generated scenario");
    }

    const steps = generatedScenarioQualityGateSteps(
      manifest,
      scenario,
      "/generated-repository",
      "apps/fixture-vue-app",
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      },
    );

    expect(steps).toContainEqual(
      expect.objectContaining({
        args: [
          "--filter",
          "./apps/fixture-vue-app",
          "exec",
          "playwright",
          "install",
          "chromium",
        ],
        environmentNeedKind: "playwright-browser-assets",
      }),
    );
  });

  it("does not run browser preparation for scenarios whose generated Check Plans do not require it", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "ts-lib" && candidate.addedPreset === "ts-lib",
    );

    const steps = generatedScenarioQualityGateSteps(
      manifest,
      scenario!,
      "/generated-repository",
      "packages/fixture-ts-lib",
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      },
    );

    expect(
      steps.some(
        (step) => step.environmentNeedKind === "playwright-browser-assets",
      ),
    ).toBe(false);
  });

  it("derives additive deployment checks for Vike Fixture Matrix scenarios from the generated Check Plan", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "vike-app" &&
        candidate.addedPreset === "ts-lib" &&
        candidate.linkFrom === undefined,
    );

    if (!scenario) {
      throw new Error("Expected vike-app + ts-lib generated scenario");
    }

    const steps = generatedScenarioQualityGateSteps(
      manifest,
      scenario,
      "/generated-repository",
      "packages/fixture-ts-lib",
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      },
    );
    const rootCheckIndex = steps.findIndex(
      (step) => step.id === "run-root-check",
    );
    const dockerIndex = steps.findIndex(
      (step) => step.environmentNeedKind === "docker-engine",
    );
    const deploymentIndex = steps.findIndex(
      (step) => step.id === "run-deployment-check",
    );

    expect(rootCheckIndex).toBeGreaterThanOrEqual(0);
    expect(dockerIndex).toBeGreaterThan(rootCheckIndex);
    expect(deploymentIndex).toBeGreaterThan(dockerIndex);
    expect(steps[deploymentIndex]).toEqual({
      id: "run-deployment-check",
      command: "pnpm",
      args: ["run", "check:deployment"],
      cwd: "/generated-repository",
      display: "pnpm run check:deployment",
      phase: "deployment",
    });
  });

  it("does not add Docker work to Fixture Matrix scenarios without a deployment check", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "ts-lib" && candidate.addedPreset === "ts-lib",
    );

    const steps = generatedScenarioQualityGateSteps(
      manifest,
      scenario!,
      "/generated-repository",
      "packages/fixture-ts-lib",
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      },
    );

    expect(
      steps.some(
        (step) =>
          step.environmentNeedKind === "docker-engine" ||
          step.id === "run-deployment-check",
      ),
    ).toBe(false);
  });

  it("keeps Docker out of init-only generated checks for deployment-capable Presets", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(manifest, "init").runnable.find(
      (candidate) => candidate.basePreset === "vike-app",
    );
    const steps = generatedScenarioQualityGateSteps(
      manifest,
      scenario!,
      "/generated-repository",
      undefined,
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
      },
    );

    expect(
      steps.some(
        (step) =>
          step.environmentNeedKind === "docker-engine" ||
          step.id === "run-deployment-check",
      ),
    ).toBe(false);
  });

  it("derives built-in Package Addition scenarios without manifest semantic skips", () => {
    const selection = selectGeneratedScenarios(
      loadBuiltInPresetSourceManifest(),
      "package-addition-matrix",
    );

    expect(selection.runnable.every((scenario) => scenario.addedPreset)).toBe(
      true,
    );
    expect(selection.skipped).toEqual([]);
  });

  it("proves built-in Package Addition Universality for supported initialization Presets and addable Presets", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const initSupportedPresets = manifest.presets
      .filter((preset) => preset.generation === "supported")
      .map((preset) => preset.name);
    const packageAdditionSupportedPresets = new Set(
      manifest.presets
        .filter(
          (preset) =>
            preset.packageAdditionSupport === PackageAdditionSupport.Supported,
        )
        .map((preset) => preset.name),
    );
    const expectedPairs = new Set(
      initSupportedPresets.flatMap((basePreset) =>
        [...packageAdditionSupportedPresets].map((addedPreset) =>
          matrixPairKey({ basePreset, addedPreset }),
        ),
      ),
    );
    const selection = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    );
    const plainMatrixScenarios = selection.runnable.filter(
      (scenario) =>
        scenario.set === "package-addition-matrix" &&
        scenario.linkFrom === undefined,
    );
    const runnablePairs = new Set(
      plainMatrixScenarios.map((scenario) =>
        matrixPairKey({
          basePreset: scenario.basePreset,
          addedPreset: scenario.addedPreset!,
        }),
      ),
    );

    expect(selection.skipped).toEqual([]);
    expect(plainMatrixScenarios).toHaveLength(expectedPairs.size);
    expect(runnablePairs).toEqual(expectedPairs);
    for (const scenario of plainMatrixScenarios) {
      expect(packageAdditionSupportedPresets.has(scenario.addedPreset!)).toBe(
        true,
      );
    }
  });

  it("wraps runner failures with the preset combination label", () => {
    const scenario = selectGeneratedScenarios(
      minimalManifest(),
      "package-addition-matrix",
    ).runnable.find((candidate) => candidate.addedPreset === "addon");

    const error = errorForFailedGeneratedScenario(
      scenario!,
      new Error("inner"),
    );

    expect(error.message).toBe("Fixture scenario failed: base + addon");
    expect(error.cause).toBeInstanceOf(Error);
    if (!(error.cause instanceof Error)) {
      throw new Error("Expected generated scenario error cause.");
    }
    expect(error.cause.message).toBe("inner");
  });

  it("wraps init runner failures with the initialization preset label", () => {
    const scenario = selectGeneratedScenarios(minimalManifest(), "init")
      .runnable[0]!;

    const error = errorForFailedGeneratedScenario(scenario, new Error("inner"));

    expect(error.message).toBe("Fixture scenario failed: base");
    expect(error.cause).toBeInstanceOf(Error);
    if (!(error.cause instanceof Error)) {
      throw new Error("Expected generated scenario error cause.");
    }
    expect(error.cause.message).toBe("inner");
  });

  it("runs selected scenarios through the shared runner", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "generated-scenario-runner-"),
    );
    const scenario = selectGeneratedScenarios(
      loadBuiltInPresetSourceManifest(),
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "ts-lib" && candidate.addedPreset === "ts-lib",
    );
    const commands: string[] = [];

    await runGeneratedScenariosConcurrently(
      loadBuiltInPresetSourceManifest(),
      [scenario!],
      workspace,
      1,
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
        runCommand: async (command, args, cwd) => {
          commands.push(`${cwd}: ${command} ${args.join(" ")}`);

          if (args[2] !== "add") {
            return;
          }

          await mkdir(path.join(cwd, ".template"), { recursive: true });
          await writeFile(
            path.join(cwd, ".template", "blueprint.json"),
            JSON.stringify({
              packages: [
                { name: "fixture-ts-lib", path: "packages/fixture-ts-lib" },
              ],
            }),
            "utf8",
          );
        },
        reporter: {},
      },
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "node --conditions=source /repo/packages/cli/src/cli.ts init",
        ),
        expect.stringContaining(
          "node --conditions=source /repo/packages/cli/src/cli.ts add package --preset ts-lib --name fixture-ts-lib",
        ),
        expect.stringContaining(
          "pnpm install --lockfile-only --prefer-offline --no-frozen-lockfile",
        ),
        expect.stringContaining("pnpm fetch"),
        expect.stringContaining("pnpm install --offline --frozen-lockfile"),
        expect.stringContaining("pnpm run fix"),
        expect.stringContaining("pnpm run check"),
      ]),
    );
  });

  it("runs a generated deployment command after the Root Check when Docker is available", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "vike-app" &&
        candidate.addedPreset === "ts-lib" &&
        candidate.linkFrom === undefined,
    );
    const workspace = await mkdtemp(
      path.join(tmpdir(), "generated-deployment-runner-"),
    );
    const commands: string[] = [];

    await runGeneratedScenariosConcurrently(
      manifest,
      [scenario!],
      workspace,
      1,
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
        runCommand: async (command, args, cwd) => {
          commands.push(`${command} ${args.join(" ")}`);

          if (args[2] !== "add") {
            return;
          }

          await mkdir(path.join(cwd, ".template"), { recursive: true });
          await writeFile(
            path.join(cwd, ".template", "blueprint.json"),
            JSON.stringify({
              packages: [
                { name: "fixture-ts-lib", path: "packages/fixture-ts-lib" },
              ],
            }),
            "utf8",
          );
        },
        reporter: {},
      },
    );

    const rootCheckIndex = commands.indexOf("pnpm run check");
    const dockerIndex = commands.indexOf(
      "docker info --format {{.ServerVersion}}",
    );
    const deploymentIndex = commands.indexOf("pnpm run check:deployment");
    expect(rootCheckIndex).toBeGreaterThanOrEqual(0);
    expect(dockerIndex).toBeGreaterThan(rootCheckIndex);
    expect(deploymentIndex).toBeGreaterThan(dockerIndex);
  });

  it("fails a required deployment check when Docker is unavailable", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "vike-app" &&
        candidate.addedPreset === "ts-lib" &&
        candidate.linkFrom === undefined,
    );
    const workspace = await mkdtemp(
      path.join(tmpdir(), "generated-deployment-skip-"),
    );
    const commands: string[] = [];
    const messages: string[] = [];
    const replayCacheDirectory = await mkdtemp(
      path.join(tmpdir(), "generated-deployment-skip-cache-"),
    );

    await expect(
      runGeneratedScenariosConcurrently(manifest, [scenario!], workspace, 1, {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
        replayCache: {
          directory: replayCacheDirectory,
          read: false,
          write: true,
        },
        runCommand: async (command, args, cwd) => {
          commands.push(`${command} ${args.join(" ")}`);

          if (command === "docker" && args[0] === "info") {
            throw new Error("Docker daemon is unavailable");
          }

          if (args[2] !== "add") {
            return;
          }

          await mkdir(path.join(cwd, ".template"), { recursive: true });
          await writeFile(
            path.join(cwd, ".template", "blueprint.json"),
            JSON.stringify({
              packages: [
                { name: "fixture-ts-lib", path: "packages/fixture-ts-lib" },
              ],
            }),
            "utf8",
          );
        },
        reporter: { info: (message) => messages.push(message) },
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(
          /Deployment check requires the docker-engine Check Environment capability/u,
        ),
      }),
    });

    expect(commands).toContain("pnpm run check");
    expect(commands).not.toContain("pnpm run check:deployment");
    expect(messages).not.toContainEqual(
      expect.stringMatching(/Skipping deployment check/u),
    );
    expect(await readdir(replayCacheDirectory)).toHaveLength(1);
  });

  it("partitions deployment replay from the current Docker capability", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "vike-app" &&
        candidate.addedPreset === "ts-lib" &&
        candidate.linkFrom === undefined,
    );
    const cacheDirectory = await mkdtemp(
      path.join(tmpdir(), "generated-deployment-replay-cache-"),
    );

    async function run(
      dockerAvailable: boolean,
      read: boolean,
      write: boolean,
    ): Promise<{ commands: string[]; messages: string[] }> {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "generated-deployment-replay-workspace-"),
      );
      const commands: string[] = [];
      const messages: string[] = [];
      await runGeneratedScenariosConcurrently(
        manifest,
        [scenario!],
        workspace,
        1,
        {
          repoRoot: "/repo",
          cliPath: "/repo/packages/cli/src/cli.ts",
          projectionSourceRoots: builtInPresetProjectionSourceRoots(),
          replayCache: { directory: cacheDirectory, read, write },
          runCommand: async (command, args, cwd) => {
            commands.push(`${command} ${args.join(" ")}`);
            if (command === "docker" && !dockerAvailable) {
              throw new Error("Docker daemon is unavailable");
            }
            if (args[2] === "add") {
              await mkdir(path.join(cwd, ".template"), { recursive: true });
              await writeFile(
                path.join(cwd, ".template", "blueprint.json"),
                JSON.stringify({
                  packages: [
                    { name: "fixture-ts-lib", path: "packages/fixture-ts-lib" },
                  ],
                }),
                "utf8",
              );
            }
          },
          reporter: { info: (message) => messages.push(message) },
        },
      );
      return { commands, messages };
    }

    await expect(run(false, false, true)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/requires the docker-engine/u),
      }),
    });

    const availableAfterUnavailable = await run(true, true, true);
    expect(availableAfterUnavailable.commands).not.toContain("pnpm run check");
    expect(availableAfterUnavailable.commands).toContain(
      "docker info --format {{.ServerVersion}}",
    );
    expect(availableAfterUnavailable.commands).toContain(
      "pnpm run check:deployment",
    );

    const availableReplay = await run(true, true, false);
    expect(availableReplay.commands).toContain(
      "docker info --format {{.ServerVersion}}",
    );
    expect(availableReplay.commands).not.toContain("pnpm run check:deployment");
    expect(availableReplay.messages).toContainEqual(
      expect.stringMatching(/Replayed passed deployment fixture/u),
    );

    await expect(run(false, true, false)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/requires the docker-engine/u),
      }),
    });
  });

  it("reports the generated scenario, deployment modes, command, and container logs on deployment failure", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const scenario = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    ).runnable.find(
      (candidate) =>
        candidate.basePreset === "vike-app" &&
        candidate.addedPreset === "ts-lib" &&
        candidate.linkFrom === undefined,
    );
    const workspace = await mkdtemp(
      path.join(tmpdir(), "generated-deployment-failure-"),
    );
    let failure: unknown;

    try {
      await runGeneratedScenariosConcurrently(
        manifest,
        [scenario!],
        workspace,
        1,
        {
          repoRoot: "/repo",
          cliPath: "/repo/packages/cli/src/cli.ts",
          projectionSourceRoots: builtInPresetProjectionSourceRoots(),
          runCommand: async (command, args, cwd) => {
            if (command === "pnpm" && args[1] === "check:deployment") {
              throw new Error("standalone container logs:\nstartup failed");
            }

            if (args[2] !== "add") {
              return;
            }

            await mkdir(path.join(cwd, ".template"), { recursive: true });
            await writeFile(
              path.join(cwd, ".template", "blueprint.json"),
              JSON.stringify({
                packages: [
                  {
                    name: "fixture-ts-lib",
                    path: "packages/fixture-ts-lib",
                  },
                ],
              }),
              "utf8",
            );
          },
          reporter: {},
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Fixture scenario failed: vike-app + ts-lib",
    );
    expect((failure as Error).cause).toBeInstanceOf(Error);
    const deploymentFailure = (failure as Error).cause as Error;
    expect(deploymentFailure.message).toMatch(
      /Generated deployment command failed.*pnpm run check:deployment.*cause.*mode.*phase.*container logs/u,
    );
    expect(deploymentFailure.cause).toBeInstanceOf(Error);
    expect((deploymentFailure.cause as Error).message).toContain(
      "standalone container logs:\nstartup failed",
    );
  });

  it("replays a passed scenario from a generated repository fingerprint", async () => {
    const cacheDir = await mkdtemp(
      path.join(tmpdir(), "fixture-replay-cache-"),
    );
    const scenario = selectGeneratedScenarios(
      loadBuiltInPresetSourceManifest(),
      "init",
    ).runnable.find((candidate) => candidate.basePreset === "ts-lib");

    if (!scenario) {
      throw new Error("Expected ts-lib init scenario.");
    }
    const selectedScenario = scenario;

    async function runWithCache(
      read: boolean,
      write: boolean,
    ): Promise<string[]> {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "fixture-replay-workspace-"),
      );
      const commands: string[] = [];

      await runGeneratedScenariosConcurrently(
        loadBuiltInPresetSourceManifest(),
        [selectedScenario],
        workspace,
        1,
        {
          repoRoot: "/repo",
          cliPath: "/repo/packages/cli/src/cli.ts",
          projectionSourceRoots: builtInPresetProjectionSourceRoots(),
          replayCache: { directory: cacheDir, read, write },
          runCommand: async (command, args, cwd) => {
            commands.push(`${cwd}: ${command} ${args.join(" ")}`);

            if (args[2] === "init") {
              const projectDir = args[3];
              if (!projectDir) {
                throw new Error("Missing generated project directory.");
              }
              await mkdir(projectDir, { recursive: true });
              await writeFile(
                path.join(projectDir, "package.json"),
                `${JSON.stringify({ name: "fixture-ts-lib" })}\n`,
                "utf8",
              );
            }

            if (
              command === "pnpm" &&
              args[0] === "install" &&
              args.includes("--lockfile-only")
            ) {
              await writeFile(
                path.join(cwd, "pnpm-lock.yaml"),
                "lockfileVersion: '9.0'\n",
                "utf8",
              );
            }
          },
          reporter: {},
        },
      );

      return commands;
    }

    const missCommands = await runWithCache(false, true);
    const hitCommands = await runWithCache(true, false);

    expect(missCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pnpm fetch"),
        expect.stringContaining("pnpm run fix"),
        expect.stringContaining("pnpm run check"),
      ]),
    );
    expect(hitCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "pnpm install --lockfile-only --prefer-offline --no-frozen-lockfile",
        ),
      ]),
    );
    expect(hitCommands).not.toContainEqual(
      expect.stringContaining("pnpm fetch"),
    );
    expect(hitCommands).not.toContainEqual(
      expect.stringContaining("pnpm run fix"),
    );
    expect(hitCommands).not.toContainEqual(
      expect.stringContaining("pnpm run check"),
    );
  });

  it("runs initialization presets through production generation and generated Root Check", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "generated-init-scenario-runner-"),
    );
    const commands: string[] = [];
    const selection = await runGeneratedScenarioSet(
      loadBuiltInPresetSourceManifest(),
      "init",
      workspace,
      {
        repoRoot: "/repo",
        cliPath: "/repo/packages/cli/src/cli.ts",
        projectionSourceRoots: builtInPresetProjectionSourceRoots(),
        runCommand: async (command, args, cwd) => {
          commands.push(`${cwd}: ${command} ${args.join(" ")}`);
        },
        reporter: {},
      },
    );

    const initPresetNames = selection.runnable.map(
      (scenario) => scenario.basePreset,
    );

    expect(initPresetNames).toEqual(
      selectGeneratedScenarios(
        loadBuiltInPresetSourceManifest(),
        "init",
      ).runnable.map((scenario) => scenario.basePreset),
    );
    for (const presetName of initPresetNames) {
      expect(commands).toContainEqual(
        expect.stringContaining(
          `/repo: node --conditions=source /repo/packages/cli/src/cli.ts init ${path.join(workspace, `fixture-${presetName}`)} --preset ${presetName} --yes`,
        ),
      );
      expect(commands).toContainEqual(
        expect.stringContaining(
          `${path.join(workspace, `fixture-${presetName}`)}: pnpm run check`,
        ),
      );
    }
    expect(commands).not.toContainEqual(
      expect.stringContaining(" add package "),
    );
  });

  it("formats linked scenario ids without test-only helpers", () => {
    expect(
      generatedScenarioId({
        basePreset: "vue-hono-app",
        addedPreset: "ts-lib",
        linkFrom: ["apps/web"],
      }),
    ).toBe("vue-hono-app-add-ts-lib-link-from-apps-web");
  });
});
