import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetProjectionDeclaration,
} from "@ykdz/template-builtin-source";
import type { GenerationContext } from "@ykdz/template-core/generation-context";
import {
  type CheckPlan,
  type ComponentOwner,
  type FixPlan,
  renderFixCommand,
  renderRootCheckCommand,
} from "@ykdz/template-core/module-graph";
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

export const rustBinPresetMetadata: BuiltInPreset = {
  name: "rust-bin",
  title: "Rust binary",
  description:
    "Rust native binary workspace with rustfmt, clippy, and cargo tests.",
  generation: "supported",
  supportedPackageManagers: ["pnpm"],
  supportedProjectKinds: ["multi-package"],
  packageAdditionSupport: PackageAdditionSupport.Unsupported,
  features: [
    "root-check",
    "fix-command",
    "devcontainer",
    "github-actions",
    "dependabot",
    "rustfmt-clippy",
    "cargo-test",
  ],
};

const rustPackageBoundary: ComponentOwner = {
  kind: "package-boundary",
  path: ".",
};

function cargoPackageNameFromProjectName(projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "rust-bin";
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

function rustWorkspacePackageName(projectName: string): string {
  return `${cargoPackageNameFromProjectName(projectName)}-native`;
}

function rustWorkspacePackagePath(projectName: string): string {
  return `packages/${cargoPackageNameFromProjectName(projectName)}`;
}

export function planRustBinChecks(): CheckPlan {
  return {
    components: [
      { kind: "rustfmt-check", owner: rustPackageBoundary },
      { kind: "cargo-clippy", owner: rustPackageBoundary },
      { kind: "cargo-test", owner: rustPackageBoundary },
    ],
    environmentNeeds: [],
  };
}

export function planRustBinFixes(): FixPlan {
  return {
    components: [{ kind: "rustfmt-write", owner: rustPackageBoundary }],
  };
}

export function rustBinBlueprint(
  options: PresetBlueprintOptions = { targetDir: process.cwd() },
): ProjectBlueprint {
  const projectName = projectNameFromDir(options.targetDir);

  return {
    schemaVersion: 1,
    preset: "rust-bin",
    packageManager: "pnpm",
    projectKind: "multi-package",
    features: [...rustBinPresetMetadata.features],
    packages: [
      {
        name: rustWorkspacePackageName(projectName),
        path: rustWorkspacePackagePath(projectName),
      },
    ],
  };
}

export function projectRustBinPackageScripts(): Record<string, string> {
  return {
    check: renderRootCheckCommand(planRustBinChecks()),
    fix: renderFixCommand(planRustBinFixes()),
  };
}

export const rustBinPresetProjection: PresetProjection = {
  metadata: rustBinPresetMetadata,
  blueprint: rustBinBlueprint,
  project(context: GenerationContext): PresetProjectionPlan {
    return interpretPresetProjectionDeclaration({
      preset: rustBinPresetMetadata,
      declaration: loadBuiltInPresetProjectionDeclaration("rust-bin"),
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
