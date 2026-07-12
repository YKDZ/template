import type { PackageContribution } from "./package-contribution.ts";
import type { ProjectBlueprintV2 } from "./project-blueprint-v2.ts";
import type { TemplateSourceHandle } from "./renderer.ts";

/** Stable, preset-agnostic input supplied after toolchain resolution. */
export type GenerationContext = {
  readonly targetDir: string;
  readonly projectName: string;
  readonly scope: string;
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly packageManagerPin: string;
  };
};

/** A side-effect-free Built-in Preset planner. */
export type BuiltInPresetDefinition = {
  readonly metadata: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
  };
  /** The Definition owns its Preset-local Self-Checking Template Source. */
  readonly source: TemplateSourceHandle;
  /** The owned planner source inspected by the Template Boundary Check. */
  readonly plannerSourceFile: string;
  blueprint(context: GenerationContext): ProjectBlueprintV2;
  planInitialization(context: GenerationContext): PackageContribution;
  /**
   * Multi-package Definitions expose their complete owned topology directly,
   * while single-package Definitions keep the compact tracer interface.
   */
  planInitializationContributions?(
    context: GenerationContext,
  ): readonly PackageContribution[];
  /** Package layout is Preset-owned even when callers omit --path. */
  defaultPackagePath?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
  }): string;
  planPackageAddition?(options: {
    readonly context: GenerationContext;
    readonly packageLeafName: string;
    readonly packagePath: string;
  }): PackageContribution;
};
