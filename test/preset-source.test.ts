import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  validateBuiltInPresetSourceManifest,
  loadPresetSourceManifestFile,
  loadBuiltInPresetSourceManifest,
  validatePresetSourceManifest,
} from "../src/preset-source.js";

function validManifest(): any {
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
    manifest.presets[0].source = {
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
      loadPresetSourceManifestFile(manifestPath).presets[0].source,
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
    manifest.presets[0].source = {
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
    manifest.sharedResources[0].path = "../shared/oxc/node";
    manifest.presets[0].source = {
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
      ...manifest.sharedResources[0],
      body: "version: 2\nupdates: []\n",
    } as (typeof manifest.sharedResources)[number];

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
