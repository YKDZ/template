import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  loadLocalTemplateMetadata,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  assertWorkflowContract,
  assertPublicationWorkflowContract,
} from "@ykdz/template-checks/workflow-contract";
import type { PackageRole } from "@ykdz/template-core/project-blueprint";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa as runExeca } from "execa";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const publicCliPackageName = ["@ykdz", "template"].join("/");
const journeyDiagnosticsRoot =
  process.env.TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR ?? tmpdir();
const packedDiagnosticExclusions = new Set([
  ".git",
  ".fixture-evidence",
  ".fixture-evidence-activity",
  ".fixture-native-cache",
  ".fixture-workspace",
  ".npm",
  ".pnpm-store",
  ".scratch",
  ".turbo",
  ".cache",
  ".cli-journey-diagnostics",
  "node_modules",
  "target",
]);

type ActivePackedRun = {
  archivePath?: string;
  readonly archiveWorkspace: string;
  workspace?: string;
  consumer?: string;
  readonly diagnostics: string;
  stage: string;
  workerPidFile?: string;
  stdoutPath?: string;
  stderrPath?: string;
  packedBin?: string;
  nativeParentPid?: number;
  signalRelay?: Promise<void>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
};

let preservePackedWorkspaceAfterSignal = false;
let activePackedRun: ActivePackedRun | undefined;
let receivedPackedSignal: NodeJS.Signals | undefined;
const packedJourneyKillGracePeriodMs = 10_000;
const packedJourneyTimeoutMs = 900_000;
const packedCancellationController = new AbortController();
const execa = runExeca({
  cancelSignal: packedCancellationController.signal,
  killDescendants: true,
  forceKillAfterDelay: packedJourneyKillGracePeriodMs,
});

function throwIfPackedCommandWasCancelled(
  result: { readonly isCanceled: boolean },
  commandDescription: string,
): void {
  if (!result.isCanceled && receivedPackedSignal === undefined) return;
  throw new Error(`packed 验收命令已取消：${commandDescription}`, {
    cause: packedCancellationController.signal.reason,
  });
}

function errorDetails(error: unknown, seen = new Set<unknown>()): unknown {
  if (error instanceof Error) {
    if (seen.has(error)) return { name: error.name, message: "[循环 cause]" };
    seen.add(error);
    const cause = "cause" in error ? error.cause : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...("exitCode" in error ? { exitCode: error.exitCode } : {}),
      ...("signal" in error ? { signal: error.signal } : {}),
      ...("timedOut" in error ? { timedOut: error.timedOut } : {}),
      ...("isCanceled" in error ? { isCanceled: error.isCanceled } : {}),
      ...(cause === undefined ? {} : { cause: errorDetails(cause, seen) }),
    };
  }
  if (typeof error === "string")
    return { name: "ThrownString", message: error };
  try {
    return { name: "ThrownValue", value: JSON.stringify(error) };
  } catch {
    return { name: "ThrownValue", value: String(error) };
  }
}

function copyDiagnosticPath(source: string, root: string): boolean {
  const relativePath = path.relative(root, source);
  if (
    relativePath
      .split(path.sep)
      .some((segment) => packedDiagnosticExclusions.has(segment))
  ) {
    return false;
  }
  return !/^packages\/[^/]+\/dist(?:\/|$)/u.test(
    relativePath.split(path.sep).join("/"),
  );
}

function packedReproduction(options: {
  readonly artifactRoot: string;
  readonly archivePath: string;
  readonly sourcePath: string;
  readonly consumerPath: string;
}): readonly string[] {
  return [
    `cd ${JSON.stringify(options.sourcePath)}`,
    "pnpm install --frozen-lockfile",
    `cd ${JSON.stringify(options.consumerPath)}`,
    `pnpm add ${JSON.stringify(options.archivePath)}`,
    `TEMPLATE_CLI_JOURNEY_MODE=packed TEMPLATE_CLI_PACKED_BIN="$(pwd)/node_modules/.bin/template" TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR=${JSON.stringify(options.artifactRoot)} node --conditions=source --test --test-reporter=tap ${JSON.stringify(path.join(options.sourcePath, "packages/cli/test/e2e/run-journeys.ts"))}`,
  ];
}

function readPackedRunnerWorkerPid(
  active: ActivePackedRun,
): number | undefined {
  if (active.workerPidFile === undefined) return undefined;
  try {
    const pid = Number(readFileSync(active.workerPidFile, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function relaySignalToPackedJourneyWorker(
  active: ActivePackedRun,
  signal: NodeJS.Signals,
): Promise<void> {
  active.signalRelay ??= (async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const pid = readPackedRunnerWorkerPid(active);
      if (pid !== undefined) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          ) {
            process.stderr.write(
              `无法向打包旅程 worker 转发 ${signal}：${String(error)}\n`,
            );
          }
        }
        active.forceKillTimer = setTimeout(() => {
          if (active.nativeParentPid === undefined) return;
          try {
            if (process.platform !== "win32") {
              process.kill(-active.nativeParentPid, "SIGKILL");
            } else {
              process.kill(active.nativeParentPid, "SIGKILL");
            }
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            ) {
              process.stderr.write(
                `无法在清理期限后结束打包旅程进程：${String(error)}\n`,
              );
            }
          }
        }, packedJourneyKillGracePeriodMs);
        return;
      }
      await delay(25);
    }
    if (active.nativeParentPid !== undefined) {
      try {
        if (process.platform !== "win32") {
          process.kill(-active.nativeParentPid, "SIGKILL");
        } else {
          process.kill(active.nativeParentPid, "SIGKILL");
        }
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          process.stderr.write(
            `无法结束未启动 worker 的打包旅程进程：${String(error)}\n`,
          );
        }
      }
    }
  })();
  return await active.signalRelay;
}

async function runPackedJourneyTests(options: {
  readonly active: ActivePackedRun;
  readonly consumer: string;
  readonly installedBin: string;
  readonly runnerPath?: string;
  readonly stageName?: string;
  readonly diagnosticsRoot?: string;
}): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  const active = options.active;
  const runner =
    options.runnerPath ??
    path.join(process.cwd(), "packages/cli/test/e2e/run-journeys.ts");
  const stageName = options.stageName ?? "packed-journeys";
  const outputDirectory = path.join(active.workspace!, stageName);
  await mkdir(outputDirectory, { recursive: true });
  const stdoutPath = path.join(outputDirectory, `${stageName}.stdout.tap`);
  const stderrPath = path.join(outputDirectory, `${stageName}.stderr.log`);
  const workerPidFile = path.join(outputDirectory, "journey-worker.pid");
  const stdoutDescriptor = openSync(stdoutPath, "w");
  const stderrDescriptor = openSync(stderrPath, "w");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TEMPLATE_CLI_JOURNEY_MODE: "packed",
    TEMPLATE_CLI_PACKED_BIN: options.installedBin,
    TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR:
      options.diagnosticsRoot ?? journeyDiagnosticsRoot,
    TEMPLATE_CLI_JOURNEY_WORKER_PID_FILE: workerPidFile,
  };
  delete environment.NODE_TEST_CONTEXT;
  active.stage = stageName;
  active.consumer = options.consumer;
  active.workerPidFile = workerPidFile;
  active.stdoutPath = stdoutPath;
  active.stderrPath = stderrPath;
  active.packedBin = options.installedBin;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      ["--conditions=source", "--test", "--test-reporter=tap", runner],
      {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
        detached: process.platform !== "win32",
      },
    );
  } finally {
    closeSync(stdoutDescriptor);
    closeSync(stderrDescriptor);
  }
  if (child.pid !== undefined) active.nativeParentPid = child.pid;

  if (receivedPackedSignal !== undefined) {
    void relaySignalToPackedJourneyWorker(active, receivedPackedSignal);
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void relaySignalToPackedJourneyWorker(active, "SIGTERM");
  }, packedJourneyTimeoutMs);
  try {
    const result = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    if (active.signalRelay !== undefined) await active.signalRelay;
    if (active.forceKillTimer !== undefined) {
      clearTimeout(active.forceKillTimer);
      delete active.forceKillTimer;
    }
    if (timedOut) {
      throw new Error("打包 CLI 旅程超过 15 分钟时限。", {
        cause: { ...result, timedOut: true },
      });
    }
    return result;
  } finally {
    clearTimeout(timeout);
    if (timedOut && active.forceKillTimer !== undefined) {
      clearTimeout(active.forceKillTimer);
      delete active.forceKillTimer;
    }
    if (active.workerPidFile !== undefined) {
      await rm(active.workerPidFile, { force: true });
      delete active.workerPidFile;
    }
    delete active.nativeParentPid;
  }
}

async function preservePackedFailure(options: {
  readonly archivePath?: string;
  readonly archiveWorkspace: string;
  readonly workspace: string;
  readonly error: unknown;
  readonly journeyOutput?: string;
  readonly journeyStderr?: string;
}): Promise<string> {
  await mkdir(journeyDiagnosticsRoot, { recursive: true });
  const diagnostics = await mkdtemp(
    path.join(journeyDiagnosticsRoot, "template-packed-failure-"),
  );
  const sourceRoot = path.join(options.archiveWorkspace, "repository");
  const consumerRoot = path.join(options.workspace, "consumer");
  const archiveCopy = path.join(diagnostics, "template-package.tgz");
  const sourceCopy = path.join(diagnostics, "source");
  const workspaceCopy = path.join(diagnostics, "workspace");
  const consumerCopy = path.join(workspaceCopy, "consumer");
  const reports: string[] = [];
  const preservationErrors: unknown[] = [];
  if (options.archivePath !== undefined) {
    try {
      await cp(options.archivePath, archiveCopy);
      reports.push("template-package.tgz");
    } catch (error) {
      preservationErrors.push(error);
    }
  }
  try {
    await cp(sourceRoot, sourceCopy, {
      recursive: true,
      filter: (source) => copyDiagnosticPath(source, sourceRoot),
    });
    reports.push("source");
  } catch (error) {
    preservationErrors.push(error);
  }
  try {
    await cp(options.workspace, workspaceCopy, {
      recursive: true,
      filter: (source) => copyDiagnosticPath(source, options.workspace),
    });
    reports.push("workspace");
  } catch (error) {
    preservationErrors.push(error);
  }
  for (const [name, content] of [
    ["packed-journeys.stdout.tap", options.journeyOutput],
    ["packed-journeys.stderr.log", options.journeyStderr],
  ] as const) {
    if (content === undefined) continue;
    try {
      await writeFile(path.join(diagnostics, name), content);
      reports.push(name);
    } catch (error) {
      preservationErrors.push(error);
    }
  }
  const nestedPath =
    `${options.journeyOutput ?? ""}\n${options.journeyStderr ?? ""}`.match(
      /CLI_JOURNEY_DIAGNOSTICS=(.+)/u,
    )?.[1];
  let nestedJourneyDiagnostics: string | undefined;
  if (nestedPath !== undefined) {
    try {
      nestedJourneyDiagnostics = path.join(
        diagnostics,
        "nested-journey-diagnostics",
      );
      await cp(nestedPath, nestedJourneyDiagnostics, {
        recursive: true,
        filter: (source) => copyDiagnosticPath(source, nestedPath),
      });
      reports.push("nested-journey-diagnostics");
    } catch (error) {
      preservationErrors.push(error);
      nestedJourneyDiagnostics = undefined;
    }
  }
  const report = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ...(options.archivePath === undefined
      ? {}
      : {
          archive: reports.includes("template-package.tgz")
            ? archiveCopy
            : options.archivePath,
        }),
    source: reports.includes("source") ? sourceCopy : sourceRoot,
    workspace: reports.includes("workspace")
      ? workspaceCopy
      : options.workspace,
    consumer: reports.includes("workspace") ? consumerCopy : consumerRoot,
    reports,
    nestedJourneyDiagnostics,
    error: errorDetails(options.error),
    preservationErrors: preservationErrors.map((error) => errorDetails(error)),
    ...(options.archivePath === undefined
      ? {
          reproduction: [
            "完成归档生成后，使用同一归档重新运行 packed CLI 旅程。",
          ],
        }
      : {
          reproduction: packedReproduction({
            artifactRoot: diagnostics,
            archivePath: archiveCopy,
            sourcePath: sourceCopy,
            consumerPath: consumerCopy,
          }),
        }),
    cleanup: {
      originalWorkspace: options.workspace,
      retryCommand: `rm -rf ${JSON.stringify(options.workspace)}`,
    },
  };
  await writeFile(
    path.join(diagnostics, "failure.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return diagnostics;
}

async function verifyPackedJourneyFailure(options: {
  readonly active: ActivePackedRun;
  readonly installedBin: string;
}): Promise<void> {
  const fixtureRoot = path.join(options.active.workspace!, "failure-probe");
  const cliRoot = path.join(fixtureRoot, "packages", "cli");
  const e2eRoot = path.join(cliRoot, "test", "e2e");
  const journeyRoot = path.join(e2eRoot, "journeys");
  await mkdir(journeyRoot, { recursive: true });
  await symlink(
    path.join(process.cwd(), "packages/cli/node_modules"),
    path.join(cliRoot, "node_modules"),
    "dir",
  );
  await Promise.all(
    ["run-journeys.ts", "journey.ts"].map((fileName) =>
      cp(
        path.join(process.cwd(), "packages/cli/test/e2e", fileName),
        path.join(e2eRoot, fileName),
      ),
    ),
  );
  await cp(
    path.join(process.cwd(), "packages/cli/package.json"),
    path.join(cliRoot, "package.json"),
  );

  const shimPath = path.join(fixtureRoot, "packed-cli-failure-shim.mjs");
  await writeFile(
    shimPath,
    [
      'import { spawn } from "node:child_process";',
      "const [executable, ...args] = process.argv.slice(2);",
      'if (executable === undefined) throw new Error("missing CLI executable");',
      'const child = spawn(executable, args, { shell: process.platform === "win32", stdio: "inherit" });',
      'child.once("error", (error) => { console.error(error); process.exitCode = 1; });',
      'child.once("exit", (code) => { process.exitCode = code === 0 ? 79 : (code ?? 1); });',
      "",
    ].join("\n"),
  );
  const journeySource = [
    'import path from "node:path";',
    'import assert from "node:assert/strict";',
    'import { builtInPresetRegistry } from "@ykdz/template-builtin-presets";',
    'import type { CliJourney } from "../journey.ts";',
    "const preset = builtInPresetRegistry.all().find((candidate) => candidate.planPackageAddition !== undefined && candidate.initialPrimaryPackage !== undefined);",
    'if (preset === undefined) throw new Error("没有可初始化的可扩展预设");',
    "const journey: CliJourney = {",
    '  name: "packed-failure-probe",',
    '  modes: ["packed"],',
    "  async setup() {},",
    "  commands(context) {",
    "    const shim = process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM;",
    "    const packedBin = process.env.TEMPLATE_CLI_PACKED_BIN;",
    '    if (shim === undefined || packedBin === undefined) throw new Error("缺少 packed 失败探针命令");',
    "    return [{",
    '      name: "生成项目后注入退出错误",',
    "      executable: process.execPath,",
    '      args: [shim, packedBin, "init", "project", "--preset", preset.metadata.name, "--scope", "acme", "--no-todo"],',
    "    }];",
    "  },",
    "  async assertions({ results }) {",
    "    assert.strictEqual(results[0]?.exitCode, 79);",
    '    assert.match(results[0]?.stdout ?? "", /"variant":"initialized"/u);',
    '    throw new Error("注入的 packed 旅程断言失败", { cause: new Error("原始 packed 旅程错误") });',
    "  },",
    "};",
    "export default journey;",
    "",
  ].join("\n");
  await writeFile(
    path.join(journeyRoot, "packed-failure.journey.ts"),
    journeySource,
  );

  const diagnosticsRoot = path.join(fixtureRoot, "diagnostics");
  const originalShim = process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM;
  process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM = shimPath;
  try {
    const result = await runPackedJourneyTests({
      active: options.active,
      consumer: options.active.consumer!,
      installedBin: options.installedBin,
      runnerPath: path.join(e2eRoot, "run-journeys.ts"),
      stageName: "packed-failure-probe",
      diagnosticsRoot,
    });
    const output = await readFile(options.active.stdoutPath!, "utf8");
    const stderr = await readFile(options.active.stderrPath!, "utf8");
    assert.notStrictEqual(result.exitCode, 0, `${output}\n${stderr}`);
    assert.match(output, /# fail 1/u);
    const diagnosticsPath = `${output}\n${stderr}`.match(
      /CLI_JOURNEY_DIAGNOSTICS=(.+)/u,
    )?.[1];
    assert.ok(diagnosticsPath, `${output}\n${stderr}`);
    const report = JSON.parse(
      await readFile(
        path.join(diagnosticsPath!, "journey-report.json"),
        "utf8",
      ),
    ) as {
      readonly journey: string;
      readonly workspace: string;
      readonly error: {
        readonly message: string;
        readonly cause?: {
          readonly message: string;
          readonly cause?: { readonly message: string };
        };
      };
      readonly results: readonly {
        readonly exitCode: number;
        readonly stdout: string;
      }[];
    };
    assert.strictEqual(report.journey, "packed-failure-probe");
    assert.strictEqual(report.results[0]?.exitCode, 79);
    assert.strictEqual(
      report.error.cause?.cause?.message,
      "原始 packed 旅程错误",
    );
    assert.match(report.error.message, /"variant":"initialized"/u);
    assert.match(report.results[0]?.stdout ?? "", /"variant":"initialized"/u);
    const generatedManifest = await readFile(
      path.join(report.workspace, "project", "package.json"),
      "utf8",
    );
    assert.ok(JSON.parse(generatedManifest));
  } finally {
    if (originalShim === undefined) {
      delete process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM;
    } else {
      process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM = originalShim;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    receivedPackedSignal ??= signal;
    preservePackedWorkspaceAfterSignal = true;
    packedCancellationController.abort(new Error(`收到 ${signal} 信号`));
    const active = activePackedRun;
    const diagnostics = active?.diagnostics ?? journeyDiagnosticsRoot;
    mkdirSync(diagnostics, { recursive: true });
    const source =
      active === undefined
        ? undefined
        : path.join(active.archiveWorkspace, "repository");
    const journeyWorkerPid =
      active === undefined ? undefined : readPackedRunnerWorkerPid(active);
    const reproduction =
      active?.archivePath !== undefined &&
      source !== undefined &&
      active.consumer !== undefined
        ? packedReproduction({
            artifactRoot: diagnostics,
            archivePath: active.archivePath,
            sourcePath: source,
            consumerPath: active.consumer,
          })
        : [];
    writeFileSync(
      path.join(diagnostics, "packed-publication-interrupted.json"),
      `${JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          signal,
          stage: active?.stage ?? "packed 测试初始化",
          processIds: {
            rootTestWorker: process.pid,
            ...(active?.nativeParentPid === undefined
              ? {}
              : { nativeTestParent: active.nativeParentPid }),
            ...(journeyWorkerPid === undefined
              ? {}
              : { journeyWorker: journeyWorkerPid }),
          },
          ...(active?.archivePath === undefined
            ? {}
            : { archive: active.archivePath }),
          ...(source === undefined ? {} : { source }),
          ...(active?.consumer === undefined
            ? {}
            : { consumer: active.consumer }),
          ...(active?.workspace === undefined
            ? {}
            : { workspace: active.workspace }),
          ...(active?.packedBin === undefined
            ? {}
            : { packedBin: active.packedBin }),
          ...(active === undefined
            ? {}
            : {
                nativeReport: {
                  stdout: active.stdoutPath,
                  stderr: active.stderrPath,
                },
              }),
          cause: {
            name: "Error",
            message: `收到 ${signal} 信号，正在保留 packed 旅程现场。`,
          },
          reproduction,
          cleanup: {
            retained: true,
            retryPath: active?.workspace,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (active?.workerPidFile !== undefined)
      void relaySignalToPackedJourneyWorker(active, signal);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}

const rootTestWorkerPidFile = process.env.TEMPLATE_ROOT_TEST_WORKER_PID_FILE;
if (rootTestWorkerPidFile !== undefined) {
  mkdirSync(path.dirname(rootTestWorkerPidFile), { recursive: true });
  writeFileSync(rootTestWorkerPidFile, `${process.pid}\n`);
}

async function packTemplateArchive(workspace: string): Promise<string> {
  const repositoryRoot = path.join(workspace, "repository");
  const archiveDirectory = path.join(workspace, "archives");
  const diagnosticsRelativePath = path.relative(
    process.cwd(),
    journeyDiagnosticsRoot,
  );
  const diagnosticsPathIsInsideRepository =
    diagnosticsRelativePath !== "" &&
    diagnosticsRelativePath !== ".." &&
    !diagnosticsRelativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(diagnosticsRelativePath);
  const normalizedDiagnosticsRelativePath = diagnosticsRelativePath
    .split(path.sep)
    .join("/");
  const ignoredDirectoryNames = new Set([
    ".git",
    ".fixture-evidence",
    ".fixture-evidence-activity",
    ".fixture-native-cache",
    ".fixture-workspace",
    ".cli-journey-diagnostics",
    ".pnpm-store",
    ".scratch",
    ".turbo",
    "node_modules",
  ]);
  await cp(process.cwd(), repositoryRoot, {
    recursive: true,
    filter(source) {
      const relativePath = path
        .relative(process.cwd(), source)
        .split(path.sep)
        .join("/");
      if (
        relativePath
          .split("/")
          .some((segment) => ignoredDirectoryNames.has(segment))
      ) {
        return false;
      }
      if (
        diagnosticsPathIsInsideRepository &&
        (relativePath === normalizedDiagnosticsRelativePath ||
          relativePath.startsWith(`${normalizedDiagnosticsRelativePath}/`))
      ) {
        return false;
      }
      return !/^packages\/[^/]+\/dist(?:\/|$)/u.test(relativePath);
    },
  });
  await mkdir(archiveDirectory, { recursive: true });
  await execa("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repositoryRoot,
  });
  await execa(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "--filter",
      publicCliPackageName,
      "pack",
      "--pack-destination",
      archiveDirectory,
    ],
    { cwd: repositoryRoot },
  );
  assert.match(
    await readFile(
      path.join(repositoryRoot, "packages/cli/dist/cli.js"),
      "utf8",
    ),
    /^#!\/usr\/bin\/env node/u,
  );
  const archive = (await readdir(archiveDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  assert.notStrictEqual(archive, undefined);
  return path.join(archiveDirectory, archive!);
}

async function expectPackedProjectionRollback(
  consumer: string,
  workspace: string,
): Promise<void> {
  const targetRoot = path.join(workspace, "packed-projection-rollback");
  const canonicalPath = path.join(targetRoot, ".template/state.json");
  const contentPath = path.join(targetRoot, "content.txt");
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await Promise.all([
    writeFile(contentPath, "before\n"),
    writeFile(canonicalPath, '{\n  "state": "before"\n}\n'),
  ]);

  const packedProjectionModule = path.join(
    consumer,
    "node_modules",
    "@ykdz",
    "template",
    "node_modules",
    "@ykdz",
    "template-core",
    "dist",
    "project-projection.js",
  );
  const projection = (await import(
    pathToFileURL(packedProjectionModule).href
  )) as typeof import("@ykdz/template-core/project-projection");
  const committedPaths: string[] = [];
  const reconcile = projection.createProjectProjectionReconciler({
    async commitMutation(options) {
      committedPaths.push(options.relativePath);
      if (committedPaths.length === 2) {
        throw new Error("injected packed projection commit failure");
      }
      await options.commit();
    },
  });
  const plan = (state: "before" | "after") => ({
    operations: [
      {
        kind: "writeText" as const,
        to: "content.txt",
        text: `${state}\n`,
      },
      {
        kind: "writeJson" as const,
        to: ".template/state.json",
        value: { state },
      },
    ],
    reconciliation: [
      {
        path: ".template/state.json",
        driver: "canonical" as const,
      },
    ],
  });

  await assert.rejects(
    reconcile({
      targetRoot,
      before: plan("before"),
      after: plan("after"),
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("injected packed projection commit failure"),
  );
  assert.strictEqual(await readFile(contentPath, "utf8"), "before\n");
  assert.strictEqual(
    await readFile(canonicalPath, "utf8"),
    '{\n  "state": "before"\n}\n',
  );
  assert.strictEqual(committedPaths?.length, 2);
}

function definitionWithPackagePath(packagePath: string) {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "package-path-selection"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    }).blueprint.packages.some((pkg) => pkg.path === packagePath),
  );
  if (definition === undefined) {
    throw new Error(
      `Expected a Built-in Preset Definition with package path ${packagePath}`,
    );
  }
  return definition;
}

function firstAddableDefinition() {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.planPackageAddition !== undefined);
  if (definition === undefined) {
    throw new Error("Expected an addable Built-in Preset Definition");
  }
  return definition;
}

function definitionWithInitialPackageRole(role: PackageRole) {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "role-selection"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    }).blueprint.packages.some((pkg) => pkg.role === role),
  );
  if (definition === undefined) {
    throw new Error(`Expected a Definition for initial Package Role ${role}`);
  }
  return definition;
}

function addableDefinitionWithPackageRole(role: PackageRole) {
  const context = createGenerationContext({
    targetDir: path.join("generated-repository", "addition-role-selection"),
    defaultPackageScope: "demo",
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
    },
  });
  const packageLeafName = "role-probe";
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const packagePath = candidate.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    return (
      packagePath !== undefined &&
      candidate.planPackageAddition?.({
        context,
        packageLeafName,
        packagePath,
      }).definition.role === role
    );
  });
  if (definition === undefined) {
    throw new Error(`Expected an addable Definition for Package Role ${role}`);
  }
  return definition;
}

async function generatedTextFiles(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly source: string }[]> {
  const files: { path: string; source: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set([".git", "node_modules", ".turbo"]).has(entry.name)) {
        files.push(...(await generatedTextFiles(root, child)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      files.push({
        path: child,
        source: await readFile(path.join(root, child), "utf8"),
      });
    } catch {
      // Binary generated assets are outside the task-model text contract.
    }
  }
  return files;
}

async function workspaceByteSnapshot(
  root: string,
  relative = "",
): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", ".turbo"]).has(entry.name)) {
        files.push(...(await workspaceByteSnapshot(root, child)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(root, child);
    files.push({
      path: child.split(path.sep).join("/"),
      mode: (await stat(filePath)).mode & 0o777,
      content: (await readFile(filePath)).toString("base64"),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function expectNativeTaskModel(projectDir: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as { readonly scripts: Record<string, string> };
  const taskModel = JSON.stringify({
    scripts: manifest.scripts,
    turbo: JSON.parse(
      await readFile(path.join(projectDir, "turbo.json"), "utf8"),
    ),
  });
  const checkCommand = manifest.scripts.check;
  if (checkCommand === undefined) {
    throw new Error("Generated Repository root manifest must define check");
  }

  const scriptNames = Object.keys(manifest.scripts);
  assert.ok(!scriptNames.some((name) => /:(?:run|root)$/u.test(name)));
  assert.ok(!scriptNames.includes("transit"));
  for (const command of [
    manifest.scripts.fix,
    manifest.scripts["check:deployment"],
  ]) {
    if (command !== undefined) assert.ok(!command.includes("--filter"));
  }
  if (manifest.scripts["publication:artifact"] === undefined) {
    assert.ok(!checkCommand.includes("--filter"));
  } else {
    const publicationExclusions = checkCommand.match(
      /--filter=!\.\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*/gu,
    );
    assert.strictEqual(publicationExclusions?.length, 1);
    assert.ok(
      !checkCommand.replace(publicationExclusions![0], "").includes("--filter"),
    );
  }
  assert.doesNotMatch(taskModel, /(?:Check|Fix) (?:Component|Plan)/u);
  assert.doesNotMatch(taskModel, /Deployment Check Component/u);
  assert.doesNotMatch(taskModel, /deployment[\s-]*(?:task[\s-]*)?owner/iu);

  const fullTree = await generatedTextFiles(projectDir);
  for (const file of fullTree) {
    assert.doesNotMatch(file.source, /\b[\p{L}\p{N}_-]+:(?:run|root)\b/iu);
    assert.doesNotMatch(file.source, /\btransit\b/iu);
    assert.doesNotMatch(
      file.source,
      /(?:Check|Fix) (?:Component|Plan)|Deployment Check Component/iu,
    );
  }

  const retiredBuild = await execa("pnpm", ["run", "build:run"], {
    cwd: projectDir,
    reject: false,
  });
  throwIfPackedCommandWasCancelled(retiredBuild, "检查已移除的构建命令");
  assert.notStrictEqual(retiredBuild.exitCode, 0);
}

function configProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  return object.properties.flatMap((member) =>
    ts.isPropertyAssignment(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === name
      ? [member.initializer]
      : [],
  )[0];
}

async function expectPackedPlaywrightConfig(
  projectDir: string,
  requiresDiagnostics: boolean,
): Promise<void> {
  const config = (await generatedTextFiles(projectDir)).find(({ path: file }) =>
    file.endsWith("playwright.config.ts"),
  );
  assert.strictEqual(config === undefined, !requiresDiagnostics);
  if (config === undefined) return;

  const source = ts.createSourceFile(
    config.path,
    config.source,
    ts.ScriptTarget.Latest,
    true,
  );
  let options: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      options = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.notStrictEqual(options, undefined);
  if (options === undefined) return;
  const loadedOptions = options;
  const use = configProperty(loadedOptions, "use");
  const reporter = configProperty(loadedOptions, "reporter");
  assert.strictEqual(
    use !== undefined && ts.isObjectLiteralExpression(use),
    true,
  );
  assert.strictEqual(
    reporter !== undefined && ts.isArrayLiteralExpression(reporter),
    true,
  );
  if (
    use === undefined ||
    !ts.isObjectLiteralExpression(use) ||
    reporter === undefined ||
    !ts.isArrayLiteralExpression(reporter)
  ) {
    return;
  }
  const trace = configProperty(use, "trace");
  assert.strictEqual(
    trace !== undefined && ts.isStringLiteral(trace) && trace.text,
    "retain-on-failure",
  );
  assert.deepStrictEqual(
    reporter.elements.map((entry) =>
      ts.isArrayLiteralExpression(entry) &&
      entry.elements[0] !== undefined &&
      ts.isStringLiteral(entry.elements[0])
        ? entry.elements[0].text
        : undefined,
    ),
    ["list", "html"],
  );
  assert.strictEqual(configProperty(loadedOptions, "retries"), undefined);
  assert.strictEqual(configProperty(use, "video"), undefined);
}

async function expectPackedHardenedRootCheckWorkflow(
  projectDir: string,
  plan: GeneratedRepositoryPlan,
): Promise<void> {
  const generatedPath = ".github/workflows/check.yml";
  const source = await readFile(path.join(projectDir, generatedPath), "utf8");
  assertWorkflowContract(plan, generatedPath, source, parseYaml(source));
  if (
    plan.packageContributions.some(
      (contribution) =>
        contribution.foundation.npmPublication?.kind === "public-cli-candidate",
    )
  ) {
    const releaseSource = await readFile(
      path.join(projectDir, ".github/workflows/release.yml"),
      "utf8",
    );
    assertPublicationWorkflowContract(
      plan,
      releaseSource,
      parseYaml(releaseSource),
    );
  }
}

function initializationRequiresDiagnostics(definitionName: string): boolean {
  return (
    initializationDiagnosticPlan(definitionName).ciDiagnosticArtifacts.length >
    0
  );
}

function initializationDiagnosticPlan(definitionName: string) {
  const definition = builtInPresetRegistry.require(definitionName);
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join(
        "generated-repository",
        "packed-diagnostic-expectation",
        definitionName,
      ),
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    }),
  });
}

void describe("packed public CLI consumer", () => {
  let archiveWorkspace: string | undefined;
  let packedArchivePath: string | undefined;

  before(
    async () => {
      await mkdir(journeyDiagnosticsRoot, { recursive: true });
      archiveWorkspace = await mkdtemp(
        path.join(tmpdir(), "template-packed-artifact-"),
      );
      activePackedRun = {
        archiveWorkspace,
        diagnostics: journeyDiagnosticsRoot,
        stage: "创建 packed 归档",
      };
      try {
        packedArchivePath = await packTemplateArchive(archiveWorkspace);
        activePackedRun.archivePath = packedArchivePath;
        if (receivedPackedSignal !== undefined) {
          const error = new Error(
            `创建 packed 归档期间收到 ${receivedPackedSignal} 信号。`,
          );
          const diagnostics = await preservePackedFailure({
            archivePath: packedArchivePath,
            archiveWorkspace,
            workspace: archiveWorkspace,
            error,
          });
          throw new Error(`packed 归档已保留：${diagnostics}`, {
            cause: error,
          });
        }
      } catch (error) {
        if (receivedPackedSignal === undefined) {
          const diagnostics = await preservePackedFailure({
            ...(packedArchivePath === undefined
              ? {}
              : { archivePath: packedArchivePath }),
            archiveWorkspace,
            workspace: archiveWorkspace,
            error,
          });
          throw new Error(`packed 归档创建失败，诊断目录：${diagnostics}`, {
            cause: error,
          });
        }
        throw error;
      }
    },
    { timeout: 900_000 },
  );

  after(async () => {
    if (!preservePackedWorkspaceAfterSignal && archiveWorkspace !== undefined) {
      await rm(archiveWorkspace, { recursive: true, force: true });
    }
    activePackedRun = undefined;
  });

  void it(
    "runs the archive alone: import, help, every initialization, and package addition",
    { timeout: 1_200_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(journeyDiagnosticsRoot, "template-packed-consumer-"),
      );
      let journeyOutput: string | undefined;
      let journeyStderr: string | undefined;
      try {
        assert.ok(packedArchivePath);
        const archivePath = packedArchivePath;
        const consumer = path.join(workspace, "consumer");
        const activeRun: ActivePackedRun = {
          archivePath,
          archiveWorkspace: archiveWorkspace!,
          workspace,
          consumer,
          diagnostics: journeyDiagnosticsRoot,
          stage: "检查 packed 归档",
        };
        activePackedRun = activeRun;
        const packedPaths = (await execa("tar", ["-tf", archivePath])).stdout
          .split("\n")
          .filter(Boolean);
        assert.strictEqual(
          packedPaths.every(
            (entry) =>
              entry.startsWith("package/") && !entry.split("/").includes(".."),
          ),
          true,
        );
        for (const expectedPath of [
          "package/dist/application.d.ts",
          "package/dist/application.js",
          "package/dist/cli.d.ts",
          "package/dist/cli.js",
          "package/dist/main.d.ts",
          "package/dist/main.js",
          "package/node_modules/@ykdz/cli-contract/package.json",
          "package/node_modules/@ykdz/template-core/package.json",
          "package/node_modules/@ykdz/template-builtin-presets/package.json",
          "package/node_modules/@ykdz/template-builtin-presets/templates/foundation/turbo.json",
          "package/node_modules/@ykdz/template-builtin-presets/dist/src/ts-cli/definition.js",
          "package/node_modules/@ykdz/template-builtin-presets/templates/ts-cli/src/cli.ts",
          "package/node_modules/typescript/package.json",
        ]) {
          assert.ok(packedPaths.includes(expectedPath));
        }
        assert.strictEqual(
          packedPaths.some((entry) => entry.startsWith("package/src/")),
          false,
        );
        assert.strictEqual(
          packedPaths.some(
            (entry) =>
              entry.includes("behavior.test") ||
              entry.startsWith("package/test/") ||
              entry.includes("/.template/") ||
              entry.includes("template-checks"),
          ),
          false,
        );
        const packedManifest = await execa("tar", [
          "-xOf",
          archivePath,
          "package/package.json",
        ]).then(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>);
        const packedCoreManifest = await execa("tar", [
          "-xOf",
          archivePath,
          "package/node_modules/@ykdz/template-core/package.json",
        ]).then(
          ({ stdout }) =>
            JSON.parse(stdout) as {
              readonly dependencies?: Readonly<Record<string, unknown>>;
              readonly peerDependencies?: Readonly<Record<string, unknown>>;
            },
        );
        const sourceManifest = JSON.parse(
          await readFile(
            path.join(process.cwd(), "packages/cli/package.json"),
            "utf8",
          ),
        ) as {
          readonly version: string;
          readonly scripts: Readonly<Record<string, string>>;
        };
        assert.strictEqual(
          sourceManifest.scripts.prepack,
          "pnpm exec turbo run build --filter=.",
        );
        assert.partialDeepStrictEqual(packedManifest, {
          version: sourceManifest.version,
          bin: { template: "dist/cli.js" },
          exports: {
            ".": {
              source: "./src/main.ts",
              types: "./dist/main.d.ts",
              default: "./dist/main.js",
            },
          },
        });
        assert.ok(
          typeof packedManifest.dependencies === "object" &&
            packedManifest.dependencies !== null,
        );
        const packedDependencies = packedManifest.dependencies as Record<
          string,
          unknown
        >;
        for (const dependencyName of [
          "@ykdz/cli-contract",
          "@valibot/to-json-schema",
          "valibot",
        ]) {
          assert.ok(Object.hasOwn(packedDependencies, dependencyName));
          assert.strictEqual(
            typeof packedDependencies[dependencyName],
            "string",
          );
        }
        assert.ok(Array.isArray(packedManifest.bundleDependencies));
        const bundledDependencies =
          packedManifest.bundleDependencies as string[];
        for (const dependencyName of [
          "@ykdz/template-core",
          "@ykdz/template-builtin-presets",
          "@ykdz/cli-contract",
          "@valibot/to-json-schema",
          "typescript",
        ]) {
          assert.ok(bundledDependencies.includes(dependencyName));
        }
        assert.ok(Object.hasOwn(packedDependencies, "typescript"));
        assert.ok(
          !Object.hasOwn(packedCoreManifest.dependencies ?? {}, "typescript"),
        );
        assert.ok(
          Object.hasOwn(
            packedCoreManifest.peerDependencies ?? {},
            "typescript",
          ),
        );
        await mkdir(consumer, { recursive: true });
        activeRun.stage = "安装 packed 消费者";
        await execa("npm", ["init", "--yes"], { cwd: consumer });
        await execa("pnpm", ["add", archivePath], { cwd: consumer });
        const bundledCoreRenderer = path.join(
          consumer,
          "node_modules",
          "@ykdz",
          "template",
          "node_modules",
          "@ykdz",
          "template-core",
          "dist",
          "renderer.js",
        );
        const compiler = createRequire(pathToFileURL(bundledCoreRenderer))(
          "typescript",
        ) as { readonly version: string };
        assert.match(compiler.version, /^6\./u);
        await expectPackedProjectionRollback(consumer, workspace);

        const installedBin = path.join(
          consumer,
          "node_modules",
          ".bin",
          "template",
        );
        const packedResult = await runPackedJourneyTests({
          active: activeRun,
          consumer,
          installedBin,
        });
        journeyOutput = await readFile(activeRun.stdoutPath!, "utf8");
        journeyStderr = await readFile(activeRun.stderrPath!, "utf8");
        if (receivedPackedSignal !== undefined) {
          throw new Error(
            `packed CLI 旅程收到 ${receivedPackedSignal} 信号并已完成清理。`,
            {
              cause: {
                exitCode: packedResult.exitCode,
                signal: packedResult.signal,
                requestSignal: receivedPackedSignal,
                stdout: journeyOutput,
                stderr: journeyStderr,
              },
            },
          );
        }
        activeRun.stage = "检查 packed 旅程报告";
        assert.strictEqual(
          packedResult.exitCode,
          0,
          `${journeyOutput}\n${journeyStderr}`,
        );
        assert.match(journeyOutput, /^# tests 5$/mu);
        assert.match(journeyOutput, /^# pass 5$/mu);
        await verifyPackedJourneyFailure({
          active: activeRun,
          installedBin,
        });
        const bundledDefinitions = path.join(
          consumer,
          "node_modules",
          "@ykdz",
          "template",
          "node_modules",
          "@ykdz",
          "template-builtin-presets",
          "dist/src/index.js",
        );
        assert.partialDeepStrictEqual(
          await execa(
            "node",
            [
              "--input-type=module",
              "-e",
              "await import(process.argv[1])",
              bundledDefinitions,
            ],
            {
              cwd: consumer,
            },
          ),
          { exitCode: 0 },
        );
        assert.partialDeepStrictEqual(
          await execa(
            "node",
            [
              "--input-type=module",
              "-e",
              [
                `const api = await import(${JSON.stringify(publicCliPackageName)});`,
                'if (typeof api.runCli !== "function") process.exit(1);',
              ].join(""),
            ],
            { cwd: consumer },
          ),
          { exitCode: 0 },
        );
        const help = await execa(installedBin, ["--help"], { cwd: consumer });
        assert.ok(help.stdout.includes("init"));
        const addHelp = await execa(
          installedBin,
          ["add", "package", "--help"],
          {
            cwd: consumer,
          },
        );
        assert.ok(addHelp.stdout.includes("template add package"));
        assert.ok(addHelp.stdout.includes("--link-from"));
        assert.ok(!addHelp.stdout.includes("template init <dir>"));
        const presets = await execa(installedBin, ["presets"], {
          cwd: consumer,
        });
        const definitions = JSON.parse(presets.stdout).data.presets as {
          name: string;
        }[];
        assert.ok(definitions.length > 0);
        for (const definition of definitions) {
          await execa(
            installedBin,
            [
              "init",
              path.join(consumer, "generated", definition.name),
              "--preset",
              definition.name,
            ],
            {
              cwd: consumer,
            },
          );
          await expectNativeTaskModel(
            path.join(consumer, "generated", definition.name),
          );
          const generatedProject = path.join(
            consumer,
            "generated",
            definition.name,
          );
          const requiresDiagnostics = initializationRequiresDiagnostics(
            definition.name,
          );
          await expectPackedHardenedRootCheckWorkflow(
            generatedProject,
            initializationDiagnosticPlan(definition.name),
          );
          await expectPackedPlaywrightConfig(
            generatedProject,
            requiresDiagnostics,
          );
        }
        const expectedAddableDefinitions = builtInPresetRegistry
          .all()
          .filter((definition) => definition.planPackageAddition !== undefined)
          .map((definition) => definition.metadata.name)
          .toSorted();
        const completedAdditions: string[] = [];
        for (const candidate of definitions) {
          const definition = builtInPresetRegistry.require(candidate.name);
          const generatedProject = path.join(
            consumer,
            "generated",
            candidate.name,
          );
          const additionPlan =
            definition.planPackageAddition === undefined
              ? undefined
              : planGeneratedRepositoryPackageAddition({
                  definition,
                  localTemplateMetadata:
                    loadLocalTemplateMetadata(generatedProject),
                  packageLeafName: "archive-addition",
                  packagePath: "packages/archive-addition",
                });
          const result = await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              candidate.name,
              "--name",
              "archive-addition",
              "--path",
              "packages/archive-addition",
            ],
            {
              cwd: path.join(consumer, "generated", candidate.name),
              reject: false,
            },
          );
          throwIfPackedCommandWasCancelled(
            result,
            `向 ${candidate.name} 预设添加包`,
          );
          if (result.exitCode === 0) {
            completedAdditions.push(candidate.name);
            await expectNativeTaskModel(
              path.join(consumer, "generated", candidate.name),
            );
            const generatedProject = path.join(
              consumer,
              "generated",
              candidate.name,
            );
            assert.notStrictEqual(additionPlan, undefined);
            const requiresDiagnostics =
              additionPlan!.ciDiagnosticArtifacts.length > 0;
            await expectPackedHardenedRootCheckWorkflow(
              generatedProject,
              additionPlan!,
            );
            await expectPackedPlaywrightConfig(
              generatedProject,
              requiresDiagnostics,
            );
          }
        }
        assert.deepStrictEqual(
          completedAdditions.toSorted(),
          expectedAddableDefinitions,
        );

        const rustDefinition =
          addableDefinitionWithPackageRole("native-package");
        const nonRustBase = builtInPresetRegistry.all().find((definition) => {
          const context = createGenerationContext({
            targetDir: path.join(
              consumer,
              "generated",
              definition.metadata.name,
            ),
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          });
          const contributions = planGeneratedRepositoryInitialization({
            definition,
            context,
          }).packageContributions;
          return contributions.every(
            (contribution) =>
              contribution.foundation.toolchains.rust === undefined,
          );
        });
        assert.notStrictEqual(nonRustBase, undefined);
        const rustAdditionTarget = path.join(
          consumer,
          "generated",
          nonRustBase!.metadata.name,
        );
        const rustDockerfilePath = path.join(
          rustAdditionTarget,
          ".devcontainer/Dockerfile",
        );
        const rustDevcontainerPath = path.join(
          rustAdditionTarget,
          ".devcontainer/devcontainer.json",
        );
        const rustToolchainPath = path.join(
          rustAdditionTarget,
          "rust-toolchain.toml",
        );
        const dependabotPath = path.join(
          rustAdditionTarget,
          ".github/dependabot.yml",
        );
        const dockerfileBeforeRust = await readFile(rustDockerfilePath, "utf8");
        const devcontainerBeforeRust = JSON.parse(
          await readFile(rustDevcontainerPath, "utf8"),
        ) as {
          readonly build: { readonly args: Readonly<Record<string, string>> };
          readonly mounts: readonly { readonly target: string }[];
        };
        const dependabotBeforeRust = await readFile(dependabotPath, "utf8");
        assert.ok(!dockerfileBeforeRust.includes("ARG RUST_TOOLCHAIN"));
        assert.ok(
          !Object.hasOwn(devcontainerBeforeRust.build.args, "RUST_TOOLCHAIN"),
        );
        assert.ok(
          !devcontainerBeforeRust.mounts.some(
            (mount) => mount.target === "/usr/local/cargo/registry",
          ),
        );
        await assert.rejects(stat(rustToolchainPath), (error) => {
          assert.ok(typeof error === "object" && error !== null);
          assert.ok(Object.hasOwn(error, "code"));
          assert.strictEqual(
            (error as { readonly code?: unknown }).code,
            "ENOENT",
          );
          return true;
        });
        assert.ok(!dependabotBeforeRust.includes("package-ecosystem: cargo"));

        const beforeRustPreview =
          await workspaceByteSnapshot(rustAdditionTarget);
        const rustPreviewResult = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            rustDefinition.metadata.name,
            "--name",
            "worker",
            "--dry-run",
          ],
          {
            cwd: rustAdditionTarget,
          },
        );
        const rustPreview = JSON.parse(rustPreviewResult.stdout).data as {
          readonly dryRun: boolean;
          readonly actions: readonly {
            readonly path: string;
            readonly action: string;
          }[];
          readonly conflicts?: readonly unknown[];
        };
        assert.strictEqual(rustPreview.dryRun, true);
        assert.deepStrictEqual(rustPreview.conflicts ?? [], []);
        for (const [expectedPath, expectedAction] of [
          [".devcontainer/Dockerfile", "update"],
          [".devcontainer/devcontainer.json", "update"],
          ["rust-toolchain.toml", "create"],
          [".github/dependabot.yml", "update"],
          ["packages/worker/package.json", "create"],
          ["packages/worker/Cargo.toml", "create"],
        ] as const) {
          assert.ok(
            rustPreview.actions.some(
              (action) =>
                action.path === expectedPath &&
                action.action === expectedAction,
            ),
          );
        }
        assert.deepStrictEqual(
          await workspaceByteSnapshot(rustAdditionTarget),
          beforeRustPreview,
        );

        await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            rustDefinition.metadata.name,
            "--name",
            "worker",
          ],
          {
            cwd: rustAdditionTarget,
          },
        );
        assert.partialDeepStrictEqual(
          await readFile(
            path.join(rustAdditionTarget, "packages/worker/package.json"),
            "utf8",
          ).then(
            (source) =>
              JSON.parse(source) as {
                readonly name: string;
                readonly scripts: Readonly<Record<string, string>>;
              },
          ),
          {
            name: `@${nonRustBase!.metadata.name}/worker`,
            scripts: {
              "format:check": "cargo fmt --all -- --check",
              lint: "cargo clippy --workspace --all-targets -- -D warnings",
              test: "cargo test --workspace",
            },
          },
        );
        assert.ok(
          (
            await readFile(
              path.join(rustAdditionTarget, "packages/worker/Cargo.toml"),
              "utf8",
            )
          ).includes('name = "worker"'),
        );
        const dockerfileAfterRust = await readFile(rustDockerfilePath, "utf8");
        assert.ok(dockerfileAfterRust.includes("ARG RUST_TOOLCHAIN"));
        assert.ok(
          dockerfileAfterRust.includes(
            '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
          ),
        );
        const devcontainerAfterRust = JSON.parse(
          await readFile(rustDevcontainerPath, "utf8"),
        ) as {
          readonly build: { readonly args: Readonly<Record<string, string>> };
          readonly mounts: readonly {
            readonly type: string;
            readonly source: string;
            readonly target: string;
          }[];
        };
        const rustToolchainAfterRust = await readFile(
          rustToolchainPath,
          "utf8",
        );
        const rootRustChannel = rustToolchainAfterRust.match(
          /^channel = "([^"]+)"$/mu,
        )?.[1];
        assert.strictEqual(
          rootRustChannel,
          releaseToolchainSnapshot.rustVersion,
        );
        assert.partialDeepStrictEqual(devcontainerAfterRust.build.args, {
          RUST_TOOLCHAIN: rootRustChannel,
        });
        for (const expectedMount of [
          {
            type: "volume",
            source: "${devcontainerId}-pnpm-store",
            target: "/pnpm/store",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-git",
            target: "/usr/local/cargo/git",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-registry",
            target: "/usr/local/cargo/registry",
          },
        ]) {
          assert.ok(
            devcontainerAfterRust.mounts.some(
              (mount) =>
                Object.keys(mount).length === 3 &&
                mount.type === expectedMount.type &&
                mount.source === expectedMount.source &&
                mount.target === expectedMount.target,
            ),
          );
        }
        assert.ok(
          !devcontainerAfterRust.mounts.some((mount) =>
            mount.target.includes("${containerWorkspaceFolder}"),
          ),
        );
        assert.strictEqual(
          rustToolchainAfterRust,
          `[toolchain]\nchannel = "${releaseToolchainSnapshot.rustVersion}"\ncomponents = ["rustfmt", "clippy"]\n`,
        );
        const dependabotAfterRust = parseYaml(
          await readFile(dependabotPath, "utf8"),
        ) as {
          readonly updates: readonly {
            readonly "package-ecosystem": string;
            readonly directory: string;
          }[];
        };
        assert.deepStrictEqual(
          dependabotAfterRust.updates
            .filter((update) => update["package-ecosystem"] === "cargo")
            .map((update) => update.directory),
          ["/packages/worker"],
        );
        assert.deepStrictEqual(
          await readFile(
            path.join(rustAdditionTarget, "packages/worker/turbo.json"),
            "utf8",
          ).then((source) => JSON.parse(source)),
          {
            extends: ["//"],
            tags: ["native"],
            tasks: {
              "format:check": {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
              "format:write": {
                dependsOn: ["//#toolchain:prepare"],
                cache: false,
              },
              lint: {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
              test: {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
            },
          },
        );
        const rootManifestAfterRust = JSON.parse(
          await readFile(path.join(rustAdditionTarget, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const rootCheckScript = rootManifestAfterRust.scripts.check;
        assert.ok(rootCheckScript !== undefined);
        assert.ok(
          rootCheckScript.includes(
            "pnpm run boundaries && turbo run format:check lint typecheck test",
          ),
        );
        assert.ok(
          rootCheckScript.includes(
            "turbo run build test:e2e --filter=!./packages/cli",
          ),
        );

        await execa("pnpm", ["install"], { cwd: rustAdditionTarget });
        await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });
        await expectPackedHardenedRootCheckWorkflow(
          rustAdditionTarget,
          initializationDiagnosticPlan(rustDefinition.metadata.name),
        );

        const cliAdditionDefinition =
          addableDefinitionWithPackageRole("cli-tool");
        const cliTarget = path.join(
          consumer,
          "generated",
          cliAdditionDefinition.metadata.name,
        );
        const explicitCliManifest = JSON.parse(
          await readFile(
            path.join(cliTarget, "packages/archive-addition/package.json"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        assert.deepStrictEqual(explicitCliManifest.bin, {
          "archive-addition": "./dist/cli.js",
        });
        assert.partialDeepStrictEqual(explicitCliManifest, { private: true });
        assert.ok(!Object.hasOwn(explicitCliManifest, "version"));
        assert.ok(!Object.hasOwn(explicitCliManifest, "exports"));
        assert.ok(!Object.hasOwn(explicitCliManifest, "imports"));
        const addSecondCli = async (): Promise<void> => {
          await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              cliAdditionDefinition.metadata.name,
              "--name",
              "default-command",
            ],
            {
              cwd: cliTarget,
            },
          );
        };
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          cliTarget,
          initializationDiagnosticPlan(cliAdditionDefinition.metadata.name),
        );
        const secondCliManifest = JSON.parse(
          await readFile(
            path.join(cliTarget, "packages/default-command/package.json"),
            "utf8",
          ),
        ) as {
          readonly name: string;
          readonly bin: Readonly<Record<string, string>>;
        };
        assert.deepStrictEqual(secondCliManifest.bin, {
          "default-command": "./dist/cli.js",
        });
        assert.partialDeepStrictEqual(secondCliManifest, { private: true });
        assert.ok(!Object.hasOwn(secondCliManifest, "version"));
        assert.ok(!Object.hasOwn(secondCliManifest, "exports"));
        assert.ok(!Object.hasOwn(secondCliManifest, "imports"));
        const secondCliSnapshot = await workspaceByteSnapshot(cliTarget);
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          cliTarget,
          initializationDiagnosticPlan(cliAdditionDefinition.metadata.name),
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(cliTarget),
          secondCliSnapshot,
        );

        const previewBaseDefinition =
          definitionWithInitialPackageRole("shared-library");
        const previewAdditionDefinition =
          addableDefinitionWithPackageRole("runtime-service");
        const previewTarget = path.join(
          consumer,
          "generated",
          previewBaseDefinition.metadata.name,
        );
        const reservedBefore = await workspaceByteSnapshot(previewTarget);
        const reservedPackagePath = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.name,
            "--name",
            "evil",
            "--path",
            "dist/evil",
            "--dry-run",
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        throwIfPackedCommandWasCancelled(
          reservedPackagePath,
          "检查保留目录拒绝行为",
        );
        assert.strictEqual(reservedPackagePath.exitCode, 2);
        assert.strictEqual(reservedPackagePath.stdout, "");
        assert.partialDeepStrictEqual(JSON.parse(reservedPackagePath.stderr), {
          kind: "usageFailure",
        });
        assert.ok(reservedPackagePath.stderr.includes("保留工作区目录"));
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          reservedBefore,
        );

        await mkdir(path.join(previewTarget, "services/existing"), {
          recursive: true,
        });
        await writeFile(
          path.join(previewTarget, "services/existing/OWNER"),
          "user\n",
        );
        const existingBefore = await workspaceByteSnapshot(previewTarget);
        const existingPackagePath = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.name,
            "--name",
            "existing",
            "--path",
            "services/existing",
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        throwIfPackedCommandWasCancelled(
          existingPackagePath,
          "检查已存在目录冲突",
        );
        assert.notStrictEqual(existingPackagePath.exitCode, 0);
        const existingPackageFailure = JSON.parse(
          existingPackagePath.stderr,
        ).data;
        assert.strictEqual(existingPackageFailure.actions.length, 0);
        assert.strictEqual(existingPackageFailure.conflicts.length, 1);
        assert.partialDeepStrictEqual(existingPackageFailure.conflicts[0], {
          path: "services/existing",
          driver: "precondition",
        });
        assert.ok(
          existingPackageFailure.conflicts[0].reason.includes(
            "Package Path services/existing already exists",
          ),
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          existingBefore,
        );

        const previewBefore = await workspaceByteSnapshot(previewTarget);
        const preview = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.name,
            "--name",
            "dashboard",
            "--path",
            "services/dashboard",
            "--dry-run",
          ],
          {
            cwd: previewTarget,
          },
        );
        const previewData = JSON.parse(preview.stdout).data;
        assert.strictEqual(previewData.dryRun, true);
        assert.ok(
          previewData.actions.some(
            (action: Record<string, unknown>) =>
              Object.keys(action).length === 3 &&
              action.path === "services/dashboard/package.json" &&
              action.driver === "structured" &&
              action.action === "create",
          ),
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          previewBefore,
        );

        const turboPath = path.join(previewTarget, "turbo.json");
        const originalTurbo = await readFile(turboPath, "utf8");
        const turbo = JSON.parse(originalTurbo) as {
          boundaries: { tags: Record<string, unknown> };
        };
        turbo.boundaries.tags.app = { dependencies: { allow: ["app"] } };
        await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
        const structuredBefore = await workspaceByteSnapshot(previewTarget);
        const structuredConflict = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.name,
            "--name",
            "dashboard",
            "--path",
            "services/dashboard",
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        throwIfPackedCommandWasCancelled(
          structuredConflict,
          "检查结构化配置冲突",
        );
        assert.notStrictEqual(structuredConflict.exitCode, 0);
        const structuredFailure = JSON.parse(structuredConflict.stderr).data;
        assert.strictEqual(structuredFailure.actions.length, 0);
        assert.strictEqual(structuredFailure.conflicts.length, 1);
        const [structuredConflictDetail] = structuredFailure.conflicts;
        assert.partialDeepStrictEqual(structuredConflictDetail, {
          path: "turbo.json",
          driver: "structured",
          location: "/boundaries/tags/app/dependencies/allow",
        });
        for (const key of ["before", "current", "after"] as const) {
          assert.strictEqual(
            typeof structuredConflictDetail.context[key],
            "string",
          );
        }
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          structuredBefore,
        );

        await writeFile(turboPath, originalTurbo);
        const dockerfilePath = path.join(
          previewTarget,
          ".devcontainer/Dockerfile",
        );
        const dockerfile = await readFile(dockerfilePath, "utf8");
        const baseToolLayerTail = '    && chmod -R a+rX "$PNPM_HOME"';
        const baseToolLayerBoundary = `${baseToolLayerTail}\n\n`;
        assert.ok(dockerfile.includes(baseToolLayerBoundary));
        await writeFile(
          dockerfilePath,
          dockerfile.replace(
            baseToolLayerBoundary,
            `${baseToolLayerBoundary}# incompatible insertion\r\n`,
          ),
        );
        const textBefore = await workspaceByteSnapshot(previewTarget);
        const textConflict = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.name,
            "--name",
            "dashboard",
            "--path",
            "services/dashboard",
            "--output-format",
            "text",
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        throwIfPackedCommandWasCancelled(textConflict, "检查文本文件冲突");
        assert.notStrictEqual(textConflict.exitCode, 0);
        assert.ok(
          textConflict.stderr.includes(".devcontainer/Dockerfile (text)"),
        );
        assert.ok(textConflict.stderr.includes("区域:"));
        assert.ok(textConflict.stderr.includes("当前:"));
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          textBefore,
        );
      } catch (error) {
        if (activePackedRun !== undefined) {
          try {
            const diagnostics = await preservePackedFailure({
              ...(activePackedRun.archivePath === undefined
                ? {}
                : { archivePath: activePackedRun.archivePath }),
              archiveWorkspace: activePackedRun.archiveWorkspace,
              workspace,
              error,
              ...(journeyOutput === undefined ? {} : { journeyOutput }),
              ...(journeyStderr === undefined ? {} : { journeyStderr }),
            });
            process.stderr.write(`\nPACKED_CLI_DIAGNOSTICS=${diagnostics}\n`);
          } catch (preservationError) {
            preservePackedWorkspaceAfterSignal = true;
            throw new AggregateError(
              [error, preservationError],
              "packed CLI 失败，保存诊断材料时又发生错误。",
              { cause: error },
            );
          }
        }
        throw error;
      } finally {
        if (!preservePackedWorkspaceAfterSignal) {
          await rm(workspace, { recursive: true, force: true });
        }
        activePackedRun = undefined;
      }
    },
  );

  void it(
    "adds a package with the packed CLI after the generated repository is installed",
    { timeout: 120000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-packed-ready-add-"),
      );
      try {
        assert.ok(packedArchivePath);
        const archivePath = packedArchivePath;
        const consumer = path.join(workspace, "consumer");
        const generated = path.join(workspace, "digital");
        const baseDefinition = definitionWithPackagePath("packages/db");
        const additionDefinition = firstAddableDefinition();
        await mkdir(consumer, { recursive: true });
        await execa("npm", ["init", "--yes"], { cwd: consumer });
        await execa("pnpm", ["add", archivePath], { cwd: consumer });

        const installedBin = path.join(
          consumer,
          "node_modules",
          ".bin",
          "template",
        );
        await execa(
          installedBin,
          [
            "init",
            generated,
            "--preset",
            baseDefinition.metadata.name,
            "--scope",
            "demo",
          ],
          {
            cwd: consumer,
          },
        );
        const gitignorePath = path.join(generated, ".gitignore");
        const workspaceManifestPath = path.join(
          generated,
          "pnpm-workspace.yaml",
        );
        await Promise.all([
          writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" }),
          writeFile(workspaceManifestPath, "# private workspace policy\n", {
            flag: "a",
          }),
        ]);
        await execa("pnpm", ["install"], { cwd: generated });
        assert.strictEqual(
          (
            await lstat(
              path.join(generated, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );

        const addPackage = async (packageName: string): Promise<void> => {
          await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              additionDefinition.metadata.name,
              "--name",
              packageName,
              "--path",
              `services/${packageName}`,
            ],
            {
              cwd: generated,
            },
          );
        };

        await addPackage("domain");
        const firstAdditionManifest = await readFile(
          path.join(generated, "services/domain/package.json"),
          "utf8",
        );
        const firstRootManifest = await readFile(
          path.join(generated, "package.json"),
          "utf8",
        );
        const firstWorkspaceManifest = await readFile(
          workspaceManifestPath,
          "utf8",
        );
        assert.ok(
          firstWorkspaceManifest.includes("# private workspace policy"),
        );
        assert.ok(
          (await readFile(gitignorePath, "utf8")).includes(
            "private-artifacts/",
          ),
        );
        const workspaceBeforeRepeat = (
          await generatedTextFiles(generated)
        ).toSorted((left, right) => left.path.localeCompare(right.path));
        assert.strictEqual(
          workspaceBeforeRepeat.some(
            (file) => file.path === ".template/blueprint.json",
          ),
          true,
        );

        await addPackage("domain");
        assert.deepStrictEqual(
          (await generatedTextFiles(generated)).toSorted((left, right) =>
            left.path.localeCompare(right.path),
          ),
          workspaceBeforeRepeat,
        );
        assert.strictEqual(
          await readFile(
            path.join(generated, "services/domain/package.json"),
            "utf8",
          ),
          firstAdditionManifest,
        );

        await addPackage("domain-two");
        assert.ok(
          (
            await readFile(
              path.join(generated, "services/domain-two/package.json"),
              "utf8",
            )
          ).includes('"name": "@demo/domain-two"'),
        );
        assert.strictEqual(
          await readFile(
            path.join(generated, "services/domain/package.json"),
            "utf8",
          ),
          firstAdditionManifest,
        );
        assert.strictEqual(
          await readFile(path.join(generated, "package.json"), "utf8"),
          firstRootManifest,
        );
        assert.strictEqual(
          await readFile(workspaceManifestPath, "utf8"),
          firstWorkspaceManifest,
        );
        const finalGitignore = await readFile(gitignorePath, "utf8");
        assert.strictEqual(
          finalGitignore.match(/^private-artifacts\/$/gmu)?.length,
          1,
        );
        assert.strictEqual(
          (
            await lstat(
              path.join(generated, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );
        await execa("pnpm", ["exec", "oxfmt", "--version"], { cwd: generated });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
