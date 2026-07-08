import path from "node:path";

import type { CheckEnvironmentNeed } from "./module-graph.js";
import type { PresetProjectionPlan } from "./preset-projection.js";
import type { RenderOperation } from "./renderer.js";

export type NextStepInstruction = {
  readonly id: string;
  readonly label: string;
  readonly kind: "navigation" | "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly machineVerifiable: boolean;
  readonly environmentNeedKind?: CheckEnvironmentNeed["kind"];
};

export type NextStepInstructionPlan = {
  readonly targetDir: string;
  readonly steps: readonly NextStepInstruction[];
};

export type PlanNextStepInstructionsOptions = {
  readonly targetDir: string;
  readonly projectionPlan: PresetProjectionPlan;
};

export type FollowUpDocumentPlan = {
  readonly enabled: boolean;
  readonly path?: "TODO.md";
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
  return plan.checkPlan.environmentNeeds.map((need) => ({
    id: need.nextStep.id,
    label: need.nextStep.label,
    kind: "command",
    command: need.nextStep.command,
    args: need.nextStep.args,
    cwd: "",
    display: need.nextStep.display,
    machineVerifiable: need.nextStep.machineVerifiable,
    environmentNeedKind: need.kind,
  }));
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

export function formatNextStepInstructionsForCli(
  plan: NextStepInstructionPlan,
): string {
  return [
    "Next Step Instructions:",
    "",
    ...plan.steps.flatMap((step, index) => [
      `  ${index + 1}. ${step.label}`,
      `     ${step.display}`,
    ]),
  ].join("\n");
}

function isOptionalGitInstruction(step: NextStepInstruction): boolean {
  return step.id.startsWith("optional-git-");
}

function relativeCwd(
  plan: NextStepInstructionPlan,
  step: NextStepInstruction,
): string | undefined {
  const targetDir = path.resolve(plan.targetDir);
  const cwd = path.resolve(step.cwd);

  if (cwd === targetDir) {
    return undefined;
  }

  const relative = path.relative(targetDir, cwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return cwd;
  }

  return relative;
}

function taskTitle(step: NextStepInstruction): string {
  const title = step.label.replace(/^Optional:\s*/, "");
  return `${title.slice(0, 1).toUpperCase()}${title.slice(1)}`;
}

function formatTodoTask(
  plan: NextStepInstructionPlan,
  step: NextStepInstruction,
): string[] {
  const taskLines = [`- [ ] ${taskTitle(step)}`];
  const cwd = relativeCwd(plan, step);

  if (cwd !== undefined) {
    taskLines.push(`  From \`${cwd}\`:`);
  }

  taskLines.push(`  \`${step.display}\``);
  return taskLines;
}

export function formatGeneratedFollowUpDocument(
  plan: NextStepInstructionPlan,
): string {
  const projectLocalSteps = plan.steps.filter(
    (step) => step.kind === "command",
  );
  const nextSteps = projectLocalSteps.filter(
    (step) => !isOptionalGitInstruction(step),
  );
  const optionalGitSteps = projectLocalSteps.filter(isOptionalGitInstruction);

  return [
    "# TODO",
    "",
    "Generated follow-up tasks for this repository.",
    "",
    "### Next Steps",
    ...nextSteps.flatMap((step) => formatTodoTask(plan, step)),
    "",
    "### Optional Git Setup",
    ...optionalGitSteps.flatMap((step) => formatTodoTask(plan, step)),
    "",
    "### Done ✓",
    "",
  ].join("\n");
}

export function generatedFollowUpDocumentOperation(
  plan: NextStepInstructionPlan,
): RenderOperation {
  return {
    kind: "writeText",
    to: "TODO.md",
    text: formatGeneratedFollowUpDocument(plan),
  };
}
