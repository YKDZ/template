import path from "node:path";
import type { PresetName } from "./declarations.js";
import { planPresetChecks, renderPlaywrightBrowserInstallCommand } from "./module-graph.js";

export type NextStepInstruction = {
  readonly id: string;
  readonly label: string;
  readonly kind: "navigation" | "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly machineVerifiable: boolean;
};

export type NextStepInstructionPlan = {
  readonly preset: PresetName;
  readonly targetDir: string;
  readonly steps: readonly NextStepInstruction[];
};

export type PlanNextStepInstructionsOptions = {
  readonly preset: PresetName;
  readonly targetDir: string;
};

function rootCheckInstruction(): NextStepInstruction {
  return {
    id: "run-root-check",
    label: "Run Root Check",
    kind: "command",
    command: "pnpm",
    args: ["run", "check"],
    cwd: "",
    display: "pnpm run check",
    machineVerifiable: true,
  };
}

function installDependenciesInstruction(): NextStepInstruction {
  return {
    id: "install-dependencies",
    label: "Install dependencies",
    kind: "command",
    command: "pnpm",
    args: ["install"],
    cwd: "",
    display: "pnpm install",
    machineVerifiable: true,
  };
}

function fixInstruction(): NextStepInstruction {
  return {
    id: "run-fix",
    label: "Run Fix Command",
    kind: "command",
    command: "pnpm",
    args: ["run", "fix"],
    cwd: "",
    display: "pnpm run fix",
    machineVerifiable: true,
  };
}

function checkEnvironmentInstructions(preset: PresetName): NextStepInstruction[] {
  const checkPlan = planPresetChecks(preset);

  if (!checkPlan) {
    return [];
  }

  return checkPlan.environmentNeeds.map((need) => {
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
      kind: "command",
      command,
      args,
      cwd: "",
      display,
      machineVerifiable: true,
    };
  });
}

function presetSpecificInstructions(preset: PresetName): NextStepInstruction[] {
  if (
    preset === "ts-lib" ||
    preset === "hono-api" ||
    preset === "vue-app" ||
    preset === "vue-hono-app" ||
    preset === "rust-bin"
  ) {
    return [
      installDependenciesInstruction(),
      fixInstruction(),
      ...checkEnvironmentInstructions(preset),
      rootCheckInstruction(),
    ];
  }

  return [installDependenciesInstruction(), rootCheckInstruction()];
}

export function planNextStepInstructions(
  options: PlanNextStepInstructionsOptions,
): NextStepInstructionPlan {
  const targetDir = path.resolve(options.targetDir);
  const commandSteps = presetSpecificInstructions(options.preset).map((step) => ({
    ...step,
    cwd: targetDir,
  }));
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

  return Object.freeze({
    preset: options.preset,
    targetDir,
    steps: Object.freeze([navigationStep, ...commandSteps].map((step) => Object.freeze(step))),
  });
}
