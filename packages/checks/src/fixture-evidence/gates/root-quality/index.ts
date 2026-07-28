import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import type { GeneratedRepositoryPlan } from "#template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  type FixtureCommandRunner,
  type FixtureEvidenceExecutionResource,
} from "../../kernel/index.ts";

const qualityTaskNames = [
  "boundaries",
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:e2e",
] as const;

const fixTaskNames = ["lint:fix", "format:write"] as const;

function expectedTaskIds(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly taskNames: readonly string[];
}): readonly string[] {
  return options.plan.manifests.flatMap((manifest) => {
    const name = manifest.name;
    const scripts = manifest.scripts;
    if (
      typeof name !== "string" ||
      typeof scripts !== "object" ||
      scripts === null
    ) {
      return [];
    }
    return options.taskNames.flatMap((taskName) =>
      typeof (scripts as Record<string, unknown>)[taskName] !== "string"
        ? []
        : [`${name.startsWith("@") ? name : "//"}#${taskName}`],
    );
  });
}

function commandStdout(result: unknown): string {
  return typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
    ? result.stdout
    : "";
}

function environmentPreparations(plan: GeneratedRepositoryPlan): readonly {
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
}[] {
  const seen = new Set<string>();
  return plan.environmentNeeds.flatMap((need) => {
    const preparation = need.nextStep;
    if (!preparation.machineVerifiable || seen.has(preparation.display)) {
      return [];
    }
    seen.add(preparation.display);
    return [
      {
        command: preparation.command,
        args: [...preparation.args],
        display: preparation.display,
      },
    ];
  });
}

export function generatedScenarioInstallArgs(
  workspace: string,
): readonly string[] {
  return ["install", "--store-dir", path.join(workspace, ".pnpm-store")];
}

export function generatedRootQualityExecutionResources(
  plan: GeneratedRepositoryPlan,
): readonly FixtureEvidenceExecutionResource[] {
  return plan.environmentNeeds.some(
    (need) => need.kind === "playwright-browser-assets",
  )
    ? ["browser"]
    : [];
}

export function normalizedGeneratedRootQualityPlan(
  plan: GeneratedRepositoryPlan,
  options: { readonly includeFix?: boolean } = {},
): unknown {
  return {
    gate: "generated-root-quality",
    executionResources: generatedRootQualityExecutionResources(plan),
    dependencyInstallation: {
      command: "pnpm",
      args: ["install", "--store-dir", "{fixture-workspace}/.pnpm-store"],
    },
    taskDiscovery: {
      command: "pnpm",
      args: ["exec", "turbo", "run", ...qualityTaskNames, "--dry-run=json"],
      expectedTaskIds: [
        ...expectedTaskIds({ plan, taskNames: qualityTaskNames }),
      ].sort(),
    },
    environmentPreparations: environmentPreparations(plan),
    normalization:
      options.includeFix === true
        ? {
            taskDiscovery: {
              command: "pnpm",
              args: ["exec", "turbo", "run", ...fixTaskNames, "--dry-run=json"],
              expectedTaskIds: [
                ...expectedTaskIds({ plan, taskNames: fixTaskNames }),
              ].sort(),
            },
            command: "pnpm",
            args: ["run", "fix"],
          }
        : null,
    rootCheck: {
      command: "pnpm",
      args: ["run", "check"],
    },
  };
}

export async function deriveGeneratedRootQualityContractIdentity(
  plan: GeneratedRepositoryPlan,
  options: { readonly includeFix?: boolean } = {},
): Promise<string> {
  return await deriveFixtureGateContractIdentity({
    normalizedPlan: normalizedGeneratedRootQualityPlan(plan, options),
    sourceProjections: [
      {
        name: "generated-root-quality",
        root: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        name: "fixture-evidence-kernel",
        root: fileURLToPath(new URL("../../kernel/", import.meta.url)),
      },
    ],
  });
}

/**
 * Validates the real Turbo action graph instead of accepting command launch
 * alone as proof that every generated Package Boundary was selected.
 */
export async function assertGeneratedTaskDiscovery(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly projectDir: string;
  readonly taskNames: readonly string[];
  readonly run?: FixtureCommandRunner;
}): Promise<void> {
  const run =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const result = await run(
    "pnpm",
    ["exec", "turbo", "run", ...options.taskNames, "--dry-run=json"],
    { cwd: options.projectDir },
  );
  let taskIds: Set<string>;
  try {
    const dryRun = JSON.parse(commandStdout(result)) as {
      tasks?: readonly { taskId?: unknown }[];
    };
    if (!Array.isArray(dryRun.tasks)) throw new Error("tasks is missing");
    taskIds = new Set(
      dryRun.tasks.flatMap((task) =>
        typeof task.taskId === "string" ? [task.taskId] : [],
      ),
    );
  } catch (error) {
    throw new Error(
      `Turbo dry-run did not return a task graph for ${options.taskNames.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const missing = expectedTaskIds(options).filter(
    (taskId) => !taskIds.has(taskId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Turbo dry-run omitted generated task(s): ${missing.join(", ")}`,
    );
  }
}

export async function executeGeneratedRootQuality(options: {
  readonly plan: GeneratedRepositoryPlan;
  readonly projectDir: string;
  readonly fixtureWorkspace: string;
  readonly includeFix?: boolean;
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  await options.run(
    "pnpm",
    generatedScenarioInstallArgs(options.fixtureWorkspace),
    {
      cwd: options.projectDir,
      stdio: "inherit",
    },
  );
  await assertGeneratedTaskDiscovery({
    plan: options.plan,
    projectDir: options.projectDir,
    taskNames: qualityTaskNames,
    run: options.run,
  });
  if (options.includeFix === true) {
    await assertGeneratedTaskDiscovery({
      plan: options.plan,
      projectDir: options.projectDir,
      taskNames: fixTaskNames,
      run: options.run,
    });
  }
  for (const preparation of environmentPreparations(options.plan)) {
    await options.run(preparation.command, preparation.args, {
      cwd: options.projectDir,
      stdio: "inherit",
    });
  }
  if (options.includeFix === true) {
    await options.run("pnpm", ["run", "fix"], {
      cwd: options.projectDir,
      stdio: "inherit",
    });
  }
  await options.run("pnpm", ["run", "check"], {
    cwd: options.projectDir,
    stdio: "inherit",
  });
}
