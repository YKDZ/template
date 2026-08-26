import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";

import {
  generatedScenariosFor,
  runGeneratedScenarioSet,
} from "../packages/checks/src/check-generated-registry.ts";
import { executeGeneratedRootQuality } from "../packages/checks/src/fixture-evidence/gates/root-quality/index.ts";
import {
  checkFixtureEvidenceHealth,
  createDevelopmentContainerFixtureSession,
  deriveDevelopmentContainerBuildIdentity,
  FileFixtureEvidenceActivityLedger,
  FileFixtureEvidenceStorage,
  formatFixtureEvidenceHealthReport,
  runFixtureEvidenceGate,
  type FixtureCommandRunner,
} from "../packages/checks/src/fixture-evidence/kernel/index.ts";

type Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
};

function fixtureIdLabel(projectDir: string): string {
  return `com.ykdz.template.fixture.project=${fixtureProjectIdentity(projectDir)}`;
}

function fixtureProjectIdentity(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex");
}

function fixtureTurboCacheRemoteEnv(projectDir: string): string {
  return `TURBO_CACHE_DIR=/tmp/template-turbo-cache-${fixtureProjectIdentity(projectDir)}`;
}

function nestedDevcontainerCommand(args: readonly string[]): {
  readonly command: string | undefined;
  readonly args: readonly string[];
} {
  let commandIndex = args.indexOf("--id-label") + 2;
  while (args[commandIndex] === "--remote-env") commandIndex += 2;
  return {
    command: args[commandIndex],
    args: args.slice(commandIndex + 1),
  };
}

async function generatedTaskIds(root: string): Promise<readonly string[]> {
  const taskIds: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(entryPath, "utf8")) as {
          readonly name: string;
          readonly scripts?: Readonly<Record<string, string>>;
        };
        for (const taskName of Object.keys(manifest.scripts ?? {})) {
          taskIds.push(
            `${manifest.name.startsWith("@") ? manifest.name : "//"}#${taskName}`,
          );
        }
      }
    }
  }
  await visit(root);
  return taskIds;
}

const requiredCapabilityProbeIdentities = new Set([
  "cargo",
  "github-cli",
  "playwright",
  "shellcheck",
]);

function registryCapabilityProbes(root: string) {
  return builtInPresetRegistry
    .all()
    .flatMap(
      (definition) =>
        planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir: path.join(root, `probe-${definition.metadata.name}`),
            defaultPackageScope: "fixture",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        }).developmentContainer.probes,
    )
    .filter((probe) => requiredCapabilityProbeIdentities.has(probe.identity));
}

describe("Development Container Fixture Executor", () => {
  it("normalizes equivalent final Development Container build inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-build-identity-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const writeBuild = async (
      projectDir: string,
      config: Readonly<Record<string, unknown>>,
    ) => {
      await mkdir(path.join(projectDir, ".devcontainer"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(projectDir, ".devcontainer", "Dockerfile"),
          'FROM node:24\nARG TOOL_VERSION\nRUN echo "$TOOL_VERSION"\n',
        ),
        writeFile(
          path.join(projectDir, ".devcontainer", "devcontainer.json"),
          `${JSON.stringify(config, null, 2)}\n`,
        ),
      ]);
    };

    try {
      await writeBuild(first, {
        name: "first fixture",
        build: {
          dockerfile: "Dockerfile",
          args: { TOOL_VERSION: "1", NODE_VERSION: "24" },
        },
        mounts: ["source=first,target=/cache,type=volume"],
      });
      await writeBuild(second, {
        mounts: ["source=second,target=/cache,type=volume"],
        build: {
          args: { NODE_VERSION: "24", TOOL_VERSION: "1" },
          dockerfile: "Dockerfile",
        },
        name: "second fixture",
      });

      const firstIdentity = await deriveDevelopmentContainerBuildIdentity({
        projectDir: first,
      });
      expect(
        await deriveDevelopmentContainerBuildIdentity({ projectDir: second }),
      ).toBe(firstIdentity);

      await writeBuild(second, {
        build: {
          dockerfile: "Dockerfile",
          args: { NODE_VERSION: "24", TOOL_VERSION: "2" },
        },
      });
      expect(
        await deriveDevelopmentContainerBuildIdentity({ projectDir: second }),
      ).not.toBe(firstIdentity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts, prepares, executes, and cleans up through supported CLI commands", async () => {
    const projectDir = path.resolve("/fixture/generated");
    const idLabel = fixtureIdLabel(projectDir);
    const calls: Command[] = [];
    const run: FixtureCommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "fixture-one\nfixture-two\n" };
      }
      return {};
    };
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run,
    });

    try {
      await session.run("pnpm", ["run", "check"], {
        cwd: projectDir,
        stdio: "inherit",
      });
    } finally {
      await session.close();
    }

    expect(calls).toEqual([
      {
        command: "docker",
        args: ["version", "--format", "{{.Server.Version}}"],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: ["--version"],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "up",
          "--workspace-folder",
          projectDir,
          "--config",
          path.join(projectDir, ".devcontainer", "devcontainer.json"),
          "--no-lockfile",
          "--id-label",
          idLabel,
        ],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "--remote-env",
          fixtureTurboCacheRemoteEnv(projectDir),
          "pnpm",
          "install",
          "--lockfile-only",
          "--store-dir",
          "/pnpm/store",
        ],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "--remote-env",
          fixtureTurboCacheRemoteEnv(projectDir),
          "pnpm",
          "fetch",
          "--store-dir",
          "/pnpm/store",
        ],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "--remote-env",
          fixtureTurboCacheRemoteEnv(projectDir),
          "pnpm",
          "install",
          "--offline",
          "--frozen-lockfile",
          "--store-dir",
          "/pnpm/store",
        ],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "--remote-env",
          fixtureTurboCacheRemoteEnv(projectDir),
          "pnpm",
          "run",
          "check",
        ],
        cwd: projectDir,
      },
      {
        command: "devcontainer",
        args: [
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "chown",
          "-R",
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          ".",
        ],
        cwd: projectDir,
      },
      {
        command: "docker",
        args: ["ps", "-aq", "--filter", `label=${idLabel}`],
        cwd: projectDir,
      },
      {
        command: "docker",
        args: ["rm", "-f", "fixture-one", "fixture-two"],
        cwd: projectDir,
      },
    ]);
  });

  it("passes identity-scoped BuildKit cache transport through Dev Container CLI", async () => {
    const projectDir = path.resolve("/fixture/buildkit-cache");
    const cacheDirectory = path.resolve("/cache/template-buildkit");
    const buildIdentity = "a".repeat(64);
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      build: { identity: buildIdentity, cacheDirectory },
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return {};
      },
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    const up = calls.find(
      ({ command, args }) => command === "devcontainer" && args[0] === "up",
    );
    const identityCache = path.join(cacheDirectory, buildIdentity);
    expect(up?.args).toEqual(
      expect.arrayContaining([
        "--cache-from",
        `type=local,src=${identityCache}`,
        "--cache-to",
        `type=local,dest=${identityCache},mode=max`,
      ]),
    );
    expect(
      calls.some(
        ({ command, args }) =>
          command === "docker" &&
          (args.includes("prune") || args.includes(identityCache)),
      ),
    ).toBe(false);
  });

  it("isolates Dev Container CLI temporary directories per fixture session", async () => {
    const projectDirs = [
      path.resolve("/fixture/devcontainer-temp-a"),
      path.resolve("/fixture/devcontainer-temp-b"),
    ];
    const calls: Command[] = [];
    const sessions = projectDirs.map((projectDir) =>
      createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        run: async (command, args, options) => {
          calls.push({
            command,
            args,
            cwd: options.cwd,
            ...(options.env === undefined ? {} : { env: options.env }),
          });
          if (command === "docker" && args[0] === "ps") {
            return { stdout: "" };
          }
          return {};
        },
      }),
    );

    await Promise.all(
      sessions.map(
        async (session, index) =>
          await session.execute(
            async (run) =>
              await run("pnpm", ["run", "check"], {
                cwd: projectDirs[index]!,
              }),
          ),
      ),
    );

    const upTempDirectories = calls
      .filter(
        ({ command, args }) => command === "devcontainer" && args[0] === "up",
      )
      .map(({ env }) => env?.TMPDIR);

    expect(upTempDirectories).toHaveLength(2);
    expect(new Set(upTempDirectories)).toHaveLength(2);
    expect(upTempDirectories).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `template-devcontainer-${fixtureProjectIdentity(projectDirs[0]!)}-`,
        ),
        expect.stringContaining(
          `template-devcontainer-${fixtureProjectIdentity(projectDirs[1]!)}-`,
        ),
      ]),
    );
  });

  it("binds only dependency-download caches into the Development Container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-native-caches-"));
    const projectDir = path.join(root, "project");
    const configPath = path.join(
      projectDir,
      ".devcontainer",
      "devcontainer.json",
    );
    const pnpmCache = path.join(root, "native-cache", "pnpm");
    const cargoCache = path.join(root, "native-cache", "cargo");
    let overridePath: string | undefined;
    let overrideConfig: unknown;
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      const generatedConfig = {
        name: "fixture development container",
        build: {
          dockerfile: "Dockerfile",
          args: { NODE_VERSION: "24" },
        },
        customizations: {
          vscode: { extensions: ["oxc.oxc-vscode"] },
        },
        mounts: [
          {
            type: "volume",
            source: "${devcontainerId}-pnpm-store",
            target: "/pnpm/store",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-registry",
            target: "/usr/local/cargo/registry",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-git",
            target: "/usr/local/cargo/git",
          },
          {
            type: "bind",
            source: "/var/run/docker.sock",
            target: "/var/run/docker.sock",
          },
        ],
      };
      await writeFile(
        configPath,
        `${JSON.stringify(generatedConfig, null, 2)}\n`,
      );
      const session = createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        dependencyCaches: { pnpm: pnpmCache, cargo: cargoCache },
        run: async (command, args) => {
          if (command === "devcontainer" && args[0] === "up") {
            const overrideIndex = args.indexOf("--override-config");
            overridePath = args[overrideIndex + 1];
            overrideConfig = JSON.parse(
              await readFile(overridePath!, "utf8"),
            ) as unknown;
          }
          if (command === "docker" && args[0] === "ps") {
            return { stdout: "" };
          }
          return {};
        },
      });

      await session.run("pnpm", ["run", "check"], { cwd: projectDir });
      expect(overrideConfig).toEqual({
        name: "fixture development container",
        build: {
          dockerfile: "Dockerfile",
          args: { NODE_VERSION: "24" },
        },
        customizations: {
          vscode: { extensions: ["oxc.oxc-vscode"] },
        },
        mounts: [
          { type: "bind", source: pnpmCache, target: "/pnpm/store" },
          {
            type: "bind",
            source: path.join(cargoCache, "registry"),
            target: "/usr/local/cargo/registry",
          },
          {
            type: "bind",
            source: path.join(cargoCache, "git"),
            target: "/usr/local/cargo/git",
          },
          {
            type: "bind",
            source: "/var/run/docker.sock",
            target: "/var/run/docker.sock",
          },
        ],
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
        generatedConfig,
      );
      expect(JSON.stringify(overrideConfig)).not.toMatch(
        /node_modules|pnpm-lock|workspace|\/target/u,
      );
      await session.close();

      await expect(readFile(overridePath!, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records deterministic cache activity only when the executor uses native caches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-cache-activity-"));
    const projectDir = path.join(root, "project");
    const configPath = path.join(
      projectDir,
      ".devcontainer",
      "devcontainer.json",
    );
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          mounts: [
            {
              type: "volume",
              source: "${devcontainerId}-pnpm-store",
              target: "/pnpm/store",
            },
            {
              type: "volume",
              source: "${devcontainerId}-cargo-registry",
              target: "/usr/local/cargo/registry",
            },
            {
              type: "volume",
              source: "${devcontainerId}-cargo-git",
              target: "/usr/local/cargo/git",
            },
          ],
        })}\n`,
      );
      const cacheActivity: Array<{
        readonly cache: string;
        readonly outcome: string;
      }> = [];
      const session = createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        dependencyCaches: {
          pnpm: path.join(root, "cache", "pnpm"),
          cargo: path.join(root, "cache", "cargo"),
        },
        build: {
          identity: "c".repeat(64),
          cacheDirectory: path.join(root, "cache", "buildkit"),
        },
        environment: {
          TURBO_TEAM: "fixture-team",
          TURBO_TOKEN: "fixture-token",
        },
        recordActivity: (event) => {
          if (event.type === "cache") cacheActivity.push(event);
        },
        run: async (command, args) => {
          if (command === "docker" && args[0] === "ps") {
            return { stdout: "" };
          }
          return {};
        },
      });

      await session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      );

      expect(cacheActivity).toEqual(
        expect.arrayContaining([
          {
            type: "cache",
            cache: "buildkit",
            outcome: "configured",
            at: expect.any(String),
          },
          {
            type: "cache",
            cache: "pnpm-downloads",
            outcome: "mounted",
            at: expect.any(String),
          },
          {
            type: "cache",
            cache: "cargo-downloads",
            outcome: "mounted",
            at: expect.any(String),
          },
          {
            type: "cache",
            cache: "turbo",
            outcome: "configured",
            at: expect.any(String),
          },
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records paired container preparation and dependency installation phases", async () => {
    const projectDir = path.resolve("/fixture/phase-lifecycle");
    const activity: Array<Record<string, unknown>> = [];
    let milliseconds = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      clock: () => new Date(milliseconds++ * 10),
      recordActivity: (event) => {
        activity.push(event);
      },
      run: async (command, args) =>
        command === "docker" && args[0] === "ps" ? { stdout: "" } : {},
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    expect(activity.filter((event) => event.type === "phase")).toEqual([
      {
        type: "phase",
        phase: "container-preparation",
        at: "1970-01-01T00:00:00.000Z",
        outcome: "started",
      },
      {
        type: "phase",
        phase: "container-preparation",
        at: "1970-01-01T00:00:00.010Z",
        outcome: "succeeded",
        durationMilliseconds: 10,
      },
      {
        type: "phase",
        phase: "dependency-installation",
        at: "1970-01-01T00:00:00.020Z",
        outcome: "started",
      },
      {
        type: "phase",
        phase: "dependency-installation",
        at: "1970-01-01T00:00:00.030Z",
        outcome: "succeeded",
        durationMilliseconds: 10,
      },
    ]);
  });

  it("retries one classified Docker registry transport failure with identical inputs", async () => {
    const projectDir = path.resolve("/fixture/docker-registry-recovery");
    const upCalls: Command[] = [];
    const activity: Array<Record<string, unknown>> = [];
    let milliseconds = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      clock: () => new Date(milliseconds++ * 10),
      recordActivity: (event) => {
        activity.push(event);
      },
      run: async (command, args, options) => {
        if (command === "devcontainer" && args[0] === "up") {
          upCalls.push({
            command,
            args: [...args],
            cwd: options.cwd,
            env: options.env,
          });
          if (upCalls.length === 1) {
            throw new Error(
              'failed to resolve source metadata for docker.io/library/node:24-bookworm-slim: Head "https://registry-1.docker.io/v2/library/node/manifests/24-bookworm-slim": dial tcp 34.194.164.123:443: i/o timeout',
            );
          }
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    expect(upCalls).toHaveLength(2);
    expect(upCalls[1]).toEqual(upCalls[0]);
    expect(
      activity.filter(
        (event) =>
          event.type === "phase" && event.phase === "container-preparation",
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: "started",
      }),
      expect.objectContaining({
        outcome: "succeeded",
      }),
    ]);
    expect(
      activity.filter(
        (event) =>
          event.type === "retry" && event.phase === "container-preparation",
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: "started",
        classification: "docker-registry-transport-transient",
        firstError: expect.stringContaining("registry-1.docker.io"),
      }),
      expect.objectContaining({ outcome: "recovered" }),
    ]);
  });

  it("retries one npm registry transport failure found in command stderr", async () => {
    const projectDir = path.resolve("/fixture/npm-registry-recovery");
    const installCalls: Command[] = [];
    const activity: Array<Record<string, unknown>> = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      recordActivity: (event) => {
        activity.push(event);
      },
      run: async (command, args, options) => {
        if (command === "devcontainer" && args[0] === "exec") {
          const nested = nestedDevcontainerCommand(args);
          if (
            nested.command === "pnpm" &&
            nested.args[0] === "install" &&
            nested.args.includes("--lockfile-only")
          ) {
            installCalls.push({
              command,
              args: [...args],
              cwd: options.cwd,
              env: options.env,
            });
            if (installCalls.length === 1) {
              const failure = new Error("Command failed with exit code 1");
              Object.assign(failure, {
                stderr:
                  "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/tinypool: read ECONNRESET",
              });
              throw failure;
            }
          }
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    expect(installCalls).toHaveLength(2);
    expect(installCalls[1]).toEqual(installCalls[0]);
    expect(
      activity.filter(
        (event) =>
          event.type === "phase" && event.phase === "dependency-installation",
      ),
    ).toEqual([
      expect.objectContaining({ outcome: "started" }),
      expect.objectContaining({ outcome: "succeeded" }),
    ]);
    expect(
      activity.filter(
        (event) =>
          event.type === "retry" && event.phase === "dependency-installation",
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: "started",
        classification: "npm-registry-transport-transient",
        firstError: expect.stringContaining("registry.npmjs.org"),
      }),
      expect.objectContaining({ outcome: "recovered" }),
    ]);
  });

  it.each([
    [
      "unknown registry host",
      "GET https://registry.example.com/v2/library/node: read ECONNRESET",
    ],
    [
      "deterministic Dockerfile failure",
      "registry-1.docker.io returned Dockerfile parse error on line 4",
    ],
    [
      "lookalike Docker registry host",
      "https://evilregistry-1.docker.io/v2/library/node: i/o timeout",
    ],
    [
      "unrelated transport marker on another line",
      "FROM registry-1.docker.io/library/node\nlocal socket: connection refused",
    ],
  ])("does not retry a %s", async (_case, diagnostic) => {
    const projectDir = path.resolve(
      `/fixture/non-retryable-${_case.replaceAll(" ", "-")}`,
    );
    let upAttempts = 0;
    const activity: Array<Record<string, unknown>> = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      recordActivity: (event) => {
        activity.push(event);
      },
      run: async (command, args) => {
        if (command === "devcontainer" && args[0] === "up") {
          upAttempts += 1;
          throw new Error(diagnostic);
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await expect(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
    ).rejects.toThrow(diagnostic);

    expect(upAttempts).toBe(1);
    expect(
      activity.filter(
        (event) =>
          event.type === "phase" && event.phase === "container-preparation",
      ),
    ).toEqual([
      expect.objectContaining({ outcome: "started" }),
      expect.objectContaining({
        outcome: "failed",
        classification: "not-retryable",
      }),
    ]);
  });

  it("does not retry a semantic gate failure even when its text resembles a registry transient", async () => {
    const projectDir = path.resolve("/fixture/semantic-no-retry");
    let semanticAttempts = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args) => {
        if (command === "devcontainer" && args[0] === "exec") {
          const nested = nestedDevcontainerCommand(args);
          if (
            nested.command === "pnpm" &&
            nested.args[0] === "run" &&
            nested.args[1] === "check"
          ) {
            semanticAttempts += 1;
            throw new Error(
              "test assertion mentions https://registry.npmjs.org and ECONNRESET",
            );
          }
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await expect(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
    ).rejects.toThrow("test assertion mentions");
    expect(semanticAttempts).toBe(1);
  });

  it("shares one retry budget across container and dependency preparation", async () => {
    const projectDir = path.resolve("/fixture/single-retry-budget");
    let upAttempts = 0;
    let installAttempts = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args) => {
        if (command === "devcontainer" && args[0] === "up") {
          upAttempts += 1;
          if (upAttempts === 1) {
            throw new Error(
              "https://registry-1.docker.io/v2/library/node: i/o timeout",
            );
          }
        }
        if (command === "devcontainer" && args[0] === "exec") {
          const nested = nestedDevcontainerCommand(args);
          if (
            nested.command === "pnpm" &&
            nested.args[0] === "install" &&
            nested.args.includes("--lockfile-only")
          ) {
            installAttempts += 1;
            throw new Error(
              "GET https://registry.npmjs.org/tinypool: read ECONNRESET",
            );
          }
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await expect(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
    ).rejects.toThrow("registry.npmjs.org");
    expect({ upAttempts, installAttempts }).toEqual({
      upAttempts: 2,
      installAttempts: 1,
    });
  });

  it("stops after one retry and preserves the first and final registry failures", async () => {
    const projectDir = path.resolve("/fixture/docker-registry-final-failure");
    let upAttempts = 0;
    const activity: Array<Record<string, unknown>> = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      recordActivity: (event) => {
        activity.push(event);
      },
      run: async (command, args) => {
        if (command === "devcontainer" && args[0] === "up") {
          upAttempts += 1;
          throw new Error(
            `https://registry-1.docker.io/v2/library/node: i/o timeout attempt ${upAttempts}`,
          );
        }
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    await expect(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
    ).rejects.toThrow(
      /container-preparation failed after docker-registry-transport-transient retry.*First failure:.*attempt 1.*Retry failure:.*attempt 2/u,
    );

    expect(upAttempts).toBe(2);
    expect(
      activity.filter(
        (event) =>
          event.type === "retry" && event.phase === "container-preparation",
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: "started",
        firstError: expect.stringContaining("attempt 1"),
      }),
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("attempt 2"),
      }),
    ]);
    expect(activity).toContainEqual(
      expect.objectContaining({
        type: "phase",
        phase: "container-preparation",
        outcome: "failed",
        classification: "docker-registry-transport-transient",
      }),
    );
  });

  it("keeps final retry failure unhealthy and issues no evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-retry-health-"));
    const projectDir = path.join(root, "project");
    const evidenceRoot = path.join(root, "evidence");
    const scenario = {
      id: "retry-final-failure",
      label: "retry final failure",
      presetIdentities: ["fixture"],
    };
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(root, "activity"),
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "retry-final-failure",
      runAttempt: "1",
      invocationId: "retry-final-failure",
      scenarioSet: "init",
      writeEnabled: true,
    });
    try {
      await invocation.record({
        type: "invocation",
        outcome: "started",
        scenarios: [scenario],
      });
      const session = createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        recordActivity: async (event) => {
          await invocation.record(
            event.type === "cache"
              ? { ...event, scenario }
              : {
                  ...event,
                  scope: "development-container-session",
                  scenario,
                },
          );
        },
        run: async (command, args) => {
          if (command === "devcontainer" && args[0] === "up") {
            throw new Error(
              "https://registry-1.docker.io/v2/library/node: i/o timeout",
            );
          }
          return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
        },
      });
      let failure: unknown;
      try {
        await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: "1".repeat(40),
          contractIdentity: "2".repeat(64),
          scenario,
          producerCommit: "test",
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          writeEnabled: true,
          recordLifecycle: invocation.record,
          execute: async () => {
            await session.execute(
              async (run) =>
                await run("pnpm", ["run", "check"], { cwd: projectDir }),
            );
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      await invocation.record({
        type: "scenario",
        scenario,
        outcome: "failed",
        error: failure instanceof Error ? failure.message : String(failure),
      });
      await invocation.record({
        type: "invocation",
        outcome: "failed",
        error: failure instanceof Error ? failure.message : String(failure),
      });

      const records = await ledger.read();
      expect(
        records.filter((record) => record.event.type === "issuance"),
      ).toEqual([]);
      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "retry-final-failure",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      expect(report.healthy).toBe(false);
      expect(report.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "failed-retry" }),
          expect.objectContaining({ code: "failed-phase" }),
          expect.objectContaining({ code: "failed-execution" }),
        ]),
      );
      expect(report.failures).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid-retry-lifecycle" }),
        ]),
      );
      expect(
        report.failures.find((entry) => entry.code === "failed-retry")?.detail,
      ).toMatch(/First failure:.*registry-1\.docker\.io.*Retry failure:/u);
      expect(formatFixtureEvidenceHealthReport(report)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /failure code=failed-retry .*scenario=retry-final-failure .*Fixture retry for container-preparation failed after docker-registry-transport-transient.*Retry failure:/u,
          ),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not single-flight Development Container startup across projects with equivalent builds", async () => {
    const cacheDirectory = path.resolve("/cache/template-buildkit");
    const buildIdentity = "b".repeat(64);
    const calls: Command[] = [];
    let releaseBuild: (() => void) | undefined;
    const run: FixtureCommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "devcontainer" && args[0] === "up") {
        if (releaseBuild === undefined) {
          await new Promise<void>((resolve) => {
            releaseBuild = resolve;
          });
        }
      }
      if (command === "docker" && args[0] === "ps") {
        return { stdout: `container-${path.basename(options.cwd)}\n` };
      }
      return {};
    };
    const projectDirs = [
      path.resolve("/fixture/equivalent-build-a"),
      path.resolve("/fixture/equivalent-build-b"),
    ];
    const sessions = projectDirs.map((projectDir) =>
      createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        build: { identity: buildIdentity, cacheDirectory },
        run,
      }),
    );

    const executions = sessions.map(
      async (session, index) =>
        await session.execute(
          async (sessionRun) =>
            await sessionRun("pnpm", ["run", "check"], {
              cwd: projectDirs[index]!,
            }),
        ),
    );
    await vi.waitFor(() => {
      expect(releaseBuild).toBeDefined();
    });
    releaseBuild!();
    await Promise.all(executions);

    expect(
      calls.filter(
        ({ command, args }) => command === "devcontainer" && args[0] === "up",
      ),
    ).toHaveLength(2);
    for (const projectDir of projectDirs) {
      expect(calls).toContainEqual({
        command: "devcontainer",
        args: expect.arrayContaining([
          "up",
          "--workspace-folder",
          projectDir,
          "--id-label",
          fixtureIdLabel(projectDir),
        ]),
        cwd: projectDir,
      });
    }
    for (const projectDir of projectDirs) {
      const idLabel = fixtureIdLabel(projectDir);
      expect(calls).toContainEqual({
        command: "devcontainer",
        args: expect.arrayContaining([
          "exec",
          "--workspace-folder",
          projectDir,
          "--id-label",
          idLabel,
          "pnpm",
          "run",
          "check",
        ]),
        cwd: projectDir,
      });
      expect(calls).toContainEqual({
        command: "docker",
        args: ["ps", "-aq", "--filter", `label=${idLabel}`],
        cwd: projectDir,
      });
      expect(calls).toContainEqual({
        command: "docker",
        args: ["rm", "-f", `container-${path.basename(projectDir)}`],
        cwd: projectDir,
      });
    }
  });

  it("shares a failed build flight retry across the same project and cleans by exact label", async () => {
    const projectDir = path.resolve("/fixture/shared-build-retry");
    const build = {
      identity: "d".repeat(64),
      cacheDirectory: path.resolve("/cache/template-buildkit"),
    };
    const calls: Command[] = [];
    let upAttempts = 0;
    let devcontainerVersionChecks = 0;
    let releaseVersionChecks!: () => void;
    const bothSessionsReachedStartup = new Promise<void>((resolve) => {
      releaseVersionChecks = resolve;
    });
    const activities: Array<Array<Record<string, unknown>>> = [[], []];
    const run: FixtureCommandRunner = async (command, args, options) => {
      calls.push({
        command,
        args: [...args],
        cwd: options.cwd,
        env: options.env,
      });
      if (command === "devcontainer" && args[0] === "--version") {
        devcontainerVersionChecks += 1;
        if (devcontainerVersionChecks === 2) releaseVersionChecks();
      }
      if (command === "devcontainer" && args[0] === "up") {
        upAttempts += 1;
        if (upAttempts === 1) {
          await bothSessionsReachedStartup;
          throw new Error(
            "https://registry-1.docker.io/v2/library/node: i/o timeout",
          );
        }
      }
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "partial-container\n" };
      }
      return {};
    };
    const sessions = activities.map((activity) =>
      createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        build,
        recordActivity: (event) => {
          activity.push(event);
        },
        run,
      }),
    );

    await Promise.all(
      sessions.map(
        async (session) =>
          await session.execute(
            async (sessionRun) =>
              await sessionRun("pnpm", ["run", "check"], {
                cwd: projectDir,
              }),
          ),
      ),
    );

    expect(upAttempts).toBe(2);
    expect(activities.flat().filter((event) => event.type === "retry")).toEqual(
      [
        expect.objectContaining({ outcome: "started" }),
        expect.objectContaining({ outcome: "recovered" }),
      ],
    );
    expect(
      activities.map((activity) =>
        activity.filter(
          (event) =>
            event.type === "phase" &&
            event.phase === "container-preparation" &&
            event.outcome === "succeeded",
        ),
      ),
    ).toEqual([[expect.any(Object)], [expect.any(Object)]]);
    const label = fixtureIdLabel(projectDir);
    expect(
      calls.filter(
        ({ command, args }) => command === "docker" && args[0] === "ps",
      ),
    ).toEqual([
      expect.objectContaining({
        args: ["ps", "-aq", "--filter", `label=${label}`],
      }),
      expect.objectContaining({
        args: ["ps", "-aq", "--filter", `label=${label}`],
      }),
    ]);
    expect(
      calls.filter(
        ({ command, args }) => command === "docker" && args[0] === "rm",
      ),
    ).toHaveLength(2);
  });

  it("checks before Fix, compares tree identities, and checks again", async () => {
    const projectDir = path.resolve("/fixture/root-order");
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.all()[0]!,
      context: createGenerationContext({
        targetDir: projectDir,
        defaultPackageScope: "fixture",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });
    const calls: Command[] = [];
    const taskIds = plan.manifests.flatMap((manifest) => {
      const name = manifest.name;
      return typeof name === "string" &&
        typeof manifest.scripts === "object" &&
        manifest.scripts !== null
        ? Object.keys(manifest.scripts).map((taskName) => ({
            taskId: `${name.startsWith("@") ? name : "//"}#${taskName}`,
          }))
        : [];
    });

    await executeGeneratedRootQuality({
      plan,
      projectDir,
      fixtureWorkspace: path.dirname(projectDir),
      includeFix: true,
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (args.includes("--dry-run=json")) {
          return { stdout: JSON.stringify({ tasks: taskIds }) };
        }
        if (command === "git" && args[0] === "write-tree") {
          return { stdout: "a".repeat(40) };
        }
        return {};
      },
    });

    expect(
      calls
        .filter(
          ({ command, args }) =>
            (command === "pnpm" &&
              args[0] === "run" &&
              (args[1] === "check" || args[1] === "fix")) ||
            (command === "git" && args[0] === "write-tree"),
        )
        .map(({ command, args }) => [command, ...args]),
    ).toEqual([
      ["pnpm", "run", "check"],
      ["git", "write-tree"],
      ["pnpm", "run", "fix"],
      ["git", "write-tree"],
      ["pnpm", "run", "check"],
    ]);
  });

  it("rejects a Fix delta before the repeated Root Check", async () => {
    const projectDir = path.resolve("/fixture/fix-delta");
    const plan = planGeneratedRepositoryInitialization({
      definition: builtInPresetRegistry.all()[0]!,
      context: createGenerationContext({
        targetDir: projectDir,
        defaultPackageScope: "fixture",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    });
    const taskIds = plan.manifests.flatMap((manifest) => {
      const name = manifest.name;
      return typeof name === "string" &&
        typeof manifest.scripts === "object" &&
        manifest.scripts !== null
        ? Object.keys(manifest.scripts).map((taskName) => ({
            taskId: `${name.startsWith("@") ? name : "//"}#${taskName}`,
          }))
        : [];
    });
    let treeWrites = 0;
    let rootChecks = 0;

    await expect(
      executeGeneratedRootQuality({
        plan,
        projectDir,
        fixtureWorkspace: path.dirname(projectDir),
        includeFix: true,
        run: async (command, args) => {
          if (args.includes("--dry-run=json")) {
            return { stdout: JSON.stringify({ tasks: taskIds }) };
          }
          if (command === "pnpm" && args[1] === "check") rootChecks += 1;
          return {};
        },
        identityRun: async (command, args) => {
          if (command === "git" && args[0] === "write-tree") {
            treeWrites += 1;
            return { stdout: `${treeWrites}`.repeat(40) };
          }
          return {};
        },
      }),
    ).rejects.toThrow(
      /Fix Command changed the working-tree identity from 1111.* to 2222/u,
    );
    expect(rootChecks).toBe(1);
  });

  it("does not touch Docker or the CLI when evidence selection has no cold gate", async () => {
    const calls: Command[] = [];
    let leases = 0;
    let releases = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir: path.resolve("/fixture/full-hit"),
      probes: [],
      acquireSession: async () => {
        leases += 1;
        return () => {
          releases += 1;
        };
      },
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return {};
      },
    });

    await session.close();

    expect(calls).toEqual([]);
    expect({ leases, releases }).toEqual({ leases: 0, releases: 0 });
  });

  it("holds one scheduling lease for a cold container lifecycle", async () => {
    const projectDir = path.resolve("/fixture/cold-session-lease");
    let leases = 0;
    let releases = 0;
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      acquireSession: async () => {
        leases += 1;
        return () => {
          releases += 1;
        };
      },
      run: async () => ({}),
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    expect({ leases, releases }).toEqual({ leases: 1, releases: 1 });
  });

  it("routes cold registry quality through one container lifecycle per scenario", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-registry-test",
    );
    const calls: Command[] = [];
    await rm(workspace, { recursive: true, force: true });
    const evidenceRoot = path.join(workspace, ".test-evidence");
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: path.join(workspace, ".test-activity"),
      evidenceRoot,
    });

    try {
      await runGeneratedScenarioSet("init", {
        workspace,
        evidence: {
          storage: new FileFixtureEvidenceStorage(evidenceRoot),
          readEnabled: false,
          writeEnabled: false,
          activity: {
            ledger,
            runId: "cold-registry-phases",
            runAttempt: "1",
          },
        },
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (command === "docker" && args[0] === "ps") {
            return {
              stdout: `${createHash("sha256").update(options.cwd).digest("hex").slice(0, 12)}\n`,
            };
          }
          if (command !== "devcontainer" || args[0] !== "exec") return {};

          const { command: nestedCommand, args: nestedArgs } =
            nestedDevcontainerCommand(args);
          if (
            nestedCommand === "pnpm" &&
            nestedArgs.includes("--lockfile-only")
          ) {
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "lockfileVersion: '9.0'\n",
            );
          }
          if (nestedCommand === "git") {
            return await execa(nestedCommand, [...nestedArgs], options);
          }
          return {};
        },
      });

      const scenarioCount = (await generatedScenariosFor("init")).length;
      const records = await ledger.read();
      const phases = records.flatMap((record) =>
        record.event.type === "phase" ? [record.event] : [],
      );
      expect(
        phases.filter((event) => event.outcome === "started"),
      ).toHaveLength(scenarioCount * 5);
      expect(
        phases.filter((event) => event.outcome === "succeeded"),
      ).toHaveLength(scenarioCount * 5);
      expect(records.filter((record) => record.event.type === "retry")).toEqual(
        [],
      );
      await expect(
        checkFixtureEvidenceHealth({
          ledger,
          runId: "cold-registry-phases",
          runAttempt: "1",
          enabledScenarioSets: ["init"],
        }),
      ).resolves.toMatchObject({
        healthy: true,
        stages: [
          expect.objectContaining({
            retries: 0,
            recoveries: 0,
          }),
        ],
      });
      expect(
        calls.filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        ),
      ).toHaveLength(scenarioCount);
      const buildCacheSources = calls
        .filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        )
        .map(({ args }) => {
          const cacheFrom = args.indexOf("--cache-from");
          expect(cacheFrom).toBeGreaterThan(0);
          expect(args).toContain("--cache-to");
          return args[cacheFrom + 1];
        });
      expect(new Set(buildCacheSources).size).toBeLessThan(
        buildCacheSources.length,
      );
      expect(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "ps",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "rm",
        ),
      ).toHaveLength(scenarioCount);
      expect(
        calls.some(
          ({ command, args }) =>
            command === "devcontainer" && args[0] === "down",
        ),
      ).toBe(false);
      expect(
        calls.filter(({ command }) => command === "pnpm" || command === "node"),
      ).toEqual([]);
      const capabilityProbes = registryCapabilityProbes(workspace);
      expect(new Set(capabilityProbes.map((probe) => probe.identity))).toEqual(
        requiredCapabilityProbeIdentities,
      );
      expect(
        calls.filter(({ command }) =>
          capabilityProbes.some((probe) => probe.command === command),
        ),
      ).toEqual([]);
      for (const probe of capabilityProbes) {
        expect(
          calls.some(({ command, args }) => {
            if (command !== "devcontainer" || args[0] !== "exec") return false;
            const nested = nestedDevcontainerCommand(args);
            return (
              nested.command === probe.command &&
              JSON.stringify(nested.args) === JSON.stringify(probe.args ?? [])
            );
          }),
        ).toBe(true);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([...requiredCapabilityProbeIdentities])(
    "does not let a host-prepared %s capability mask its missing container probe",
    async (identity) => {
      const projectDir = path.resolve(`/fixture/container-${identity}-missing`);
      const probe = registryCapabilityProbes(projectDir).find(
        (candidate) => candidate.identity === identity,
      );
      if (probe === undefined) {
        throw new Error(`Expected registry-derived ${identity} probe`);
      }
      const calls: Command[] = [];
      const session = createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [probe],
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === probe.command) {
            return { stdout: "host-prepared capability is available" };
          }
          if (command === "devcontainer" && args[0] === "exec") {
            const nested = nestedDevcontainerCommand(args);
            if (nested.command === probe.command) {
              throw new Error("container capability is missing");
            }
          }
          return {};
        },
      });

      try {
        await expect(
          session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        ).rejects.toThrow(
          new RegExp(
            `Tool Layer capability ${identity}.*container capability is missing`,
            "u",
          ),
        );
      } finally {
        await session.close();
      }

      expect(calls.some(({ command }) => command === probe.command)).toBe(
        false,
      );
      expect(
        calls.some(
          ({ command, args }) =>
            command === "devcontainer" &&
            args[0] === "exec" &&
            nestedDevcontainerCommand(args).command === probe.command,
        ),
      ).toBe(true);
      expect(calls.some(({ args }) => args.includes("--lockfile-only"))).toBe(
        false,
      );
    },
  );

  it("shares one cold container session across independent Root and Deployment gates", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-shared-deployment-test",
    );
    const calls: Command[] = [];
    const lifecycle: Array<{
      readonly type: string;
      readonly gate?: string;
      readonly identity?: string;
      readonly outcome?: string;
      readonly scenario?: { readonly id: string };
    }> = [];
    await rm(workspace, { recursive: true, force: true });

    try {
      await runGeneratedScenarioSet("deployment", {
        workspace,
        containerEnvironment: {},
        evidence: {
          writeEnabled: false,
          recordLifecycle: (event) => {
            lifecycle.push(event);
          },
        },
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (args.includes("--dry-run=json")) {
            return {
              stdout: JSON.stringify({
                tasks: (await generatedTaskIds(options.cwd)).map((taskId) => ({
                  taskId,
                })),
              }),
            };
          }
          if (command === "docker" && args[0] === "ps") {
            return {
              stdout: `${createHash("sha256").update(options.cwd).digest("hex").slice(0, 12)}\n`,
            };
          }
          if (command !== "devcontainer" || args[0] !== "exec") return {};
          const { command: nestedCommand, args: nestedArgs } =
            nestedDevcontainerCommand(args);
          if (nestedCommand === "pnpm" && args.includes("--lockfile-only")) {
            await writeFile(
              path.join(options.cwd, "pnpm-lock.yaml"),
              "lockfileVersion: '9.0'\n",
            );
          }
          if (nestedCommand === "git") {
            return await execa("git", [...nestedArgs], {
              cwd: options.cwd,
            });
          }
          return {};
        },
      });

      const started = lifecycle.filter(
        (event) => event.type === "execution" && event.outcome === "started",
      );
      const deploymentStarts = started.filter(
        (event) => event.gate === "deployment-quality",
      );
      expect(deploymentStarts.length).toBeGreaterThan(0);
      for (const deployment of deploymentStarts) {
        const root = started.find(
          (event) =>
            event.gate === "generated-root-quality" &&
            event.scenario?.id === deployment.scenario?.id,
        );
        expect(root).toBeDefined();
        expect(root?.identity).not.toBe(deployment.identity);
        const projectDir = path.join(workspace, deployment.scenario!.id);
        expect(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir &&
              command === "devcontainer" &&
              args[0] === "up",
          ),
        ).toHaveLength(1);
        expect(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir && command === "docker" && args[0] === "ps",
          ),
        ).toHaveLength(1);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps dependency diagnostics primary when registry scenario cleanup fails", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-registry-cleanup-failure-test",
    );
    await rm(workspace, { recursive: true, force: true });
    const reports: string[] = [];

    try {
      const failure: unknown = await runGeneratedScenarioSet("init", {
        workspace,
        reporter: {
          info: (message) => {
            reports.push(message);
          },
        },
        run: async (command, args, options) => {
          if (command === "git") {
            return await execa(command, [...args], options);
          }
          if (
            command === "devcontainer" &&
            args[0] === "exec" &&
            args.includes("fetch")
          ) {
            throw new Error("fixture registry unavailable");
          }
          if (command === "docker" && args[0] === "ps") {
            throw new Error("fixture cleanup daemon stopped");
          }
          return {};
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toMatch(
        /^Dependency preparation failed during pnpm fetch.*fixture registry unavailable/u,
      );
      expect((failure as AggregateError).message).toContain(
        "fixture cleanup daemon stopped",
      );
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /\[Fixture Evidence\] init .* \(init--.*\) failed: .*Reproduce the scenario set with pnpm --filter @ykdz\/template-checks check:generated; generated artifact:/u,
          ),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cleans up by exact label after startup fails", async () => {
    const projectDir = path.resolve("/fixture/startup-failure");
    const idLabel = fixtureIdLabel(projectDir);
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command === "devcontainer" && args[0] === "up") {
          throw new Error("image build failed");
        }
        return {};
      },
    });

    try {
      await expect(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
      ).rejects.toThrow("image build failed");
    } finally {
      await session.close();
    }

    expect(
      calls
        .filter(
          ({ command, args }) =>
            (command === "devcontainer" &&
              (args[0] === "up" || args[0] === "down")) ||
            (command === "docker" && args[0] === "ps"),
        )
        .map(({ command, args }) => [command, ...args]),
    ).toEqual([
      [
        "devcontainer",
        "up",
        "--workspace-folder",
        projectDir,
        "--config",
        path.join(projectDir, ".devcontainer", "devcontainer.json"),
        "--no-lockfile",
        "--id-label",
        idLabel,
      ],
      ["docker", "ps", "-aq", "--filter", `label=${idLabel}`],
    ]);
  });

  it("attributes probe failures before dependency preparation or quality commands", async () => {
    const projectDir = path.resolve("/fixture/probe-failure");
    const idLabel = fixtureIdLabel(projectDir);
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [
        {
          identity: "docker-client",
          command: "docker",
          args: ["info"],
          failureMessage: "Docker daemon access is unavailable",
        },
      ],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("docker")
        ) {
          throw new Error("permission denied");
        }
        return {};
      },
    });

    try {
      await expect(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
      ).rejects.toThrow(
        /Tool Layer capability docker-client.*Docker daemon access is unavailable.*permission denied/u,
      );
    } finally {
      await session.close();
    }

    expect(
      calls.some(
        ({ args }) =>
          args.includes("--lockfile-only") ||
          (args.includes("run") && args.includes("check")),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(
          ({ command, args }) =>
            (command === "docker" && args[0] === "ps") ||
            (command === "devcontainer" && args[0] === "down"),
        )
        .map(({ command, args }) => [command, ...args]),
    ).toEqual([["docker", "ps", "-aq", "--filter", `label=${idLabel}`]]);
  });

  it("keeps a probe failure primary when cleanup also fails", async () => {
    const projectDir = path.resolve("/fixture/probe-and-cleanup-failure");
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [
        {
          identity: "docker-client",
          command: "docker",
          args: ["info"],
          failureMessage: "Docker daemon access is unavailable",
        },
      ],
      run: async (command, args) => {
        if (
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("docker")
        ) {
          throw new Error("permission denied");
        }
        if (command === "docker" && args[0] === "ps") {
          throw new Error("cleanup daemon stopped");
        }
        return {};
      },
    });

    const failure: unknown = await session
      .execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toMatch(
      /^Tool Layer capability docker-client.*permission denied/u,
    );
    expect((failure as AggregateError).message).toContain(
      "cleanup daemon stopped",
    );
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it("fails a successful scenario when cleanup fails", async () => {
    const projectDir = path.resolve("/fixture/cleanup-only-failure");
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args) => {
        if (command === "docker" && args[0] === "ps") {
          throw new Error("cleanup daemon stopped");
        }
        return {};
      },
    });

    const failure: unknown = await session
      .execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Development Container Fixture cleanup failed",
    );
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "cleanup daemon stopped" }),
    ]);
  });

  it("attributes dependency preparation failures and still cleans up", async () => {
    const projectDir = path.resolve("/fixture/fetch-failure");
    const idLabel = fixtureIdLabel(projectDir);
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("fetch")
        ) {
          throw new Error("registry unavailable");
        }
        return {};
      },
    });

    try {
      await expect(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
      ).rejects.toThrow(
        /Dependency preparation failed during pnpm fetch.*registry unavailable/u,
      );
    } finally {
      await session.close();
    }

    expect(
      calls.some(
        ({ command, args }) =>
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("check"),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(
          ({ command, args }) =>
            (command === "docker" && args[0] === "ps") ||
            (command === "devcontainer" && args[0] === "down"),
        )
        .map(({ command, args }) => [command, ...args]),
    ).toEqual([["docker", "ps", "-aq", "--filter", `label=${idLabel}`]]);
  });

  it.each([
    {
      unavailable: "docker",
      expected: /Docker is required for Generated Repository Fixture quality/u,
      expectedCalls: [["docker", "version", "--format", "{{.Server.Version}}"]],
    },
    {
      unavailable: "devcontainer",
      expected:
        /pinned Dev Container CLI is required for Generated Repository Fixture quality/u,
      expectedCalls: [
        ["docker", "version", "--format", "{{.Server.Version}}"],
        ["devcontainer", "--version"],
      ],
    },
  ])(
    "reports a clear $unavailable prerequisite error without host fallback",
    async ({ unavailable, expected, expectedCalls }) => {
      const projectDir = path.resolve(`/fixture/missing-${unavailable}`);
      const calls: Command[] = [];
      const session = createDevelopmentContainerFixtureSession({
        projectDir,
        probes: [],
        run: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === unavailable) {
            throw new Error(`${unavailable} executable not found`);
          }
          return {};
        },
      });

      try {
        await expect(
          session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        ).rejects.toThrow(expected);
      } finally {
        await session.close();
      }

      expect(calls.map(({ command, args }) => [command, ...args])).toEqual(
        expectedCalls,
      );
      expect(calls.some(({ command }) => command === "pnpm")).toBe(false);
      expect(
        calls.some(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        ),
      ).toBe(false);
    },
  );

  it("removes the labeled container and exactly the declared scenario volumes after a command failure", async () => {
    const projectDir = path.resolve("/fixture/command-failure");
    const idLabel = fixtureIdLabel(projectDir);
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      ownedVolumes: [
        "template-fixture-command-failure-workspace",
        "template-fixture-command-failure-state",
      ],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command === "docker" && args[0] === "ps") {
          return { stdout: "fixture-command-failure\n" };
        }
        if (
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("check")
        ) {
          throw new Error("Root Check failed");
        }
        return {};
      },
    });

    try {
      await expect(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
      ).rejects.toThrow("Root Check failed");
    } finally {
      await session.close();
    }

    expect(
      calls
        .filter(
          ({ command, args }) =>
            command === "docker" &&
            (args[0] === "ps" || args[0] === "rm" || args[0] === "volume"),
        )
        .map(({ command, args }) => [command, ...args]),
    ).toEqual([
      ["docker", "ps", "-aq", "--filter", `label=${idLabel}`],
      ["docker", "rm", "-f", "fixture-command-failure"],
      ["docker", "volume", "rm", "template-fixture-command-failure-workspace"],
      ["docker", "volume", "rm", "template-fixture-command-failure-state"],
    ]);
    expect(
      calls.some(
        ({ command, args }) => command === "devcontainer" && args[0] === "down",
      ),
    ).toBe(false);
    expect(calls.some(({ args }) => args.includes("prune"))).toBe(false);
  });

  it("preserves an in-repository command working directory inside the container", async () => {
    const projectDir = path.resolve("/fixture/focused");
    const idLabel = fixtureIdLabel(projectDir);
    const consumerDir = path.join(projectDir, "apps", "web");
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return {};
      },
    });

    try {
      await session.run("node", ["--conditions=source", "probe.mjs"], {
        cwd: consumerDir,
      });
    } finally {
      await session.close();
    }

    expect(
      calls.find(
        ({ command, args }) =>
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("probe.mjs"),
      )?.args,
    ).toEqual([
      "exec",
      "--workspace-folder",
      projectDir,
      "--id-label",
      idLabel,
      "--remote-env",
      fixtureTurboCacheRemoteEnv(projectDir),
      "sh",
      "-c",
      'cd "$1" && shift && exec "$@"',
      "sh",
      "apps/web",
      "node",
      "--conditions=source",
      "probe.mjs",
    ]);
  });

  it("forwards only the Turbo cache environment whitelist to container commands", async () => {
    const projectDir = path.resolve("/fixture/turbo-cache");
    const calls: Command[] = [];
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      environment: {
        TURBO_TEAM: "fixture-team",
        TURBO_TOKEN: "fixture-token",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY: "fixture-signature",
        TURBO_REMOTE_CACHE_READ_ONLY: "true",
        UNRELATED_SECRET: "must-not-be-forwarded",
      },
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return {};
      },
    });

    await session.execute(
      async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
    );

    const execCall = calls.find(
      ({ command, args }) =>
        command === "devcontainer" &&
        args[0] === "exec" &&
        args.includes("check"),
    );
    expect(execCall?.args).toEqual(
      expect.arrayContaining([
        "--remote-env",
        expect.stringMatching(/^TURBO_CACHE_DIR=\/tmp\/template-turbo-cache-/u),
        "--remote-env",
        "TURBO_TEAM=fixture-team",
        "TURBO_TOKEN=fixture-token",
        "TURBO_REMOTE_CACHE_SIGNATURE_KEY=fixture-signature",
        "TURBO_REMOTE_CACHE_READ_ONLY=true",
      ]),
    );
    expect(execCall?.args.join("\n")).not.toContain("UNRELATED_SECRET");
    expect(
      calls
        .filter(
          ({ command, args }) =>
            command === "devcontainer" && args[0] !== "exec",
        )
        .flatMap(({ args }) => args),
    ).not.toContain("fixture-token");
  });

  it("redacts forwarded Turbo secrets from propagated failures and activity records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-turbo-redaction-"));
    const projectDir = path.join(root, "project");
    const activityRoot = path.join(root, "activity");
    const evidenceRoot = path.join(root, "evidence");
    const turboToken = "turbo-token-must-not-leak";
    const signatureKey = "turbo-signature-must-not-leak";
    const execaFailure = new Error(
      `Command failed with exit code 1: devcontainer exec --remote-env TURBO_TOKEN=${turboToken} --remote-env TURBO_REMOTE_CACHE_SIGNATURE_KEY=${signatureKey} pnpm run check`,
    );
    Object.assign(execaFailure, {
      command: `devcontainer exec --remote-env TURBO_TOKEN=${turboToken} --remote-env TURBO_REMOTE_CACHE_SIGNATURE_KEY=${signatureKey} pnpm run check`,
      escapedCommand: `devcontainer exec --remote-env "TURBO_TOKEN=${turboToken}" --remote-env "TURBO_REMOTE_CACHE_SIGNATURE_KEY=${signatureKey}" pnpm run check`,
    });
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: [],
      environment: {
        TURBO_TOKEN: turboToken,
        TURBO_REMOTE_CACHE_SIGNATURE_KEY: signatureKey,
      },
      run: async (command, args) => {
        if (
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("check")
        ) {
          throw execaFailure;
        }
        if (command === "docker" && args[0] === "ps") return { stdout: "" };
        return {};
      },
    });
    const ledger = new FileFixtureEvidenceActivityLedger({
      root: activityRoot,
      evidenceRoot,
    });
    const invocation = ledger.invocation({
      runId: "turbo-redaction",
      runAttempt: "1",
      invocationId: "turbo-redaction-invocation",
      scenarioSet: "init",
      writeEnabled: false,
    });

    try {
      let propagated: unknown;
      try {
        await runFixtureEvidenceGate({
          gate: "generated-root-quality",
          generatedContentIdentity: "1".repeat(40),
          contractIdentity: "2".repeat(64),
          scenario: {
            id: "turbo-redaction",
            label: "Turbo redaction",
            presetIdentities: ["fixture"],
          },
          producerCommit: "local",
          readEnabled: false,
          writeEnabled: false,
          recordLifecycle: async (event) => await invocation.record(event),
          execute: async () => {
            await session.execute(async (run) => {
              await run("pnpm", ["run", "check"], { cwd: projectDir });
            });
          },
        });
      } catch (error) {
        propagated = error;
      }

      expect(propagated).toBeInstanceOf(Error);
      const propagatedText =
        propagated instanceof Error
          ? `${propagated.message}\n${propagated.stack ?? ""}`
          : String(propagated);
      const activityText = await readFile(
        path.join(activityRoot, "activity.jsonl"),
        "utf8",
      );
      expect(`${propagatedText}\n${activityText}`).toContain("[REDACTED]");
      expect(`${propagatedText}\n${activityText}`).not.toContain(turboToken);
      expect(`${propagatedText}\n${activityText}`).not.toContain(signatureKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
