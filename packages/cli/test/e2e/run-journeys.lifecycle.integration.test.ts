import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const sourceE2eRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceCliRoot = path.resolve(sourceE2eRoot, "..", "..");

async function createRunnerFixture(): Promise<{
  readonly root: string;
  readonly runner: string;
  readonly journeyRoot: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "template-journey-lifecycle-"),
  );
  const cliRoot = path.join(root, "packages", "cli");
  const e2eRoot = path.join(cliRoot, "test", "e2e");
  const journeyRoot = path.join(e2eRoot, "journeys");
  await mkdir(journeyRoot, { recursive: true });
  await symlink(
    path.join(sourceCliRoot, "node_modules"),
    path.join(cliRoot, "node_modules"),
    "dir",
  );
  await Promise.all(
    ["run-journeys.ts", "journey.ts"].map((fileName) =>
      cp(path.join(sourceE2eRoot, fileName), path.join(e2eRoot, fileName)),
    ),
  );
  return {
    root,
    runner: path.join(e2eRoot, "run-journeys.ts"),
    journeyRoot,
  };
}

function startRunner(
  fixture: Awaited<ReturnType<typeof createRunnerFixture>>,
  options: {
    readonly diagnosticsRoot: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly cancelSignal?: AbortSignal;
    readonly timeout?: number;
    readonly killDescendants?: boolean;
  },
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TEMPLATE_CLI_JOURNEY_MODE: "packed",
    TEMPLATE_CLI_PACKED_BIN: process.execPath,
    TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR: options.diagnosticsRoot,
    ...options.environment,
  };
  delete environment.NODE_TEST_CONTEXT;
  return execa(
    process.execPath,
    ["--conditions=source", "--test", "--test-reporter=tap", fixture.runner],
    {
      cwd: fixture.root,
      env: environment,
      extendEnv: false,
      reject: false,
      timeout: options.timeout ?? 15000,
      ...(options.cancelSignal === undefined
        ? {}
        : { cancelSignal: options.cancelSignal }),
      killDescendants: options.killDescendants ?? true,
      forceKillAfterDelay: 2000,
    },
  );
}

async function runRunner(
  fixture: Awaited<ReturnType<typeof createRunnerFixture>>,
  options: Parameters<typeof startRunner>[1],
) {
  return await startRunner(fixture, options);
}

function diagnosticsPath(output: string): string {
  const pathFromOutput = output.match(/CLI_JOURNEY_DIAGNOSTICS=(.+)/u)?.[1];
  assert.ok(pathFromOutput, output);
  return pathFromOutput;
}

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await delay(25);
    }
  }
  throw new Error(`等待文件超时：${filePath}`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") {
    try {
      const status = await readFile(`/proc/${pid}/stat`, "utf8");
      if (status.slice(status.lastIndexOf(")") + 2).startsWith("Z "))
        return false;
    } catch {
      // The process table is not exposed on every supported platform.
    }
  }
  return true;
}

async function assertProcessesStopped(pids: readonly number[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await Promise.all(pids.map(processIsAlive));
    if (alive.every((isAlive) => !isAlive)) return;
    await delay(30);
  }
  const alivePids = await Promise.all(
    pids.map(async (pid) => ((await processIsAlive(pid)) ? pid : undefined)),
  );
  assert.deepStrictEqual(
    alivePids.filter((pid) => pid !== undefined),
    [],
  );
}

function longRunningCommandJourney(options: {
  readonly timeoutMs?: number;
  readonly cleanupAfterSignal?: boolean;
}): string {
  const childSource = [
    'import { spawn } from "node:child_process";',
    'import { writeFile } from "node:fs/promises";',
    'const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000)"]);',
    ...(options.cleanupAfterSignal
      ? [
          "const keepAlive = setInterval(() => {}, 1000);",
          'process.on("SIGTERM", () => {',
          "  clearInterval(keepAlive);",
          '  setTimeout(async () => { await writeFile("async-cleanup.txt", "completed\\n"); process.exit(0); }, 200);',
          "});",
        ]
      : []),
    "await writeFile(process.env.TEMPLATE_TEST_PID_FILE, `${process.pid}\\n${child.pid}\\n`);",
    ...(options.cleanupAfterSignal ? [] : ["setInterval(() => {}, 1000);"]),
  ].join(" ");
  return [
    'import type { CliJourney } from "../journey.ts";',
    "const journey: CliJourney = {",
    '  name: "owned-process",',
    '  modes: ["packed"],',
    ...(options.timeoutMs === undefined
      ? []
      : [`  timeoutMs: ${options.timeoutMs},`]),
    "  async setup() {},",
    "  commands() {",
    "    return [{",
    '      name: "long child tree",',
    "      executable: process.execPath,",
    `      args: ["--input-type=module", "-e", ${JSON.stringify(childSource)}],`,
    ...(options.timeoutMs === undefined ? ["      timeoutMs: 800,"] : []),
    "    }];",
    "  },",
    '  async assertions() { throw new Error("长时间运行的命令意外完成"); },',
    "};",
    "export default journey;",
  ].join("\n");
}

async function removeFixture(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

void test(
  "断言失败退出后仍可读取旅程生成的文件",
  { timeout: 30000 },
  async () => {
    const fixture = await createRunnerFixture();
    const diagnosticsRoot = path.join(fixture.root, "ci-workspace");
    try {
      await writeFile(
        path.join(fixture.journeyRoot, "retained.journey.ts"),
        [
          'import { writeFile } from "node:fs/promises";',
          'import path from "node:path";',
          'import type { CliJourney } from "../journey.ts";',
          "const journey: CliJourney = {",
          '  name: "retained",',
          '  modes: ["packed"],',
          "  async setup(context) {",
          '    await writeFile(path.join(context.workDir, "generated.txt"), "kept after failure\\n");',
          "  },",
          "  commands() { return []; },",
          '  async assertions() { throw new Error("注入的旅程断言失败"); },',
          "};",
          "export default journey;",
        ].join("\n"),
      );
      const run = await runRunner(fixture, { diagnosticsRoot });
      const output = `${run.stdout}\n${run.stderr}`;
      assert.notStrictEqual(run.exitCode, 0, output);
      const diagnostics = diagnosticsPath(output);
      const report = JSON.parse(
        await readFile(path.join(diagnostics, "journey-report.json"), "utf8"),
      ) as {
        readonly error: {
          readonly cause: { readonly message: string };
        };
      };
      assert.strictEqual(report.error.cause.message, "注入的旅程断言失败");
      assert.strictEqual(
        await readFile(
          path.join(diagnostics, "workspace", "generated.txt"),
          "utf8",
        ),
        "kept after failure\n",
      );
    } finally {
      await removeFixture(fixture.root);
    }
  },
);

void test("所选模式没有匹配旅程时验收失败", { timeout: 15000 }, async () => {
  const fixture = await createRunnerFixture();
  try {
    const run = await runRunner(fixture, {
      diagnosticsRoot: path.join(fixture.root, "ci-workspace"),
    });
    assert.notStrictEqual(run.exitCode, 0);
    assert.match(
      `${run.stdout}\n${run.stderr}`,
      /模式 packed 没有可运行的 CLI 旅程/u,
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

void test(
  "命令超时会结束所属进程树并保留失败现场",
  { timeout: 15000 },
  async () => {
    const fixture = await createRunnerFixture();
    const pidFile = path.join(fixture.root, "owned-pids.txt");
    try {
      await writeFile(
        path.join(fixture.journeyRoot, "owned-process.journey.ts"),
        longRunningCommandJourney({}),
      );
      const run = await runRunner(fixture, {
        diagnosticsRoot: path.join(fixture.root, "ci-workspace"),
        environment: { TEMPLATE_TEST_PID_FILE: pidFile },
      });
      const output = `${run.stdout}\n${run.stderr}`;
      assert.notStrictEqual(run.exitCode, 0, output);
      const diagnostics = diagnosticsPath(output);
      const report = JSON.parse(
        await readFile(path.join(diagnostics, "journey-report.json"), "utf8"),
      ) as {
        readonly error: {
          readonly cause: { readonly timedOut: boolean };
        };
      };
      assert.strictEqual(report.error.cause.timedOut, true);
      const pids = (await waitForFile(pidFile)).trim().split("\n").map(Number);
      assert.strictEqual(pids.length, 2);
      await assertProcessesStopped(pids);
    } finally {
      await removeFixture(fixture.root);
    }
  },
);

void test(
  "SIGTERM 会取消旅程并等待所属进程异步清理",
  { timeout: 20000 },
  async () => {
    const fixture = await createRunnerFixture();
    const pidFile = path.join(fixture.root, "owned-pids.txt");
    const workerPidFile = path.join(fixture.root, "worker.pid");
    let ownedPids: number[] = [];
    try {
      await writeFile(
        path.join(fixture.journeyRoot, "owned-process.journey.ts"),
        longRunningCommandJourney({
          timeoutMs: 12000,
          cleanupAfterSignal: true,
        }),
      );
      const runnerProcess = startRunner(fixture, {
        diagnosticsRoot: path.join(fixture.root, "ci-workspace"),
        environment: {
          TEMPLATE_TEST_PID_FILE: pidFile,
          TEMPLATE_CLI_JOURNEY_WORKER_PID_FILE: workerPidFile,
        },
        timeout: 15000,
        killDescendants: false,
      });
      ownedPids = (await waitForFile(pidFile)).trim().split("\n").map(Number);
      const workerPid = Number((await waitForFile(workerPidFile)).trim());
      process.kill(workerPid, "SIGTERM");
      const run = await runnerProcess;
      const output = `${run.stdout}\n${run.stderr}`;
      assert.notStrictEqual(run.exitCode, 0, output);
      const diagnostics = diagnosticsPath(output);
      const report = JSON.parse(
        await readFile(path.join(diagnostics, "journey-report.json"), "utf8"),
      ) as {
        readonly error: {
          readonly cause: { readonly isCanceled: boolean };
        };
      };
      assert.strictEqual(report.error.cause.isCanceled, true);
      assert.strictEqual(
        await readFile(
          path.join(diagnostics, "workspace", "async-cleanup.txt"),
          "utf8",
        ),
        "completed\n",
      );
      await assertProcessesStopped(ownedPids);
    } finally {
      for (const pid of ownedPids) {
        if (await processIsAlive(pid)) process.kill(pid, "SIGKILL");
      }
      await removeFixture(fixture.root);
    }
  },
);
