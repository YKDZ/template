import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import {
  createDevelopmentContainerSession,
  type ContainerCommandRunner,
} from "@ykdz/template-verification-runtime/development-container-session";
import { execa } from "execa";

import {
  generatedScenariosFor,
  runGeneratedRegistryCli,
  type GeneratedCommandRunner,
} from "../src/check-generated-registry.ts";
import {
  createFixtureEvidenceScheduler,
  runFixtureEvidenceGate,
  type FixtureEvidenceLifecycleEvent,
  type FixtureEvidenceSchedulerFactory,
  type FixtureEvidenceStorage,
} from "../src/fixture-evidence/kernel/index.ts";

function hasCause(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((nested) => hasCause(nested, expected))
  ) {
    return true;
  }
  return error instanceof Error && hasCause(error.cause, expected);
}

function hasErrorMessage(error: unknown, expected: string): boolean {
  if (
    error instanceof AggregateError &&
    error.errors.some((nested) => hasErrorMessage(nested, expected))
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.message.includes(expected) || hasErrorMessage(error.cause, expected))
  );
}

void it("部分启动失败后先恢复属主，再移除所属容器", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-partial-up-owner-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  const startupCause = new Error("devcontainer up cause");
  const startupFailure = new Error("partial devcontainer up failed", {
    cause: startupCause,
  });
  const events: string[] = [];
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    run: async (command, args) => {
      if (command === "devcontainer" && args[0] === "up") {
        throw startupFailure;
      }
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "partial-up-container\n" };
      }
      if (
        command === "devcontainer" &&
        args[0] === "exec" &&
        args.includes("chown")
      ) {
        events.push("restore-owner");
        assert.equal(
          args.at(-2),
          `${process.getuid?.()}:${process.getgid?.()}`,
        );
      }
      if (command === "docker" && args[0] === "rm") {
        events.push("remove-container");
      }
      return {};
    },
  });

  try {
    const failure = await session
      .execute(async (run) => {
        await run("pnpm", ["run", "check:full"], { cwd: projectDir });
      })
      .catch((error: unknown) => error);

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /^partial devcontainer up failed/u);
    assert.match(failure.message, /devcontainer up cause/u);
    assert.deepStrictEqual(events, ["restore-owner", "remove-container"]);

    await session.close();
    assert.deepStrictEqual(events, ["restore-owner", "remove-container"]);
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("清理时首次恢复属主失败后，execute 重试成功再移除容器", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-owner-retry-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  const operationFailure = new Error("fixture operation failed");
  const restoreFailure = new Error("owner restore failed once");
  const events: string[] = [];
  let restoreAttempts = 0;
  let removeAttempts = 0;
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    run: async (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "owned-fixture-container\n" };
      }
      if (
        command === "devcontainer" &&
        args[0] === "exec" &&
        args.includes("chown")
      ) {
        restoreAttempts += 1;
        events.push(`restore-${restoreAttempts}`);
        if (restoreAttempts === 1) throw restoreFailure;
      }
      if (command === "docker" && args[0] === "rm") {
        removeAttempts += 1;
        events.push("remove-container");
      }
      return {};
    },
  });

  try {
    const failure = await session
      .execute(async (run) => {
        await run("pnpm", ["run", "check:full"], { cwd: projectDir });
        throw operationFailure;
      })
      .catch((error: unknown) => error);

    assert.ok(failure instanceof AggregateError);
    assert.ok(hasCause(failure, operationFailure));
    assert.match(failure.message, /owner restore failed once/u);
    assert.deepStrictEqual(events, [
      "restore-1",
      "restore-2",
      "remove-container",
    ]);
    assert.equal(restoreAttempts, 2);
    assert.equal(removeAttempts, 1);
    await session.close();
    assert.deepStrictEqual(events, [
      "restore-1",
      "restore-2",
      "remove-container",
    ]);
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("连续恢复属主失败时保留容器并允许显式 close 再试", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-owner-persistent-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  const operationFailure = new Error("fixture operation failed");
  const restoreFailure = new Error("owner restore remains unavailable");
  const events: string[] = [];
  let restoreAttempts = 0;
  let removeAttempts = 0;
  let allowRestore = false;
  let notifiedCleanupFailure: unknown;
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    onCleanupFailure: (error) => {
      notifiedCleanupFailure = error;
    },
    run: async (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "owned-fixture-container\n" };
      }
      if (
        command === "devcontainer" &&
        args[0] === "exec" &&
        args.includes("chown")
      ) {
        restoreAttempts += 1;
        events.push(`restore-${restoreAttempts}`);
        if (!allowRestore) throw restoreFailure;
      }
      if (command === "docker" && args[0] === "rm") {
        removeAttempts += 1;
        events.push("remove-container");
      }
      return {};
    },
  });

  try {
    const failure = await session
      .execute(async (run) => {
        await run("pnpm", ["run", "check:full"], { cwd: projectDir });
        throw operationFailure;
      })
      .catch((error: unknown) => error);

    assert.ok(failure instanceof AggregateError);
    assert.ok(hasCause(failure, operationFailure));
    assert.ok(hasErrorMessage(failure, "owner restore remains unavailable"));
    assert.match(failure.message, /清理未完成/u);
    assert.ok(notifiedCleanupFailure instanceof AggregateError);
    assert.ok(hasErrorMessage(notifiedCleanupFailure, "清理未完成"));
    assert.deepStrictEqual(events, ["restore-1", "restore-2"]);
    assert.equal(removeAttempts, 0);

    allowRestore = true;
    await session.close();
    assert.deepStrictEqual(events, [
      "restore-1",
      "restore-2",
      "restore-3",
      "remove-container",
    ]);
    assert.equal(removeAttempts, 1);

    await session.close();
    assert.deepStrictEqual(events, [
      "restore-1",
      "restore-2",
      "restore-3",
      "remove-container",
    ]);
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("retries owned container cleanup when close is called again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-cleanup-retry-"));
  const projectDir = path.join(root, "project");
  let removeAttempts = 0;
  const devcontainerTempDirectories: string[] = [];
  const calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
  }> = [];
  const run: ContainerCommandRunner = async (command, args, options) => {
    calls.push({ command, args });
    if (command === "devcontainer") {
      const tempDirectory = options.env?.TMPDIR;
      assert.ok(tempDirectory);
      await stat(tempDirectory);
      devcontainerTempDirectories.push(tempDirectory);
    }
    if (command === "docker" && args[0] === "ps") {
      return { stdout: "owned-fixture-container\n" };
    }
    if (command === "docker" && args[0] === "rm") {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        throw new Error("Docker daemon is temporarily unavailable");
      }
    }
    return {};
  };
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    run,
  });

  try {
    await session.prepare();
    await assert.rejects(session.close(), /cleanup failed/u);
    await session.close();

    assert.equal(removeAttempts, 2);
    assert.equal(
      calls.filter(
        ({ command, args }) => command === "docker" && args[0] === "ps",
      ).length,
      2,
    );
    assert.equal(new Set(devcontainerTempDirectories).size, 1);
    await assert.rejects(stat(devcontainerTempDirectories[0]!));
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("cancels a running container command and still removes its container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-cancel-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  const controller = new AbortController();
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const cleanupSignals: AbortSignal[] = [];
  const calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
  }> = [];
  const run: ContainerCommandRunner = async (command, args, options) => {
    calls.push({ command, args });
    if (
      command === "devcontainer" &&
      args[0] === "exec" &&
      args.includes("check:full")
    ) {
      commandStarted();
      return await new Promise<never>((_resolve, reject) => {
        options.cancelSignal?.addEventListener(
          "abort",
          () => reject(options.cancelSignal?.reason),
          { once: true },
        );
      });
    }
    if (command === "docker" && args[0] === "ps") {
      cleanupSignals.push(options.cancelSignal!);
      return { stdout: "owned-fixture-container\n" };
    }
    return {};
  };
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    cancelSignal: controller.signal,
    run,
  });

  try {
    const execution = session.execute(async (runCommand) => {
      await runCommand("pnpm", ["run", "check:full"], { cwd: projectDir });
    });
    await started;
    const cancellation = new Error("Fixture cancelled by SIGINT");
    controller.abort(cancellation);

    await assert.rejects(execution, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cancelled/u);
      assert.equal(hasCause(error, cancellation), true);
      return true;
    });
    assert.equal(
      calls.some(
        ({ command, args }) =>
          command === "docker" &&
          args[0] === "rm" &&
          args.includes("owned-fixture-container"),
      ),
      true,
    );
    assert.equal(cleanupSignals.length, 1);
    assert.notEqual(cleanupSignals[0], controller.signal);
    assert.equal(cleanupSignals[0]?.aborted, false);
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("times out a hung container command and waits for owned resource cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixture-timeout-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  let removeAttempted = false;
  const run: ContainerCommandRunner = async (command, args, options) => {
    if (
      command === "devcontainer" &&
      args[0] === "exec" &&
      args.includes("check:full")
    ) {
      return await execa(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60_000)"],
        {
          cwd: options.cwd,
          ...(options.timeout === undefined
            ? {}
            : { timeout: options.timeout }),
          ...(options.cancelSignal === undefined
            ? {}
            : { cancelSignal: options.cancelSignal }),
          ...(options.killDescendants === undefined
            ? {}
            : { killDescendants: options.killDescendants }),
        },
      );
    }
    if (command === "docker" && args[0] === "ps") {
      return { stdout: "owned-fixture-container\n" };
    }
    if (command === "docker" && args[0] === "rm") removeAttempted = true;
    return {};
  };
  const session = createDevelopmentContainerSession({
    projectDir,
    probes: [],
    commandTimeoutMilliseconds: 25,
    run,
  });

  try {
    await assert.rejects(
      session.execute(async (runCommand) => {
        await runCommand("pnpm", ["run", "check:full"], { cwd: projectDir });
      }),
      /timed out/u,
    );
    assert.equal(removeAttempted, true);
  } finally {
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void it("cancels a queued Fixture session without reserving capacity afterward", async () => {
  const scheduler = createFixtureEvidenceScheduler({
    concurrency: 1,
    developmentContainerSessions: 1,
  });
  const resource = ["development-container-session"] as const;
  const release = await scheduler.acquire(resource);
  const controller = new AbortController();
  const cancellation = new Error("Fixture queue cancelled");
  const waiting = scheduler.acquire(resource, {
    cancelSignal: controller.signal,
  });
  controller.abort(cancellation);

  await assert.rejects(waiting, (error: unknown) => error === cancellation);
  release();
  const afterCancellation = await scheduler.acquire(resource);
  afterCancellation();
});

void it("does not issue evidence when cancellation arrives after semantic execution", async () => {
  const controller = new AbortController();
  const cancellation = new Error("Fixture cancelled before evidence issuance");
  let writes = 0;
  const events: FixtureEvidenceLifecycleEvent[] = [];
  const storage: FixtureEvidenceStorage = {
    read: async () => undefined,
    writeAtomically: async () => {
      writes += 1;
    },
  };

  await assert.rejects(
    runFixtureEvidenceGate({
      gate: "generated-root-quality",
      generatedContentIdentity: "1".repeat(40),
      contractIdentity: "2".repeat(64),
      scenario: {
        id: "cancel-before-issuance",
        label: "cancel before issuance",
        presetIdentities: [],
      },
      producerCommit: "test",
      storage,
      writeEnabled: true,
      cancelSignal: controller.signal,
      recordLifecycle: (event) => {
        events.push(event);
      },
      execute: async () => {
        controller.abort(cancellation);
      },
    }),
    (error: unknown) => error === cancellation,
  );

  assert.equal(writes, 0);
  assert.equal(
    events.some(
      (event) => event.type === "issuance" && event.outcome === "issued",
    ),
    false,
  );
});

void it(
  "rejects a queued session after cleanup fails and holds capacity for a close retry",
  { timeout: 2_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fixture-cleanup-queue-"));
    const firstProject = path.join(root, "first");
    const secondProject = path.join(root, "second");
    await Promise.all([
      mkdir(firstProject, { recursive: true }),
      mkdir(secondProject, { recursive: true }),
    ]);
    const scheduler = createFixtureEvidenceScheduler({
      concurrency: 1,
      developmentContainerSessions: 1,
    });
    let removeAttempts = 0;
    const cancellation = new AbortController();
    let cleanupFailure: unknown;
    let secondRunnerCalls = 0;
    const first = createDevelopmentContainerSession({
      projectDir: firstProject,
      probes: [],
      cancelSignal: cancellation.signal,
      onCleanupFailure: (error) => {
        cleanupFailure = error;
        cancellation.abort(error);
      },
      acquireSession: async (cancelSignal) =>
        await scheduler.acquire(
          ["development-container-session"],
          cancelSignal === undefined ? undefined : { cancelSignal },
        ),
      run: async (command, args) => {
        if (command === "docker" && args[0] === "ps") {
          return { stdout: "owned-fixture-container\n" };
        }
        if (command === "docker" && args[0] === "rm") {
          removeAttempts += 1;
          if (removeAttempts <= 2) {
            throw new Error("Docker daemon is temporarily unavailable");
          }
        }
        return {};
      },
    });
    const second = createDevelopmentContainerSession({
      projectDir: secondProject,
      probes: [],
      cancelSignal: cancellation.signal,
      acquireSession: async (cancelSignal) =>
        await scheduler.acquire(
          ["development-container-session"],
          cancelSignal === undefined ? undefined : { cancelSignal },
        ),
      run: async (command, args) => {
        secondRunnerCalls += 1;
        return command === "docker" && args[0] === "ps" ? { stdout: "" } : {};
      },
    });

    try {
      await first.prepare();
      const secondPreparation = second.prepare();
      await assert.rejects(
        first.execute(async () => {
          throw new Error("scenario failed");
        }),
        (error: unknown) => {
          assert.ok(
            error instanceof AggregateError,
            `Unexpected cancellation error: ${error instanceof Error ? error.stack : String(error)}`,
          );
          assert.match(error.message, /scenario failed/u);
          return true;
        },
      );
      await assert.rejects(secondPreparation, (error: unknown) => {
        assert.equal(error, cleanupFailure);
        return true;
      });
      assert.equal(secondRunnerCalls, 0);
      assert.equal(removeAttempts, 2);
      await first.close();
      assert.equal(removeAttempts, 3);
    } finally {
      await Promise.all([
        first.close().catch(() => undefined),
        second.close().catch(() => undefined),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

void it(
  "keeps active command output when an earlier generated scenario is queued at cancellation",
  { timeout: 45_000 },
  async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "fixture-cli-queued-cancellation-"),
    );
    const controller = new AbortController();
    const cancellation = new Error(
      "Fixture CLI cancelled while scenarios were queued",
    );
    const scenarios = await generatedScenariosFor("init");
    const [firstScenario, secondScenario] = scenarios;
    assert.ok(firstScenario);
    assert.ok(secondScenario);

    let firstSessionQueued!: () => void;
    let secondSessionQueued!: () => void;
    const firstSessionQueuedPromise = new Promise<void>((resolve) => {
      firstSessionQueued = resolve;
    });
    const secondSessionQueuedPromise = new Promise<void>((resolve) => {
      secondSessionQueued = resolve;
    });
    let acquisitionCount = 0;
    const waitForCancellation = (
      signal: AbortSignal | undefined,
    ): Promise<never> =>
      new Promise((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("Fixture scheduler did not receive cancellation"));
        } else if (signal.aborted) {
          reject(signal.reason);
        } else {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }
      });
    const schedulerFactory: FixtureEvidenceSchedulerFactory = () => ({
      acquire: async (_resources, options) => {
        acquisitionCount += 1;
        if (acquisitionCount === 1) {
          firstSessionQueued();
          return await waitForCancellation(options?.cancelSignal);
        }
        if (acquisitionCount === 2) {
          secondSessionQueued();
          return () => undefined;
        }
        return await waitForCancellation(options?.cancelSignal);
      },
      run: async (_resources, execute) => await execute(),
    });
    let activeCommandOutputSeen = false;
    const run: GeneratedCommandRunner = (command, args, options) => {
      const scenarioIndex = scenarios.findIndex(
        (scenario) => scenario.id === path.basename(options.cwd ?? ""),
      );
      if (command === "git") {
        const result =
          args[0] === "write-tree" ? { stdout: "a".repeat(40) } : {};
        if (scenarioIndex === 0) return Promise.resolve(result);
        const release =
          scenarioIndex === 1
            ? firstSessionQueuedPromise
            : secondSessionQueuedPromise;
        return release.then(() => result);
      }
      const nodeIndex = args.indexOf("node");
      if (
        command === "devcontainer" &&
        args[0] === "exec" &&
        nodeIndex >= 0 &&
        args[nodeIndex + 1] === "--conditions=source" &&
        args[nodeIndex + 2] === "scripts/task-gates.ts" &&
        args[nodeIndex + 3] === "check" &&
        scenarioIndex === 1
      ) {
        const activeCommand = execa(
          process.execPath,
          [
            "-e",
            'process.stdout.write("fixture-active-command-output\\n"); setInterval(() => {}, 1_000)',
          ],
          {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            cancelSignal: options.cancelSignal ?? controller.signal,
          },
        );
        activeCommand.stdout?.once("data", () => {
          activeCommandOutputSeen = true;
          controller.abort(cancellation);
        });
        return activeCommand;
      }
      return Promise.resolve({});
    };

    try {
      let cliFailure: unknown;
      await assert.rejects(
        runGeneratedRegistryCli({
          scenarioSet: "init",
          environment: {
            TEMPLATE_FIXTURE_WORKSPACE_DIR: workspaceRoot,
          },
          reporter: { info: () => undefined },
          schedulerFactory,
          cancelSignal: controller.signal,
          run,
        }),
        (error: unknown) => {
          cliFailure = error;
          return true;
        },
      );
      assert.equal(activeCommandOutputSeen, true);

      const [workspaceName] = await readdir(workspaceRoot);
      assert.ok(workspaceName);
      const reportText = await readFile(
        path.join(workspaceRoot, workspaceName, "fixture-failure.json"),
        "utf8",
      );
      const report = JSON.parse(reportText) as {
        readonly failure: {
          readonly name: string;
          readonly cause: { readonly message: string };
          readonly errors: readonly unknown[];
        };
      };
      const failureDescription = JSON.stringify(report.failure);
      assert.equal(
        report.failure.name,
        "AggregateError",
        `Failure report lost queued cancellation details: ${failureDescription}`,
      );
      assert.equal(report.failure.cause.message, cancellation.message);
      assert.ok(report.failure.errors.length > 0);
      assert.match(failureDescription, /fixture-active-command-output/u);
      assert.ok(cliFailure instanceof AggregateError);
      assert.equal(cliFailure.cause, cancellation);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

void it(
  "preserves a readable generated workspace and failure report after CLI cancellation",
  { timeout: 180_000 },
  async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "fixture-cli-cancellation-"),
    );
    const controller = new AbortController();
    const secret = "fixture-report-secret-marker";
    const cancellation = new Error(
      `Fixture CLI cancelled by caller: ${secret}`,
    );
    Object.assign(cancellation, {
      stdout: `native stdout contains ${secret}`,
      stderr: `native stderr contains ${secret}`,
    });
    const [scenario] = await generatedScenariosFor("init");
    assert.ok(scenario);
    const run: GeneratedCommandRunner = async (_command, _args, options) => {
      assert.ok(options.cancelSignal);
      assert.notEqual(options.cancelSignal, controller.signal);
      assert.equal(options.cancelSignal.aborted, false);
      controller.abort(cancellation);
      assert.equal(options.cancelSignal.aborted, true);
      assert.equal(options.cancelSignal.reason, cancellation);
      throw cancellation;
    };

    try {
      await assert.rejects(
        runGeneratedRegistryCli({
          scenarioSet: "init",
          environment: {
            TEMPLATE_FIXTURE_WORKSPACE_DIR: workspaceRoot,
            TEMPLATE_FIXTURE_TURBO_TOKEN: secret,
          },
          reporter: {
            info: (message) => {
              if (message.includes(" failed:")) {
                throw new Error("fixture reporter failed");
              }
            },
          },
          cancelSignal: controller.signal,
          run,
        }),
        (error: unknown) => {
          assert.equal(hasCause(error, cancellation), true);
          return true;
        },
      );

      const [workspaceName] = await readdir(workspaceRoot);
      assert.ok(workspaceName);
      const workspace = path.join(workspaceRoot, workspaceName);
      const reportText = await readFile(
        path.join(workspace, "fixture-failure.json"),
        "utf8",
      );
      const report = JSON.parse(reportText) as {
        readonly scenarioSet: string;
        readonly reproductionCommand: string;
        readonly generatedWorkspace: string;
        readonly failure: {
          readonly name: string;
          readonly message: string;
        };
      };
      assert.equal(report.scenarioSet, "init");
      assert.equal(
        report.reproductionCommand,
        "pnpm --filter @ykdz/template-checks check:generated",
      );
      assert.equal(report.generatedWorkspace, workspace);
      assert.match(report.failure.message, /\[REDACTED\]/u);
      if (report.failure.name === "AggregateError") {
        assert.match(reportText, /"errors": \[/u);
      }
      assert.match(reportText, /native stdout contains \[REDACTED\]/u);
      assert.match(reportText, /native stderr contains \[REDACTED\]/u);
      assert.equal(reportText.includes(secret), false);
      const generatedManifest = JSON.parse(
        await readFile(
          path.join(workspace, scenario.id, "package.json"),
          "utf8",
        ),
      ) as { readonly name: string };
      assert.ok(generatedManifest.name.length > 0);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

void it(
  "handles operating-system interrupts through the official Fixture CLI",
  { timeout: 180_000 },
  async () => {
    for (const [signal, expectedExitCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), `fixture-cli-${signal.toLowerCase()}-`),
      );
      const workspaceRoot = path.join(temporaryRoot, "workspaces");
      const binDirectory = path.join(temporaryRoot, "bin");
      const markerPath = path.join(temporaryRoot, "command-started");
      await Promise.all([
        mkdir(workspaceRoot, { recursive: true }),
        mkdir(binDirectory, { recursive: true }),
      ]);
      const gitPath = path.join(binDirectory, "git");
      await writeFile(
        gitPath,
        `#!${process.execPath}\nrequire("node:fs").writeSync(1, "fixture-native-stdout\\n");\nsetTimeout(() => {\n  require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));\n  setInterval(() => {}, 1_000);\n}, 250);\n`,
      );
      await chmod(gitPath, 0o755);

      let stdout = "";
      let stderr = "";
      let ownedCommandPid: number | undefined;
      const cliEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        TEMPLATE_FIXTURE_WORKSPACE_DIR: workspaceRoot,
      };
      for (const name of [
        "TEMPLATE_FIXTURE_EVIDENCE_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_READ",
        "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
        "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
      ]) {
        delete cliEnvironment[name];
      }
      const cli = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--experimental-strip-types",
          path.resolve("src/check-generated-registry.ts"),
          "init",
        ],
        {
          cwd: process.cwd(),
          env: cliEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      cli.stdout.setEncoding("utf8");
      cli.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      cli.stderr.setEncoding("utf8");
      cli.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const processExit = new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        cli.once("error", reject);
        cli.once("exit", (code, receivedSignal) => {
          resolve({ code, signal: receivedSignal });
        });
      });

      try {
        let commandStarted = false;
        const deadline = Date.now() + 30_000;
        while (!commandStarted && Date.now() < deadline) {
          try {
            const marker = await readFile(markerPath, "utf8");
            ownedCommandPid = Number(marker);
            commandStarted = Number.isSafeInteger(ownedCommandPid);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            ) {
              throw error;
            }
          }
          if (!commandStarted) {
            assert.equal(
              cli.exitCode,
              null,
              `Fixture CLI exited before the command started: ${stderr}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        assert.equal(
          commandStarted,
          true,
          `Fixture CLI did not start git: ${stderr}`,
        );
        assert.ok(ownedCommandPid);
        assert.equal(cli.kill(signal), true);

        const result = await processExit;
        assert.equal(result.code, expectedExitCode, stderr);
        assert.equal(result.signal, null);
        assert.match(stderr, new RegExp(`cancelled by ${signal}`, "u"));
        assert.match(stdout, /Failure report: .*fixture-failure\.json/u);
        let ownedCommandExited = false;
        const childExitDeadline = Date.now() + 5_000;
        while (!ownedCommandExited && Date.now() < childExitDeadline) {
          try {
            process.kill(ownedCommandPid, 0);
          } catch (error) {
            ownedCommandExited =
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH";
          }
          if (!ownedCommandExited) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        assert.equal(ownedCommandExited, true);

        const [workspaceName] = await readdir(workspaceRoot);
        assert.ok(workspaceName);
        const workspace = path.join(workspaceRoot, workspaceName);
        const reportText = await readFile(
          path.join(workspace, "fixture-failure.json"),
          "utf8",
        );
        const report = JSON.parse(reportText) as {
          readonly generatedWorkspace: string;
          readonly failure: unknown;
        };
        assert.equal(report.generatedWorkspace, workspace);
        const failureDescription = JSON.stringify(report.failure);
        assert.match(failureDescription, /FixtureCliCancellationError/u);
        assert.match(
          failureDescription,
          new RegExp(`cancelled by ${signal}`, "u"),
        );
        assert.match(failureDescription, /fixture-native-stdout/u);
        const [scenarioDirectory] = await readdir(workspace, {
          withFileTypes: true,
        }).then((entries) =>
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        );
        assert.ok(scenarioDirectory);
        const generatedManifest = JSON.parse(
          await readFile(
            path.join(workspace, scenarioDirectory, "package.json"),
            "utf8",
          ),
        ) as { readonly name: string };
        assert.ok(generatedManifest.name.length > 0);
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) {
          cli.kill("SIGKILL");
          await processExit.catch(() => undefined);
        }
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  },
);
