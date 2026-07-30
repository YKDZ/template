import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";

import { execa } from "execa";

export type FixtureCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio?: "inherit" },
) => Promise<unknown>;

export type DevelopmentContainerFixtureProbe = {
  readonly identity: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly failureMessage?: string | undefined;
};

export type DevelopmentContainerFixtureSession = {
  readonly reserve: () => Promise<void>;
  readonly run: FixtureCommandRunner;
  readonly execute: <Result>(
    operation: (run: FixtureCommandRunner) => Promise<Result>,
  ) => Promise<Result>;
  readonly close: () => Promise<void>;
};

export type DevelopmentContainerFixtureDependencyCaches = {
  readonly pnpm?: string | undefined;
  readonly cargo?: string | undefined;
};

export type DevelopmentContainerFixtureCacheActivity = {
  readonly cache: FixtureEvidenceCacheKind;
};

const developmentContainerSharedPnpmStore = "/pnpm/store";
const developmentContainerCargoRegistry = "/usr/local/cargo/registry";
const developmentContainerCargoGit = "/usr/local/cargo/git";
const turboCacheEnvironmentNames = [
  "TURBO_TEAM",
  "TURBO_TOKEN",
  "TURBO_REMOTE_CACHE_SIGNATURE_KEY",
  "TURBO_REMOTE_CACHE_READ_ONLY",
] as const;
const turboCacheSecretEnvironmentNames = [
  "TURBO_TOKEN",
  "TURBO_REMOTE_CACHE_SIGNATURE_KEY",
] as const;
const developmentContainerBuildFlights = new Map<string, Promise<void>>();

function redactSecretValues(
  value: string,
  secretValues: readonly string[],
): string {
  return [...secretValues]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      value,
    );
}

function redactCommandError(
  error: unknown,
  secretValues: readonly string[],
): unknown {
  if (error instanceof AggregateError) {
    return new AggregateError(
      error.errors.map((nested) => redactCommandError(nested, secretValues)),
      redactSecretValues(error.message, secretValues),
      error.cause === undefined
        ? undefined
        : { cause: redactCommandError(error.cause, secretValues) },
    );
  }
  if (error instanceof Error) {
    const redacted = new Error(
      redactSecretValues(error.message, secretValues),
      error.cause === undefined
        ? undefined
        : { cause: redactCommandError(error.cause, secretValues) },
    );
    redacted.name = error.name;
    return redacted;
  }
  return typeof error === "string"
    ? redactSecretValues(error, secretValues)
    : error;
}

async function runDevelopmentContainerBuildFlight(
  key: string,
  execute: () => Promise<unknown>,
): Promise<void> {
  const existing = developmentContainerBuildFlights.get(key);
  if (existing !== undefined) {
    await existing;
    return;
  }
  const current = (async () => {
    await execute();
  })();
  developmentContainerBuildFlights.set(key, current);
  try {
    await current;
  } finally {
    if (developmentContainerBuildFlights.get(key) === current) {
      developmentContainerBuildFlights.delete(key);
    }
  }
}

export async function deriveDevelopmentContainerBuildIdentity(options: {
  readonly projectDir: string;
}): Promise<string> {
  const configDirectory = path.join(options.projectDir, ".devcontainer");
  const configPath = path.join(configDirectory, "devcontainer.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (
    typeof config !== "object" ||
    config === null ||
    !("build" in config) ||
    typeof config.build !== "object" ||
    config.build === null
  ) {
    throw new Error(
      `Generated Development Container configuration ${configPath} must declare an object build`,
    );
  }
  const build = config.build as Record<string, unknown>;
  const dockerfile =
    build.dockerfile === undefined ? "Dockerfile" : build.dockerfile;
  const context = build.context === undefined ? "." : build.context;
  if (typeof dockerfile !== "string" || typeof context !== "string") {
    throw new Error(
      `Generated Development Container configuration ${configPath} must use string build paths`,
    );
  }
  const resolveBuildPath = (value: string, label: string): string => {
    const absolute = path.resolve(configDirectory, value);
    const relative = path.relative(options.projectDir, absolute);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Generated Development Container ${label} must stay inside ${options.projectDir}`,
      );
    }
    return relative.split(path.sep).join("/");
  };
  const dockerfilePath = path.resolve(configDirectory, dockerfile);
  const args = build.args ?? {};
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    !Object.values(args).every((value) => typeof value === "string")
  ) {
    throw new Error(
      `Generated Development Container configuration ${configPath} must use string build arguments`,
    );
  }
  return createHash("sha256")
    .update(
      canonicalize({
        dockerfile: {
          path: resolveBuildPath(dockerfile, "Dockerfile"),
          sha256: createHash("sha256")
            .update(await readFile(dockerfilePath))
            .digest("hex"),
        },
        context: resolveBuildPath(context, "build context"),
        args,
      }),
    )
    .digest("hex");
}

export function createDevelopmentContainerFixtureSession(options: {
  readonly projectDir: string;
  readonly probes: readonly DevelopmentContainerFixtureProbe[];
  readonly ownedVolumes?: readonly string[] | undefined;
  readonly dependencyCaches?:
    | DevelopmentContainerFixtureDependencyCaches
    | undefined;
  readonly build?:
    | {
        readonly identity: string;
        readonly cacheDirectory: string;
      }
    | undefined;
  readonly acquireSession?: (() => Promise<() => void>) | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly run?: FixtureCommandRunner;
  readonly recordCacheActivity?:
    | ((
        event: DevelopmentContainerFixtureCacheActivity,
      ) => void | Promise<void>)
    | undefined;
}): DevelopmentContainerFixtureSession {
  const rawRun =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const environment = options.environment ?? {};
  const secretValues = turboCacheSecretEnvironmentNames.flatMap((name) => {
    const value = environment[name];
    return value === undefined || value.length === 0 ? [] : [value];
  });
  const run: FixtureCommandRunner = async (command, args, runOptions) => {
    try {
      return await rawRun(command, args, runOptions);
    } catch (error) {
      throw redactCommandError(error, secretValues);
    }
  };
  const config = path.join(
    options.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const workspaceArgs = ["--workspace-folder", options.projectDir] as const;
  const idLabel = `com.ykdz.template.fixture.project=${createHash("sha256").update(path.resolve(options.projectDir)).digest("hex")}`;
  const identityArgs = ["--id-label", idLabel] as const;
  const remoteEnvironmentArgs = turboCacheEnvironmentNames.flatMap((name) => {
    const value = environment[name];
    return value === undefined || value.length === 0
      ? []
      : ["--remote-env", `${name}=${value}`];
  });
  const buildCacheArgs =
    options.build === undefined
      ? []
      : [
          "--cache-from",
          `type=local,src=${path.join(options.build.cacheDirectory, options.build.identity)}`,
          "--cache-to",
          `type=local,dest=${path.join(options.build.cacheDirectory, options.build.identity)},mode=max`,
        ];
  const recordCacheActivity = async (
    cache: FixtureEvidenceCacheKind,
  ): Promise<void> => {
    await options.recordCacheActivity?.({ cache });
  };
  const createDependencyCacheOverride = async (): Promise<
    | {
        readonly path: string;
        readonly caches: readonly FixtureEvidenceCacheKind[];
      }
    | undefined
  > => {
    const configuredMounts = [
      ...(options.dependencyCaches?.pnpm === undefined
        ? []
        : [
            {
              source: path.resolve(options.dependencyCaches.pnpm),
              target: developmentContainerSharedPnpmStore,
            },
          ]),
      ...(options.dependencyCaches?.cargo === undefined
        ? []
        : [
            {
              source: path.resolve(options.dependencyCaches.cargo, "registry"),
              target: developmentContainerCargoRegistry,
            },
            {
              source: path.resolve(options.dependencyCaches.cargo, "git"),
              target: developmentContainerCargoGit,
            },
          ]),
    ];
    if (configuredMounts.length === 0) return undefined;

    const generatedConfig = JSON.parse(
      await readFile(config, "utf8"),
    ) as Record<string, unknown>;
    const generatedMounts = Array.isArray(generatedConfig.mounts)
      ? generatedConfig.mounts
      : [];
    const generatedTargets = new Set(
      generatedMounts.flatMap((mount) =>
        typeof mount === "object" &&
        mount !== null &&
        "target" in mount &&
        typeof mount.target === "string"
          ? [mount.target]
          : [],
      ),
    );
    const mounts = configuredMounts
      .filter(({ target }) => generatedTargets.has(target))
      .map(({ source, target }) => ({ type: "bind", source, target }));
    if (mounts.length === 0) return undefined;
    const caches = [
      ...(mounts.some(
        ({ target }) => target === developmentContainerSharedPnpmStore,
      )
        ? (["pnpm-downloads"] as const)
        : []),
      ...(mounts.some(
        ({ target }) =>
          target === developmentContainerCargoRegistry ||
          target === developmentContainerCargoGit,
      )
        ? (["cargo-downloads"] as const)
        : []),
    ];

    await Promise.all(
      mounts.map(async ({ source }) => {
        await mkdir(source, { recursive: true });
      }),
    );
    const overrideDirectory = path.join(options.projectDir, ".template");
    await mkdir(overrideDirectory, { recursive: true });
    const overridePath = path.join(
      overrideDirectory,
      `fixture-devcontainer-cache-${randomUUID()}.json`,
    );
    const mountsByTarget = new Map(
      mounts.map((mount) => [mount.target, mount] as const),
    );
    const mergedMounts = generatedMounts.map((mount) =>
      typeof mount === "object" &&
      mount !== null &&
      "target" in mount &&
      typeof mount.target === "string"
        ? (mountsByTarget.get(mount.target) ?? mount)
        : mount,
    );
    await writeFile(
      overridePath,
      `${JSON.stringify({ ...generatedConfig, mounts: mergedMounts }, null, 2)}\n`,
      { flag: "wx" },
    );
    return { path: overridePath, caches };
  };
  let startup: Promise<void> | undefined;
  let reservation: Promise<void> | undefined;
  let upAttempted = false;
  let closed = false;
  let releaseSession: (() => void) | undefined;
  let dependencyCacheOverridePath: string | undefined;

  const exec = async (
    command: string,
    args: readonly string[],
    execOptions: {
      readonly cwd?: string;
      readonly stdio?: "inherit";
    } = {},
  ): Promise<unknown> => {
    const commandCwd = path.resolve(execOptions.cwd ?? options.projectDir);
    const relativeCwd = path.relative(options.projectDir, commandCwd);
    if (
      path.isAbsolute(relativeCwd) ||
      relativeCwd === ".." ||
      relativeCwd.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Development Container Fixture command cwd must be inside ${options.projectDir}`,
      );
    }
    const containerCommand =
      relativeCwd.length === 0
        ? [command, ...args]
        : [
            "sh",
            "-c",
            'cd "$1" && shift && exec "$@"',
            "sh",
            relativeCwd.split(path.sep).join("/"),
            command,
            ...args,
          ];
    if (
      command === "pnpm" &&
      ((args[0] === "run" &&
        (args[1] === "check" ||
          args[1] === "fix" ||
          args[1] === "check:deployment")) ||
        (args[0] === "exec" && args[1] === "turbo"))
    ) {
      await recordCacheActivity("turbo");
    }
    return await run(
      "devcontainer",
      [
        "exec",
        ...workspaceArgs,
        ...identityArgs,
        ...remoteEnvironmentArgs,
        ...containerCommand,
      ],
      {
        cwd: options.projectDir,
        ...(execOptions.stdio === undefined
          ? {}
          : { stdio: execOptions.stdio }),
      },
    );
  };

  const reserve = async (): Promise<void> => {
    reservation ??= (async () => {
      releaseSession = await options.acquireSession?.();
    })();
    await reservation;
  };

  const start = async (): Promise<void> => {
    await reserve();
    try {
      await run("docker", ["version", "--format", "{{.Server.Version}}"], {
        cwd: options.projectDir,
      });
    } catch (error) {
      throw new Error(
        `Docker is required for Generated Repository Fixture quality: ${errorMessage(error)}`,
      );
    }
    try {
      await run("devcontainer", ["--version"], { cwd: options.projectDir });
    } catch (error) {
      throw new Error(
        `The pinned Dev Container CLI is required for Generated Repository Fixture quality: ${errorMessage(error)}`,
      );
    }
    const dependencyCacheOverride = await createDependencyCacheOverride();
    dependencyCacheOverridePath = dependencyCacheOverride?.path;
    for (const cache of dependencyCacheOverride?.caches ?? []) {
      await recordCacheActivity(cache);
    }
    upAttempted = true;
    const up = async () =>
      await run(
        "devcontainer",
        [
          "up",
          ...workspaceArgs,
          "--config",
          config,
          ...(dependencyCacheOverridePath === undefined
            ? []
            : ["--override-config", dependencyCacheOverridePath]),
          "--no-lockfile",
          ...identityArgs,
          ...buildCacheArgs,
        ],
        { cwd: options.projectDir },
      );
    if (options.build === undefined) {
      await up();
    } else {
      await recordCacheActivity("buildkit");
      await runDevelopmentContainerBuildFlight(
        `${path.resolve(options.build.cacheDirectory)}\0${options.build.identity}`,
        up,
      );
    }
    for (const probe of options.probes) {
      try {
        await exec(probe.command, probe.args ?? []);
      } catch (error) {
        throw new Error(
          `Tool Layer capability ${probe.identity} is unavailable${probe.failureMessage === undefined ? "" : `: ${probe.failureMessage}`}: ${errorMessage(error)}`,
        );
      }
    }
    for (const command of fixtureDependencyInstallationPlan(
      developmentContainerSharedPnpmStore,
    ).commands) {
      try {
        await exec(command.command, command.args);
      } catch (error) {
        throw new Error(
          `Dependency preparation failed during ${command.command} ${command.args[0]}: ${errorMessage(error)}`,
        );
      }
    }
  };

  const sessionRun: FixtureCommandRunner = async (
    command,
    args,
    runOptions,
  ) => {
    if (closed) {
      throw new Error("Development Container Fixture session is closed");
    }
    startup ??= start();
    await startup;
    return await exec(command, args, runOptions);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!upAttempted) {
      releaseSession?.();
      return;
    }
    const cleanupErrors: unknown[] = [];
    try {
      const result = await run(
        "docker",
        ["ps", "-aq", "--filter", `label=${idLabel}`],
        { cwd: options.projectDir },
      );
      const stdout =
        typeof result === "object" &&
        result !== null &&
        "stdout" in result &&
        typeof result.stdout === "string"
          ? result.stdout
          : "";
      const containerIds = stdout.trim().split(/\s+/u).filter(Boolean);
      if (containerIds.length > 0) {
        await run("docker", ["rm", "-f", ...containerIds], {
          cwd: options.projectDir,
        });
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const volume of options.ownedVolumes ?? []) {
      try {
        await run("docker", ["volume", "rm", volume], {
          cwd: options.projectDir,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (dependencyCacheOverridePath !== undefined) {
      try {
        await unlink(dependencyCacheOverridePath);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          cleanupErrors.push(error);
        }
      }
    }
    releaseSession?.();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Development Container Fixture cleanup failed",
      );
    }
  };

  return {
    reserve,
    run: sessionRun,
    execute: async <Result>(
      operation: (run: FixtureCommandRunner) => Promise<Result>,
    ): Promise<Result> => {
      let execution:
        | { readonly succeeded: true; readonly value: Result }
        | { readonly succeeded: false; readonly error: unknown };
      try {
        execution = {
          succeeded: true,
          value: await operation(sessionRun),
        };
      } catch (error) {
        execution = { succeeded: false, error };
      }
      let cleanup:
        | { readonly succeeded: true }
        | { readonly succeeded: false; readonly error: unknown };
      try {
        await close();
        cleanup = { succeeded: true };
      } catch (error) {
        cleanup = { succeeded: false, error };
      }
      if (!execution.succeeded) {
        if (cleanup.succeeded) throw execution.error;
        const cleanupErrors =
          cleanup.error instanceof AggregateError
            ? cleanup.error.errors
            : [cleanup.error];
        throw new AggregateError(
          [execution.error, ...cleanupErrors],
          `${errorMessage(execution.error)}; Development Container Fixture cleanup also failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
          { cause: execution.error },
        );
      }
      if (!cleanup.succeeded) throw cleanup.error;
      return execution.value;
    },
    close,
  };
}

const fixtureEvidenceGates = [
  "generated-root-quality",
  "focused-package-link",
  "deployment-quality",
] as const;

export type FixtureEvidenceGate = (typeof fixtureEvidenceGates)[number];

export type FixtureEvidenceMissReason =
  | "absent"
  | "stale"
  | "content-changed"
  | "contract-changed"
  | "invalid"
  | "read-disabled";

export type FixtureEvidenceScenarioDiagnostics = {
  readonly id: string;
  readonly label: string;
  readonly presetIdentities: readonly string[];
};

export type FixtureEvidenceRecord = {
  readonly schema: "fixture-verification-evidence/v1";
  readonly gate: FixtureEvidenceGate;
  readonly identity: string;
  readonly components: {
    readonly generatedContent: string;
    readonly contract: string;
    readonly rootEvidence?: string;
  };
  readonly issuedAt: string;
  readonly scenario: FixtureEvidenceScenarioDiagnostics;
  readonly producerCommit: string;
};

export type FixtureEvidenceLifecycleEvent =
  | {
      readonly type: "lookup";
      readonly gate: FixtureEvidenceGate;
      readonly identity: string;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "hit";
    }
  | {
      readonly type: "lookup";
      readonly gate: FixtureEvidenceGate;
      readonly identity: string;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "miss";
      readonly reason: FixtureEvidenceMissReason;
    }
  | {
      readonly type: "lookup";
      readonly gate: FixtureEvidenceGate;
      readonly identity: string;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "error";
      readonly error: string;
    }
  | {
      readonly type: "execution";
      readonly gate: FixtureEvidenceGate;
      readonly identity: string;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "started" | "succeeded" | "failed";
      readonly error?: string;
    }
  | {
      readonly type: "issuance";
      readonly gate: FixtureEvidenceGate;
      readonly identity: string;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "issued" | "error";
      readonly error?: string;
    };

export type FixtureEvidenceCacheKind =
  | "buildkit"
  | "pnpm-downloads"
  | "cargo-downloads"
  | "turbo";

export type FixtureEvidenceInvocationEvent =
  | FixtureEvidenceLifecycleEvent
  | {
      readonly type: "cache";
      readonly cache: FixtureEvidenceCacheKind;
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly at: string;
      readonly outcome: "used";
    }
  | {
      readonly type: "invocation";
      readonly outcome: "started";
      readonly scenarios: readonly FixtureEvidenceScenarioDiagnostics[];
    }
  | {
      readonly type: "invocation";
      readonly outcome: "completed";
    }
  | {
      readonly type: "invocation";
      readonly outcome: "failed";
      readonly error: string;
    }
  | {
      readonly type: "scenario";
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly outcome: "completed" | "not-applicable";
    }
  | {
      readonly type: "scenario";
      readonly scenario: FixtureEvidenceScenarioDiagnostics;
      readonly outcome: "failed";
      readonly error: string;
    }
  | {
      readonly type: "lifecycle-error";
      readonly stage: "activity" | "prune";
      readonly at: string;
      readonly error: string;
    };

export type FixtureEvidenceActivityRecord = {
  readonly schema: "fixture-evidence-activity/v1";
  readonly runId: string;
  readonly runAttempt: string;
  readonly invocationId: string;
  readonly scenarioSet: string;
  readonly writeEnabled: boolean;
  readonly recordedAt: string;
  readonly event: FixtureEvidenceInvocationEvent;
};

export type FixtureEvidenceActivityInvocation = {
  readonly record: (event: FixtureEvidenceInvocationEvent) => Promise<void>;
};

export type FixtureEvidenceActivityLedger = {
  readonly invocation: (options: {
    readonly runId: string;
    readonly runAttempt: string;
    readonly invocationId: string;
    readonly scenarioSet: string;
    readonly writeEnabled: boolean;
    readonly clock?: () => Date;
  }) => FixtureEvidenceActivityInvocation;
  readonly read: () => Promise<readonly FixtureEvidenceActivityRecord[]>;
};

export type FixtureEvidenceHealthFailureCode =
  | "activity-io-error"
  | "incomplete-invocation"
  | "incomplete-scenario"
  | "failed-execution"
  | "lifecycle-error"
  | "missing-issuance"
  | "missing-scenario-set"
  | "no-lookup";

export type FixtureEvidenceHealthFailure = {
  readonly code: FixtureEvidenceHealthFailureCode;
  readonly scenarioSet?: string;
  readonly invocationId?: string;
  readonly scenarioId?: string;
  readonly gate?: FixtureEvidenceGate;
  readonly identity?: string;
  readonly detail: string;
};

export type FixtureEvidenceHealthStage = {
  readonly scenarioSet: string;
  readonly invocations: number;
  readonly scenarios: number;
  readonly hits: number;
  readonly misses: Partial<Record<FixtureEvidenceMissReason, number>>;
  readonly cacheActivity: Partial<Record<FixtureEvidenceCacheKind, number>>;
  readonly executions: number;
  readonly issuances: number;
  readonly lifecycleErrors: number;
  readonly durationMilliseconds: number;
};

export type FixtureEvidenceHealthScenario = {
  readonly scenarioSet: string;
  readonly invocationId: string;
  readonly id: string;
  readonly label: string;
  readonly outcome: "completed" | "failed" | "not-applicable";
  readonly gates: readonly {
    readonly gate: FixtureEvidenceGate;
    readonly status: "executed" | "failed" | "hit";
    readonly missReason?: FixtureEvidenceMissReason;
    readonly issued: boolean;
  }[];
};

export type FixtureEvidenceHealthReport = {
  readonly healthy: boolean;
  readonly runId: string;
  readonly runAttempt: string;
  readonly failures: readonly FixtureEvidenceHealthFailure[];
  readonly scenarios: readonly FixtureEvidenceHealthScenario[];
  readonly stages: readonly FixtureEvidenceHealthStage[];
};

export type FixtureEvidenceStorage = {
  readonly read: (
    gate: FixtureEvidenceGate,
    identity: string,
  ) => Promise<string | undefined>;
  readonly writeAtomically: (record: FixtureEvidenceRecord) => Promise<void>;
  readonly prune?: (options?: {
    readonly clock?: () => Date;
    readonly freshnessMilliseconds?: number;
  }) => Promise<{ readonly removed: number }>;
};

export type FixtureEvidenceAtomicFileOperations = {
  readonly writeTemporary?: (
    temporary: string,
    contents: string,
  ) => Promise<void>;
  readonly replace?: (temporary: string, destination: string) => Promise<void>;
};

export type FixtureEvidenceExecutionResource =
  | "browser"
  | "development-container-session"
  | "docker";

export type FixtureEvidenceSchedulingOptions = {
  readonly concurrency?: number;
  readonly developmentContainerSessions?: number;
};

export type FixtureEvidenceScheduler = {
  readonly acquire: (
    resources: readonly FixtureEvidenceExecutionResource[],
  ) => Promise<() => void>;
  readonly run: <Result>(
    resources: readonly FixtureEvidenceExecutionResource[],
    execute: () => Promise<Result>,
  ) => Promise<Result>;
};

export type FixtureEvidenceSchedulerFactory = (
  options: FixtureEvidenceSchedulingOptions,
) => FixtureEvidenceScheduler;

export const fixtureEvidenceFreshnessMilliseconds = 7 * 24 * 60 * 60 * 1_000;

export function defaultDevelopmentContainerSessionConcurrency(): number {
  return Math.max(1, Math.min(2, Math.floor(availableParallelism() / 2)));
}

class CapacityLimiter {
  readonly #capacity: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(capacity: number, label: string) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`${label} concurrency must be a positive integer`);
    }
    this.#capacity = capacity;
  }

  async run<Result>(execute: () => Promise<Result>): Promise<Result> {
    const release = await this.acquire();
    try {
      return await execute();
    } finally {
      release();
    }
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#capacity) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#active -= 1;
    } else {
      next();
    }
  }
}

export function createFixtureEvidenceScheduler(
  options: FixtureEvidenceSchedulingOptions = {},
): FixtureEvidenceScheduler {
  const ordinary = new CapacityLimiter(
    options.concurrency ?? 2,
    "Fixture evidence",
  );
  const browser = new CapacityLimiter(1, "Browser");
  const developmentContainerSession = new CapacityLimiter(
    options.developmentContainerSessions ??
      defaultDevelopmentContainerSessionConcurrency(),
    "Development Container session",
  );
  const docker = new CapacityLimiter(1, "Docker");
  const acquire = async (
    resources: readonly FixtureEvidenceExecutionResource[],
  ): Promise<() => void> => {
    const releases: Array<() => void> = [];
    try {
      if (resources.includes("docker")) {
        releases.push(await docker.acquire());
      }
      if (resources.includes("development-container-session")) {
        releases.push(await developmentContainerSession.acquire());
      }
      if (resources.includes("browser")) {
        releases.push(await browser.acquire());
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  };
  return {
    acquire,
    run: async (resources, execute) => {
      const release = await acquire(resources);
      try {
        return await ordinary.run(execute);
      } finally {
        release();
      }
    },
  };
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio?: "inherit" },
): Promise<unknown> {
  return execa(command, [...args], options);
}

function commandStdout(result: unknown): string {
  return typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
    ? result.stdout.trim()
    : "";
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("contract plans must contain only JSON values");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type FixtureDependencyInstallationCommand = {
  readonly command: "pnpm";
  readonly args: readonly string[];
};

export type FixtureDependencyInstallationPlan = {
  readonly storeDir: string;
  readonly commands: readonly FixtureDependencyInstallationCommand[];
};

export function fixtureDependencyInstallationPlan(
  storeDir: string,
): FixtureDependencyInstallationPlan {
  return {
    storeDir,
    commands: [
      {
        command: "pnpm",
        args: ["install", "--lockfile-only", "--store-dir", storeDir],
      },
      {
        command: "pnpm",
        args: ["fetch", "--store-dir", storeDir],
      },
      {
        command: "pnpm",
        args: [
          "install",
          "--offline",
          "--frozen-lockfile",
          "--store-dir",
          storeDir,
        ],
      },
    ],
  };
}

export function normalizedFixtureDependencyInstallationPlan(): FixtureDependencyInstallationPlan {
  return fixtureDependencyInstallationPlan(developmentContainerSharedPnpmStore);
}

function fixtureEvidenceIdentity(options: {
  readonly gate: FixtureEvidenceGate;
  readonly generatedContentIdentity: string;
  readonly contractIdentity: string;
  readonly rootEvidenceIdentity?: string;
}): string {
  return sha256(
    canonicalize({
      gate: options.gate,
      generatedContent: options.generatedContentIdentity,
      contract: options.contractIdentity,
      ...(options.rootEvidenceIdentity === undefined
        ? {}
        : { rootEvidence: options.rootEvidenceIdentity }),
    }),
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    [...keys].sort().every((key, index) => key === actual[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFixtureEvidenceGate(value: unknown): value is FixtureEvidenceGate {
  return fixtureEvidenceGates.some((gate) => gate === value);
}

function isFixtureEvidenceCacheKind(
  value: unknown,
): value is FixtureEvidenceCacheKind {
  return (
    value === "buildkit" ||
    value === "pnpm-downloads" ||
    value === "cargo-downloads" ||
    value === "turbo"
  );
}

function parseFixtureEvidenceRecord(value: unknown): FixtureEvidenceRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "gate",
      "identity",
      "components",
      "issuedAt",
      "scenario",
      "producerCommit",
    ]) ||
    value.schema !== "fixture-verification-evidence/v1" ||
    !isFixtureEvidenceGate(value.gate) ||
    typeof value.identity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.identity) ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    new Date(value.issuedAt).toISOString() !== value.issuedAt ||
    typeof value.producerCommit !== "string" ||
    !isRecord(value.components) ||
    !hasExactKeys(
      value.components,
      value.gate === "generated-root-quality"
        ? ["generatedContent", "contract"]
        : ["generatedContent", "contract", "rootEvidence"],
    ) ||
    typeof value.components.generatedContent !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(value.components.generatedContent) ||
    typeof value.components.contract !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.components.contract) ||
    (value.gate !== "generated-root-quality" &&
      (typeof value.components.rootEvidence !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.components.rootEvidence))) ||
    !isRecord(value.scenario) ||
    !hasExactKeys(value.scenario, ["id", "label", "presetIdentities"]) ||
    typeof value.scenario.id !== "string" ||
    typeof value.scenario.label !== "string" ||
    !Array.isArray(value.scenario.presetIdentities) ||
    !value.scenario.presetIdentities.every(
      (identity) => typeof identity === "string",
    )
  ) {
    throw new Error("invalid Fixture Verification Evidence record");
  }
  return value as FixtureEvidenceRecord;
}

function evidenceMissReason(options: {
  readonly record: FixtureEvidenceRecord;
  readonly identity: string;
  readonly generatedContentIdentity: string;
  readonly contractIdentity: string;
  readonly rootEvidenceIdentity?: string;
  readonly now: Date;
  readonly freshnessMilliseconds: number;
}): FixtureEvidenceMissReason | undefined {
  if (
    options.record.identity !== options.identity ||
    fixtureEvidenceIdentity({
      gate: options.record.gate,
      generatedContentIdentity: options.record.components.generatedContent,
      contractIdentity: options.record.components.contract,
      ...(options.record.components.rootEvidence === undefined
        ? {}
        : {
            rootEvidenceIdentity: options.record.components.rootEvidence,
          }),
    }) !== options.record.identity
  ) {
    return "invalid";
  }
  if (
    options.record.components.generatedContent !==
    options.generatedContentIdentity
  ) {
    return "content-changed";
  }
  if (options.record.components.contract !== options.contractIdentity) {
    return "contract-changed";
  }
  if (options.record.components.rootEvidence !== options.rootEvidenceIdentity) {
    return "contract-changed";
  }
  const age = options.now.getTime() - Date.parse(options.record.issuedAt);
  if (age < 0) return "invalid";
  if (age >= options.freshnessMilliseconds) return "stale";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitLifecycle(
  recorder:
    | ((event: FixtureEvidenceLifecycleEvent) => void | Promise<void>)
    | undefined,
  event: FixtureEvidenceLifecycleEvent,
): Promise<void> {
  await recorder?.(event);
}

function storageSegment(value: string, label: string): string {
  if (!/^[a-z0-9-]+$/u.test(value)) {
    throw new Error(`${label} is not a valid evidence storage segment`);
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseScenarioDiagnostics(
  value: unknown,
): FixtureEvidenceScenarioDiagnostics {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "label", "presetIdentities"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    !Array.isArray(value.presetIdentities) ||
    !value.presetIdentities.every((identity) => typeof identity === "string")
  ) {
    throw new Error("invalid Fixture Evidence scenario diagnostics");
  }
  return value as FixtureEvidenceScenarioDiagnostics;
}

function parseFixtureEvidenceInvocationEvent(
  value: unknown,
): FixtureEvidenceInvocationEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("invalid Fixture Evidence activity event");
  }
  if (value.type === "invocation") {
    if (value.outcome === "started") {
      if (
        !hasExactKeys(value, ["type", "outcome", "scenarios"]) ||
        !Array.isArray(value.scenarios)
      ) {
        throw new Error("invalid Fixture Evidence invocation start");
      }
      value.scenarios.forEach(parseScenarioDiagnostics);
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "completed" &&
      hasExactKeys(value, ["type", "outcome"])
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "failed" &&
      hasExactKeys(value, ["type", "outcome", "error"]) &&
      typeof value.error === "string"
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    throw new Error("invalid Fixture Evidence invocation result");
  }
  if (value.type === "scenario") {
    parseScenarioDiagnostics(value.scenario);
    if (
      (value.outcome === "completed" || value.outcome === "not-applicable") &&
      hasExactKeys(value, ["type", "scenario", "outcome"])
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "failed" &&
      hasExactKeys(value, ["type", "scenario", "outcome", "error"]) &&
      typeof value.error === "string"
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    throw new Error("invalid Fixture Evidence scenario result");
  }
  if (value.type === "lifecycle-error") {
    if (
      !hasExactKeys(value, ["type", "stage", "at", "error"]) ||
      (value.stage !== "activity" && value.stage !== "prune") ||
      !isIsoTimestamp(value.at) ||
      typeof value.error !== "string"
    ) {
      throw new Error("invalid Fixture Evidence lifecycle error");
    }
    return value as FixtureEvidenceInvocationEvent;
  }
  if (value.type === "cache") {
    parseScenarioDiagnostics(value.scenario);
    if (
      !hasExactKeys(value, ["type", "cache", "scenario", "at", "outcome"]) ||
      !isFixtureEvidenceCacheKind(value.cache) ||
      !isIsoTimestamp(value.at) ||
      value.outcome !== "used"
    ) {
      throw new Error("invalid Fixture Evidence cache activity");
    }
    return value as FixtureEvidenceInvocationEvent;
  }
  if (
    value.type !== "lookup" &&
    value.type !== "execution" &&
    value.type !== "issuance"
  ) {
    throw new Error("unknown Fixture Evidence activity event");
  }
  if (
    !isFixtureEvidenceGate(value.gate) ||
    typeof value.identity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.identity) ||
    !isIsoTimestamp(value.at)
  ) {
    throw new Error("invalid Fixture Evidence gate activity");
  }
  parseScenarioDiagnostics(value.scenario);
  const commonKeys = ["type", "gate", "identity", "scenario", "at", "outcome"];
  if (value.type === "lookup") {
    if (value.outcome === "hit" && hasExactKeys(value, commonKeys)) {
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "miss" &&
      hasExactKeys(value, [...commonKeys, "reason"]) &&
      (
        [
          "absent",
          "stale",
          "content-changed",
          "contract-changed",
          "invalid",
          "read-disabled",
        ] as readonly unknown[]
      ).includes(value.reason)
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "error" &&
      hasExactKeys(value, [...commonKeys, "error"]) &&
      typeof value.error === "string"
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    throw new Error("invalid Fixture Evidence lookup activity");
  }
  if (value.type === "execution") {
    if (
      (value.outcome === "started" || value.outcome === "succeeded") &&
      hasExactKeys(value, commonKeys)
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    if (
      value.outcome === "failed" &&
      hasExactKeys(value, [...commonKeys, "error"]) &&
      typeof value.error === "string"
    ) {
      return value as FixtureEvidenceInvocationEvent;
    }
    throw new Error("invalid Fixture Evidence execution activity");
  }
  if (value.outcome === "issued" && hasExactKeys(value, commonKeys)) {
    return value as FixtureEvidenceInvocationEvent;
  }
  if (
    value.outcome === "error" &&
    hasExactKeys(value, [...commonKeys, "error"]) &&
    typeof value.error === "string"
  ) {
    return value as FixtureEvidenceInvocationEvent;
  }
  throw new Error("invalid Fixture Evidence issuance activity");
}

function parseFixtureEvidenceActivityRecord(
  value: unknown,
): FixtureEvidenceActivityRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "runId",
      "runAttempt",
      "invocationId",
      "scenarioSet",
      "writeEnabled",
      "recordedAt",
      "event",
    ]) ||
    value.schema !== "fixture-evidence-activity/v1" ||
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    typeof value.runAttempt !== "string" ||
    value.runAttempt.length === 0 ||
    typeof value.invocationId !== "string" ||
    value.invocationId.length === 0 ||
    typeof value.scenarioSet !== "string" ||
    value.scenarioSet.length === 0 ||
    typeof value.writeEnabled !== "boolean" ||
    !isIsoTimestamp(value.recordedAt)
  ) {
    throw new Error("invalid Fixture Evidence activity record");
  }
  parseFixtureEvidenceInvocationEvent(value.event);
  return value as FixtureEvidenceActivityRecord;
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function canonicalPath(input: string): string {
  const missingSegments: string[] = [];
  let existing = path.resolve(input);
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.resolve(input);
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missingSegments);
}

const activityFileWrites = new Map<string, Promise<void>>();

export class FileFixtureEvidenceActivityLedger implements FixtureEvidenceActivityLedger {
  readonly #file: string;

  constructor(options: {
    readonly root: string;
    readonly evidenceRoot: string;
  }) {
    const activityRoot = canonicalPath(options.root);
    const evidenceRoot = canonicalPath(options.evidenceRoot);
    if (
      pathContains(activityRoot, evidenceRoot) ||
      pathContains(evidenceRoot, activityRoot)
    ) {
      throw new Error(
        "Fixture Evidence activity must be isolated from shared evidence storage",
      );
    }
    this.#file = path.join(activityRoot, "activity.jsonl");
  }

  invocation(options: {
    readonly runId: string;
    readonly runAttempt: string;
    readonly invocationId: string;
    readonly scenarioSet: string;
    readonly writeEnabled: boolean;
    readonly clock?: () => Date;
  }): FixtureEvidenceActivityInvocation {
    const clock = options.clock ?? (() => new Date());
    return {
      record: async (event) => {
        const record = parseFixtureEvidenceActivityRecord({
          schema: "fixture-evidence-activity/v1",
          runId: options.runId,
          runAttempt: options.runAttempt,
          invocationId: options.invocationId,
          scenarioSet: options.scenarioSet,
          writeEnabled: options.writeEnabled,
          recordedAt: clock().toISOString(),
          event,
        });
        const previous =
          activityFileWrites.get(this.#file) ?? Promise.resolve();
        const write = previous
          .catch(() => undefined)
          .then(async () => {
            await mkdir(path.dirname(this.#file), { recursive: true });
            await appendFile(this.#file, `${JSON.stringify(record)}\n`, "utf8");
          });
        activityFileWrites.set(this.#file, write);
        try {
          await write;
        } finally {
          if (activityFileWrites.get(this.#file) === write) {
            activityFileWrites.delete(this.#file);
          }
        }
      },
    };
  }

  async read(): Promise<readonly FixtureEvidenceActivityRecord[]> {
    await activityFileWrites.get(this.#file);
    let source: string;
    try {
      source = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isRecord(error) && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) =>
        parseFixtureEvidenceActivityRecord(JSON.parse(line) as unknown),
      );
  }
}

function fixtureActivityGateKey(event: FixtureEvidenceLifecycleEvent): string {
  return [event.scenario.id, event.gate, event.identity].join("\u0000");
}

export async function checkFixtureEvidenceHealth(options: {
  readonly ledger: FixtureEvidenceActivityLedger;
  readonly runId: string;
  readonly runAttempt: string;
  readonly enabledScenarioSets: readonly string[];
}): Promise<FixtureEvidenceHealthReport> {
  let allRecords: readonly FixtureEvidenceActivityRecord[];
  try {
    allRecords = await options.ledger.read();
  } catch (error) {
    return {
      healthy: false,
      runId: options.runId,
      runAttempt: options.runAttempt,
      failures: [
        {
          code: "activity-io-error",
          detail: `Fixture Evidence activity could not be read: ${errorMessage(error)}`,
        },
      ],
      scenarios: [],
      stages: [],
    };
  }
  const records = allRecords.filter(
    (record) =>
      record.runId === options.runId &&
      record.runAttempt === options.runAttempt,
  );
  const failures: FixtureEvidenceHealthFailure[] = [];
  const scenarioStatuses: FixtureEvidenceHealthScenario[] = [];
  const stages: FixtureEvidenceHealthStage[] = [];

  for (const scenarioSet of options.enabledScenarioSets) {
    const stageRecords = records.filter(
      (record) => record.scenarioSet === scenarioSet,
    );
    const invocationIds = new Set(
      stageRecords.map((record) => record.invocationId),
    );
    if (invocationIds.size === 0) {
      failures.push({
        code: "missing-scenario-set",
        scenarioSet,
        detail: `Enabled scenario set ${scenarioSet} has no current-run activity`,
      });
      continue;
    }
    const missCounts: Partial<Record<FixtureEvidenceMissReason, number>> = {};
    let scenarios = 0;
    let hits = 0;
    const cacheActivity: Partial<Record<FixtureEvidenceCacheKind, number>> = {};
    let executions = 0;
    let issuances = 0;
    let lifecycleErrors = 0;

    for (const invocationId of invocationIds) {
      const invocationRecords = stageRecords.filter(
        (record) => record.invocationId === invocationId,
      );
      const starts = invocationRecords.filter(
        (record) =>
          record.event.type === "invocation" &&
          record.event.outcome === "started",
      );
      const terminals = invocationRecords.filter(
        (record) =>
          record.event.type === "invocation" &&
          record.event.outcome !== "started",
      );
      if (starts.length !== 1 || terminals.length !== 1) {
        failures.push({
          code: "incomplete-invocation",
          scenarioSet,
          invocationId,
          detail: `Scenario-set invocation ${invocationId} must have one start and one result`,
        });
      }
      if (
        new Set(invocationRecords.map((record) => record.writeEnabled)).size !==
        1
      ) {
        failures.push({
          code: "incomplete-invocation",
          scenarioSet,
          invocationId,
          detail: `Scenario-set invocation ${invocationId} changed write policy within one ledger`,
        });
      }
      const start = starts[0]?.event;
      const expectedScenarios =
        start?.type === "invocation" && start.outcome === "started"
          ? start.scenarios
          : [];
      scenarios += expectedScenarios.length;
      const scenarioResults = invocationRecords.flatMap((record) =>
        record.event.type === "scenario" ? [record.event] : [],
      );
      for (const scenario of expectedScenarios) {
        if (
          scenarioResults.filter((result) => result.scenario.id === scenario.id)
            .length !== 1
        ) {
          failures.push({
            code: "incomplete-scenario",
            scenarioSet,
            invocationId,
            scenarioId: scenario.id,
            detail: `Scenario ${scenario.id} has no unique current-run result`,
          });
        }
      }

      const lifecycle = invocationRecords.flatMap((record) =>
        record.event.type === "lookup" ||
        record.event.type === "execution" ||
        record.event.type === "issuance"
          ? [record.event]
          : [],
      );
      const cacheEvents = invocationRecords.flatMap((record) =>
        record.event.type === "cache" ? [record.event] : [],
      );
      const expectedScenarioIds = new Set(
        expectedScenarios.map((scenario) => scenario.id),
      );
      for (const event of lifecycle) {
        if (expectedScenarioIds.has(event.scenario.id)) continue;
        failures.push({
          code: "incomplete-scenario",
          scenarioSet,
          invocationId,
          scenarioId: event.scenario.id,
          detail: `Lifecycle activity references undeclared scenario ${event.scenario.id}`,
        });
      }
      for (const event of cacheEvents) {
        if (expectedScenarioIds.has(event.scenario.id)) continue;
        failures.push({
          code: "incomplete-scenario",
          scenarioSet,
          invocationId,
          scenarioId: event.scenario.id,
          detail: `Cache activity references undeclared scenario ${event.scenario.id}`,
        });
      }
      for (const scenario of expectedScenarios) {
        const result = scenarioResults.find(
          (candidate) => candidate.scenario.id === scenario.id,
        );
        const scenarioLifecycle = lifecycle.filter(
          (event) => event.scenario.id === scenario.id,
        );
        if (
          result !== undefined &&
          result.outcome !== "not-applicable" &&
          !scenarioLifecycle.some((event) => event.type === "lookup")
        ) {
          failures.push({
            code: "no-lookup",
            scenarioSet,
            invocationId,
            scenarioId: scenario.id,
            detail: `Scenario ${scenario.id} performed no evidence lookup`,
          });
        }
        const gates = [...new Set(scenarioLifecycle.map((event) => event.gate))]
          .map((gate) => {
            const gateEvents = scenarioLifecycle.filter(
              (event) => event.gate === gate,
            );
            const lookup = gateEvents.find((event) => event.type === "lookup");
            const execution = gateEvents.find(
              (event) =>
                event.type === "execution" &&
                (event.outcome === "succeeded" || event.outcome === "failed"),
            );
            const issuance = gateEvents.find(
              (event) =>
                event.type === "issuance" && event.outcome === "issued",
            );
            return {
              gate,
              status:
                lookup?.type === "lookup" && lookup.outcome === "hit"
                  ? ("hit" as const)
                  : execution?.type === "execution" &&
                      execution.outcome === "succeeded"
                    ? ("executed" as const)
                    : ("failed" as const),
              ...(lookup?.type === "lookup" && lookup.outcome === "miss"
                ? { missReason: lookup.reason }
                : {}),
              issued: issuance !== undefined,
            };
          })
          .sort((left, right) => left.gate.localeCompare(right.gate));
        scenarioStatuses.push({
          scenarioSet,
          invocationId,
          id: scenario.id,
          label: scenario.label,
          outcome:
            result?.outcome === "failed"
              ? "failed"
              : result?.outcome === "not-applicable"
                ? "not-applicable"
                : "completed",
          gates,
        });
      }
      const lookups = lifecycle.filter((event) => event.type === "lookup");
      if (lookups.length === 0) {
        failures.push({
          code: "no-lookup",
          scenarioSet,
          invocationId,
          detail: `Scenario-set invocation ${invocationId} performed no evidence lookup`,
        });
      }
      const misses = new Map<string, FixtureEvidenceLifecycleEvent>();
      const successfulExecutions = new Set<string>();
      const issued = new Set<string>();
      for (const event of lifecycle) {
        if (event.type === "lookup") {
          if (event.outcome === "hit") {
            hits += 1;
          } else if (event.outcome === "miss") {
            missCounts[event.reason] = (missCounts[event.reason] ?? 0) + 1;
            misses.set(fixtureActivityGateKey(event), event);
          } else {
            lifecycleErrors += 1;
            failures.push({
              code: "lifecycle-error",
              scenarioSet,
              invocationId,
              scenarioId: event.scenario.id,
              gate: event.gate,
              identity: event.identity,
              detail: `Evidence lookup failed: ${event.error}`,
            });
          }
        } else if (
          event.type === "execution" &&
          event.outcome === "succeeded"
        ) {
          executions += 1;
          successfulExecutions.add(fixtureActivityGateKey(event));
        } else if (event.type === "execution" && event.outcome === "failed") {
          failures.push({
            code: "failed-execution",
            scenarioSet,
            invocationId,
            scenarioId: event.scenario.id,
            gate: event.gate,
            identity: event.identity,
            detail: `Fixture execution failed for ${event.gate}: ${event.error}`,
          });
        } else if (event.type === "issuance") {
          if (event.outcome === "issued") {
            issuances += 1;
            issued.add(fixtureActivityGateKey(event));
          } else {
            lifecycleErrors += 1;
            failures.push({
              code: "lifecycle-error",
              scenarioSet,
              invocationId,
              scenarioId: event.scenario.id,
              gate: event.gate,
              identity: event.identity,
              detail: `Evidence issuance failed: ${event.error ?? "unknown error"}`,
            });
          }
        }
      }
      for (const event of cacheEvents) {
        cacheActivity[event.cache] = (cacheActivity[event.cache] ?? 0) + 1;
      }
      for (const record of invocationRecords) {
        if (record.event.type !== "lifecycle-error") continue;
        lifecycleErrors += 1;
        failures.push({
          code: "lifecycle-error",
          scenarioSet,
          invocationId,
          detail: `${record.event.stage} lifecycle failed: ${record.event.error}`,
        });
      }
      if (invocationRecords[0]?.writeEnabled === true) {
        for (const [key, miss] of misses) {
          if (successfulExecutions.has(key) && !issued.has(key)) {
            failures.push({
              code: "missing-issuance",
              scenarioSet,
              invocationId,
              scenarioId: miss.scenario.id,
              gate: miss.gate,
              identity: miss.identity,
              detail: `Successful writable miss for ${miss.gate} issued no evidence`,
            });
          }
        }
      }
    }
    stages.push({
      scenarioSet,
      invocations: invocationIds.size,
      scenarios,
      hits,
      misses: missCounts,
      cacheActivity,
      executions,
      issuances,
      lifecycleErrors,
      durationMilliseconds:
        Math.max(
          ...stageRecords.map((record) => Date.parse(record.recordedAt)),
        ) -
        Math.min(
          ...stageRecords.map((record) => Date.parse(record.recordedAt)),
        ),
    });
  }

  return {
    healthy: failures.length === 0,
    runId: options.runId,
    runAttempt: options.runAttempt,
    failures,
    scenarios: scenarioStatuses,
    stages,
  };
}

export function formatFixtureEvidenceHealthReport(
  report: FixtureEvidenceHealthReport,
): readonly string[] {
  const scenarioLines = report.scenarios.map((scenario) => {
    const status =
      scenario.outcome === "not-applicable"
        ? "not applicable"
        : scenario.gates
            .map(
              (gate) =>
                `${gate.gate} ${gate.status}${gate.missReason === undefined ? "" : ` (${gate.missReason})`}${gate.issued ? " issued" : ""}`,
            )
            .join(", ");
    return `[Fixture Evidence] ${scenario.scenarioSet} ${scenario.label}: ${status || scenario.outcome}`;
  });
  const stageLines = report.stages.map((stage) => {
    const misses = Object.entries(stage.misses)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(",");
    const cacheActivity = [
      "buildkit",
      "pnpm-downloads",
      "cargo-downloads",
      "turbo",
    ]
      .map(
        (cache) =>
          `${cache}=${stage.cacheActivity[cache as FixtureEvidenceCacheKind] ?? 0}`,
      )
      .join(",");
    return `[Fixture Evidence] ${stage.scenarioSet}: scenarios=${stage.scenarios} hits=${stage.hits} misses=${misses || "none"} executions=${stage.executions} issuances=${stage.issuances} lifecycle-errors=${stage.lifecycleErrors} duration-ms=${stage.durationMilliseconds} cache-activity=${cacheActivity}`;
  });
  return [...scenarioLines, ...stageLines];
}

export class FileFixtureEvidenceStorage implements FixtureEvidenceStorage {
  readonly #root: string;
  readonly #writeTemporary: (
    temporary: string,
    contents: string,
  ) => Promise<void>;
  readonly #replace: (temporary: string, destination: string) => Promise<void>;

  constructor(
    root: string,
    operations: FixtureEvidenceAtomicFileOperations = {},
  ) {
    this.#root = root;
    this.#writeTemporary =
      operations.writeTemporary ??
      (async (temporary, contents) => {
        await writeFile(temporary, contents, { flag: "wx" });
      });
    this.#replace =
      operations.replace ??
      (async (temporary, destination) => {
        await rename(temporary, destination);
      });
  }

  async read(
    gate: FixtureEvidenceGate,
    identity: string,
  ): Promise<string | undefined> {
    try {
      return await readFile(this.#recordPath(gate, identity), "utf8");
    } catch (error) {
      if (isRecord(error) && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async writeAtomically(record: FixtureEvidenceRecord): Promise<void> {
    const destination = this.#recordPath(record.gate, record.identity);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${randomUUID()}.tmp`,
    );
    try {
      await this.#writeTemporary(
        temporary,
        `${JSON.stringify(record, null, 2)}\n`,
      );
      await this.#replace(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async prune(
    options: {
      readonly clock?: () => Date;
      readonly freshnessMilliseconds?: number;
    } = {},
  ): Promise<{ readonly removed: number }> {
    const now = (options.clock ?? (() => new Date()))();
    let removed = 0;
    for (const gate of fixtureEvidenceGates) {
      const gateRoot = path.join(this.#root, gate);
      let entries;
      try {
        entries = await readdir(gateRoot, { withFileTypes: true });
      } catch (error) {
        if (isRecord(error) && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const recordPath = path.join(gateRoot, entry.name);
        let shouldRemove = true;
        try {
          const record = parseFixtureEvidenceRecord(
            JSON.parse(await readFile(recordPath, "utf8")),
          );
          const reason = evidenceMissReason({
            record,
            identity: record.identity,
            generatedContentIdentity: record.components.generatedContent,
            contractIdentity: record.components.contract,
            ...(record.components.rootEvidence === undefined
              ? {}
              : { rootEvidenceIdentity: record.components.rootEvidence }),
            now,
            freshnessMilliseconds:
              options.freshnessMilliseconds ??
              fixtureEvidenceFreshnessMilliseconds,
          });
          shouldRemove =
            record.gate !== gate ||
            entry.name !== `${record.identity}.json` ||
            reason !== undefined;
        } catch {
          shouldRemove = true;
        }
        if (shouldRemove) {
          await unlink(recordPath);
          removed += 1;
        }
      }
    }
    return { removed };
  }

  #recordPath(gate: FixtureEvidenceGate, identity: string): string {
    return path.join(
      this.#root,
      storageSegment(gate, "gate"),
      `${storageSegment(identity, "identity")}.json`,
    );
  }
}

type FixtureEvidenceGateOptions = {
  readonly gate: FixtureEvidenceGate;
  readonly generatedContentIdentity: string;
  readonly contractIdentity: string;
  readonly scenario: FixtureEvidenceScenarioDiagnostics;
  readonly producerCommit: string;
  readonly storage?: FixtureEvidenceStorage;
  readonly clock?: () => Date;
  readonly freshnessMilliseconds?: number;
  readonly readEnabled?: boolean;
  readonly writeEnabled?: boolean;
  readonly recordLifecycle?: (
    event: FixtureEvidenceLifecycleEvent,
  ) => void | Promise<void>;
  readonly execute: () => Promise<void>;
};

export type FixtureEvidenceGateResult<
  Gate extends FixtureEvidenceGate = FixtureEvidenceGate,
> = {
  readonly [fixtureEvidenceProof]: true;
  readonly gate: Gate;
  readonly status: "hit" | "executed" | "executed-unissued";
  readonly identity: string;
  readonly generatedContentIdentity: string;
  readonly contractIdentity: string;
  readonly missReason?: FixtureEvidenceMissReason;
  readonly issuanceError?: string;
  readonly record?: FixtureEvidenceRecord;
};

const fixtureEvidenceProof = Symbol("fixture-evidence-proof");

type GeneratedRootQualityEvidenceOptions = FixtureEvidenceGateOptions & {
  readonly gate: "generated-root-quality";
  readonly rootEvidence?: never;
};

type FocusedPackageLinkEvidenceOptions = FixtureEvidenceGateOptions & {
  readonly gate: "focused-package-link";
  readonly rootEvidence: FixtureEvidenceGateResult<"generated-root-quality">;
};

type DeploymentQualityEvidenceOptions = FixtureEvidenceGateOptions & {
  readonly gate: "deployment-quality";
  readonly rootEvidence: FixtureEvidenceGateResult<"generated-root-quality">;
};

export function runFixtureEvidenceGate(
  options: GeneratedRootQualityEvidenceOptions,
): Promise<FixtureEvidenceGateResult<"generated-root-quality">>;
export function runFixtureEvidenceGate(
  options: FocusedPackageLinkEvidenceOptions,
): Promise<FixtureEvidenceGateResult<"focused-package-link">>;
export function runFixtureEvidenceGate(
  options: DeploymentQualityEvidenceOptions,
): Promise<FixtureEvidenceGateResult<"deployment-quality">>;
export async function runFixtureEvidenceGate(
  options:
    | GeneratedRootQualityEvidenceOptions
    | FocusedPackageLinkEvidenceOptions
    | DeploymentQualityEvidenceOptions,
): Promise<FixtureEvidenceGateResult> {
  const clock = options.clock ?? (() => new Date());
  const rootEvidenceIdentity =
    options.gate === "generated-root-quality"
      ? undefined
      : options.rootEvidence.identity;
  if (
    options.gate !== "generated-root-quality" &&
    (options.rootEvidence[fixtureEvidenceProof] !== true ||
      options.rootEvidence.gate !== "generated-root-quality" ||
      options.rootEvidence.generatedContentIdentity !==
        options.generatedContentIdentity ||
      fixtureEvidenceIdentity({
        gate: "generated-root-quality",
        generatedContentIdentity: options.rootEvidence.generatedContentIdentity,
        contractIdentity: options.rootEvidence.contractIdentity,
      }) !== options.rootEvidence.identity)
  ) {
    throw new Error(
      `${options.gate === "focused-package-link" ? "Focused Package Link" : "Deployment Quality"} evidence requires successful Root Quality evidence for the same Generated Repository content`,
    );
  }
  const identity = fixtureEvidenceIdentity({
    ...options,
    ...(rootEvidenceIdentity === undefined ? {} : { rootEvidenceIdentity }),
  });
  const now = clock();
  const baseEvent = {
    gate: options.gate,
    identity,
    scenario: options.scenario,
  } as const;
  let missReason: FixtureEvidenceMissReason | undefined;

  if ((options.readEnabled ?? options.storage !== undefined) === false) {
    missReason = "read-disabled";
  } else {
    try {
      const source = await options.storage?.read(options.gate, identity);
      if (source === undefined) {
        missReason = "absent";
      } else {
        let record: FixtureEvidenceRecord | undefined;
        try {
          record = parseFixtureEvidenceRecord(JSON.parse(source));
        } catch {
          missReason = "invalid";
        }
        if (record !== undefined) {
          missReason = evidenceMissReason({
            record,
            identity,
            generatedContentIdentity: options.generatedContentIdentity,
            contractIdentity: options.contractIdentity,
            ...(rootEvidenceIdentity === undefined
              ? {}
              : { rootEvidenceIdentity }),
            now,
            freshnessMilliseconds:
              options.freshnessMilliseconds ??
              fixtureEvidenceFreshnessMilliseconds,
          });
          if (missReason === undefined) {
            await emitLifecycle(options.recordLifecycle, {
              ...baseEvent,
              type: "lookup",
              at: now.toISOString(),
              outcome: "hit",
            });
            return {
              [fixtureEvidenceProof]: true,
              gate: options.gate,
              status: "hit",
              identity,
              generatedContentIdentity: options.generatedContentIdentity,
              contractIdentity: options.contractIdentity,
              record,
            };
          }
        }
      }
    } catch (error) {
      await emitLifecycle(options.recordLifecycle, {
        ...baseEvent,
        type: "lookup",
        at: now.toISOString(),
        outcome: "error",
        error: errorMessage(error),
      });
    }
  }

  if (missReason !== undefined) {
    await emitLifecycle(options.recordLifecycle, {
      ...baseEvent,
      type: "lookup",
      at: now.toISOString(),
      outcome: "miss",
      reason: missReason,
    });
  }
  await emitLifecycle(options.recordLifecycle, {
    ...baseEvent,
    type: "execution",
    at: clock().toISOString(),
    outcome: "started",
  });
  try {
    await options.execute();
    await emitLifecycle(options.recordLifecycle, {
      ...baseEvent,
      type: "execution",
      at: clock().toISOString(),
      outcome: "succeeded",
    });
  } catch (error) {
    await emitLifecycle(options.recordLifecycle, {
      ...baseEvent,
      type: "execution",
      at: clock().toISOString(),
      outcome: "failed",
      error: errorMessage(error),
    });
    throw error;
  }

  if (
    (options.writeEnabled ?? false) === false ||
    options.storage === undefined
  ) {
    return {
      [fixtureEvidenceProof]: true,
      gate: options.gate,
      status: "executed",
      identity,
      generatedContentIdentity: options.generatedContentIdentity,
      contractIdentity: options.contractIdentity,
      ...(missReason === undefined ? {} : { missReason }),
    };
  }
  const record: FixtureEvidenceRecord = {
    schema: "fixture-verification-evidence/v1",
    gate: options.gate,
    identity,
    components: {
      generatedContent: options.generatedContentIdentity,
      contract: options.contractIdentity,
      ...(rootEvidenceIdentity === undefined
        ? {}
        : { rootEvidence: rootEvidenceIdentity }),
    },
    issuedAt: clock().toISOString(),
    scenario: options.scenario,
    producerCommit: options.producerCommit,
  };
  try {
    await options.storage.writeAtomically(record);
    await emitLifecycle(options.recordLifecycle, {
      ...baseEvent,
      type: "issuance",
      at: clock().toISOString(),
      outcome: "issued",
    });
  } catch (error) {
    await emitLifecycle(options.recordLifecycle, {
      ...baseEvent,
      type: "issuance",
      at: clock().toISOString(),
      outcome: "error",
      error: errorMessage(error),
    });
    return {
      [fixtureEvidenceProof]: true,
      gate: options.gate,
      status: "executed-unissued",
      identity,
      generatedContentIdentity: options.generatedContentIdentity,
      contractIdentity: options.contractIdentity,
      ...(missReason === undefined ? {} : { missReason }),
      issuanceError: errorMessage(error),
    };
  }
  return {
    [fixtureEvidenceProof]: true,
    gate: options.gate,
    status: "executed",
    identity,
    generatedContentIdentity: options.generatedContentIdentity,
    contractIdentity: options.contractIdentity,
    ...(missReason === undefined ? {} : { missReason }),
    record,
  };
}

type ContractSourceEntry = {
  readonly executable: boolean;
  readonly path: string;
  readonly projection: string;
  readonly sha256: string;
  readonly type: "file" | "symlink";
};

async function collectContractSourceEntries(options: {
  readonly name: string;
  readonly root: string;
}): Promise<readonly ContractSourceEntry[]> {
  const entries: ContractSourceEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      const relativePath = path
        .relative(options.root, absolutePath)
        .split(path.sep)
        .join("/");
      const metadata = await lstat(absolutePath);
      const content = child.isSymbolicLink()
        ? Buffer.from(await readlink(absolutePath))
        : await readFile(absolutePath);
      entries.push({
        executable: (metadata.mode & 0o111) !== 0,
        path: relativePath,
        projection: options.name,
        sha256: createHash("sha256").update(content).digest("hex"),
        type: child.isSymbolicLink() ? "symlink" : "file",
      });
    }
  }

  await visit(options.root);
  return entries;
}

export async function deriveFixtureGateContractIdentity(options: {
  readonly normalizedPlan: unknown;
  readonly sourceProjections: readonly {
    readonly name: string;
    readonly root: string;
  }[];
}): Promise<string> {
  const projectionNames = new Set<string>();
  for (const projection of options.sourceProjections) {
    if (projection.name.length === 0 || projectionNames.has(projection.name)) {
      throw new Error("contract source projection names must be unique");
    }
    projectionNames.add(projection.name);
  }
  const sources = (
    await Promise.all(
      options.sourceProjections.map(collectContractSourceEntries),
    )
  )
    .flat()
    .sort(
      (left, right) =>
        left.projection.localeCompare(right.projection) ||
        left.path.localeCompare(right.path),
    );
  return createHash("sha256")
    .update(
      canonicalize({
        plan: options.normalizedPlan,
        sources,
      }),
    )
    .digest("hex");
}

export async function initializeFixtureGitRepository(options: {
  readonly repositoryRoot: string;
  readonly run?: FixtureCommandRunner;
}): Promise<void> {
  await (options.run ?? defaultCommandRunner)("git", ["init", "--quiet"], {
    cwd: options.repositoryRoot,
  });
}

export async function stageFixtureGitRepository(options: {
  readonly repositoryRoot: string;
  readonly run?: FixtureCommandRunner;
}): Promise<void> {
  await (options.run ?? defaultCommandRunner)(
    "git",
    ["add", "--all", "--", "."],
    {
      cwd: options.repositoryRoot,
    },
  );
}

export async function writeGeneratedRepositoryTree(options: {
  readonly repositoryRoot: string;
  readonly run?: FixtureCommandRunner;
}): Promise<string> {
  const run = options.run ?? defaultCommandRunner;
  await stageFixtureGitRepository({
    repositoryRoot: options.repositoryRoot,
    run,
  });
  const result = await run("git", ["write-tree"], {
    cwd: options.repositoryRoot,
  });
  const identity = commandStdout(result);
  if (!/^[0-9a-f]{40,64}$/u.test(identity)) {
    throw new Error("git write-tree did not return a tree object identity");
  }
  return identity;
}
