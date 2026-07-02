import path from "node:path";

import type { PackageManager, ProjectBlueprint } from "./declarations.js";
import type { ResolvedToolchainVersions } from "./toolchain-resolution.js";

export type ProjectName = {
  readonly kind: "ProjectName";
  readonly value: string;
};

export type GenerationPackageManager = {
  readonly kind: "PackageManager";
  readonly value: PackageManager;
};

export type GenerationContext = {
  readonly projectName: ProjectName;
  readonly preset: string;
  readonly packageManager?: GenerationPackageManager;
  readonly blueprint: ProjectBlueprint;
  readonly toolchain: ResolvedToolchainVersions;
};

export type AssembleGenerationContextOptions = {
  readonly targetDir: string;
  readonly blueprint: ProjectBlueprint;
  readonly toolchain: ResolvedToolchainVersions;
};

export function assembleGenerationContext(
  options: AssembleGenerationContextOptions,
): GenerationContext {
  return {
    projectName: {
      kind: "ProjectName",
      value: path.basename(path.resolve(options.targetDir)),
    },
    preset: options.blueprint.preset,
    packageManager: options.blueprint.packageManager
      ? { kind: "PackageManager", value: options.blueprint.packageManager }
      : undefined,
    blueprint: options.blueprint,
    toolchain: options.toolchain,
  };
}
