import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BuiltInPreset } from "@ykdz/template-core/declarations";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import type { PresetPackageAdditionOptions } from "@ykdz/template-core/preset-projection";
import {
  findPresetSourceManifestPreset,
  type PresetSourceManifest,
  type PresetSourceManifestPreset,
  validateBuiltInPresetSourceManifest,
} from "@ykdz/template-core/preset-source";
import {
  defaultPackagePathForPresetSourcePackageAddition,
  planPresetSourcePackageAddition,
  projectPresetSourcePreset,
  validateProjectionCapabilities,
  type PresetProjectionSourceRoots,
  type PresetProjectionDeclaration,
  type ProjectionSourcePreset,
} from "@ykdz/template-core/projection-capabilities";

export {
  findPresetSourceManifestPreset,
  loadPresetSourceManifestFile,
  manifestReferencedSourceFiles,
  presetSourceManifestJsonSchema,
  validateBuiltInPresetSourceManifest,
  validatePresetSourceManifest,
  type PresetSourceManifest,
  type PresetSourceManifestPreset,
} from "@ykdz/template-core/preset-source";

export function builtInPresetSourceRoot(...segments: string[]): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "..", "..", "templates", ...segments),
    path.join(moduleDir, "..", "templates", ...segments),
    path.join(
      moduleDir,
      "..",
      "..",
      "..",
      "template-builtin-source",
      "templates",
      ...segments,
    ),
  ];

  return (
    candidates.find((candidate) => readPathExists(candidate)) ?? candidates[0]!
  );
}

function readPathExists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "EISDIR") {
      return true;
    }

    if (errorCode(error) === "ENOENT") {
      return false;
    }

    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

export function builtInPresetProjectionSourceRoots(): PresetProjectionSourceRoots {
  return {
    preset(sourcePreset: ProjectionSourcePreset): string {
      return builtInPresetSourceRoot(sourcePreset);
    },
    sharedOxc(): string {
      return builtInPresetSourceRoot("shared", "oxc");
    },
    sharedDevcontainer(): string {
      return builtInPresetSourceRoot("shared", "devcontainer");
    },
  };
}

export function loadBuiltInPresetSourceManifest(): PresetSourceManifest {
  const filePath = builtInPresetSourceRoot("preset-source.json");
  const result = validateBuiltInPresetSourceManifest(
    JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    { sourceRoot: path.dirname(filePath) },
  );

  if (!result.ok) {
    throw new Error(
      `Built-in Preset Source Manifest is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

export const builtInPresets: readonly BuiltInPreset[] =
  loadBuiltInPresetSourceManifest().presets;

export function findBuiltInPreset(name: string): BuiltInPreset | undefined {
  return builtInPresets.find((preset) => preset.name === name);
}

export function findBuiltInPresetSourceManifestPreset(
  presetName: string,
): PresetSourceManifestPreset | undefined {
  return findPresetSourceManifestPreset(
    loadBuiltInPresetSourceManifest(),
    presetName,
  );
}

export function loadBuiltInPresetProjectionDeclaration(
  presetName: string,
): PresetProjectionDeclaration {
  const preset = findBuiltInPresetSourceManifestPreset(presetName);

  if (!preset?.projection) {
    throw new Error(
      `Built-in Preset ${presetName} must declare a Projection Declaration`,
    );
  }

  const result = validateProjectionCapabilities(preset.projection);
  if (!result.ok) {
    throw new Error(
      `Built-in Preset ${presetName} Projection Declaration is invalid:\n${result.issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return result.value;
}

export function projectBuiltInPresetSourcePreset(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly context: GenerationContext;
}) {
  return projectPresetSourcePreset({
    ...options,
    sourceRoots: builtInPresetProjectionSourceRoots(),
  });
}

export function defaultPackagePathForBuiltInPackageAddition(
  preset: PresetSourceManifestPreset,
  packageLeafName: string,
): string {
  return defaultPackagePathForPresetSourcePackageAddition(
    preset,
    packageLeafName,
    builtInPresetProjectionSourceRoots(),
  );
}

export function planBuiltInPackageAddition(options: {
  readonly preset: PresetSourceManifestPreset;
  readonly addition: PresetPackageAdditionOptions;
}) {
  return planPresetSourcePackageAddition({
    ...options,
    sourceRoots: builtInPresetProjectionSourceRoots(),
  });
}
