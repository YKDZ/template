import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

export type ContainerCommandOptions = {
  readonly cwd: string;
  readonly stdio?: "inherit";
  readonly env?: NodeJS.ProcessEnv;
  readonly cancelSignal?: AbortSignal;
  readonly timeout?: number;
  readonly killDescendants?: boolean;
};

export type ContainerCommandRunner = (
  command: string,
  args: readonly string[],
  options: ContainerCommandOptions,
) => Promise<unknown>;

export const containerCommandTimeoutMilliseconds = 60 * 60 * 1_000;
export const containerCleanupTimeoutMilliseconds = 5 * 60 * 1_000;

export type DevelopmentContainerProbe = {
  readonly identity: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly failureMessage?: string | undefined;
};

export type DevelopmentContainerSession = {
  readonly reserve: () => Promise<void>;
  readonly prepare: () => Promise<void>;
  readonly run: ContainerCommandRunner;
  readonly execute: <Result>(
    operation: (run: ContainerCommandRunner) => Promise<Result>,
  ) => Promise<Result>;
  readonly close: () => Promise<void>;
};

export type DevelopmentContainerDependencyCaches = {
  readonly pnpm?: string | undefined;
  readonly cargo?: string | undefined;
};

type DevelopmentContainerSessionCacheFact =
  | { readonly cache: "buildkit"; readonly outcome: "configured" }
  | {
      readonly cache: "pnpm-downloads" | "cargo-downloads";
      readonly outcome: "mounted";
    };

export type DevelopmentContainerSessionCacheActivity = {
  readonly type: "cache";
  readonly at: string;
} & DevelopmentContainerSessionCacheFact;

export type DevelopmentContainerSessionPhase =
  | "container-preparation"
  | "dependency-installation";

export type ExternalFailureClassification =
  | "docker-registry-transport-transient"
  | "npm-registry-transport-transient"
  | "not-retryable";

export type DevelopmentContainerSessionPhaseActivity =
  | {
      readonly type: "phase";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "started";
    }
  | {
      readonly type: "phase";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "succeeded";
      readonly durationMilliseconds: number;
    }
  | {
      readonly type: "phase";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "failed";
      readonly durationMilliseconds: number;
      readonly classification: ExternalFailureClassification;
      readonly error: string;
    };

export type DevelopmentContainerSessionRetryActivity =
  | {
      readonly type: "retry";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "started";
      readonly classification: Exclude<
        ExternalFailureClassification,
        "not-retryable"
      >;
      readonly firstError: string;
    }
  | {
      readonly type: "retry";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "recovered";
      readonly durationMilliseconds: number;
    }
  | {
      readonly type: "retry";
      readonly phase: DevelopmentContainerSessionPhase;
      readonly at: string;
      readonly outcome: "failed";
      readonly durationMilliseconds: number;
      readonly error: string;
    };

export type DevelopmentContainerSessionActivity =
  | DevelopmentContainerSessionCacheActivity
  | DevelopmentContainerSessionPhaseActivity
  | DevelopmentContainerSessionRetryActivity;

export type DependencyPreparationCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly retryRegistry?: "npm" | undefined;
};

export const developmentContainerPnpmStorePath = "/pnpm/store";

export async function developmentContainerSessionContractIdentity(): Promise<string> {
  return createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
}
const developmentContainerCargoRegistry = "/usr/local/cargo/registry";
const developmentContainerCargoGit = "/usr/local/cargo/git";
const turboCacheEnvironmentNames = [
  "TURBO_CACHE_DIR",
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
const developmentContainerBuildTails = new Map<string, Promise<void>>();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("build inputs must contain only JSON values");
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
      redactSecretValues(commandErrorDiagnostic(error), secretValues),
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

function commandErrorDiagnostic(error: unknown, depth = 0): string {
  if (depth > 4) return "unknown error";
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.map((nested) =>
        commandErrorDiagnostic(nested, depth + 1),
      ),
      ...(error.cause === undefined
        ? []
        : [commandErrorDiagnostic(error.cause, depth + 1)]),
    ]
      .filter(
        (value, index, values) =>
          value.length > 0 && values.indexOf(value) === index,
      )
      .join("\n");
  }
  if (error instanceof Error || isRecord(error)) {
    const record = error as unknown as Record<string, unknown>;
    return [
      error instanceof Error ? error.message : undefined,
      typeof record.shortMessage === "string" ? record.shortMessage : undefined,
      typeof record.stderr === "string" ? record.stderr : undefined,
      typeof record.stdout === "string" ? record.stdout : undefined,
      record.cause === undefined
        ? undefined
        : commandErrorDiagnostic(record.cause, depth + 1),
    ]
      .filter(
        (value, index, values): value is string =>
          typeof value === "string" &&
          value.length > 0 &&
          values.indexOf(value) === index,
      )
      .join("\n");
  }
  return errorMessage(error);
}

const registryTransportTransientMarkers = [
  "econnreset",
  "etimedout",
  "eai_again",
  "enetunreach",
  "connection reset by peer",
  "connection refused",
  "i/o timeout",
  "socket hang up",
  "temporary failure in name resolution",
  "tls handshake timeout",
] as const;

function classifyRegistryTransportFailure(
  error: unknown,
  registry: "docker" | "npm",
): Exclude<ExternalFailureClassification, "not-retryable"> | undefined {
  const diagnostic = commandErrorDiagnostic(error).toLowerCase();
  const hosts =
    registry === "docker"
      ? ["registry-1.docker.io", "auth.docker.io"]
      : ["registry.npmjs.org"];
  const isSupportedTransientLine = diagnostic.split(/\r?\n/u).some((line) =>
    hosts.some((host) => {
      const start = line.indexOf(host);
      if (start < 0) return false;
      const preceding = line[start - 1];
      const following = line[start + host.length];
      const hasHostBoundary =
        (preceding === undefined || /[\s/"']/u.test(preceding)) &&
        (following === undefined || /[\s/:"']/u.test(following));
      return (
        hasHostBoundary &&
        registryTransportTransientMarkers.some((marker) =>
          line.includes(marker),
        )
      );
    }),
  );
  if (!isSupportedTransientLine) {
    return undefined;
  }
  return registry === "docker"
    ? "docker-registry-transport-transient"
    : "npm-registry-transport-transient";
}

function elapsedMilliseconds(startedAt: Date, finishedAt: Date): number {
  const duration = finishedAt.getTime() - startedAt.getTime();
  if (duration < 0) {
    throw new Error("Verification activity clock moved backwards");
  }
  return duration;
}

function awaitWithCancellation<Result>(
  promise: Promise<Result>,
  cancelSignal?: AbortSignal,
): Promise<Result> {
  if (cancelSignal === undefined) return promise;
  cancelSignal.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => {
      cancelSignal.removeEventListener("abort", onAbort);
      reject(cancelSignal.reason ?? new Error("Container work cancelled"));
    };
    cancelSignal.addEventListener("abort", onAbort, { once: true });
    if (cancelSignal.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => {
        cancelSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        cancelSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runDevelopmentContainerBuildFlight(
  key: string,
  destination: string,
  execute: () => Promise<unknown>,
  cancelSignal?: AbortSignal,
): Promise<void> {
  const existing = developmentContainerBuildFlights.get(key);
  if (existing !== undefined) {
    await awaitWithCancellation(existing, cancelSignal);
    return;
  }
  const previous = developmentContainerBuildTails.get(destination);
  let executionStarted = false;
  let signalExecutionStarted!: () => void;
  const executionStartedPromise = new Promise<void>((resolve) => {
    signalExecutionStarted = resolve;
  });
  const current = (async () => {
    if (previous !== undefined) {
      await previous.catch(() => undefined);
    }
    cancelSignal?.throwIfAborted();
    executionStarted = true;
    signalExecutionStarted();
    await execute();
  })();
  developmentContainerBuildFlights.set(key, current);
  developmentContainerBuildTails.set(destination, current);
  const removeFlight = () => {
    if (developmentContainerBuildFlights.get(key) === current) {
      developmentContainerBuildFlights.delete(key);
    }
    if (developmentContainerBuildTails.get(destination) === current) {
      developmentContainerBuildTails.delete(destination);
    }
  };
  void current.then(removeFlight, removeFlight);

  if (cancelSignal !== undefined) {
    const startOrFinish = Promise.race([
      executionStartedPromise,
      current.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    try {
      await awaitWithCancellation(startOrFinish, cancelSignal);
    } catch (error) {
      if (!executionStarted) throw error;
    }
  }
  await current;
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

export function createDevelopmentContainerSession(options: {
  readonly projectDir: string;
  readonly probes: readonly DevelopmentContainerProbe[];
  readonly dependencyPreparation?: {
    readonly trustWorkspace?: boolean;
    readonly commands: readonly DependencyPreparationCommand[];
  };
  readonly workspaceMount?: {
    readonly source: string;
    readonly target: string;
  };
  readonly ownedVolumePrefix?: string;
  readonly cancelSignal?: AbortSignal;
  readonly commandTimeoutMilliseconds?: number;
  readonly cleanupTimeoutMilliseconds?: number;
  readonly ownedVolumes?: readonly string[] | undefined;
  readonly dependencyCaches?: DevelopmentContainerDependencyCaches | undefined;
  readonly build?:
    | {
        readonly identity: string;
        readonly cacheDirectory: string;
      }
    | undefined;
  readonly acquireSession?:
    | ((cancelSignal?: AbortSignal) => Promise<() => void>)
    | undefined;
  readonly onCleanupFailure?: ((error: unknown) => void) | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly run?: ContainerCommandRunner;
  readonly onCommand?:
    | ((command: string, args: readonly string[]) => void | Promise<void>)
    | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly recordActivity?:
    | ((event: DevelopmentContainerSessionActivity) => void | Promise<void>)
    | undefined;
}): DevelopmentContainerSession {
  const rawRun =
    options.run ??
    ((command, args, runOptions) => execa(command, [...args], runOptions));
  const environment = options.environment ?? {};
  const clock = options.clock ?? (() => new Date());
  const secretValues = turboCacheSecretEnvironmentNames.flatMap((name) => {
    const value = environment[name];
    return value === undefined || value.length === 0 ? [] : [value];
  });
  const config = path.join(
    options.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const workspaceArgs = ["--workspace-folder", options.projectDir] as const;
  const projectIdentity = createHash("sha256")
    .update(path.resolve(options.projectDir))
    .digest("hex");
  const idLabel = `com.ykdz.template.verification.project=${projectIdentity}`;
  const identityArgs = ["--id-label", idLabel] as const;
  let devcontainerTempDirectory: string | undefined;
  const ensureDevcontainerTempDirectory = async (): Promise<string> => {
    devcontainerTempDirectory ??= await mkdtemp(
      path.join(tmpdir(), `template-devcontainer-${projectIdentity}-`),
    );
    return devcontainerTempDirectory;
  };
  const run: ContainerCommandRunner = async (command, args, runOptions) => {
    try {
      const cancelSignal = runOptions.cancelSignal ?? options.cancelSignal;
      cancelSignal?.throwIfAborted();
      const commandOptions =
        command === "devcontainer"
          ? {
              ...runOptions,
              ...(cancelSignal === undefined ? {} : { cancelSignal }),
              timeout:
                runOptions.timeout ??
                options.commandTimeoutMilliseconds ??
                containerCommandTimeoutMilliseconds,
              killDescendants: runOptions.killDescendants ?? true,
              env: {
                ...runOptions.env,
                TMPDIR: await ensureDevcontainerTempDirectory(),
              },
            }
          : {
              ...runOptions,
              ...(cancelSignal === undefined ? {} : { cancelSignal }),
              timeout:
                runOptions.timeout ??
                options.commandTimeoutMilliseconds ??
                containerCommandTimeoutMilliseconds,
              killDescendants: runOptions.killDescendants ?? true,
            };
      cancelSignal?.throwIfAborted();
      return await rawRun(command, args, commandOptions);
    } catch (error) {
      const diagnostic = redactCommandError(error, secretValues);
      const cancelSignal = runOptions.cancelSignal ?? options.cancelSignal;
      if (cancelSignal?.aborted) {
        const reason =
          cancelSignal.reason instanceof Error
            ? cancelSignal.reason
            : new Error("Container command cancelled");
        if (diagnostic === reason) throw reason;
        throw new AggregateError(
          [reason, diagnostic],
          `${errorMessage(reason)}; command stopped during cancellation: ${errorMessage(diagnostic)}`,
          { cause: reason },
        );
      }
      throw diagnostic;
    }
  };
  const remoteEnvironmentArgs = [
    ...turboCacheEnvironmentNames,
    "NODE_USE_ENV_PROXY",
  ].flatMap((name) => {
    const value =
      environment[name] ??
      (name === "TURBO_CACHE_DIR"
        ? `/tmp/template-turbo-cache-${projectIdentity}`
        : undefined);
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
    fact: DevelopmentContainerSessionCacheFact,
  ): Promise<void> => {
    await options.recordActivity?.({
      type: "cache",
      ...fact,
      at: clock().toISOString(),
    });
  };
  type PhaseAttempt = {
    readonly phase: DevelopmentContainerSessionPhase;
    readonly startedAt: Date;
    finished: boolean;
  };
  const startPhase = async (
    phase: DevelopmentContainerSessionPhase,
  ): Promise<PhaseAttempt> => {
    const startedAt = clock();
    await options.recordActivity?.({
      type: "phase",
      phase,
      at: startedAt.toISOString(),
      outcome: "started",
    });
    return { phase, startedAt, finished: false };
  };
  const finishPhase = async (
    phaseAttempt: PhaseAttempt,
    result:
      | { readonly outcome: "succeeded" }
      | {
          readonly outcome: "failed";
          readonly classification: ExternalFailureClassification;
          readonly error: unknown;
        },
  ): Promise<void> => {
    if (phaseAttempt.finished) return;
    phaseAttempt.finished = true;
    const finishedAt = clock();
    await options.recordActivity?.({
      type: "phase",
      phase: phaseAttempt.phase,
      at: finishedAt.toISOString(),
      durationMilliseconds: elapsedMilliseconds(
        phaseAttempt.startedAt,
        finishedAt,
      ),
      ...(result.outcome === "succeeded"
        ? { outcome: "succeeded" }
        : {
            outcome: "failed",
            classification: result.classification,
            error: errorMessage(result.error),
          }),
    });
  };
  const runWithExternalRetry = async <Result>(retryOptions: {
    readonly phase: DevelopmentContainerSessionPhase;
    readonly registry: "docker" | "npm";
    readonly operation: () => Promise<Result>;
  }): Promise<Result> => {
    try {
      return await retryOptions.operation();
    } catch (firstError) {
      if (options.cancelSignal?.aborted) throw firstError;
      const classification = classifyRegistryTransportFailure(
        firstError,
        retryOptions.registry,
      );
      if (classification === undefined || retryUsed) throw firstError;
      retryUsed = true;
      const retryStartedAt = clock();
      await options.recordActivity?.({
        type: "retry",
        phase: retryOptions.phase,
        at: retryStartedAt.toISOString(),
        outcome: "started",
        classification,
        firstError: errorMessage(firstError),
      });
      try {
        const result = await retryOptions.operation();
        const retryFinishedAt = clock();
        await options.recordActivity?.({
          type: "retry",
          phase: retryOptions.phase,
          at: retryFinishedAt.toISOString(),
          outcome: "recovered",
          durationMilliseconds: elapsedMilliseconds(
            retryStartedAt,
            retryFinishedAt,
          ),
        });
        return result;
      } catch (retryError) {
        const retryFinishedAt = clock();
        await options.recordActivity?.({
          type: "retry",
          phase: retryOptions.phase,
          at: retryFinishedAt.toISOString(),
          outcome: "failed",
          durationMilliseconds: elapsedMilliseconds(
            retryStartedAt,
            retryFinishedAt,
          ),
          error: errorMessage(retryError),
        });
        throw new Error(
          `Container ${retryOptions.phase} failed after ${classification} retry. First failure: ${errorMessage(firstError)}. Retry failure: ${errorMessage(retryError)}`,
          { cause: retryError },
        );
      }
    }
  };
  const sessionOwnedVolumes = new Set<string>();
  const createDependencyCacheOverride = async (): Promise<
    | {
        readonly path: string;
        readonly caches: readonly ("pnpm-downloads" | "cargo-downloads")[];
      }
    | undefined
  > => {
    const configuredMounts = [
      ...(options.dependencyCaches?.pnpm === undefined
        ? []
        : [
            {
              source: path.resolve(options.dependencyCaches.pnpm),
              target: developmentContainerPnpmStorePath,
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
    if (
      configuredMounts.length === 0 &&
      options.ownedVolumePrefix === undefined &&
      options.workspaceMount === undefined
    )
      return undefined;

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
    if (
      mounts.length === 0 &&
      options.ownedVolumePrefix === undefined &&
      options.workspaceMount === undefined
    )
      return undefined;
    const caches = [
      ...(mounts.some(
        ({ target }) => target === developmentContainerPnpmStorePath,
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
      `development-container-session-cache-${randomUUID()}.json`,
    );
    const mountsByTarget = new Map(
      mounts.map((mount) => [mount.target, mount] as const),
    );
    const mergedMounts = generatedMounts.map((mount) => {
      if (
        typeof mount !== "object" ||
        mount === null ||
        !("target" in mount) ||
        typeof mount.target !== "string"
      )
        return mount;
      const replacement = mountsByTarget.get(mount.target);
      if (replacement !== undefined) return replacement;
      if (
        options.ownedVolumePrefix !== undefined &&
        "type" in mount &&
        mount.type === "volume" &&
        "source" in mount &&
        typeof mount.source === "string" &&
        mount.source.includes("${devcontainerId}")
      ) {
        const source = mount.source.replaceAll(
          "${devcontainerId}",
          options.ownedVolumePrefix,
        );
        sessionOwnedVolumes.add(source);
        return { ...mount, source };
      }
      return mount;
    });
    await writeFile(
      overridePath,
      `${JSON.stringify(
        {
          ...generatedConfig,
          mounts: mergedMounts,
          ...(options.workspaceMount === undefined
            ? {}
            : {
                workspaceMount: `type=bind,source=${options.workspaceMount.source},target=${options.workspaceMount.target}`,
                workspaceFolder: options.workspaceMount.target,
              }),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return { path: overridePath, caches };
  };
  let startup: Promise<void> | undefined;
  let reservation: Promise<void> | undefined;
  let upAttempted = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let releaseSession: (() => void) | undefined;
  let dependencyCacheOverridePath: string | undefined;
  let retryUsed = false;
  let containerCleanupComplete = false;
  let dependencyCacheOverrideRemoved = false;
  let devcontainerTempDirectoryRemoved = false;
  const removedOwnedVolumes = new Set<string>();
  const releaseSessionReservation = (): void => {
    const release = releaseSession;
    releaseSession = undefined;
    release?.();
  };

  const exec = async (
    command: string,
    args: readonly string[],
    execOptions: {
      readonly cwd?: string;
      readonly stdio?: "inherit";
      readonly cancelSignal?: AbortSignal;
      readonly timeout?: number;
    } = {},
  ): Promise<unknown> => {
    const cancelSignal = execOptions.cancelSignal ?? options.cancelSignal;
    cancelSignal?.throwIfAborted();
    const commandCwd = path.resolve(execOptions.cwd ?? options.projectDir);
    const relativeCwd = path.relative(options.projectDir, commandCwd);
    if (
      path.isAbsolute(relativeCwd) ||
      relativeCwd === ".." ||
      relativeCwd.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Development Container command cwd must be inside ${options.projectDir}`,
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
    await options.onCommand?.(command, args);
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
        ...(cancelSignal === undefined ? {} : { cancelSignal }),
        timeout:
          execOptions.timeout ??
          options.commandTimeoutMilliseconds ??
          containerCommandTimeoutMilliseconds,
        killDescendants: true,
      },
    );
  };

  const reserve = async (): Promise<void> => {
    options.cancelSignal?.throwIfAborted();
    reservation ??= (async () => {
      releaseSession = await options.acquireSession?.(options.cancelSignal);
    })();
    await reservation;
  };

  const start = async (): Promise<void> => {
    await reserve();
    options.cancelSignal?.throwIfAborted();
    const containerAttempt = await startPhase("container-preparation");
    let containerFailureClassification: ExternalFailureClassification =
      "not-retryable";
    try {
      try {
        await run("docker", ["version", "--format", "{{.Server.Version}}"], {
          cwd: options.projectDir,
        });
      } catch (error) {
        throw new Error(
          `Docker is required for Development Container checks: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      try {
        await run("devcontainer", ["--version"], { cwd: options.projectDir });
      } catch (error) {
        throw new Error(
          `The pinned Dev Container CLI is required for Development Container checks: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const dependencyCacheOverride = await createDependencyCacheOverride();
      dependencyCacheOverridePath = dependencyCacheOverride?.path;
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
            ...(options.dependencyPreparation?.trustWorkspace === true
              ? ["--skip-post-create"]
              : []),
            ...identityArgs,
            ...buildCacheArgs,
          ],
          { cwd: options.projectDir },
        );
      try {
        const upWithRetry = async () =>
          await runWithExternalRetry({
            phase: "container-preparation",
            registry: "docker",
            operation: up,
          });
        if (options.build === undefined) {
          await upWithRetry();
        } else {
          await recordCacheActivity({
            cache: "buildkit",
            outcome: "configured",
          });
          const cacheDestination = path.resolve(
            options.projectDir,
            options.build.cacheDirectory,
            options.build.identity,
          );
          await runDevelopmentContainerBuildFlight(
            `${cacheDestination}\0${projectIdentity}`,
            cacheDestination,
            upWithRetry,
            options.cancelSignal,
          );
        }
      } catch (error) {
        containerFailureClassification =
          classifyRegistryTransportFailure(error, "docker") ?? "not-retryable";
        throw error;
      }
      for (const cache of dependencyCacheOverride?.caches ?? []) {
        await recordCacheActivity({ cache, outcome: "mounted" });
      }
      for (const probe of options.probes) {
        try {
          await exec(probe.command, probe.args ?? []);
        } catch (error) {
          throw new Error(
            `Development Container capability ${probe.identity} is unavailable${probe.failureMessage === undefined ? "" : `: ${probe.failureMessage}`}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }
      await finishPhase(containerAttempt, { outcome: "succeeded" });
    } catch (error) {
      await finishPhase(containerAttempt, {
        outcome: "failed",
        classification: containerFailureClassification,
        error,
      });
      throw error;
    }

    if (options.dependencyPreparation !== undefined) {
      const dependencyAttempt = await startPhase("dependency-installation");
      let dependencyFailureClassification: ExternalFailureClassification =
        "not-retryable";
      try {
        if (options.dependencyPreparation.trustWorkspace === true) {
          await exec("git", [
            "config",
            "--global",
            "--add",
            "safe.directory",
            options.workspaceMount?.target ??
              `/workspaces/${path.basename(options.projectDir)}`,
          ]);
        }
        for (const command of options.dependencyPreparation.commands) {
          try {
            const install = async () =>
              await exec(command.command, command.args);
            if (command.retryRegistry === undefined) {
              await install();
            } else {
              await runWithExternalRetry({
                phase: "dependency-installation",
                registry: command.retryRegistry,
                operation: install,
              });
            }
          } catch (error) {
            if (command.retryRegistry !== undefined) {
              dependencyFailureClassification =
                classifyRegistryTransportFailure(
                  error,
                  command.retryRegistry,
                ) ?? "not-retryable";
            }
            throw new Error(
              `Dependency preparation failed during ${command.command} ${command.args[0] ?? ""}: ${errorMessage(error)}`,
              { cause: error },
            );
          }
        }
        await finishPhase(dependencyAttempt, { outcome: "succeeded" });
      } catch (error) {
        await finishPhase(dependencyAttempt, {
          outcome: "failed",
          classification: dependencyFailureClassification,
          error,
        });
        throw error;
      }
    }
  };

  const sessionRun: ContainerCommandRunner = async (
    command,
    args,
    runOptions,
  ) => {
    if (closed) {
      throw new Error("Development Container session is closed");
    }
    await prepare();
    return await exec(command, args, runOptions);
  };

  const prepare = async (): Promise<void> => {
    if (closed) {
      throw new Error("Development Container session is closed");
    }
    startup ??= start();
    await startup;
  };

  const cleanup = async (): Promise<void> => {
    const cleanupErrors: unknown[] = [];
    const cleanupSignal = AbortSignal.timeout(
      options.cleanupTimeoutMilliseconds ?? containerCleanupTimeoutMilliseconds,
    );
    const cleanupDevcontainerTempDirectory = async (): Promise<void> => {
      if (devcontainerTempDirectoryRemoved) return;
      if (devcontainerTempDirectory === undefined) {
        devcontainerTempDirectoryRemoved = true;
        return;
      }
      try {
        await rm(devcontainerTempDirectory, { recursive: true, force: true });
        devcontainerTempDirectoryRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (upAttempted && !containerCleanupComplete) {
      try {
        const result = await run(
          "docker",
          ["ps", "-aq", "--filter", `label=${idLabel}`],
          {
            cwd: options.projectDir,
            cancelSignal: cleanupSignal,
            timeout:
              options.cleanupTimeoutMilliseconds ??
              containerCleanupTimeoutMilliseconds,
          },
        );
        const stdout =
          typeof result === "object" &&
          result !== null &&
          "stdout" in result &&
          typeof result.stdout === "string"
            ? result.stdout
            : "";
        const containerIds = stdout.trim().split(/\s+/u).filter(Boolean);
        if (containerIds.length === 0) {
          containerCleanupComplete = true;
        } else {
          const restoreUid = process.getuid?.();
          const restoreGid = process.getgid?.();
          let workspaceOwnerRestored =
            restoreUid === undefined || restoreGid === undefined;
          if (restoreUid !== undefined && restoreGid !== undefined) {
            try {
              await run(
                "devcontainer",
                [
                  "exec",
                  ...workspaceArgs,
                  ...identityArgs,
                  "chown",
                  "-R",
                  `${restoreUid}:${restoreGid}`,
                  ".",
                ],
                {
                  cwd: options.projectDir,
                  cancelSignal: cleanupSignal,
                  timeout:
                    options.cleanupTimeoutMilliseconds ??
                    containerCleanupTimeoutMilliseconds,
                },
              );
              workspaceOwnerRestored = true;
            } catch (error) {
              cleanupErrors.push(
                new Error(
                  `恢复工作区属主失败，容器清理未完成：${errorMessage(error)}`,
                  { cause: error },
                ),
              );
            }
          }
          if (workspaceOwnerRestored) {
            try {
              await run("docker", ["rm", "-f", ...containerIds], {
                cwd: options.projectDir,
                cancelSignal: cleanupSignal,
                timeout:
                  options.cleanupTimeoutMilliseconds ??
                  containerCleanupTimeoutMilliseconds,
              });
              containerCleanupComplete = true;
            } catch (error) {
              cleanupErrors.push(
                new Error(
                  `移除容器失败，容器清理未完成：${errorMessage(error)}`,
                  { cause: error },
                ),
              );
            }
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const ownedVolumes = new Set(options.ownedVolumes ?? []);
    if (sessionOwnedVolumes.size > 0) {
      try {
        const result = await run(
          "docker",
          [
            "volume",
            "ls",
            "--filter",
            `name=${options.ownedVolumePrefix}`,
            "--format",
            "{{.Name}}",
          ],
          {
            cwd: options.projectDir,
            cancelSignal: cleanupSignal,
            timeout:
              options.cleanupTimeoutMilliseconds ??
              containerCleanupTimeoutMilliseconds,
          },
        );
        if (
          typeof result === "object" &&
          result !== null &&
          "stdout" in result &&
          typeof result.stdout === "string"
        ) {
          for (const volume of result.stdout.trim().split(/\s+/u)) {
            if (sessionOwnedVolumes.has(volume)) ownedVolumes.add(volume);
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const volume of ownedVolumes) {
      if (removedOwnedVolumes.has(volume)) continue;
      try {
        await run("docker", ["volume", "rm", volume], {
          cwd: options.projectDir,
          cancelSignal: cleanupSignal,
          timeout:
            options.cleanupTimeoutMilliseconds ??
            containerCleanupTimeoutMilliseconds,
        });
        removedOwnedVolumes.add(volume);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (
      dependencyCacheOverridePath !== undefined &&
      !dependencyCacheOverrideRemoved
    ) {
      try {
        await unlink(dependencyCacheOverridePath);
        dependencyCacheOverrideRemoved = true;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          cleanupErrors.push(error);
        } else {
          dependencyCacheOverrideRemoved = true;
        }
      }
    }
    if (!upAttempted || containerCleanupComplete) {
      await cleanupDevcontainerTempDirectory();
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Development Container cleanup failed: ${cleanupErrors.map((error) => commandErrorDiagnostic(error).replaceAll(/\r?\n/gu, "; ")).join("; ")}`,
      );
    }
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    if (closing !== undefined) return await closing;
    const attempt = cleanup();
    closing = attempt;
    try {
      await attempt;
      closed = true;
      releaseSessionReservation();
    } finally {
      if (closing === attempt) closing = undefined;
    }
  };

  return {
    reserve,
    prepare,
    run: sessionRun,
    execute: async <Result>(
      operation: (run: ContainerCommandRunner) => Promise<Result>,
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
      } catch (firstError) {
        try {
          await close();
          cleanup = { succeeded: false, error: firstError };
        } catch (retryError) {
          cleanup = {
            succeeded: false,
            error: new AggregateError(
              [firstError, retryError],
              `Development Container cleanup retry failed: ${commandErrorDiagnostic(retryError).replaceAll(/\r?\n/gu, "; ")}`,
              { cause: firstError },
            ),
          };
        }
      }
      if (!cleanup.succeeded && !closed) {
        try {
          options.onCleanupFailure?.(cleanup.error);
        } catch {
          // 生命周期通知失败不能覆盖清理原因。
        }
      }
      if (!execution.succeeded) {
        if (cleanup.succeeded) throw execution.error;
        const cleanupErrors =
          cleanup.error instanceof AggregateError
            ? cleanup.error.errors
            : [cleanup.error];
        throw new AggregateError(
          [execution.error, ...cleanupErrors],
          `${errorMessage(execution.error)}; Development Container cleanup also failed: ${cleanupErrors.map((error) => commandErrorDiagnostic(error).replaceAll(/\r?\n/gu, "; ")).join("; ")}`,
          { cause: execution.error },
        );
      }
      if (!cleanup.succeeded) throw cleanup.error;
      return execution.value;
    },
    close,
  };
}
