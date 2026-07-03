import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  errorForFailedGeneratedScenario,
  generatedScenarioId,
  packageLeafNameForAddedPreset,
  runGeneratedScenarioSet,
  runGeneratedScenariosConcurrently,
  selectGeneratedScenarios,
} from "../src/generated-scenarios.js";
import { PackageAdditionSupport } from "../src/package-addition-support.js";
import type { PresetSourceManifest } from "../src/preset-source.js";
import { loadBuiltInPresetSourceManifest } from "../src/preset-source.js";

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
    fixtureMatrix: {
      initSupport: [{ preset: "base" }],
      packageAdditionSupport: [
        { preset: "addon", packageLeafName: "fixture-addon" },
      ],
      supportedCombinations: [
        { basePreset: "base", addedPreset: "addon" },
        {
          basePreset: "base",
          addedPreset: "addon",
          linkFrom: ["apps/web"],
        },
      ],
      semanticSkips: [
        {
          basePreset: "base",
          addedPreset: "blocked",
          reason: "blocked is init-only",
        },
      ],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    },
  };
}

describe("generated scenarios", () => {
  it("derives the init-only scenario set from the Fixture Matrix Contract", () => {
    expect(selectGeneratedScenarios(minimalManifest(), "init")).toEqual({
      runnable: [
        {
          set: "init",
          basePreset: "base",
          id: "base",
          label: "base",
        },
      ],
      skipped: [],
    });
  });

  it("derives Package Addition matrix scenarios and semantic skips with reasons", () => {
    expect(
      selectGeneratedScenarios(minimalManifest(), "package-addition-matrix"),
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
          basePreset: "base",
          addedPreset: "addon",
          linkFrom: ["apps/web"],
          id: "base-add-addon-link-from-apps-web",
          label: "base + addon linked from apps/web",
        },
      ],
      skipped: [
        {
          set: "package-addition-matrix",
          basePreset: "base",
          addedPreset: "blocked",
          id: "base-add-blocked",
          label: "base + blocked",
          reason: "blocked is init-only",
        },
      ],
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

  it("uses manifest-declared Package Addition leaf names", () => {
    expect(packageLeafNameForAddedPreset(minimalManifest(), "addon")).toBe(
      "fixture-addon",
    );
  });

  it("keeps built-in scenario selection on the manifest contract", () => {
    const selection = selectGeneratedScenarios(
      loadBuiltInPresetSourceManifest(),
      "package-addition-matrix",
    );

    expect(selection.runnable.map((scenario) => scenario.id)).toContain(
      "vue-hono-app-add-ts-lib-link-from-apps-web",
    );
    expect(selection.runnable.every((scenario) => scenario.addedPreset)).toBe(
      true,
    );
    expect(
      selection.skipped.map((scenario) => [scenario.id, scenario.reason]),
    ).toContainEqual([
      "ts-lib-add-rust-bin",
      "rust-bin is an initialization-only native binary preset.",
    ]);
  });

  it("covers the built-in Package Addition matrix from the Fixture Matrix Contract", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const contract = manifest.fixtureMatrix;

    expect(contract).toBeDefined();

    const initSupportedPresets = contract!.initSupport.map(
      (support) => support.preset,
    );
    const packageAdditionSupportedPresets = new Set(
      contract!.packageAdditionSupport.map((support) => support.preset),
    );
    const expectedPairs = new Set(
      initSupportedPresets.flatMap((basePreset) =>
        initSupportedPresets.map((addedPreset) =>
          matrixPairKey({ basePreset, addedPreset }),
        ),
      ),
    );
    const selection = selectGeneratedScenarios(
      manifest,
      "package-addition-matrix",
    );
    const runnablePairs = new Set(
      selection.runnable.map((scenario) =>
        matrixPairKey({
          basePreset: scenario.basePreset,
          addedPreset: scenario.addedPreset!,
        }),
      ),
    );
    const skippedPairs = new Set(selection.skipped.map(matrixPairKey));

    expect(new Set([...runnablePairs, ...skippedPairs])).toEqual(expectedPairs);
    for (const scenario of selection.runnable) {
      expect(packageAdditionSupportedPresets.has(scenario.addedPreset!)).toBe(
        true,
      );
    }
    for (const scenario of selection.skipped) {
      expect(packageAdditionSupportedPresets.has(scenario.addedPreset)).toBe(
        false,
      );
      expect(scenario.reason.length).toBeGreaterThan(0);
    }
  });

  it("wraps runner failures with the preset combination label", () => {
    const scenario = selectGeneratedScenarios(
      minimalManifest(),
      "package-addition-matrix",
    ).runnable.find((candidate) => candidate.addedPreset === "addon");

    expect(
      errorForFailedGeneratedScenario(scenario!, new Error("inner")),
    ).toMatchObject({
      message: "Fixture scenario failed: base + addon",
      cause: expect.objectContaining({ message: "inner" }),
    });
  });

  it("wraps init runner failures with the initialization preset label", () => {
    const scenario = selectGeneratedScenarios(minimalManifest(), "init")
      .runnable[0];

    expect(
      errorForFailedGeneratedScenario(scenario, new Error("inner")),
    ).toMatchObject({
      message: "Fixture scenario failed: base",
      cause: expect.objectContaining({ message: "inner" }),
    });
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
        cliPath: "/repo/src/cli.ts",
        runCommand: async (command, args, cwd) => {
          commands.push(`${cwd}: ${command} ${args.join(" ")}`);

          if (args[3] !== "add") {
            return;
          }

          await mkdir(path.join(cwd, ".template"), { recursive: true });
          await writeFile(
            path.join(cwd, ".template", "blueprint.json"),
            JSON.stringify({
              packages: [{ name: "fixture-lib", path: "packages/fixture-lib" }],
            }),
            "utf8",
          );
        },
        reporter: {},
      },
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pnpm exec tsx /repo/src/cli.ts init"),
        expect.stringContaining(
          "pnpm exec tsx /repo/src/cli.ts add package --preset ts-lib --name fixture-lib",
        ),
        expect.stringContaining("pnpm install"),
        expect.stringContaining("pnpm run fix"),
        expect.stringContaining("pnpm run check"),
      ]),
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
        cliPath: "/repo/src/cli.ts",
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
          `/repo: pnpm exec tsx /repo/src/cli.ts init ${path.join(workspace, `fixture-${presetName}`)} --preset ${presetName} --yes`,
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
