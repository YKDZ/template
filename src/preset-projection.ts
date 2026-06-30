import type { BuiltInPreset, ProjectBlueprint } from "./declarations.js";
import type { GenerationContext } from "./generation-context.js";
import { type CheckPlan, type FixPlan } from "./module-graph.js";
import {
  planNextStepInstructions,
  type NextStepInstruction,
} from "./next-step-instructions.js";
import type { DependencyMaintenancePolicy } from "./project-github.js";
import type { RenderOperation } from "./renderer.js";

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
