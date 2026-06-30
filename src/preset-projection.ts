import type { BuiltInPreset, ProjectBlueprint } from "./declarations.js";
import type { GenerationContext } from "./generation-context.js";
import {
  type CheckPlan,
  type FixPlan,
  renderPlaywrightBrowserInstallCommand,
} from "./module-graph.js";
import type { NextStepInstruction } from "./next-step-instructions.js";
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
  const targetDir = options.targetDir;
  const navigationStep: NextStepInstruction = {
    id: "enter-project",
    label: "Enter Generated Repository",
    kind: "navigation",
    command: "cd",
    args: [targetDir],
    cwd: ".",
    display: `cd ${targetDir}`,
    machineVerifiable: false,
  };
  const environmentSteps = options.plan.checkPlan.environmentNeeds.map(
    (need) => {
      const display = renderPlaywrightBrowserInstallCommand(need);
      const [command, ...args] = display.split(" ");

      return {
        id:
          need.owner.path === "apps/web"
            ? "install-web-playwright-browsers"
            : "install-playwright-browsers",
        label:
          need.owner.path === "apps/web"
            ? "Install Playwright browser assets for web workspace"
            : "Install Playwright browser assets",
        kind: "command" as const,
        command,
        args,
        cwd: targetDir,
        display,
        machineVerifiable: true,
      };
    },
  );

  return [
    navigationStep,
    {
      id: "install-dependencies",
      label: "Install dependencies",
      kind: "command",
      command: "pnpm",
      args: ["install"],
      cwd: targetDir,
      display: "pnpm install",
      machineVerifiable: true,
    },
    {
      id: "run-fix",
      label: "Run Fix Command",
      kind: "command",
      command: "pnpm",
      args: ["run", "fix"],
      cwd: targetDir,
      display: "pnpm run fix",
      machineVerifiable: true,
    },
    ...environmentSteps,
    {
      id: "run-root-check",
      label: "Run Root Check",
      kind: "command",
      command: "pnpm",
      args: ["run", "check"],
      cwd: targetDir,
      display: "pnpm run check",
      machineVerifiable: true,
    },
  ];
}
