import { fileURLToPath } from "node:url";

import type { GeneratedRepositoryPlan } from "#template-builtin-presets";

import {
  deriveFixtureGateContractIdentity,
  normalizedFixtureDependencyInstallationPlan,
  writeGeneratedRepositoryTree,
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
    dependencyInstallation: normalizedFixtureDependencyInstallationPlan(),
    taskDiscovery: {
      command: "pnpm",
      args: ["exec", "turbo", "run", ...qualityTaskNames, "--dry-run=json"],
      expectedTaskIds: [
        ...expectedTaskIds({ plan, taskNames: qualityTaskNames }),
      ].sort(),
    },
    developmentContainer: {
      lockfileWrites: false,
      probes: plan.developmentContainer.probes.map((probe) => ({
        identity: probe.identity,
        command: probe.command,
        args: [...(probe.args ?? [])],
        failureMessage: probe.failureMessage ?? null,
      })),
    },
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
  readonly run: FixtureCommandRunner;
}): Promise<void> {
  const result = await options.run(
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
  readonly identityRun?: FixtureCommandRunner;
}): Promise<void> {
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
  await options.run("pnpm", ["run", "check"], {
    cwd: options.projectDir,
    stdio: "inherit",
  });
  if (options.includeFix === true) {
    const beforeFix = await writeGeneratedRepositoryTree({
      repositoryRoot: options.projectDir,
      run: options.identityRun ?? options.run,
    });
    await options.run("pnpm", ["run", "fix"], {
      cwd: options.projectDir,
      stdio: "inherit",
    });
    const afterFix = await writeGeneratedRepositoryTree({
      repositoryRoot: options.projectDir,
      run: options.identityRun ?? options.run,
    });
    if (afterFix !== beforeFix) {
      throw new Error(
        `Generated Repository Fix Command changed the working-tree identity from ${beforeFix} to ${afterFix}`,
      );
    }
    await options.run("pnpm", ["run", "check"], {
      cwd: options.projectDir,
      stdio: "inherit",
    });
  }
}
