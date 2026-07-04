import { renderPlaywrightBrowserInstallCommand } from "./module-graph.js";
import type { PresetProjectionPlan } from "./preset-projection.js";

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
  readonly targetDir: string;
  readonly steps: readonly NextStepInstruction[];
};

export type PlanNextStepInstructionsOptions = {
  readonly targetDir: string;
  readonly projectionPlan: PresetProjectionPlan;
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

function optionalGitInstructions(): NextStepInstruction[] {
  return [
    {
      id: "optional-git-init",
      label: "Optional: initialize git",
      kind: "command",
      command: "git",
      args: ["init"],
      cwd: "",
      display: "git init",
      machineVerifiable: false,
    },
    {
      id: "optional-git-add",
      label: "Optional: stage files",
      kind: "command",
      command: "git",
      args: ["add", "."],
      cwd: "",
      display: "git add .",
      machineVerifiable: false,
    },
    {
      id: "optional-git-commit",
      label: "Optional: create your first commit",
      kind: "command",
      command: "git",
      args: ["commit", "-m", "Initial commit"],
      cwd: "",
      display: 'git commit -m "Initial commit"',
      machineVerifiable: false,
    },
  ];
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

function checkEnvironmentInstructions(
  plan: PresetProjectionPlan,
): NextStepInstruction[] {
  return plan.checkPlan.environmentNeeds.map((need) => {
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

function projectionInstructions(
  plan: PresetProjectionPlan,
): NextStepInstruction[] {
  const steps = [installDependenciesInstruction()];

  if (plan.capabilities.fixCommand) {
    steps.push(fixInstruction());
  }

  steps.push(...checkEnvironmentInstructions(plan));

  if (plan.capabilities.rootCheck) {
    steps.push(rootCheckInstruction());
  }

  steps.push(...optionalGitInstructions());

  return steps;
}

export function planNextStepInstructions(
  options: PlanNextStepInstructionsOptions,
): NextStepInstructionPlan {
  const targetDir = options.targetDir;
  const commandSteps = projectionInstructions(options.projectionPlan).map(
    (step) => ({
      ...step,
      cwd: targetDir,
    }),
  );
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
    targetDir,
    steps: Object.freeze(
      [navigationStep, ...commandSteps].map((step) => Object.freeze(step)),
    ),
  });
}
