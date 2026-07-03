import {
  validateBuiltInPresetSourceManifest,
  loadBuiltInPresetSourceManifest,
  validatePresetSourceManifest,
} from "../src/preset-source.js";

function validManifest() {
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
  };
}

describe("Preset Source Manifest validation", () => {
  it("loads the built-in Preset Source Manifest metadata", () => {
    expect(
      loadBuiltInPresetSourceManifest().presets.map((preset) => ({
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
  });

  it("reports duplicate Preset names with an actionable diagnostic", () => {
    const manifest = validManifest();
    manifest.presets.push({
      ...manifest.presets[0],
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
    manifest.presets[0].supportedPackageManagers = ["pnpm", "pnpm"];
    manifest.presets[0].supportedProjectKinds = [
      "multi-package",
      "multi-package",
    ];
    manifest.presets[0].features = ["root-check", "root-check"];

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
    manifest.presets[0].supportedProjectKinds = ["single-package"];

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
    manifest.presets[0].packageAdditionSupport = "maybe";

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
    delete (manifest.presets[0] as Partial<(typeof manifest.presets)[number]>)
      .title;

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

  it("rejects supported built-in Presets without a registry projection", () => {
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
          path: "$.presets[7].name",
          message:
            "Supported built-in Preset missing-supported must have a registry projection until generation no longer uses the registry bridge",
        },
      ],
    });
  });

  it("rejects built-in Package Addition Support drift from registry projections", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const presets = manifest.presets.map((preset) =>
      preset.name === "ts-lib"
        ? { ...preset, packageAdditionSupport: "unsupported" as const }
        : preset,
    );

    expect(
      validateBuiltInPresetSourceManifest({
        ...manifest,
        presets,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].packageAdditionSupport",
          message:
            "Built-in Preset ts-lib Package Addition Support must match the registry projection: supported",
        },
      ],
    });
  });

  it("rejects registry projections that are not supported by the built-in manifest", () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const presets = manifest.presets.map((preset) =>
      preset.name === "ts-lib"
        ? { ...preset, generation: "future" as const }
        : preset,
    );

    expect(
      validateBuiltInPresetSourceManifest({
        ...manifest,
        presets,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.presets[0].generation",
          message:
            "Registry projection ts-lib must be declared as a supported built-in Preset until generation no longer uses the registry bridge",
        },
      ],
    });
  });
});
