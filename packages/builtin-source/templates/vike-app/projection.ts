import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import type {
  PresetBlueprintOptions,
  PresetProjection,
  PresetProjectionPlan,
} from "@ykdz/template-core/preset-projection";
import { interpretPresetProjectionDeclaration } from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";
import {
  PackageAdditionSupport,
  type BuiltInPreset,
  type ProjectBlueprint,
} from "@ykdz/template-shared";

export const vikeAppPresetMetadata: BuiltInPreset = {
  name: "vike-app",
  title: "Vike app",
  description:
    "Vike, Hono, Telefunc, Drizzle, and Vue workspace with a separate database package.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
  packageAdditionSupport: PackageAdditionSupport.Unsupported,
  features: [
    "pnpm-catalog",
    "oxc-format-lint",
    "strict-typescript",
    "root-check",
    "fix-command",
    "devcontainer",
    "github-actions",
    "dependabot",
  ],
};

function projectNameFromDir(targetDir: string): string {
  return targetDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "vike-app";
}

function scopedPackageName(packageScope: string): string {
  return `@${packageScope}/web`;
}

function scopedDbPackageName(packageScope: string): string {
  return `@${packageScope}/db`;
}

export function vikeAppBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const projectName = projectNameFromDir(options.targetDir);

  return {
    schemaVersion: 1,
    preset: "vike-app",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...vikeAppPresetMetadata.features],
    packages: [
      { name: scopedPackageName(projectName), path: "apps/web" },
      {
        name: scopedDbPackageName(projectName),
        path: "packages/db",
        role: "shared-library",
        sourcePreset: "ts-lib",
      },
    ],
  };
}

export const vikeAppPresetProjection: PresetProjection = {
  metadata: vikeAppPresetMetadata,
  blueprint: vikeAppBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    return interpretPresetProjectionDeclaration({
      preset: vikeAppPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("vike-app"),
      context,
      sourceRoots: builtInPresetProjectionSourceRoots(),
    });
  },
  async render({ targetDir, plan }): Promise<void> {
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });
  },
};
