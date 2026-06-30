import { execa, type Options as ExecaOptions } from "execa";
import path from "node:path";
import type { PresetName } from "./declarations.js";

export type PostCommand = {
  id: string;
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
};

export type PlanPostCommandsOptions = {
  preset: PresetName;
  targetDir: string;
};

const postCommandPlanBrand: unique symbol = Symbol("PostCommandPlan");

export type PostCommandPlan = {
  readonly preset: PresetName;
  readonly targetDir: string;
  readonly commands: readonly PostCommand[];
  readonly [postCommandPlanBrand]: true;
};

export type PostCommandExecution =
  | {
      command: PostCommand;
      status: "run";
      exitCode: 0;
    }
  | {
      command: PostCommand;
      status: "failed";
      exitCode: number | null;
      error: string;
    };

export type PostCommandExecutor = (
  command: PostCommand
) => Promise<{ exitCode: number }>;

export type RunPostCommandsOptions = {
  plan: PostCommandPlan;
  executor?: PostCommandExecutor;
};

const nodeReadySmokeCommand = {
  id: "node-ready-smoke",
  label: "Check Node runtime",
  command: "node",
  args: ["--version"]
} as const;

function postCommandsForPreset(options: PlanPostCommandsOptions): PostCommand[] {
  if (options.preset === "rust-bin") {
    return [];
  }

  return [
    {
      ...nodeReadySmokeCommand,
      cwd: options.targetDir
    }
  ];
}

export function planPostCommands(options: PlanPostCommandsOptions): PostCommandPlan {
  const targetDir = path.resolve(options.targetDir);
  const commands = postCommandsForPreset({
    preset: options.preset,
    targetDir
  }).map((command) => Object.freeze(command));

  return Object.freeze({
    preset: options.preset,
    targetDir,
    commands: Object.freeze(commands),
    [postCommandPlanBrand]: true as const
  });
}

async function defaultExecutor(command: PostCommand): Promise<{ exitCode: number }> {
  await execa(command.command, [...command.args], {
    cwd: command.cwd,
    stdio: "ignore"
  } satisfies ExecaOptions);

  return { exitCode: 0 };
}

function isWithinDirectory(parentDir: string, childPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function sameCommand(left: PostCommand, right: PostCommand): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index]) &&
    path.resolve(left.cwd) === path.resolve(right.cwd)
  );
}

function validatePostCommandPlan(plan: PostCommandPlan): void {
  const expectedCommands = postCommandsForPreset({
    preset: plan.preset,
    targetDir: path.resolve(plan.targetDir)
  });

  for (const command of plan.commands) {
    if (!isWithinDirectory(plan.targetDir, command.cwd)) {
      throw new Error(`Post Command cwd must stay within the target directory: ${command.id}`);
    }

    const expectedCommand = expectedCommands.find((candidate) => candidate.id === command.id);
    if (!expectedCommand) {
      throw new Error(`Unplanned Post Command: ${command.id}`);
    }

    if (!sameCommand(command, expectedCommand)) {
      throw new Error(`Post Command does not match the planned template command: ${command.id}`);
    }
  }
}

export async function runPostCommands(
  options: RunPostCommandsOptions
): Promise<PostCommandExecution[]> {
  const executor = options.executor ?? defaultExecutor;
  const results: PostCommandExecution[] = [];

  validatePostCommandPlan(options.plan);

  for (const command of options.plan.commands) {
    try {
      const result = await executor(command);
      if (result.exitCode !== 0) {
        results.push({
          command,
          status: "failed",
          exitCode: result.exitCode,
          error: `Post Command failed with exit code ${result.exitCode}: ${command.id}`
        });
        break;
      }

      results.push({ command, status: "run", exitCode: 0 });
    } catch (error: unknown) {
      const exitCode =
        error instanceof Error && "exitCode" in error && typeof error.exitCode === "number"
          ? error.exitCode
          : null;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        command,
        status: "failed",
        exitCode,
        error: `Post Command failed: ${command.id}: ${message}`
      });
      break;
    }
  }

  return results;
}
