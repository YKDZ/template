import { spawn } from "node:child_process";
import path from "node:path";

const webRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(webRoot, "../..");
const uniqueId = `${process.pid}-${Date.now()}`;
const standaloneImage = `vike-deployment-check-standalone:${uniqueId}`;
const runtimeImage = `vike-deployment-check-runtime:${uniqueId}`;
const network = `vike-deployment-check-${uniqueId}`;
const containers = {
  standalone: `vike-deployment-check-standalone-${uniqueId}`,
  preparation: `vike-deployment-check-preparation-${uniqueId}`,
  runtime: `vike-deployment-check-runtime-${uniqueId}`,
  unprepared: `vike-deployment-check-unprepared-${uniqueId}`,
} as const;
const volumes = {
  standalone: `vike-deployment-check-standalone-${uniqueId}`,
  prepared: `vike-deployment-check-prepared-${uniqueId}`,
  unprepared: `vike-deployment-check-unprepared-${uniqueId}`,
} as const;
const abortController = new AbortController();
const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
const defaultReadinessTimeoutMs = 60_000;

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

type DeploymentMode =
  | "standalone"
  | "external-preparation"
  | "runtime"
  | "fresh-runtime";

async function deploymentPhase<T>(
  mode: DeploymentMode,
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new Error(`Deployment mode ${mode} failed during ${phase}.`, {
      cause: error,
    });
  }
}

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) {
        resolve({ stderr, stdout });
      } else {
        reject(Object.assign(error, { stderr, stdout }));
      }
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0 && !timedOut) {
        finish();
        return;
      }
      finish(
        Object.assign(
          new Error(
            `${commandDisplay(command, args)} ${
              timedOut
                ? `timed out after ${options.timeout}ms`
                : `exited with code ${String(code)}${signal === null ? "" : ` from ${signal}`}`
            }\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
          { code, signal },
        ),
      );
    });
  });
}

function readinessTimeoutMs(): number {
  const configured = process.env.STANDALONE_DEPLOYMENT_READINESS_TIMEOUT_MS;
  if (configured === undefined) {
    return defaultReadinessTimeoutMs;
  }

  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(
      "STANDALONE_DEPLOYMENT_READINESS_TIMEOUT_MS must be a positive integer",
    );
  }
  return timeout;
}

async function dockerWithTimeout(
  timeout: number,
  ...args: string[]
): Promise<string> {
  const { stdout } = await runCommand("docker", args, {
    cwd: repositoryRoot,
    signal: abortController.signal,
    timeout,
  });
  return stdout.trim();
}

async function docker(...args: string[]): Promise<string> {
  return dockerWithTimeout(600_000, ...args);
}

async function cleanup(): Promise<void> {
  const cleanupCommands = [
    ...Object.values(containers).map((name) => ["rm", "--force", name]),
    ...Object.values(volumes).map((name) => ["volume", "rm", "--force", name]),
    ["network", "rm", network],
    ["image", "rm", "--force", runtimeImage],
    ["image", "rm", "--force", standaloneImage],
  ];

  for (const args of cleanupCommands) {
    try {
      await runCommand("docker", args, {
        cwd: repositoryRoot,
        timeout: 30_000,
      });
    } catch {
      // A resource may not have been created yet.
    }
  }
}

async function containerLogs(container: string): Promise<string> {
  try {
    const { stderr, stdout } = await runCommand("docker", ["logs", container], {
      cwd: repositoryRoot,
      signal: AbortSignal.timeout(10_000),
      timeout: 10_000,
    });
    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  } catch (error) {
    return `Container logs unavailable: ${String(error)}`;
  }
}

async function deploymentLogs(): Promise<string> {
  const logs = await Promise.all(
    Object.entries(containers).map(
      async ([phase, container]) =>
        `${phase} container logs:\n${await containerLogs(container)}`,
    ),
  );
  return logs.join("\n");
}

async function publishedBaseUrl(container: string): Promise<string> {
  const portOutput = await dockerWithTimeout(
    10_000,
    "port",
    container,
    "3000/tcp",
  );
  const match = /:(\d+)$/u.exec(portOutput.split("\n")[0] ?? "");
  if (!match?.[1]) {
    throw new Error(
      `Could not determine the published web port: ${portOutput}`,
    );
  }
  return `http://127.0.0.1:${match[1]}`;
}

async function waitForReady(
  phase: "Standalone" | "Runtime",
  container: string,
  baseUrl: string,
): Promise<void> {
  const timeout = readinessTimeoutMs();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The container may still be starting the server.
    }

    const running = await dockerWithTimeout(
      5_000,
      "inspect",
      "--format={{.State.Running}}",
      container,
    );
    if (running !== "true") {
      throw new Error(
        `${phase} container exited before readiness.\n${await containerLogs(container)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `${phase} container was not ready within ${timeout}ms.\n${await containerLogs(container)}`,
  );
}

async function assertProcessIdentity(
  phase: "Standalone" | "Runtime",
  container: string,
): Promise<void> {
  await docker(
    "exec",
    container,
    "node",
    "--input-type=module",
    "--eval",
    `import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const expectedIdentity = 1001;
if (process.getuid() !== expectedIdentity || process.getgid() !== expectedIdentity) {
  throw new Error(\`${phase} process identity must be 1001:1001, received \${process.getuid()}:\${process.getgid()}\`);
}
const databaseStat = statSync(process.env.DATABASE_FILE);
if (databaseStat.uid !== expectedIdentity || databaseStat.gid !== expectedIdentity) {
  throw new Error(\`Database ownership must be 1001:1001, received \${databaseStat.uid}:\${databaseStat.gid}\`);
}`,
  );
}

async function assertEmptyDatabase(container: string): Promise<void> {
  await docker(
    "exec",
    container,
    "node",
    "--input-type=module",
    "--eval",
    `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DATABASE_FILE);
const row = db.prepare("select count(*) as count from todos").get();
if (row.count !== 0) throw new Error(\`Fresh deployment must contain zero TODOs, received \${row.count}\`);`,
  );
}

async function runPlaywright(baseUrl: string): Promise<void> {
  await runCommand("pnpm", ["--dir", "apps/web", "run", "test:e2e:run"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_EXTERNAL_BASE_URL: baseUrl,
    },
    signal: abortController.signal,
    timeout: 120_000,
  });
}

async function runStartedDeployment(
  mode: "standalone" | "runtime",
  readinessLabel: "Standalone" | "Runtime",
  container: string,
  volume: string,
  image: string,
): Promise<void> {
  await deploymentPhase(mode, "start", async () =>
    docker(
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      network,
      "--publish",
      "127.0.0.1::3000",
      "--volume",
      `${volume}:/data`,
      image,
    ),
  );
  const baseUrl = await deploymentPhase(mode, "start", async () =>
    publishedBaseUrl(container),
  );
  await deploymentPhase(mode, "readiness", async () =>
    waitForReady(readinessLabel, container, baseUrl),
  );
  await deploymentPhase(mode, "identity", async () =>
    assertProcessIdentity(readinessLabel, container),
  );
  await deploymentPhase(mode, "empty-database", async () =>
    assertEmptyDatabase(container),
  );
  await deploymentPhase(mode, "playwright", async () => runPlaywright(baseUrl));
}

async function assertUnpreparedRuntimeFails(): Promise<void> {
  await dockerWithTimeout(
    30_000,
    "run",
    "--detach",
    "--name",
    containers.unprepared,
    "--network",
    network,
    "--publish",
    "127.0.0.1::3000",
    "--volume",
    `${volumes.unprepared}:/data`,
    runtimeImage,
  );
  const baseUrl = await publishedBaseUrl(containers.unprepared);
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const statePromise = dockerWithTimeout(
      5_000,
      "inspect",
      "--format={{.State.Status}}:{{.State.ExitCode}}",
      containers.unprepared,
    ).then(
      (state) => ({ state }),
      (error: unknown) => ({ error }),
    );
    const probe = await fetch(baseUrl, {
      signal: AbortSignal.timeout(500),
    }).then(
      (response) => ({ response }),
      () => ({ response: undefined }),
    );

    if (probe.response !== undefined) {
      throw new Error(
        `Unprepared runtime served HTTP ${probe.response.status} before exiting.`,
      );
    }

    const stateResult = await statePromise;
    if ("error" in stateResult) {
      throw stateResult.error;
    }
    const match =
      /^(created|running|paused|restarting|removing|exited|dead):(\d+)$/u.exec(
        stateResult.state,
      );
    if (match?.[1] === "exited") {
      const exitCode = Number(match[2]);
      const logs = await containerLogs(containers.unprepared);
      if (exitCode === 0) {
        throw new Error(
          `Unprepared runtime exited successfully instead of rejecting startup.\n${logs}`,
        );
      }
      if (!logs.includes("Database is not ready")) {
        throw new Error(
          `Unprepared runtime did not report database readiness failure.\n${logs}`,
        );
      }
      return;
    }
    if (match === null || match[1] === "dead") {
      throw new Error(
        `Unprepared runtime entered unexpected state ${stateResult.state}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Unprepared runtime did not exit within 30000ms");
}

for (const signal of forwardedSignals) {
  const handler = (): void => {
    abortController.abort(new Error(`Received ${signal}`));
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

try {
  await deploymentPhase("standalone", "build", async () =>
    docker(
      "build",
      "--file",
      "apps/web/Dockerfile",
      "--target",
      "standalone",
      "--build-arg",
      `DEPLOYMENT_BUILD_ID=${uniqueId}`,
      "--tag",
      standaloneImage,
      ".",
    ),
  );
  await deploymentPhase("runtime", "build", async () =>
    docker(
      "build",
      "--file",
      "apps/web/Dockerfile",
      "--target",
      "runtime",
      "--build-arg",
      `DEPLOYMENT_BUILD_ID=${uniqueId}`,
      "--tag",
      runtimeImage,
      ".",
    ),
  );
  for (const volume of Object.values(volumes)) {
    await docker("volume", "create", volume);
  }
  await docker("network", "create", network);

  await runStartedDeployment(
    "standalone",
    "Standalone",
    containers.standalone,
    volumes.standalone,
    standaloneImage,
  );

  await deploymentPhase("external-preparation", "prepare", async () =>
    docker(
      "run",
      "--name",
      containers.preparation,
      "--network",
      network,
      "--volume",
      `${volumes.prepared}:/data`,
      standaloneImage,
      "prepare-only",
    ),
  );
  await deploymentPhase("external-preparation", "exit", async () => {
    const state = await dockerWithTimeout(
      10_000,
      "inspect",
      "--format={{.State.Status}}:{{.State.ExitCode}}",
      containers.preparation,
    );
    if (state !== "exited:0") {
      throw new Error(
        `Preparation-only container must exit successfully, received ${state}.\n${await containerLogs(containers.preparation)}`,
      );
    }
  });
  await runStartedDeployment(
    "runtime",
    "Runtime",
    containers.runtime,
    volumes.prepared,
    runtimeImage,
  );

  await deploymentPhase("fresh-runtime", "rejection", async () =>
    assertUnpreparedRuntimeFails(),
  );
} catch (error) {
  console.error(error);
  console.error(await deploymentLogs());
  process.exitCode = 1;
} finally {
  for (const signal of forwardedSignals) {
    const handler = signalHandlers.get(signal);
    if (handler) {
      process.removeListener(signal, handler);
    }
  }
  await cleanup();
}
