import { spawn } from "node:child_process";
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

type PlannedPostCommand = Omit<PostCommand, "cwd">;

const packageManagerPin = "pnpm@10.0.0";

const nodeReadyCommands = [
  {
    id: "node-enable-corepack",
    label: "Enable Corepack",
    command: "corepack",
    args: ["enable"]
  },
  {
    id: "node-refresh-package-manager-pin",
    label: "Refresh Package Manager Pin and Install Dependencies",
    command: "corepack",
    args: ["use", packageManagerPin]
  },
  {
    id: "node-run-fix",
    label: "Run Fix Command",
    command: "pnpm",
    args: ["run", "fix"]
  }
] as const satisfies readonly PlannedPostCommand[];

const vueReadyCommand = {
  id: "vue-install-playwright-browsers",
  label: "Install Playwright browser assets",
  command: "pnpm",
  args: ["exec", "playwright", "install", "chromium"]
} as const satisfies PlannedPostCommand;

const vueHonoReadyCommand = {
  id: "vue-hono-install-playwright-browsers",
  label: "Install Playwright browser assets for web workspace",
  command: "pnpm",
  args: ["--filter", "./apps/web", "exec", "playwright", "install", "chromium"]
} as const satisfies PlannedPostCommand;

function postCommandsForPreset(options: PlanPostCommandsOptions): PostCommand[] {
  if (
    options.preset !== "ts-lib" &&
    options.preset !== "hono-api" &&
    options.preset !== "vue-app" &&
    options.preset !== "vue-hono-app"
  ) {
    return [];
  }

  const commands: PlannedPostCommand[] = [...nodeReadyCommands];

  if (options.preset === "vue-app") {
    commands.push(vueReadyCommand);
  }

  if (options.preset === "vue-hono-app") {
    commands.push(vueHonoReadyCommand);
  }

  return commands.map((command) => ({
    ...command,
    cwd: options.targetDir
  }));
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
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1 });
    });
  });
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
  const expectedCommandIds = new Set(expectedCommands.map((command) => command.id));

  for (const command of plan.commands) {
    if (!isWithinDirectory(plan.targetDir, command.cwd)) {
      throw new Error(`Post Command cwd must stay within the target directory: ${command.id}`);
    }

    if (!expectedCommandIds.has(command.id)) {
      throw new Error(`Unplanned Post Command: ${command.id}`);
    }
  }

  if (plan.commands.length !== expectedCommands.length) {
    throw new Error("Post Command plan must match the complete planned sequence");
  }

  for (const [index, command] of plan.commands.entries()) {
    const expectedCommand = expectedCommands[index];
    if (!expectedCommand || command.id !== expectedCommand.id) {
      throw new Error("Post Command plan must match the complete planned sequence");
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
