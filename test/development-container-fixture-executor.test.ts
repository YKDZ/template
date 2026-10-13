import assert from "node:assert/strict";
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
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";

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
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          }),
        }).developmentContainer.probes,
    )
    .filter((probe) => requiredCapabilityProbeIdentities.has(probe.identity));
}

void describe("Development Container Fixture Executor", () => {
  void it("normalizes equivalent final Development Container build inputs", async () => {
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
      assert.strictEqual(
        await deriveDevelopmentContainerBuildIdentity({ projectDir: second }),
        firstIdentity,
      );

      await writeBuild(second, {
        build: {
          dockerfile: "Dockerfile",
          args: { NODE_VERSION: "24", TOOL_VERSION: "2" },
        },
      });
      assert.notStrictEqual(
        await deriveDevelopmentContainerBuildIdentity({ projectDir: second }),
        firstIdentity,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("starts, prepares, executes, and cleans up through supported CLI commands", async () => {
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

    assert.deepStrictEqual(calls, [
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

  void it("passes identity-scoped BuildKit cache transport through Dev Container CLI", async () => {
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
    assert.ok(up);
    for (const requiredArgument of [
      "--cache-from",
      `type=local,src=${identityCache}`,
      "--cache-to",
      `type=local,dest=${identityCache},mode=max`,
    ]) {
      assert.ok(up.args.includes(requiredArgument));
    }
    assert.strictEqual(
      calls.some(
        ({ command, args }) =>
          command === "docker" &&
          (args.includes("prune") || args.includes(identityCache)),
      ),
      false,
    );
  });

  void it("isolates Dev Container CLI temporary directories per fixture session", async () => {
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

    assert.strictEqual(upTempDirectories.length, 2);
    assert.strictEqual(new Set(upTempDirectories).size, 2);
    for (const projectDir of projectDirs) {
      const prefix = `template-devcontainer-${fixtureProjectIdentity(projectDir)}-`;
      assert.ok(
        upTempDirectories.some(
          (directory) =>
            typeof directory === "string" && directory.includes(prefix),
        ),
      );
    }
  });

  void it("binds only dependency-download caches into the Development Container", async () => {
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
      assert.deepStrictEqual(overrideConfig, {
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
      assert.deepStrictEqual(
        JSON.parse(await readFile(configPath, "utf8")),
        generatedConfig,
      );
      assert.doesNotMatch(
        JSON.stringify(overrideConfig),
        /node_modules|pnpm-lock|workspace|\/target/u,
      );
      await session.close();

      await assert.rejects(readFile(overridePath!, "utf8"), (error) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.ok(Object.hasOwn(error, "code"));
        assert.strictEqual(Reflect.get(error, "code"), "ENOENT");
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("records deterministic cache activity only when the executor uses native caches", async () => {
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
      const cacheActivity: Array<Record<string, unknown>> = [];
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

      for (const expected of [
        { cache: "buildkit", outcome: "configured" },
        { cache: "pnpm-downloads", outcome: "mounted" },
        { cache: "cargo-downloads", outcome: "mounted" },
        { cache: "turbo", outcome: "configured" },
      ]) {
        const event = cacheActivity.find(
          (candidate) =>
            candidate.cache === expected.cache &&
            candidate.outcome === expected.outcome,
        );
        assert.ok(event);
        assert.strictEqual(Object.getPrototypeOf(event), Object.prototype);
        assert.strictEqual(Reflect.ownKeys(event).length, 4);
        assert.ok(Object.hasOwn(event, "type"));
        assert.ok(Object.hasOwn(event, "cache"));
        assert.ok(Object.hasOwn(event, "outcome"));
        assert.ok(Object.hasOwn(event, "at"));
        assert.strictEqual(event.type, "cache");
        assert.strictEqual(typeof event.at, "string");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("records paired container preparation and dependency installation phases", async () => {
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

    assert.deepStrictEqual(
      activity.filter((event) => event.type === "phase"),
      [
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
      ],
    );
  });

  void it("retries one classified Docker registry transport failure with identical inputs", async () => {
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

    assert.strictEqual(upCalls.length, 2);
    assert.deepStrictEqual(upCalls[1], upCalls[0]);
    const preparationPhases = activity.filter(
      (event) =>
        event.type === "phase" && event.phase === "container-preparation",
    );
    assert.strictEqual(preparationPhases.length, 2);
    assert.partialDeepStrictEqual(preparationPhases[0], { outcome: "started" });
    assert.partialDeepStrictEqual(preparationPhases[1], {
      outcome: "succeeded",
    });
    const preparationRetries = activity.filter(
      (event) =>
        event.type === "retry" && event.phase === "container-preparation",
    );
    assert.strictEqual(preparationRetries.length, 2);
    assert.partialDeepStrictEqual(preparationRetries[0], {
      outcome: "started",
      classification: "docker-registry-transport-transient",
    });
    assert.ok(
      typeof preparationRetries[0]!.firstError === "string" &&
        preparationRetries[0]!.firstError.includes("registry-1.docker.io"),
    );
    assert.partialDeepStrictEqual(preparationRetries[1], {
      outcome: "recovered",
    });
  });

  void it("retries one npm registry transport failure found in command stderr", async () => {
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

    assert.strictEqual(installCalls.length, 2);
    assert.deepStrictEqual(installCalls[1], installCalls[0]);
    const installationPhases = activity.filter(
      (event) =>
        event.type === "phase" && event.phase === "dependency-installation",
    );
    assert.strictEqual(installationPhases.length, 2);
    assert.partialDeepStrictEqual(installationPhases[0], {
      outcome: "started",
    });
    assert.partialDeepStrictEqual(installationPhases[1], {
      outcome: "succeeded",
    });
    const installationRetries = activity.filter(
      (event) =>
        event.type === "retry" && event.phase === "dependency-installation",
    );
    assert.strictEqual(installationRetries.length, 2);
    assert.partialDeepStrictEqual(installationRetries[0], {
      outcome: "started",
      classification: "npm-registry-transport-transient",
    });
    assert.ok(
      typeof installationRetries[0]!.firstError === "string" &&
        installationRetries[0]!.firstError.includes("registry.npmjs.org"),
    );
    assert.partialDeepStrictEqual(installationRetries[1], {
      outcome: "recovered",
    });
  });

  for (const [caseName, diagnostic] of [
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
  ] as const) {
    void it(`does not retry a ${caseName}`, async () => {
      const projectDir = path.resolve(
        `/fixture/non-retryable-${caseName.replaceAll(" ", "-")}`,
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

      await assert.rejects(
        session.execute(
          async (run) =>
            await run("pnpm", ["run", "check"], { cwd: projectDir }),
        ),
        (error) => error instanceof Error && error.message.includes(diagnostic),
      );

      assert.strictEqual(upAttempts, 1);
      const preparationPhases = activity.filter(
        (event) =>
          event.type === "phase" && event.phase === "container-preparation",
      );
      assert.strictEqual(preparationPhases.length, 2);
      assert.partialDeepStrictEqual(preparationPhases[0], {
        outcome: "started",
      });
      assert.partialDeepStrictEqual(preparationPhases[1], {
        outcome: "failed",
        classification: "not-retryable",
      });
    });
  }

  void it("does not retry a semantic gate failure even when its text resembles a registry transient", async () => {
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

    await assert.rejects(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
      (error) =>
        error instanceof Error &&
        error.message.includes("test assertion mentions"),
    );
    assert.strictEqual(semanticAttempts, 1);
  });

  void it("shares one retry budget across container and dependency preparation", async () => {
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

    await assert.rejects(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
      (error) =>
        error instanceof Error && error.message.includes("registry.npmjs.org"),
    );
    assert.deepStrictEqual(
      { upAttempts, installAttempts },
      {
        upAttempts: 2,
        installAttempts: 1,
      },
    );
  });

  void it("stops after one retry and preserves the first and final registry failures", async () => {
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

    await assert.rejects(
      session.execute(
        async (run) => await run("pnpm", ["run", "check"], { cwd: projectDir }),
      ),
      (error) =>
        error instanceof Error &&
        /container-preparation failed after docker-registry-transport-transient retry.*First failure:.*attempt 1.*Retry failure:.*attempt 2/u.test(
          error.message,
        ),
    );

    assert.strictEqual(upAttempts, 2);
    const preparationRetries = activity.filter(
      (event) =>
        event.type === "retry" && event.phase === "container-preparation",
    );
    assert.strictEqual(preparationRetries.length, 2);
    assert.partialDeepStrictEqual(preparationRetries[0], {
      outcome: "started",
    });
    assert.ok(
      typeof preparationRetries[0]!.firstError === "string" &&
        preparationRetries[0]!.firstError.includes("attempt 1"),
    );
    assert.partialDeepStrictEqual(preparationRetries[1], {
      outcome: "failed",
    });
    assert.ok(
      typeof preparationRetries[1]!.error === "string" &&
        preparationRetries[1]!.error.includes("attempt 2"),
    );
    assert.ok(
      activity.some(
        (event) =>
          event.type === "phase" &&
          event.phase === "container-preparation" &&
          event.outcome === "failed" &&
          event.classification === "docker-registry-transport-transient",
      ),
    );
  });

  void it("keeps final retry failure unhealthy and issues no evidence", async () => {
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
      assert.ok(failure instanceof Error);
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
      assert.deepStrictEqual(
        records.filter((record) => record.event.type === "issuance"),
        [],
      );
      const report = await checkFixtureEvidenceHealth({
        ledger,
        runId: "retry-final-failure",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(report.healthy, false);
      for (const code of ["failed-retry", "failed-phase", "failed-execution"]) {
        assert.ok(report.failures.some((entry) => entry.code === code));
      }
      assert.ok(
        report.failures.every(
          (entry) => entry.code !== "invalid-retry-lifecycle",
        ),
      );
      const retryFailure = report.failures.find(
        (entry) => entry.code === "failed-retry",
      );
      assert.ok(retryFailure !== undefined);
      assert.match(
        retryFailure.detail,
        /First failure:.*registry-1\.docker\.io.*Retry failure:/u,
      );
      assert.ok(
        formatFixtureEvidenceHealthReport(report).some((line) =>
          /failure code=failed-retry .*scenario=retry-final-failure .*Fixture retry for container-preparation failed after docker-registry-transport-transient.*Retry failure:/u.test(
            line,
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not single-flight Development Container startup across projects with equivalent builds", async () => {
    const cacheDirectory = path.resolve("/cache/template-buildkit");
    const buildIdentity = "b".repeat(64);
    const calls: Command[] = [];
    let releaseBuild: (() => void) | undefined;
    let signalBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      signalBuildStarted = resolve;
    });
    const run: FixtureCommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "devcontainer" && args[0] === "up") {
        if (releaseBuild === undefined) {
          await new Promise<void>((resolve) => {
            releaseBuild = resolve;
            signalBuildStarted();
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
    await buildStarted;
    assert.ok(releaseBuild);
    releaseBuild();
    await Promise.all(executions);

    assert.strictEqual(
      calls.filter(
        ({ command, args }) => command === "devcontainer" && args[0] === "up",
      ).length,
      2,
    );
    for (const projectDir of projectDirs) {
      const requiredUpArguments = [
        "up",
        "--workspace-folder",
        projectDir,
        "--id-label",
        fixtureIdLabel(projectDir),
      ];
      assert.ok(
        calls.some(
          (call) =>
            call.command === "devcontainer" &&
            call.cwd === projectDir &&
            requiredUpArguments.every((argument) =>
              call.args.includes(argument),
            ),
        ),
      );
    }
    for (const projectDir of projectDirs) {
      const idLabel = fixtureIdLabel(projectDir);
      const requiredExecArguments = [
        "exec",
        "--workspace-folder",
        projectDir,
        "--id-label",
        idLabel,
        "pnpm",
        "run",
        "check",
      ];
      assert.ok(
        calls.some(
          (call) =>
            call.command === "devcontainer" &&
            call.cwd === projectDir &&
            requiredExecArguments.every((argument) =>
              call.args.includes(argument),
            ),
        ),
      );
      const inspectArguments = ["ps", "-aq", "--filter", `label=${idLabel}`];
      assert.ok(
        calls.some(
          (call) =>
            call.command === "docker" &&
            call.cwd === projectDir &&
            call.args.length === inspectArguments.length &&
            call.args.every(
              (argument, index) => argument === inspectArguments[index],
            ),
        ),
      );
      const removeArguments = [
        "rm",
        "-f",
        `container-${path.basename(projectDir)}`,
      ];
      assert.ok(
        calls.some(
          (call) =>
            call.command === "docker" &&
            call.cwd === projectDir &&
            call.args.length === removeArguments.length &&
            call.args.every(
              (argument, index) => argument === removeArguments[index],
            ),
        ),
      );
    }
  });

  void it("shares a failed build flight retry across the same project and cleans by exact label", async () => {
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

    assert.strictEqual(upAttempts, 2);
    const retries = activities.flat().filter((event) => event.type === "retry");
    assert.strictEqual(retries.length, 2);
    assert.partialDeepStrictEqual(retries[0], { outcome: "started" });
    assert.partialDeepStrictEqual(retries[1], { outcome: "recovered" });
    const preparationSuccesses = activities.map((activity) =>
      activity.filter(
        (event) =>
          event.type === "phase" &&
          event.phase === "container-preparation" &&
          event.outcome === "succeeded",
      ),
    );
    assert.strictEqual(preparationSuccesses.length, 2);
    for (const successes of preparationSuccesses) {
      assert.strictEqual(successes.length, 1);
      assert.ok(typeof successes[0] === "object" && successes[0] !== null);
    }
    const label = fixtureIdLabel(projectDir);
    const inspectCalls = calls.filter(
      ({ command, args }) => command === "docker" && args[0] === "ps",
    );
    assert.strictEqual(inspectCalls.length, 2);
    for (const call of inspectCalls) {
      assert.deepStrictEqual(call.args, [
        "ps",
        "-aq",
        "--filter",
        `label=${label}`,
      ]);
    }
    assert.strictEqual(
      calls.filter(
        ({ command, args }) => command === "docker" && args[0] === "rm",
      ).length,
      2,
    );
  });

  void it("checks before Fix, compares tree identities, and checks again", async () => {
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

    assert.deepStrictEqual(
      calls
        .filter(
          ({ command, args }) =>
            (command === "pnpm" &&
              args[0] === "run" &&
              (args[1] === "check" || args[1] === "fix")) ||
            (command === "git" && args[0] === "write-tree"),
        )
        .map(({ command, args }) => [command, ...args]),
      [
        ["pnpm", "run", "check"],
        ["git", "write-tree"],
        ["pnpm", "run", "fix"],
        ["git", "write-tree"],
        ["pnpm", "run", "check"],
      ],
    );
  });

  void it("rejects a Fix delta before the repeated Root Check", async () => {
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

    await assert.rejects(
      executeGeneratedRootQuality({
        plan,
        projectDir,
        fixtureWorkspace: path.dirname(projectDir),
        includeFix: true,
        run: async (command, args) => {
          if (args.includes("--dry-run=json")) {
            return { stdout: JSON.stringify({ tasks: taskIds }) };
          }
          if (command === "git" && args[0] === "write-tree") {
            treeWrites += 1;
            return { stdout: `${treeWrites}`.repeat(40) };
          }
          if (command === "pnpm" && args[1] === "check") rootChecks += 1;
          return {};
        },
      }),
      (error) =>
        error instanceof Error &&
        /Fix Command changed the working-tree identity from 1111.* to 2222/u.test(
          error.message,
        ),
    );
    assert.strictEqual(rootChecks, 1);
  });

  void it("does not touch Docker or the CLI when evidence selection has no cold gate", async () => {
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

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual({ leases, releases }, { leases: 0, releases: 0 });
  });

  void it("holds one scheduling lease for a cold container lifecycle", async () => {
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

    assert.deepStrictEqual({ leases, releases }, { leases: 1, releases: 1 });
  });

  void it("routes cold registry quality through one container lifecycle per scenario", async () => {
    const workspace = path.resolve(
      "/tmp/template-development-container-registry-test",
    );
    const calls: Command[] = [];
    const containerGeneratedLockfiles = new Set<string>();
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
            if (
              args[0] === "add" &&
              containerGeneratedLockfiles.has(options.cwd)
            ) {
              throw new Error(
                'error: open("pnpm-lock.yaml"): Permission denied',
              );
            }
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
            containerGeneratedLockfiles.add(options.cwd);
          }
          if (nestedCommand === "git") {
            if (
              nestedArgs[0] !== "-c" ||
              nestedArgs[1] !==
                `safe.directory=/workspaces/${path.basename(options.cwd)}`
            ) {
              throw new Error(
                `fatal: detected dubious ownership in repository at '/workspaces/${path.basename(options.cwd)}'`,
              );
            }
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
      assert.strictEqual(
        phases.filter((event) => event.outcome === "started").length,
        scenarioCount * 5,
      );
      assert.strictEqual(
        phases.filter((event) => event.outcome === "succeeded").length,
        scenarioCount * 5,
      );
      assert.deepStrictEqual(
        records.filter((record) => record.event.type === "retry"),
        [],
      );
      const health = await checkFixtureEvidenceHealth({
        ledger,
        runId: "cold-registry-phases",
        runAttempt: "1",
        enabledScenarioSets: ["init"],
      });
      assert.strictEqual(health.healthy, true);
      assert.strictEqual(health.stages.length, 1);
      assert.partialDeepStrictEqual(health.stages[0], {
        retries: 0,
        recoveries: 0,
      });
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.filter(({ command, args }) => {
          if (command !== "devcontainer" || args[0] !== "exec") return false;
          const nested = nestedDevcontainerCommand(args);
          const nestedGitArgs =
            nested.args[0] === "-c" &&
            nested.args[1]?.startsWith("safe.directory=")
              ? nested.args.slice(2)
              : nested.args;
          return (
            nested.command === "git" &&
            (nestedGitArgs[0] === "add" || nestedGitArgs[0] === "write-tree")
          );
        }).length,
        scenarioCount * 4,
      );
      const buildCacheSources = calls
        .filter(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        )
        .map(({ args }) => {
          const cacheFrom = args.indexOf("--cache-from");
          assert.ok(cacheFrom > 0);
          assert.ok(args.includes("--cache-to"));
          return args[cacheFrom + 1];
        });
      assert.ok(new Set(buildCacheSources).size < buildCacheSources.length);
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "ps",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.filter(
          ({ command, args }) => command === "docker" && args[0] === "rm",
        ).length,
        scenarioCount,
      );
      assert.strictEqual(
        calls.some(
          ({ command, args }) =>
            command === "devcontainer" && args[0] === "down",
        ),
        false,
      );
      assert.deepStrictEqual(
        calls.filter(({ command }) => command === "pnpm" || command === "node"),
        [],
      );
      const capabilityProbes = registryCapabilityProbes(workspace);
      assert.deepStrictEqual(
        new Set(capabilityProbes.map((probe) => probe.identity)),
        requiredCapabilityProbeIdentities,
      );
      assert.deepStrictEqual(
        calls.filter(({ command }) =>
          capabilityProbes.some((probe) => probe.command === command),
        ),
        [],
      );
      for (const probe of capabilityProbes) {
        assert.strictEqual(
          calls.some(({ command, args }) => {
            if (command !== "devcontainer" || args[0] !== "exec") return false;
            const nested = nestedDevcontainerCommand(args);
            return (
              nested.command === probe.command &&
              JSON.stringify(nested.args) === JSON.stringify(probe.args ?? [])
            );
          }),
          true,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  for (const identity of requiredCapabilityProbeIdentities) {
    void it(`does not let a host-prepared ${identity} capability mask its missing container probe`, async () => {
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
        await assert.rejects(
          session.run("pnpm", ["run", "check"], { cwd: projectDir }),
          (error) =>
            error instanceof Error &&
            new RegExp(
              `Development Container capability ${identity}.*container capability is missing`,
              "u",
            ).test(error.message),
        );
      } finally {
        await session.close();
      }

      assert.strictEqual(
        calls.some(({ command }) => command === probe.command),
        false,
      );
      assert.strictEqual(
        calls.some(
          ({ command, args }) =>
            command === "devcontainer" &&
            args[0] === "exec" &&
            nestedDevcontainerCommand(args).command === probe.command,
        ),
        true,
      );
      assert.strictEqual(
        calls.some(({ args }) => args.includes("--lockfile-only")),
        false,
      );
    });
  }

  void it("shares one cold container session across independent Root and Deployment gates", async () => {
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
      assert.ok(deploymentStarts.length > 0);
      for (const deployment of deploymentStarts) {
        const root = started.find(
          (event) =>
            event.gate === "generated-root-quality" &&
            event.scenario?.id === deployment.scenario?.id,
        );
        assert.notStrictEqual(root, undefined);
        assert.notStrictEqual(root?.identity, deployment.identity);
        const projectDir = path.join(workspace, deployment.scenario!.id);
        assert.strictEqual(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir &&
              command === "devcontainer" &&
              args[0] === "up",
          ).length,
          1,
        );
        assert.strictEqual(
          calls.filter(
            ({ command, args, cwd }) =>
              cwd === projectDir && command === "docker" && args[0] === "ps",
          ).length,
          1,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("keeps dependency diagnostics primary when registry scenario cleanup fails", async () => {
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

      assert.ok(failure instanceof AggregateError);
      assert.match(
        (failure as AggregateError).message,
        /^Dependency preparation failed during pnpm fetch.*fixture registry unavailable/u,
      );
      assert.ok(
        (failure as AggregateError).message.includes(
          "fixture cleanup daemon stopped",
        ),
      );
      assert.strictEqual((failure as AggregateError).errors.length, 2);
      assert.ok(
        reports.some((report) =>
          /\[Fixture Evidence\] init .* \(init--.*\) failed: .*Reproduce the scenario set with pnpm --filter @ykdz\/template-checks check:generated; generated artifact:/u.test(
            report,
          ),
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("cleans up by exact label after startup fails", async () => {
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
      await assert.rejects(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        (error) =>
          error instanceof Error &&
          error.message.includes("image build failed"),
      );
    } finally {
      await session.close();
    }

    assert.deepStrictEqual(
      calls
        .filter(
          ({ command, args }) =>
            (command === "devcontainer" &&
              (args[0] === "up" || args[0] === "down")) ||
            (command === "docker" && args[0] === "ps"),
        )
        .map(({ command, args }) => [command, ...args]),
      [
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
      ],
    );
  });

  void it("attributes probe failures before dependency preparation or quality commands", async () => {
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
      await assert.rejects(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        (error) =>
          error instanceof Error &&
          /Development Container capability docker-client.*Docker daemon access is unavailable.*permission denied/u.test(
            error.message,
          ),
      );
    } finally {
      await session.close();
    }

    assert.strictEqual(
      calls.some(
        ({ args }) =>
          args.includes("--lockfile-only") ||
          (args.includes("run") && args.includes("check")),
      ),
      false,
    );
    assert.deepStrictEqual(
      calls
        .filter(
          ({ command, args }) =>
            (command === "docker" && args[0] === "ps") ||
            (command === "devcontainer" && args[0] === "down"),
        )
        .map(({ command, args }) => [command, ...args]),
      [["docker", "ps", "-aq", "--filter", `label=${idLabel}`]],
    );
  });

  void it("keeps a probe failure primary when cleanup also fails", async () => {
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

    assert.ok(failure instanceof AggregateError);
    assert.match(
      (failure as AggregateError).message,
      /^Development Container capability docker-client.*permission denied/u,
    );
    assert.ok(
      (failure as AggregateError).message.includes("cleanup daemon stopped"),
    );
    assert.strictEqual((failure as AggregateError).errors.length, 2);
  });

  void it("fails a successful scenario when cleanup fails", async () => {
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

    assert.ok(failure instanceof AggregateError);
    assert.strictEqual(
      (failure as AggregateError).message,
      "Development Container Fixture cleanup failed",
    );
    const cleanupErrors = (failure as AggregateError).errors;
    assert.strictEqual(cleanupErrors.length, 1);
    const cleanupError = cleanupErrors[0]!;
    assert.ok(typeof cleanupError === "object" && cleanupError !== null);
    assert.ok(Object.hasOwn(cleanupError, "message"));
    assert.strictEqual(
      Reflect.get(cleanupError, "message"),
      "cleanup daemon stopped",
    );
  });

  void it("attributes dependency preparation failures and still cleans up", async () => {
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
      await assert.rejects(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        (error) =>
          error instanceof Error &&
          /Dependency preparation failed during pnpm fetch.*registry unavailable/u.test(
            error.message,
          ),
      );
    } finally {
      await session.close();
    }

    assert.strictEqual(
      calls.some(
        ({ command, args }) =>
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("check"),
      ),
      false,
    );
    assert.deepStrictEqual(
      calls
        .filter(
          ({ command, args }) =>
            (command === "docker" && args[0] === "ps") ||
            (command === "devcontainer" && args[0] === "down"),
        )
        .map(({ command, args }) => [command, ...args]),
      [["docker", "ps", "-aq", "--filter", `label=${idLabel}`]],
    );
  });

  for (const scenario of [
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
  ] as const) {
    void it(`reports a clear ${scenario.unavailable} prerequisite error without host fallback`, async () => {
      const { unavailable, expected, expectedCalls } = scenario;
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
        await assert.rejects(
          session.run("pnpm", ["run", "check"], { cwd: projectDir }),
          expected,
        );
      } finally {
        await session.close();
      }

      assert.deepStrictEqual(
        calls.map(({ command, args }) => [command, ...args]),
        expectedCalls,
      );
      assert.strictEqual(
        calls.some(({ command }) => command === "pnpm"),
        false,
      );
      assert.strictEqual(
        calls.some(
          ({ command, args }) => command === "devcontainer" && args[0] === "up",
        ),
        false,
      );
    });
  }

  void it("removes the labeled container and exactly the declared scenario volumes after a command failure", async () => {
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
      await assert.rejects(
        session.run("pnpm", ["run", "check"], { cwd: projectDir }),
        (error) =>
          error instanceof Error && error.message.includes("Root Check failed"),
      );
    } finally {
      await session.close();
    }

    assert.deepStrictEqual(
      calls
        .filter(
          ({ command, args }) =>
            command === "docker" &&
            (args[0] === "ps" || args[0] === "rm" || args[0] === "volume"),
        )
        .map(({ command, args }) => [command, ...args]),
      [
        ["docker", "ps", "-aq", "--filter", `label=${idLabel}`],
        ["docker", "rm", "-f", "fixture-command-failure"],
        [
          "docker",
          "volume",
          "rm",
          "template-fixture-command-failure-workspace",
        ],
        ["docker", "volume", "rm", "template-fixture-command-failure-state"],
      ],
    );
    assert.strictEqual(
      calls.some(
        ({ command, args }) => command === "devcontainer" && args[0] === "down",
      ),
      false,
    );
    assert.strictEqual(
      calls.some(({ args }) => args.includes("prune")),
      false,
    );
  });

  void it("preserves an in-repository command working directory inside the container", async () => {
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

    assert.deepStrictEqual(
      calls.find(
        ({ command, args }) =>
          command === "devcontainer" &&
          args[0] === "exec" &&
          args.includes("probe.mjs"),
      )?.args,
      [
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
      ],
    );
  });

  void it("forwards only the Turbo cache environment whitelist to container commands", async () => {
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
    assert.ok(execCall);
    for (const expectedArgument of [
      "--remote-env",
      "TURBO_TEAM=fixture-team",
      "TURBO_TOKEN=fixture-token",
      "TURBO_REMOTE_CACHE_SIGNATURE_KEY=fixture-signature",
      "TURBO_REMOTE_CACHE_READ_ONLY=true",
    ]) {
      assert.ok(execCall.args.includes(expectedArgument));
    }
    assert.ok(
      execCall.args.some((argument) =>
        /^TURBO_CACHE_DIR=\/tmp\/template-turbo-cache-/u.test(argument),
      ),
    );
    assert.ok(!execCall?.args.join("\n").includes("UNRELATED_SECRET"));
    assert.ok(
      !calls
        .filter(
          ({ command, args }) =>
            command === "devcontainer" && args[0] !== "exec",
        )
        .flatMap(({ args }) => args)
        .includes("fixture-token"),
    );
  });

  void it("redacts forwarded Turbo secrets from propagated failures and activity records", async () => {
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

      assert.ok(propagated instanceof Error);
      const propagatedText =
        propagated instanceof Error
          ? `${propagated.message}\n${propagated.stack ?? ""}`
          : String(propagated);
      const activityText = await readFile(
        path.join(activityRoot, "activity.jsonl"),
        "utf8",
      );
      assert.ok(`${propagatedText}\n${activityText}`.includes("[REDACTED]"));
      assert.ok(!`${propagatedText}\n${activityText}`.includes(turboToken));
      assert.ok(!`${propagatedText}\n${activityText}`.includes(signatureKey));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
