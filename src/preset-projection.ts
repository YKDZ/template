import type { BuiltInPreset, ProjectBlueprint } from "./declarations.js";
import type { GenerationContext } from "./generation-context.js";
import { type CheckPlan, type FixPlan } from "./module-graph.js";
import {
  planNextStepInstructions,
  type NextStepInstruction,
} from "./next-step-instructions.js";
import type { PackageRole, PackageSourcePreset } from "./package-linking.js";
import type { DependencyMaintenancePolicy } from "./project-github.js";
import type { RenderOperation } from "./renderer.js";

export type PresetPackageAdditionOptions = {
  readonly root: string;
  readonly blueprint: ProjectBlueprint;
  readonly packageLeafName: string;
  readonly packageName: string;
  readonly packagePath: string;
  readonly nodeVersion: string;
};

export type PresetPackageAdditionPlan = {
  readonly packagePath: string;
  readonly workspacePackageGlob: string;
  readonly packageRole: PackageRole;
  readonly packageSourcePreset: PackageSourcePreset;
  readonly sourceRoot: string;
  readonly sourceRoots?: Record<string, string>;
  readonly operations: readonly RenderOperation[];
  readonly textFiles?: readonly {
    readonly path: string;
    readonly text: string;
  }[];
};

export type PresetPackageAdditionCapability = {
  planPackageAddition(
    options: PresetPackageAdditionOptions,
  ): PresetPackageAdditionPlan | Promise<PresetPackageAdditionPlan>;
};

export type PresetProjectionPlan = {
  readonly sourceRoot: string;
  readonly sourceRoots?: Record<string, string>;
  readonly operations: readonly RenderOperation[];
  readonly checkPlan: CheckPlan;
  readonly fixPlan: FixPlan;
  readonly dependencyMaintenancePolicy: DependencyMaintenancePolicy;
  readonly packageScripts: Record<string, string>;
  readonly capabilities: {
    readonly rootCheck: true;
    readonly fixCommand: true;
    readonly githubActions: true;
    readonly dependabot: true;
    readonly devcontainer: true;
  };
};

export type PresetBlueprintOptions = {
  readonly targetDir: string;
  readonly scope?: string;
};

export type RenderPresetProjectionOptions = {
  readonly targetDir: string;
  readonly plan: PresetProjectionPlan;
};

export type PresetProjection = {
  readonly metadata: BuiltInPreset;
  readonly capabilities?: {
    readonly packageAddition?: PresetPackageAdditionCapability;
  };
  blueprint(options: PresetBlueprintOptions): ProjectBlueprint;
  project(context: GenerationContext): PresetProjectionPlan;
  render(options: RenderPresetProjectionOptions): Promise<void>;
};

export function planNextStepInstructionsForProjection(options: {
  readonly targetDir: string;
  readonly plan: PresetProjectionPlan;
}): readonly NextStepInstruction[] {
  return planNextStepInstructions({
    targetDir: options.targetDir,
    projectionPlan: options.plan,
  }).steps;
}
