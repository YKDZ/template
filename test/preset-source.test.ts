import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  presetSourceManifestJsonSchema,
  validateBuiltInPresetSourceManifest,
  loadPresetSourceManifestFile,
  loadBuiltInPresetSourceManifest,
  validatePresetSourceManifest,
} from "@ykdz/template-builtin-source";
import type {
  PresetSourceFixtureMatrixContract,
  PresetSourceManifestPreset,
  PresetSourceManifestSharedResource,
} from "@ykdz/template-core/preset-source";

type ManifestPresetInput = Omit<
  PresetSourceManifestPreset,
  | "dependencyCatalog"
  | "features"
  | "packageAdditionSupport"
  | "projection"
  | "source"
  | "supportedPackageManagers"
  | "supportedProjectKinds"
> & {
  dependencyCatalog?: unknown;
  features: unknown[];
  packageAdditionSupport: unknown;
  projection?: unknown;
  source?: unknown;
  supportedPackageManagers: unknown[];
  supportedProjectKinds: unknown[];
};

type SharedResourceInput = PresetSourceManifestSharedResource &
  Record<string, unknown>;

type PresetSourceManifestInput = {
  schemaVersion: 1;
  name: string;
  presets: ManifestPresetInput[];
  sharedResources: SharedResourceInput[];
  fixtureMatrix?: PresetSourceFixtureMatrixContract;
};

function validManifest(): PresetSourceManifestInput {
  return {
    schemaVersion: 1,
    name: "custom-source",
    presets: [
      {
        name: "custom-lib",
        title: "Custom library",
        description: "A custom strict TypeScript library preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: "unsupported",
        features: ["strict-typescript", "root-check"],
      },
    ],
    sharedResources: [
      {
        id: "shared-oxc-node",
        path: "shared/oxc/node",
      },
    ],
  };
}

function firstPreset(manifest: PresetSourceManifestInput): ManifestPresetInput {
  const preset = manifest.presets[0];
  if (!preset) {
    throw new Error("Test manifest must contain a preset");
  }

  return preset;
}

function firstSharedResource(
  manifest: PresetSourceManifestInput,
): SharedResourceInput {
  const resource = manifest.sharedResources[0];
  if (!resource) {
    throw new Error("Test manifest must contain a shared resource");
  }

  return resource;
}

describe("Preset Source Manifest validation", () => {
  it("accepts reference-only Shared Resource declarations with stable identities", () => {
    expect(validatePresetSourceManifest(validManifest())).toMatchObject({
      ok: true,
      value: {
        sharedResources: [
          {
            id: "shared-oxc-node",
            path: "shared/oxc/node",
          },
        ],
      },
    });
  });

  it("accepts maintained Dependency Catalog entry references", () => {
    const manifest = validManifest();
    firstPreset(manifest).dependencyCatalog = ["typescript", "valibot"];

    expect(validatePresetSourceManifest(manifest)).toMatchObject({
      ok: true,
      value: {
        presets: [
          {
            name: "custom-lib",
            dependencyCatalog: ["typescript", "valibot"],
          },
        ],
      },
    });
  });

  it("accepts Fixture Matrix Contracts with supported combinations and semantic skips", () => {
    const manifest = validManifest();
    manifest.presets.push({
      name: "custom-app",
      title: "Custom app",
      description: "A custom strict TypeScript app preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: "supported",
      features: ["strict-typescript", "root-check"],
    });
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [
        { preset: "custom-app", packageLeafName: "fixture-app" },
      ],
      supportedCombinations: [
        { basePreset: "custom-lib", addedPreset: "custom-app" },
      ],
      semanticSkips: [
        {
          basePreset: "custom-lib",
          addedPreset: "custom-lib",
          reason: "custom-lib is init-only",
        },
      ],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    };

    expect(validatePresetSourceManifest(manifest)).toMatchObject({
      ok: true,
      value: {
        fixtureMatrix: {
          packageAdditionSupport: [
            { preset: "custom-app", packageLeafName: "fixture-app" },
          ],
          semanticSkips: [
            {
              basePreset: "custom-lib",
              addedPreset: "custom-lib",
              reason: "custom-lib is init-only",
            },
          ],
        },
      },
    });
  });

  it("rejects Fixture Matrix Package Addition support that disagrees with Preset metadata", () => {
    const manifest = validManifest();
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [
        { preset: "custom-lib", packageLeafName: "fixture-lib" },
      ],
      supportedCombinations: [
        { basePreset: "custom-lib", addedPreset: "custom-lib" },
      ],
      semanticSkips: [],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.fixtureMatrix.packageAdditionSupport[0].preset",
          message:
            "Fixture Matrix Package Addition support must match Preset metadata: custom-lib is unsupported",
        },
      ],
    });
  });

  it("rejects supported Package Addition Presets missing Fixture Matrix support", () => {
    const manifest = validManifest();
    manifest.presets.push({
      name: "custom-app",
      title: "Custom app",
      description: "A custom strict TypeScript app preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: "supported",
      features: ["strict-typescript", "root-check"],
    });
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [],
      supportedCombinations: [],
      semanticSkips: [],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[1].packageAdditionSupport",
          message:
            "Fixture Matrix Package Addition support must declare supported Preset: custom-app",
        },
      ],
    });
  });

  it("rejects Package Addition matrix pairs missing a supported combination or semantic skip", () => {
    const manifest = validManifest();
    manifest.presets.push({
      name: "custom-app",
      title: "Custom app",
      description: "A custom strict TypeScript app preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: "supported",
      features: ["strict-typescript", "root-check"],
    });
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [
        { preset: "custom-app", packageLeafName: "fixture-app" },
      ],
      supportedCombinations: [],
      semanticSkips: [],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.fixtureMatrix.supportedCombinations",
          message:
            "Fixture Matrix must explicitly cover supported combination or semantic skip: custom-lib + custom-app",
        },
      ],
    });
  });

  it("rejects Package Addition fixture leaf names outside the CLI name rule", () => {
    const packageLeafNameSchema =
      presetSourceManifestJsonSchema.properties.fixtureMatrix.properties
        .packageAdditionSupport.items.properties.packageLeafName;
    const manifest = validManifest();
    manifest.presets.push({
      name: "custom-app",
      title: "Custom app",
      description: "A custom strict TypeScript app preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: "supported",
      features: ["strict-typescript", "root-check"],
    });
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [
        { preset: "custom-app", packageLeafName: "Fixture_App" },
      ],
      supportedCombinations: [
        { basePreset: "custom-lib", addedPreset: "custom-app" },
      ],
      semanticSkips: [],
      checkRequirements: ["machine-verifiable-next-steps", "root-check-ci"],
      environmentPreparation: ["playwright-browser-assets"],
    };

    expect(packageLeafNameSchema).toMatchObject({
      pattern: "^[a-z0-9][a-z0-9-]*$",
    });
    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.fixtureMatrix.packageAdditionSupport[0].packageLeafName",
          message:
            "Fixture Matrix Package Addition packageLeafName must be a lowercase package leaf name using letters, numbers, and hyphens",
        },
      ],
    });
  });

  it("rejects Fixture Matrix contracts missing required check and environment declarations", () => {
    const manifest = validManifest();
    manifest.presets.push({
      name: "custom-app",
      title: "Custom app",
      description: "A custom strict TypeScript app preset.",
      generation: "supported",
      supportedPackageManagers: ["pnpm"],
      supportedProjectKinds: ["multi-package"],
      packageAdditionSupport: "supported",
      features: ["strict-typescript", "root-check"],
    });
    manifest.fixtureMatrix = {
      initSupport: [{ preset: "custom-lib" }],
      packageAdditionSupport: [
        { preset: "custom-app", packageLeafName: "fixture-app" },
      ],
      supportedCombinations: [
        { basePreset: "custom-lib", addedPreset: "custom-app" },
      ],
      semanticSkips: [],
      checkRequirements: ["machine-verifiable-next-steps"],
      environmentPreparation: [],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.fixtureMatrix.checkRequirements",
          message:
            "Fixture Matrix check requirements must include root-check-ci",
        },
        {
          path: "$.fixtureMatrix.environmentPreparation",
          message:
            "Fixture Matrix environment preparation must include playwright-browser-assets",
        },
      ],
    });
  });

  it("rejects unknown Projection Capability kinds with semantic diagnostics", () => {
    const manifest = validManifest();
    firstPreset(manifest).projection = {
      capabilities: [
        {
          kind: "write-my-private-file",
        },
      ],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].projection.capabilities[0].kind",
          message: "Unknown Projection Capability kind: write-my-private-file",
        },
      ],
    });
  });

  it("rejects missing Projection Capabilities with semantic diagnostics", () => {
    const manifest = validManifest();
    firstPreset(manifest).projection = {
      capabilities: [
        {
          kind: "workspace-library-package",
          workspacePackageGlob: "packages/*",
          packageRole: "shared-library",
          packageSourcePreset: "ts-lib",
          sourceFiles: ["src/index.ts", "src/name-schema.ts"],
        },
        { kind: "strict-typescript-root" },
        { kind: "oxc-format-lint" },
      ],
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].projection.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide GitHub Actions maintenance",
        },
        {
          path: "$.presets[0].projection.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide Dependabot maintenance",
        },
        {
          path: "$.presets[0].projection.capabilities",
          message:
            "Projection Capability composition must include node-pnpm-devcontainer to provide development container support",
        },
      ],
    });
  });

  it("reports missing Dependency Catalog entry references with semantic diagnostics", () => {
    const manifest = validManifest();
    firstPreset(manifest).dependencyCatalog = ["missing-package"];

    expect(
      validatePresetSourceManifest(manifest, { dependencyCatalog: {} }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].dependencyCatalog",
          message:
            "Preset custom-lib references missing Template Dependency Catalog entry: missing-package",
        },
      ],
    });
  });

  it("rejects inline Dependency Catalog semver specifiers in manifest-shaped references", () => {
    const manifest = validManifest();
    firstPreset(manifest).dependencyCatalog = ["^6.0.3"];

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].dependencyCatalog[0]",
          message:
            "Preset Source Manifests must reference Template Dependency Catalog entries by name, not inline semver specifier ^6.0.3",
        },
      ],
    });
  });

  it("rejects inline Dependency Catalog semver specifiers in object-shaped declarations", () => {
    const manifest = validManifest();
    firstPreset(manifest).dependencyCatalog = {
      typescript: "^6.0.3",
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].dependencyCatalog.typescript",
          message:
            "Preset Source Manifests must reference Template Dependency Catalog entries by name, not inline semver specifier ^6.0.3",
        },
      ],
    });
  });

  it("rejects missing Shared Resource paths through manifest loading", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-"));
    const manifestPath = path.join(workspace, "preset-source.json");

    await writeFile(
      manifestPath,
      `${JSON.stringify(validManifest(), null, 2)}\n`,
      "utf8",
    );

    expect(() => loadPresetSourceManifestFile(manifestPath)).toThrow(
      [
        "Preset Source Manifest is invalid:",
        "  - $.sharedResources[0].path: Shared Resource shared-oxc-node path does not exist: shared/oxc/node",
      ].join("\n"),
    );
  });

  it("loads Preset-owned source references and Shared Resource identity references", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-"));
    await mkdir(path.join(workspace, "shared/oxc/node"), { recursive: true });
    await mkdir(path.join(workspace, "custom-lib/src"), { recursive: true });
    await writeFile(
      path.join(workspace, "custom-lib/src/index.ts"),
      "export function greet() {}\n",
      "utf8",
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validManifest();
    firstPreset(manifest).source = {
      roots: ["custom-lib/src"],
      files: ["custom-lib/src/index.ts"],
      sharedResources: ["shared-oxc-node"],
    };

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    expect(
      loadPresetSourceManifestFile(manifestPath).presets[0]!.source,
    ).toEqual({
      roots: ["custom-lib/src"],
      files: ["custom-lib/src/index.ts"],
      sharedResources: ["shared-oxc-node"],
    });
  });

  it("rejects missing Preset source references and undeclared Shared Resource identities", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-"));
    await mkdir(path.join(workspace, "shared/oxc/node"), { recursive: true });
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validManifest();
    firstPreset(manifest).source = {
      files: ["custom-lib/src/index.ts"],
      sharedResources: ["missing-resource"],
    };

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    expect(() => loadPresetSourceManifestFile(manifestPath)).toThrow(
      [
        "Preset Source Manifest is invalid:",
        "  - $.presets[0].source.sharedResources: Preset custom-lib references undeclared Shared Resource: missing-resource",
        "  - $.presets[0].source.files[0]: Preset custom-lib source file does not exist: custom-lib/src/index.ts",
      ].join("\n"),
    );
  });

  it("rejects Preset Source references that escape the source boundary", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-"));
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validManifest();
    firstSharedResource(manifest).path = "../shared/oxc/node";
    firstPreset(manifest).source = {
      roots: ["../custom-lib/src"],
    };

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    expect(() => loadPresetSourceManifestFile(manifestPath)).toThrow(
      [
        "Preset Source Manifest is invalid:",
        "  - $.sharedResources[0].path: Preset Source path escapes its source boundary: ../shared/oxc/node",
        "  - $.presets[0].source.roots[0]: Preset Source path escapes its source boundary: ../custom-lib/src",
      ].join("\n"),
    );
  });

  it("rejects Preset Source symlinks that escape the source boundary", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "preset-source-outside-"),
    );
    await mkdir(path.join(outside, "shared/oxc/node"), { recursive: true });
    await symlink(
      path.join(outside, "shared"),
      path.join(workspace, "shared"),
      "dir",
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validManifest();

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    expect(() => loadPresetSourceManifestFile(manifestPath)).toThrow(
      [
        "Preset Source Manifest is invalid:",
        "  - $.sharedResources[0].path: Preset Source path escapes its source boundary: shared/oxc/node",
      ].join("\n"),
    );
  });

  it("rejects inline Generated Repository file bodies in manifest declarations", () => {
    const manifest = validManifest();
    manifest.sharedResources[0] = {
      ...firstSharedResource(manifest),
      body: "version: 2\nupdates: []\n",
    };

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.sharedResources[0].body",
          message:
            "Preset Source Manifests must reference Generated Repository file bodies by path, not inline body",
        },
      ],
    });
  });

  it("loads the built-in Preset Source Manifest metadata", () => {
    const manifest = loadBuiltInPresetSourceManifest();

    expect(manifest.sharedResources).toEqual(
      expect.arrayContaining([
        { id: "shared-oxc-node", path: "shared/oxc/node" },
        { id: "shared-oxc-vue", path: "shared/oxc/vue" },
        { id: "shared-devcontainer", path: "shared/devcontainer" },
        {
          id: "shared-editor-customization",
          path: "shared/editor-customization/capabilities.json",
        },
      ]),
    );
    expect(
      manifest.presets.map((preset) => ({
        name: preset.name,
        generation: preset.generation,
        packageAdditionSupport: preset.packageAdditionSupport,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          name: "ts-lib",
          generation: "supported",
          packageAdditionSupport: "supported",
        },
        {
          name: "vue-hono-app",
          generation: "supported",
          packageAdditionSupport: "unsupported",
        },
        {
          name: "node-cli",
          generation: "future",
          packageAdditionSupport: "unsupported",
        },
      ]),
    );
    expect(
      Object.fromEntries(
        manifest.presets
          .filter((preset) => preset.generation === "supported")
          .map((preset) => [preset.name, preset.dependencyCatalog]),
      ),
    ).toEqual({
      "hono-api": [
        "@hono/node-server",
        "@types/node",
        "hono",
        "oxfmt",
        "oxlint",
        "oxlint-tsgolint",
        "tsc-alias",
        "turbo",
        "typescript",
        "vitest",
      ],
      "rust-bin": ["turbo"],
      "ts-lib": [
        "@types/node",
        "oxfmt",
        "oxlint",
        "oxlint-tsgolint",
        "turbo",
        "typescript",
        "valibot",
      ],
      "vue-app": [
        "@playwright/test",
        "@tailwindcss/vite",
        "@types/node",
        "@types/web-bluetooth",
        "@vitejs/plugin-vue",
        "@vue/tsconfig",
        "oxfmt",
        "oxlint",
        "oxlint-tsgolint",
        "pinia",
        "tailwindcss",
        "turbo",
        "typescript",
        "vite",
        "vitest",
        "vue",
        "vue-tsc",
      ],
      "vue-hono-app": [
        "@hono/node-server",
        "@playwright/test",
        "@tailwindcss/vite",
        "@types/node",
        "@types/web-bluetooth",
        "@vitejs/plugin-vue",
        "@vue/tsconfig",
        "hono",
        "oxfmt",
        "oxlint",
        "oxlint-tsgolint",
        "pinia",
        "tailwindcss",
        "tsc-alias",
        "tsx",
        "turbo",
        "typescript",
        "vite",
        "vitest",
        "vue",
        "vue-tsc",
      ],
    });

    const rustPreset = manifest.presets.find(
      (preset) => preset.name === "rust-bin",
    );
    expect(rustPreset).toMatchObject({
      projection: {
        capabilities: [
          {
            kind: "rust-binary-workspace",
            workspacePackageGlob: "packages/*",
            sourceFiles: ["src/main.rs"],
          },
        ],
      },
      source: {
        roots: ["rust-bin/.github", "rust-bin/src"],
        files: ["rust-bin/rust-toolchain.toml", "rust-bin/rustfmt.toml"],
        sharedResources: ["shared-devcontainer", "shared-editor-customization"],
      },
    });
  });

  it("reports duplicate Preset names with an actionable diagnostic", () => {
    const manifest = validManifest();
    manifest.presets.push({
      ...firstPreset(manifest),
      title: "Duplicate custom library",
    });

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets.name",
          message: "Duplicate Preset name: custom-lib",
        },
      ],
    });
  });

  it("reports duplicate Preset metadata array values with actionable diagnostics", () => {
    const manifest = validManifest();
    firstPreset(manifest).supportedPackageManagers = ["pnpm", "pnpm"];
    firstPreset(manifest).supportedProjectKinds = [
      "multi-package",
      "multi-package",
    ];
    firstPreset(manifest).features = ["root-check", "root-check"];

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].supportedPackageManagers",
          message: "Duplicate value: pnpm",
        },
        {
          path: "$.presets[0].supportedProjectKinds",
          message: "Duplicate value: multi-package",
        },
        {
          path: "$.presets[0].features",
          message: "Duplicate value: root-check",
        },
      ],
    });
  });

  it("reports unsupported Project Shape declarations with domain language", () => {
    const manifest = validManifest();
    firstPreset(manifest).supportedProjectKinds = ["single-package"];

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].supportedProjectKinds",
          message:
            "single-package Project Shape is unsupported in V1; use the workspace monorepo Project Shape",
        },
      ],
    });
  });

  it("reports invalid Package Addition Support values with supported values", () => {
    const manifest = validManifest();
    firstPreset(manifest).packageAdditionSupport = "maybe";

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].packageAdditionSupport",
          message:
            "Package Addition Support must be one of: supported, unsupported",
        },
      ],
    });
  });

  it("reports missing required Preset metadata with the missing field path", () => {
    const manifest = validManifest();
    delete (firstPreset(manifest) as Partial<ManifestPresetInput>).title;

    expect(validatePresetSourceManifest(manifest)).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].title",
          message: "Preset metadata is missing required field: title",
        },
      ],
    });
  });

  it("rejects supported Presets without a Projection Declaration", () => {
    const manifest = loadBuiltInPresetSourceManifest();

    expect(
      validateBuiltInPresetSourceManifest({
        ...manifest,
        presets: [
          ...manifest.presets,
          {
            name: "missing-supported",
            title: "Missing supported preset",
            description: "A supported built-in preset with no projection.",
            generation: "supported",
            supportedPackageManagers: ["pnpm"],
            supportedProjectKinds: ["multi-package"],
            packageAdditionSupport: "unsupported",
            features: [],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[7].projection",
          message:
            "Supported Preset missing-supported must declare a Projection Declaration",
        },
      ],
    });
  });

  it("allows future built-in Presets to carry metadata without Projection Declarations", () => {
    const manifest = loadBuiltInPresetSourceManifest();

    const result = validateBuiltInPresetSourceManifest({
      ...manifest,
      fixtureMatrix: undefined,
      presets: manifest.presets.map((preset) =>
        preset.name === "ts-app"
          ? {
              ...preset,
              projection: undefined,
              source: undefined,
            }
          : preset,
      ),
    });

    expect(result.ok).toBe(true);
  });
});
