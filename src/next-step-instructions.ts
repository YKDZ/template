import path from "node:path";
import type { PresetName } from "./declarations.js";

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

function rustCheckInstruction(): NextStepInstruction {
  return {
    id: "run-check-script",
    label: "Run Check Script",
    kind: "command",
    command: "./scripts/check",
    args: [],
    cwd: "",
    display: "./scripts/check",
    machineVerifiable: true,
  };
}

function presetSpecificInstructions(preset: PresetName): NextStepInstruction[] {
  if (preset === "vue-app") {
    return [
      installDependenciesInstruction(),
      fixInstruction(),
      {
        id: "install-playwright-browsers",
        label: "Install Playwright browser assets",
        kind: "command",
        command: "pnpm",
        args: ["exec", "playwright", "install", "chromium"],
        cwd: "",
        display: "pnpm exec playwright install chromium",
        machineVerifiable: true,
      },
      rootCheckInstruction(),
    ];
  }

  if (preset === "vue-hono-app") {
    return [
      installDependenciesInstruction(),
      fixInstruction(),
      {
        id: "install-web-playwright-browsers",
        label: "Install Playwright browser assets for web workspace",
        kind: "command",
        command: "pnpm",
        args: ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"],
        cwd: "",
        display: "pnpm --filter ./apps/web exec playwright install chromium",
        machineVerifiable: true,
      },
      rootCheckInstruction(),
    ];
  }

  if (preset === "ts-lib" || preset === "hono-api") {
    return [installDependenciesInstruction(), fixInstruction(), rootCheckInstruction()];
  }

  if (preset === "rust-bin") {
    return [rustCheckInstruction()];
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
