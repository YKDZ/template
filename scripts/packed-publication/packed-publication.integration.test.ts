import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
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
  realpath,
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
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { checkPresetPublicationSources } from "@ykdz/template-checks/publication-source";
import {
  assertWorkflowContract,
  assertPublicationWorkflowContract,
} from "@ykdz/template-checks/workflow-contract";
import type { PackageRole } from "@ykdz/template-core/project-blueprint";
import type { DefaultWorkspaceCreationInput } from "@ykdz/template-workspace/default-workspace-strategy";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { execa as runExeca } from "execa";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const publicCliPackageName = ["@ykdz", "template"].join("/");
type PackedRuntime = Parameters<typeof checkPresetPublicationSources>[0];
type PackedRuntimeWithCollectionProjection = PackedRuntime & {
  readonly deriveTemplateMembers: typeof import("@ykdz/template-content").deriveTemplateMembers;
  readonly definePreset: typeof import("@ykdz/template-core/preset-definition").definePreset;
};
type PackedPreset = Extract<
  PackedRuntime["content"][number],
  { readonly kind: "preset" }
>;
type PackedReference = Extract<
  PackedRuntime["content"][number],
  { readonly manifest: unknown }
>;
type PackedReceipt = Parameters<typeof assertWorkflowContract>[0];
type PackedCreationInput = DefaultWorkspaceCreationInput<TsCliCreationInput>;
const turboExecutablePath = fileURLToPath(import.meta.resolve("turbo"));
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
  ".verified-packed-publication",
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
let passedPackedConsumers = 0;
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
  const installation = existsSync(
    path.join(options.consumerPath, "package-lock.json"),
  )
    ? "npm install"
    : "pnpm add";
  return [
    `cd ${JSON.stringify(options.consumerPath)}`,
    `${installation} ${JSON.stringify(options.archivePath)}`,
    `cd ${JSON.stringify(options.sourcePath)}`,
    `TEMPLATE_CLI_JOURNEY_MODE=packed TEMPLATE_CLI_PACKED_BIN=${JSON.stringify(path.join(options.consumerPath, "node_modules/.bin/template"))} TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR=${JSON.stringify(options.artifactRoot)} pnpm --filter @ykdz/template run test:e2e:packed`,
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
  readonly stageName?: string;
  readonly diagnosticsRoot?: string;
}): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  const active = options.active;
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
      "pnpm",
      ["--filter", publicCliPackageName, "run", "test:e2e:packed"],
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
  const sourceRoot = process.cwd();
  const consumerRoot = path.join(options.workspace, "consumer");
  const archiveCopy = path.join(diagnostics, "template-package.tgz");
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
    source: sourceRoot,
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
            sourcePath: sourceRoot,
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    receivedPackedSignal ??= signal;
    preservePackedWorkspaceAfterSignal = true;
    packedCancellationController.abort(new Error(`收到 ${signal} 信号`));
    const active = activePackedRun;
    const diagnostics = active?.diagnostics ?? journeyDiagnosticsRoot;
    mkdirSync(diagnostics, { recursive: true });
    const source = active === undefined ? undefined : process.cwd();
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
  const archiveDirectory = path.join(workspace, "archives");
  await mkdir(archiveDirectory, { recursive: true });
  await execa(
    "pnpm",
    [
      "--filter",
      publicCliPackageName,
      "run",
      "pack:bundled",
      "--pack-destination",
      archiveDirectory,
    ],
    { cwd: process.cwd() },
  );
  const archives = (await readdir(archiveDirectory)).filter((file) =>
    file.endsWith(".tgz"),
  );
  assert.strictEqual(archives.length, 1);
  return path.join(archiveDirectory, archives[0]!);
}

async function prepareVerifiedPackedArtifactDirectory(): Promise<void> {
  const outputDirectory = process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
  if (outputDirectory === undefined || outputDirectory.length === 0) return;
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
}

async function writeVerifiedPackedArtifact(
  packedArchivePath: string | undefined,
): Promise<void> {
  const outputDirectory = process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
  if (outputDirectory === undefined || outputDirectory.length === 0) return;
  if (passedPackedConsumers !== 2 || receivedPackedSignal !== undefined) {
    throw new Error("两个 packed 消费者未全部成功，不能保留发布候选。");
  }
  if (packedArchivePath === undefined) {
    throw new Error("packed 消费者通过后缺少已验证归档。");
  }

  const archiveName = path.basename(packedArchivePath);
  const outputArchive = path.join(outputDirectory, archiveName);
  await cp(packedArchivePath, outputArchive);
  const digest = createHash("sha512")
    .update(await readFile(outputArchive))
    .digest("hex");
  await writeFile(
    path.join(outputDirectory, "SHA512SUMS"),
    `${digest}  ${archiveName}\n`,
  );
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

  const fromConsumer = createRequire(path.join(consumer, "package.json"));
  const fromCli = createRequire(fromConsumer.resolve(publicCliPackageName));
  const projection = (await import(
    pathToFileURL(fromCli.resolve("@ykdz/template-core/project-projection"))
      .href
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

async function loadPackedRuntime(
  fromCli: ReturnType<typeof createRequire>,
): Promise<PackedRuntimeWithCollectionProjection> {
  const [
    content,
    generator,
    workspace,
    renderer,
    projectLinking,
    presetDefinition,
  ] = await Promise.all([
    import(
      pathToFileURL(fromCli.resolve("@ykdz/template-content")).href
    ) as Promise<typeof import("@ykdz/template-content")>,
    import(
      pathToFileURL(fromCli.resolve("@ykdz/template-generator")).href
    ) as Promise<typeof import("@ykdz/template-generator")>,
    import(
      pathToFileURL(
        fromCli.resolve("@ykdz/template-workspace/default-workspace-strategy"),
      ).href
    ) as Promise<
      typeof import("@ykdz/template-workspace/default-workspace-strategy")
    >,
    import(
      pathToFileURL(fromCli.resolve("@ykdz/template-core/renderer")).href
    ) as Promise<typeof import("@ykdz/template-core/renderer")>,
    import(
      pathToFileURL(fromCli.resolve("@ykdz/template-workspace/project-linking"))
        .href
    ) as Promise<typeof import("@ykdz/template-workspace/project-linking")>,
    import(
      pathToFileURL(fromCli.resolve("@ykdz/template-core/preset-definition"))
        .href
    ) as Promise<typeof import("@ykdz/template-core/preset-definition")>,
  ]);
  return {
    content: content.templateContent,
    deriveTemplateMembers: content.deriveTemplateMembers,
    createGenerator: generator.createGenerator,
    createDefaultWorkspaceStrategy: workspace.createDefaultWorkspaceStrategy,
    resolveTemplateSource: renderer.resolveTemplateSource,
    canConsumeNodePackageNameImportForRole:
      projectLinking.canConsumeNodePackageNameImportForRole,
    canProvideSourceConditionPackageNameImportForRole:
      projectLinking.canProvideSourceConditionPackageNameImportForRole,
    definePreset: presetDefinition.definePreset,
  };
}

function createPackedGenerator(runtime: PackedRuntime) {
  return runtime.createGenerator({
    content: runtime.content,
    strategy: runtime.createDefaultWorkspaceStrategy<PackedCreationInput>(),
  });
}

function packedPresets(
  runtime: PackedRuntimeWithCollectionProjection,
): readonly PackedPreset[] {
  return runtime.deriveTemplateMembers(runtime.content).presets;
}

async function registerTestOwnedCollectionMember(options: {
  readonly runtime: PackedRuntimeWithCollectionProjection;
  readonly workspace: string;
  readonly fromCli: NodeJS.Require;
}): Promise<{
  readonly runtime: PackedRuntimeWithCollectionProjection;
  readonly presetAlias: string;
  readonly packageName: string;
  readonly preset: PackedPreset;
  readonly packageManifest: {
    readonly name: string;
    readonly exports: { readonly "./template": string };
    readonly dependencies: Readonly<Record<string, string>>;
  };
  readonly publicEntry: string;
}> {
  const originalMembers = options.runtime.deriveTemplateMembers(
    options.runtime.content,
  );
  const sourceReference = originalMembers.referencePackages.find(
    (reference) => reference.manifest.name === "@ykdz/reference-ts-lib",
  );
  if (sourceReference === undefined) {
    throw new Error("已安装内容缺少测试内容使用的真实 TypeScript 库依赖");
  }
  const referencePackageRoot = path.dirname(
    options.fromCli.resolve(`${sourceReference.manifest.name}/reference`),
  );
  const packageName = "@fixture/single-registration-library";
  const packageRoot = path.join(options.workspace, "test-owned-content");
  const relativeReferencePackage = path
    .relative(packageRoot, referencePackageRoot)
    .split(path.sep)
    .join("/");
  const packageManifest = {
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { "./template": "./template.mjs" },
    dependencies: {
      [sourceReference.manifest.name]: `file:${relativeReferencePackage}`,
    },
    devDependencies: {
      "@ykdz/reference-typescript-config": "workspace:*",
    },
  };
  await mkdir(path.join(packageRoot, "node_modules", "@ykdz"), {
    recursive: true,
  });
  await symlink(
    referencePackageRoot,
    path.join(packageRoot, "node_modules", "@ykdz", "reference-ts-lib"),
    "dir",
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "template.mjs"),
    [
      'import { referencePackage as sourceReference } from "@ykdz/reference-ts-lib/template";',
      'import packageManifest from "./package.json" with { type: "json" };',
      "export const referencePackage = {",
      "  ...sourceReference,",
      '  identity: "test:single-registration-library",',
      '  defaultLeafName: "single-registration-library",',
      '  defaultPath: "packages/single-registration-library",',
      "  manifest: packageManifest,",
      "};",
      "",
    ].join("\n"),
  );
  const packageLink = path.join(
    options.workspace,
    "node_modules",
    "@fixture",
    "single-registration-library",
  );
  await mkdir(path.dirname(packageLink), { recursive: true });
  await symlink(packageRoot, packageLink, "dir");
  const fromWorkspace = createRequire(
    path.join(options.workspace, "package.json"),
  );
  const publicEntry = fromWorkspace.resolve(`${packageName}/template`);
  const loadedPackage = (await import(pathToFileURL(publicEntry).href)) as {
    readonly referencePackage: PackedReference;
  };
  const fixtureReference = loadedPackage.referencePackage;
  assert.deepStrictEqual(fixtureReference.manifest, packageManifest);
  assert.ok(
    Object.hasOwn(packageManifest.dependencies, sourceReference.manifest.name),
    `测试内容包必须声明真实模板依赖 ${sourceReference.manifest.name}`,
  );
  const fixturePreset = options.runtime.definePreset({
    metadata: {
      alias: "single-registration-fixture",
      title: "单次登记测试预设",
      description: "通过真实已安装参考包验证集合派生",
    },
    operations: ["init"],
    nodes: { library: { reference: fixtureReference } },
  });
  const registeredContent = [
    ...options.runtime.content,
    fixtureReference,
    fixturePreset,
  ] as unknown as PackedRuntime["content"];
  const registeredMembers =
    options.runtime.deriveTemplateMembers(registeredContent);
  assert.strictEqual(
    (registeredMembers.presets as readonly unknown[]).filter(
      (member) => member === fixturePreset,
    ).length,
    1,
    "测试预设只在内容集合登记一次",
  );
  assert.strictEqual(
    (registeredMembers.referencePackages as readonly unknown[]).filter(
      (member) => member === fixtureReference,
    ).length,
    1,
    "测试参考包只在内容集合登记一次",
  );
  assert.ok(
    !(originalMembers.presets as readonly unknown[]).includes(fixturePreset),
    "未登记的预设不进入选择器",
  );
  assert.ok(
    !(originalMembers.referencePackages as readonly unknown[]).includes(
      fixtureReference,
    ),
    "未登记的参考包不进入打包根",
  );
  assert.ok(
    (registeredMembers.referencePackages as readonly unknown[]).includes(
      fixtureReference,
    ),
    "登记后的真实参考依赖进入打包根输入",
  );

  const withoutReference = [
    ...options.runtime.content,
    fixturePreset,
  ] as unknown as PackedRuntime["content"];
  assert.throws(
    () =>
      options.runtime.createGenerator({
        content: withoutReference,
        strategy:
          options.runtime.createDefaultWorkspaceStrategy<PackedCreationInput>(),
      }),
    /显式内容集合缺少预设参考成员/u,
    "缺少声明的真实模板依赖必须明确失败",
  );

  return {
    runtime: {
      ...options.runtime,
      content: registeredContent,
    },
    presetAlias: fixturePreset.metadata.alias,
    packageName: fixtureReference.manifest.name,
    preset: fixturePreset,
    packageManifest,
    publicEntry,
  };
}

async function generatePackedPreset(options: {
  readonly generator: ReturnType<typeof createPackedGenerator>;
  readonly preset: PackedPreset;
  readonly targetRoot: string;
  readonly packageScope: string;
  readonly todo?: boolean;
  readonly dryRun?: boolean;
}): Promise<PackedReceipt> {
  const result = await options.generator.init({
    targetRoot: options.targetRoot,
    selection: { roots: [{ preset: options.preset }] },
    strategyInput: {
      repositoryName: path.basename(options.targetRoot),
      defaultPackageScope: options.packageScope,
      todo: options.todo ?? true,
    },
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  if (
    result.status !== "success" ||
    result.projection === null ||
    result.projection === undefined ||
    result.projection.blueprint === undefined ||
    result.projection.ownerFacts === undefined
  ) {
    throw new Error(
      `packed runtime 未为 ${options.preset.metadata.alias} 返回初始化收据：${JSON.stringify(result)}`,
    );
  }
  const successful = result as PackedReceipt["result"];
  return {
    status: "generated",
    scenario: {
      id: `init--${options.preset.metadata.alias}`,
      label: `initialize ${options.preset.metadata.alias}`,
      base: options.preset,
    },
    projectDir: options.targetRoot,
    initialization: successful,
    result: successful,
    linkFrom: [],
  };
}

async function addPackedPreset(options: {
  readonly generator: ReturnType<typeof createPackedGenerator>;
  readonly preset: PackedPreset;
  readonly base: PackedReceipt;
  readonly packageLeafName: string;
  readonly packagePath?: string;
  readonly dryRun?: boolean;
}): Promise<PackedReceipt> {
  const result = await options.generator.add({
    repositoryRoot: options.base.projectDir,
    preset: options.preset,
    creationInput: {
      leafName: options.packageLeafName,
      ...(options.packagePath === undefined
        ? {}
        : { packagePath: options.packagePath }),
    },
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  if (
    result.status !== "success" ||
    result.projection === null ||
    result.projection === undefined ||
    result.projection.blueprint === undefined ||
    result.projection.ownerFacts === undefined
  ) {
    throw new Error(
      `packed runtime 未为 ${options.preset.metadata.alias} 返回添加收据：${JSON.stringify(result)}`,
    );
  }
  const successful = result as PackedReceipt["result"];
  return {
    status: "generated",
    scenario: {
      id: `${options.base.scenario.id}--add--${options.preset.metadata.alias}`,
      label: `${options.base.scenario.label}, then add ${options.preset.metadata.alias}`,
      base: options.base.scenario.base,
      addition: options.preset,
    },
    projectDir: options.base.projectDir,
    initialization: options.base.result,
    result: successful,
    linkFrom: [],
  };
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
  const rootTurbo = JSON.parse(
    await readFile(path.join(projectDir, "turbo.json"), "utf8"),
  ) as { readonly tasks: Readonly<Record<string, unknown>> };
  const checkCommand = manifest.scripts.check;
  if (checkCommand === undefined) {
    throw new Error("Generated Repository root manifest must define check");
  }
  assert.strictEqual(
    checkCommand,
    "node --conditions=source scripts/task-gates.ts check",
  );
  assert.strictEqual(
    manifest.scripts["check:heavy"],
    "node --conditions=source scripts/task-gates.ts check:heavy",
  );
  assert.strictEqual(
    manifest.scripts["check:full"],
    "node --conditions=source scripts/task-gates.ts check:full",
  );

  assert.strictEqual(
    manifest.scripts.fix,
    "node --conditions=source scripts/task-gates.ts fix",
  );

  const rootTaskNames = Object.keys(rootTurbo.tasks)
    .filter((name) => name.startsWith("//#"))
    .map((name) => name.slice(3))
    .toSorted();
  assert.ok(rootTaskNames.length > 0, "生成根包应拥有自己的 Turbo 任务");
  assert.deepStrictEqual(
    rootTaskNames,
    Object.keys(manifest.scripts).toSorted(),
    "生成根 Turbo 任务应与根 manifest 命令闭合",
  );

  const nativeDirectory = await runExeca(
    turboExecutablePath,
    ["query", packageOwnedTaskQuery],
    { cwd: projectDir },
  );
  const nativePackages = (
    JSON.parse(nativeDirectory.stdout) as {
      readonly data: {
        readonly packages: { readonly items: readonly NativeTurboPackage[] };
      };
    }
  ).data.packages.items;
  const rootPackage = nativePackages.find((pkg) => pkg.name === "//");
  assert.notStrictEqual(rootPackage, undefined, "Turbo 应发现生成根包");
  for (const nativePackage of nativePackages) {
    if (nativePackage.name !== "//") {
      assert.ok(
        nativePackage.tags.length > 0,
        `${nativePackage.name} 应保留包边界标签归属`,
      );
    }
    for (const task of nativePackage.tasks.items) {
      const roles = task.tags.filter(
        (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
      );
      const executable =
        (task.script !== null && task.script.trim().length > 0) ||
        (task.command !== null && task.command.trim().length > 0);
      assert.equal(
        roles.length,
        executable ? 1 : 0,
        `${task.fullName} 应仅在有命令时声明唯一职责标签`,
      );
    }
  }
}

type NativeTurboPackage = {
  readonly name: string;
  readonly tags: readonly string[];
  readonly tasks: {
    readonly items: readonly {
      readonly name: string;
      readonly fullName: string;
      readonly tags: readonly string[];
      readonly script: string | null;
      readonly command: string | null;
    }[];
  };
};

const packageOwnedTaskQuery =
  "{ packages { items { name tags tasks { items { name fullName tags script command } } } } }";

async function expectPackedHardenedRootCheckWorkflow(
  projectDir: string,
  receipt: PackedReceipt,
): Promise<void> {
  const generatedPath = ".github/workflows/check.yml";
  const source = await readFile(path.join(projectDir, generatedPath), "utf8");
  assertWorkflowContract(receipt, generatedPath, source, parseYaml(source));
  if (receipt.result.projection.ownerFacts.publication.candidate !== null) {
    const releaseSource = await readFile(
      path.join(projectDir, ".github/workflows/release.yml"),
      "utf8",
    );
    assertPublicationWorkflowContract(
      receipt,
      releaseSource,
      parseYaml(releaseSource),
    );
  }
}

async function assertWorkflowArtifactParity(
  projectDir: string,
  receipt: PackedReceipt,
): Promise<void> {
  const generatedPaths = [
    ".github/workflows/check.yml",
    ...(receipt.result.projection.ownerFacts.publication.candidate === null
      ? []
      : [".github/workflows/release.yml"]),
  ];
  for (const generatedPath of generatedPaths) {
    assert.strictEqual(
      await readFile(path.join(projectDir, generatedPath), "utf8"),
      await readFile(path.join(receipt.projectDir, generatedPath), "utf8"),
      `CLI 输出应与同一归档 generator 的 ${generatedPath} 投影一致`,
    );
  }
}

void describe("packed public CLI consumer", () => {
  let archiveWorkspace: string | undefined;
  let packedArchivePath: string | undefined;

  before(
    async () => {
      await prepareVerifiedPackedArtifactDirectory();
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
    try {
      await writeVerifiedPackedArtifact(packedArchivePath);
    } finally {
      if (
        !preservePackedWorkspaceAfterSignal &&
        archiveWorkspace !== undefined
      ) {
        await rm(archiveWorkspace, { recursive: true, force: true });
      }
      activePackedRun = undefined;
    }
  });

  void it(
    "runs the archive alone: import, help, every initialization, and package addition",
    { timeout: 1_200_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-packed-consumer-"),
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
          "package/node_modules/@ykdz/template-content/package.json",
          "package/node_modules/@ykdz/template-generator/package.json",
          "package/node_modules/@ykdz/template-workspace/package.json",
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
              /(?:^|\/)(?:\.turbo|\.cache|\.pnpm)(?:\/|$)/u.test(entry) ||
              /\/dist\/.*\.(?:light|integration)\.test\.(?:[cm]?js|d\.ts)$/u.test(
                entry,
              ) ||
              /\/(?:reference-packages|assets)\/.*\/node_modules(?:\/|$)/u.test(
                entry,
              ) ||
              entry.startsWith("package/test/") ||
              entry.includes("/.template/") ||
              entry.includes("template-checks") ||
              entry.includes("template-builtin-presets"),
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
            },
        );
        assert.partialDeepStrictEqual(packedManifest, {
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
          "@ykdz/template-content",
          "@ykdz/template-generator",
          "@ykdz/template-workspace",
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
          "@ykdz/template-content",
          "@ykdz/template-generator",
          "@ykdz/template-environment",
          "@ykdz/template-workspace",
          "@ykdz/template-workspace-authoring",
          "@ykdz/cli-contract",
          "@valibot/to-json-schema",
          "typescript",
        ]) {
          assert.ok(bundledDependencies.includes(dependencyName));
        }
        assert.ok(
          !bundledDependencies.includes("@ykdz/template-builtin-presets"),
        );
        assert.ok(Object.hasOwn(packedDependencies, "typescript"));
        assert.ok(
          !Object.hasOwn(packedCoreManifest.dependencies ?? {}, "typescript"),
        );
        await mkdir(consumer, { recursive: true });
        activeRun.stage = "安装 packed 消费者";
        await execa("npm", ["init", "--yes"], { cwd: consumer });
        await execa("npm", ["install", archivePath], { cwd: consumer });
        const fromConsumer = createRequire(path.join(consumer, "package.json"));
        const installedCliEntry = await realpath(
          fromConsumer.resolve(publicCliPackageName),
        );
        assert.ok(
          installedCliEntry.startsWith(
            `${await realpath(path.join(consumer, "node_modules"))}${path.sep}`,
          ),
          `CLI 默认入口越出隔离消费者：${installedCliEntry}`,
        );
        const fromCli = createRequire(installedCliEntry);
        const installedRuntime = await loadPackedRuntime(fromCli);
        const installedGenerator = createPackedGenerator(installedRuntime);
        const presetsInArchive = packedPresets(installedRuntime).filter(
          (preset) => preset.operations.includes("init"),
        );
        const testOwnedCollection = await registerTestOwnedCollectionMember({
          runtime: installedRuntime,
          workspace,
          fromCli,
        });
        const defaultReferenceNames = new Set(
          installedRuntime
            .deriveTemplateMembers(installedRuntime.content)
            .referencePackages.map((reference) => reference.manifest.name),
        );
        const registeredReferenceNames = testOwnedCollection.runtime
          .deriveTemplateMembers(testOwnedCollection.runtime.content)
          .referencePackages.map((reference) => reference.manifest.name);
        assert.ok(!defaultReferenceNames.has(testOwnedCollection.packageName));
        assert.ok(
          registeredReferenceNames.includes(testOwnedCollection.packageName),
        );
        assert.ok(
          testOwnedCollection.runtime
            .deriveTemplateMembers(testOwnedCollection.runtime.content)
            .presets.some(
              (preset) =>
                preset.metadata.alias === testOwnedCollection.presetAlias,
            ),
          "已登记的新预设进入唯一选择投影",
        );
        const fixtureOnlyRuntime: PackedRuntime = {
          ...testOwnedCollection.runtime,
          content: testOwnedCollection.runtime.content.filter(
            (member) =>
              !("kind" in member) || member === testOwnedCollection.preset,
          ) as unknown as PackedRuntime["content"],
        };
        const fixturePublicationSources =
          await checkPresetPublicationSources(fixtureOnlyRuntime);
        assert.strictEqual(
          fixturePublicationSources.scenariosVerified,
          1,
          "登记后的单个预设应成为正式检查入口的唯一场景",
        );
        assert.ok(fixturePublicationSources.resourcesRead > 0);
        await writeFile(
          path.join(workspace, "collection-derivation-proof.json"),
          JSON.stringify(
            {
              presetAlias: testOwnedCollection.presetAlias,
              fixturePackageName: testOwnedCollection.packageName,
              registeredPresetCount: 1,
              registeredReferenceCount: 1,
              checkScenariosVerified:
                fixturePublicationSources.scenariosVerified,
              sourceResourcesRead: fixturePublicationSources.resourcesRead,
              testOwnedPackage: {
                name: testOwnedCollection.packageManifest.name,
                templateExport:
                  testOwnedCollection.packageManifest.exports["./template"],
                referenceDependency:
                  testOwnedCollection.packageManifest.dependencies[
                    "@ykdz/reference-ts-lib"
                  ],
                publicEntryLoaded: true,
              },
              unregisteredPresetExposed: installedRuntime
                .deriveTemplateMembers(installedRuntime.content)
                .presets.some(
                  (preset) =>
                    preset.metadata.alias === testOwnedCollection.presetAlias,
                ),
              fixtureDependencyDeclared: Object.hasOwn(
                testOwnedCollection.packageManifest.dependencies,
                "@ykdz/reference-ts-lib",
              ),
              packRootReferenceNames: registeredReferenceNames,
            },
            null,
            2,
          ),
        );
        const initializationReceipts = new Map<string, PackedReceipt>();
        const additionReceipts = new Map<string, PackedReceipt>();
        const publicationSources = await checkPresetPublicationSources(
          testOwnedCollection.runtime,
        );
        assert.strictEqual(
          publicationSources.scenariosVerified,
          35,
          "新增测试预设应把实际 init/add 检查范围从 30 个场景扩到 35 个",
        );
        assert.ok(publicationSources.resourcesRead > 0);
        await writeFile(
          path.join(workspace, "publication-resources.json"),
          JSON.stringify(publicationSources, null, 2),
        );
        const compiler = fromCli("typescript") as { readonly version: string };
        assert.match(compiler.version, /^6\./u);
        await execa("npm", ["ls", "--omit=dev", "--all"], { cwd: consumer });
        for (const dependency of [
          "vue",
          "vike",
          "hono",
          "drizzle-orm",
          "vite",
        ]) {
          assert.throws(() => fromCli.resolve(dependency), {
            code: "MODULE_NOT_FOUND",
          });
        }
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
        assert.match(journeyOutput, /^# tests [1-9]\d*$/mu);
        assert.match(journeyOutput, /^# fail 0$/mu);
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
          title: string;
          description: string;
        }[];
        assert.deepStrictEqual(
          definitions.map(({ name }) => name).toSorted(),
          presetsInArchive.map(({ metadata }) => metadata.alias).toSorted(),
          "packed CLI 目录应直接来自已安装内容集合",
        );
        assert.ok(definitions.length > 0);
        for (const preset of presetsInArchive) {
          const alias = preset.metadata.alias;
          const oracleRoot = path.join(consumer, "generator-oracle", alias);
          const receipt = await generatePackedPreset({
            generator: installedGenerator,
            preset,
            targetRoot: oracleRoot,
            packageScope: alias,
          });
          initializationReceipts.set(alias, receipt);
          await expectPackedHardenedRootCheckWorkflow(oracleRoot, receipt);
          await execa(
            installedBin,
            [
              "init",
              path.join(consumer, "generated", alias),
              "--preset",
              alias,
            ],
            {
              cwd: consumer,
            },
          );
          await expectNativeTaskModel(path.join(consumer, "generated", alias));
          await assertWorkflowArtifactParity(
            path.join(consumer, "generated", alias),
            receipt,
          );
        }

        const presetWithInitialRole = (role: PackageRole): PackedPreset => {
          const preset = presetsInArchive.find((candidate) =>
            initializationReceipts
              .get(candidate.metadata.alias)
              ?.result.blueprint.packages.some(
                (definition) => definition.role === role,
              ),
          );
          if (preset === undefined) {
            throw new Error(`已安装内容没有初始包角色 ${role} 的预设`);
          }
          return preset;
        };
        const presetWithAddedRole = (role: PackageRole): PackedPreset => {
          const preset = presetsInArchive.find((candidate) =>
            additionReceipts
              .get(candidate.metadata.alias)
              ?.result.blueprint.packages.some(
                (definition) =>
                  definition.path === "packages/archive-addition" &&
                  definition.role === role,
              ),
          );
          if (preset === undefined) {
            throw new Error(`已安装内容没有新增包角色 ${role} 的预设`);
          }
          return preset;
        };
        const presetWithPackagePath = (packagePath: string): PackedPreset => {
          const preset = presetsInArchive.find((candidate) =>
            initializationReceipts
              .get(candidate.metadata.alias)
              ?.result.blueprint.packages.some(
                (definition) => definition.path === packagePath,
              ),
          );
          if (preset === undefined) {
            throw new Error(`已安装内容没有输出包路径 ${packagePath} 的预设`);
          }
          return preset;
        };

        const sharedLibraryDefinition = presetWithAddedRole("shared-library");
        const sharedLibraryProject = path.join(
          consumer,
          "generated",
          sharedLibraryDefinition.metadata.alias,
        );
        await execa("pnpm", ["install"], { cwd: sharedLibraryProject });

        const cliToolDefinition = presetWithAddedRole("cli-tool");
        const cliToolProject = path.join(
          consumer,
          "generated",
          cliToolDefinition.metadata.alias,
        );
        await execa("pnpm", ["install"], { cwd: cliToolProject });

        const nativePackageDefinition = presetWithAddedRole("native-package");
        const nativePackageProject = path.join(
          consumer,
          "generated",
          nativePackageDefinition.metadata.alias,
        );
        await execa("pnpm", ["install"], { cwd: nativePackageProject });

        const deploymentDefinition = presetWithPackagePath("packages/db");
        const deploymentProject = path.join(
          consumer,
          "generated",
          deploymentDefinition.metadata.alias,
        );
        await execa("pnpm", ["install"], { cwd: deploymentProject });

        const expectedAddableDefinitions = presetsInArchive
          .filter((preset) => preset.operations.includes("add"))
          .map((preset) => preset.metadata.alias)
          .toSorted();
        const completedAdditions: string[] = [];
        for (const preset of presetsInArchive) {
          const alias = preset.metadata.alias;
          const generatedProject = path.join(consumer, "generated", alias);
          const baseReceipt = initializationReceipts.get(alias);
          assert.notStrictEqual(baseReceipt, undefined);
          const additionReceipt = preset.operations.includes("add")
            ? await addPackedPreset({
                generator: installedGenerator,
                preset,
                base: baseReceipt!,
                packageLeafName: "archive-addition",
                packagePath: "packages/archive-addition",
              })
            : undefined;
          activeRun.stage = `添加 ${alias} 预设包`;
          const result = await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              alias,
              "--name",
              "archive-addition",
              "--path",
              "packages/archive-addition",
            ],
            {
              cwd: generatedProject,
              reject: false,
            },
          );
          throwIfPackedCommandWasCancelled(result, `向 ${alias} 预设添加包`);
          if (result.exitCode === 0) {
            completedAdditions.push(alias);
            assert.notStrictEqual(additionReceipt, undefined);
            additionReceipts.set(alias, additionReceipt!);
            await expectNativeTaskModel(
              path.join(consumer, "generated", alias),
            );
            await expectPackedHardenedRootCheckWorkflow(
              additionReceipt!.projectDir,
              additionReceipt!,
            );
            await assertWorkflowArtifactParity(
              generatedProject,
              additionReceipt!,
            );
          } else {
            assert.strictEqual(
              additionReceipt,
              undefined,
              `${alias} 实际不支持 add 时，内容操作元数据应同步声明`,
            );
          }
        }
        assert.deepStrictEqual(
          completedAdditions.toSorted(),
          expectedAddableDefinitions,
        );

        const sharedLibraryAdditionDefinition =
          presetWithAddedRole("shared-library");
        const sharedLibraryAdditionProject = path.join(
          consumer,
          "generated",
          sharedLibraryAdditionDefinition.metadata.alias,
        );
        await execa("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: sharedLibraryAdditionProject,
        });

        const cliToolAdditionDefinition = presetWithAddedRole("cli-tool");
        const cliToolAdditionProject = path.join(
          consumer,
          "generated",
          cliToolAdditionDefinition.metadata.alias,
        );
        await execa("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: cliToolAdditionProject,
        });

        const nativePackageAdditionDefinition =
          presetWithAddedRole("native-package");
        const nativePackageAdditionProject = path.join(
          consumer,
          "generated",
          nativePackageAdditionDefinition.metadata.alias,
        );
        await execa("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: nativePackageAdditionProject,
        });

        const rustDefinition = presetWithAddedRole("native-package");
        const nonRustBase = presetsInArchive.find((preset) => {
          const receipt = initializationReceipts.get(preset.metadata.alias);
          return receipt?.result.projection.operations.every(
            (operation) =>
              !("to" in operation && operation.to === "rust-toolchain.toml"),
          );
        });
        assert.notStrictEqual(nonRustBase, undefined);
        const nonRustBaseReceipt = initializationReceipts.get(
          nonRustBase!.metadata.alias,
        );
        assert.notStrictEqual(nonRustBaseReceipt, undefined);
        const rustAdditionTarget = path.join(
          consumer,
          "generated",
          nonRustBase!.metadata.alias,
        );
        const rustOracleTarget = nonRustBaseReceipt!.projectDir;
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
            rustDefinition.metadata.alias,
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
        const rustPreviewReceipt = await addPackedPreset({
          generator: installedGenerator,
          preset: rustDefinition,
          base: nonRustBaseReceipt!,
          packageLeafName: "worker",
          dryRun: true,
        });
        assert.strictEqual(rustPreviewReceipt.result.dryRun, true);
        assert.deepStrictEqual(
          rustPreview.actions,
          rustPreviewReceipt.result.actions,
        );
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
            rustDefinition.metadata.alias,
            "--name",
            "worker",
          ],
          {
            cwd: rustAdditionTarget,
          },
        );
        const rustAdditionReceipt = await addPackedPreset({
          generator: installedGenerator,
          preset: rustDefinition,
          base: nonRustBaseReceipt!,
          packageLeafName: "worker",
        });
        const rustManifest = JSON.parse(
          await readFile(
            path.join(rustAdditionTarget, "packages/worker/package.json"),
            "utf8",
          ),
        ) as { readonly name: string };
        const initialRustBasePackage =
          nonRustBaseReceipt!.result.blueprint.packages[0];
        assert.notStrictEqual(initialRustBasePackage, undefined);
        const packageScope =
          initialRustBasePackage!.name.match(/^@([^/]+)\//u)?.[1];
        assert.notStrictEqual(packageScope, undefined);
        assert.strictEqual(rustManifest.name, `@${packageScope}/worker`);
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
        const rustToolchain = parseToml(rustToolchainAfterRust).toolchain;
        assert.ok(
          typeof rustToolchain === "object" &&
            rustToolchain !== null &&
            "components" in rustToolchain,
        );
        assert.ok(Array.isArray(rustToolchain.components));
        assert.deepStrictEqual(
          new Set(rustToolchain.components),
          new Set(["clippy", "rustfmt"]),
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
        const rootManifestAfterRust = JSON.parse(
          await readFile(path.join(rustAdditionTarget, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const rootCheckScript = rootManifestAfterRust.scripts.check;
        assert.strictEqual(
          rootCheckScript,
          "node --conditions=source scripts/task-gates.ts check",
        );
        assert.strictEqual(
          rootManifestAfterRust.scripts["check:heavy"],
          "node --conditions=source scripts/task-gates.ts check:heavy",
        );
        assert.strictEqual(
          rootManifestAfterRust.scripts["check:full"],
          "node --conditions=source scripts/task-gates.ts check:full",
        );

        await execa("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: rustAdditionTarget,
        });
        await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });
        await expectPackedHardenedRootCheckWorkflow(
          rustOracleTarget,
          rustAdditionReceipt,
        );
        await assertWorkflowArtifactParity(
          rustAdditionTarget,
          rustAdditionReceipt,
        );

        const cliAdditionDefinition = presetWithAddedRole("cli-tool");
        const cliTarget = path.join(
          consumer,
          "generated",
          cliAdditionDefinition.metadata.alias,
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
        const addSecondCli = async (): Promise<void> => {
          await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              cliAdditionDefinition.metadata.alias,
              "--name",
              "default-command",
            ],
            {
              cwd: cliTarget,
            },
          );
        };
        const cliBaseReceipt = initializationReceipts.get(
          cliAdditionDefinition.metadata.alias,
        );
        assert.notStrictEqual(cliBaseReceipt, undefined);
        const secondCliReceipt = await addPackedPreset({
          generator: installedGenerator,
          preset: cliAdditionDefinition,
          base: cliBaseReceipt!,
          packageLeafName: "default-command",
        });
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          secondCliReceipt.projectDir,
          secondCliReceipt,
        );
        await assertWorkflowArtifactParity(cliTarget, secondCliReceipt);
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
        const secondCliSnapshot = await workspaceByteSnapshot(cliTarget);
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          secondCliReceipt.projectDir,
          secondCliReceipt,
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(cliTarget),
          secondCliSnapshot,
        );

        const previewBaseDefinition = presetWithInitialRole("shared-library");
        const previewAdditionDefinition =
          presetWithAddedRole("runtime-service");
        const previewTarget = path.join(
          consumer,
          "generated",
          previewBaseDefinition.metadata.alias,
        );
        const reservedBefore = await workspaceByteSnapshot(previewTarget);
        const reservedPackagePath = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            previewAdditionDefinition.metadata.alias,
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
            previewAdditionDefinition.metadata.alias,
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
            previewAdditionDefinition.metadata.alias,
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
            previewAdditionDefinition.metadata.alias,
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
            previewAdditionDefinition.metadata.alias,
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
      passedPackedConsumers += 1;
    },
  );

  void it(
    "adds a package with the packed CLI after the generated repository is installed",
    { timeout: 120000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-packed-ready-add-"),
      );
      const consumer = path.join(workspace, "consumer");
      const generated = path.join(workspace, "digital");
      const activeRun: ActivePackedRun = {
        archiveWorkspace: archiveWorkspace!,
        workspace,
        consumer,
        diagnostics: journeyDiagnosticsRoot,
        stage: "准备 packed CLI 消费者",
      };
      activePackedRun = activeRun;
      let failed = false;
      let failure: unknown;
      try {
        try {
          assert.ok(packedArchivePath);
          const archivePath = packedArchivePath;
          activeRun.archivePath = archivePath;
          await mkdir(consumer, { recursive: true });
          activeRun.stage = "初始化 packed 消费者";
          await execa("npm", ["init", "--yes"], { cwd: consumer });
          activeRun.stage = "安装 packed CLI";
          await execa("pnpm", ["add", archivePath], { cwd: consumer });
          const fromConsumer = createRequire(
            path.join(consumer, "package.json"),
          );
          const fromCli = createRequire(
            fromConsumer.resolve(publicCliPackageName),
          );
          const installedRuntime = await loadPackedRuntime(fromCli);
          const installedGenerator = createPackedGenerator(installedRuntime);
          const presets = packedPresets(installedRuntime);
          let baseDefinition: PackedPreset | undefined;
          for (const preset of presets.filter((candidate) =>
            candidate.operations.includes("init"),
          )) {
            const receipt = await generatePackedPreset({
              generator: installedGenerator,
              preset,
              targetRoot: path.join(
                workspace,
                "selection",
                preset.metadata.alias,
              ),
              packageScope: "demo",
              dryRun: true,
            });
            if (
              receipt.result.blueprint.packages.some(
                (definition) => definition.path === "packages/db",
              )
            ) {
              baseDefinition = preset;
              break;
            }
          }
          assert.notStrictEqual(baseDefinition, undefined);
          const selectionReceipt = await generatePackedPreset({
            generator: installedGenerator,
            preset: baseDefinition!,
            targetRoot: path.join(workspace, "selection", "generated"),
            packageScope: "demo",
          });
          let additionDefinition: PackedPreset | undefined;
          for (const preset of presets.filter((candidate) =>
            candidate.operations.includes("add"),
          )) {
            const result = await installedGenerator.add({
              repositoryRoot: selectionReceipt.projectDir,
              preset,
              creationInput: { leafName: "role-probe" },
              dryRun: true,
            });
            if (result.status !== "success") {
              throw new Error(
                `packed runtime 无法对 ${preset.metadata.alias} 预览加包：${JSON.stringify(result)}`,
              );
            }
            const addedPackage = result.generationRecord.packages.find(
              (record) => record.createdBy === "addition",
            );
            if (addedPackage?.definition.role === "native-package") {
              additionDefinition = preset;
              break;
            }
          }
          assert.notStrictEqual(additionDefinition, undefined);

          const installedBin = path.join(
            consumer,
            "node_modules",
            ".bin",
            "template",
          );
          activeRun.packedBin = installedBin;
          activeRun.stage = `生成 ${baseDefinition!.metadata.alias} 仓库`;
          await execa(
            installedBin,
            [
              "init",
              generated,
              "--preset",
              baseDefinition!.metadata.alias,
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
          activeRun.stage = "安装生成仓库";
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
            activeRun.stage = `添加 ${packageName} 包`;
            try {
              await execa(
                installedBin,
                [
                  "add",
                  "package",
                  "--preset",
                  additionDefinition!.metadata.alias,
                  "--name",
                  packageName,
                  "--path",
                  `services/${packageName}`,
                ],
                {
                  cwd: generated,
                },
              );
            } catch (error) {
              if (
                receivedPackedSignal !== undefined &&
                typeof error === "object" &&
                error !== null &&
                "isCanceled" in error &&
                error.isCanceled === true
              ) {
                throw new Error(`packed CLI 添加 ${packageName} 包时已取消。`, {
                  cause: error,
                });
              }
              throw error;
            }
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
          await execa("pnpm", ["exec", "oxfmt", "--version"], {
            cwd: generated,
          });
        } catch (error) {
          failed = true;
          failure = error;
          try {
            const diagnostics = await preservePackedFailure({
              ...(activeRun.archivePath === undefined
                ? {}
                : { archivePath: activeRun.archivePath }),
              archiveWorkspace: activeRun.archiveWorkspace,
              workspace,
              error,
            });
            process.stderr.write(`\nPACKED_CLI_DIAGNOSTICS=${diagnostics}\n`);
          } catch (preservationError) {
            preservePackedWorkspaceAfterSignal = true;
            failure = new AggregateError(
              [error, preservationError],
              "packed CLI 失败，保存诊断材料时又发生错误。",
              { cause: error },
            );
          }
        }

        try {
          if (!preservePackedWorkspaceAfterSignal) {
            await rm(workspace, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          if (failed) {
            failure = new AggregateError(
              [failure, cleanupError],
              "packed CLI 失败，清理消费者临时目录时又发生错误。",
              { cause: failure },
            );
          } else {
            failed = true;
            failure = cleanupError;
            try {
              const diagnostics = await preservePackedFailure({
                ...(activeRun.archivePath === undefined
                  ? {}
                  : { archivePath: activeRun.archivePath }),
                archiveWorkspace: activeRun.archiveWorkspace,
                workspace,
                error: cleanupError,
              });
              process.stderr.write(`\nPACKED_CLI_DIAGNOSTICS=${diagnostics}\n`);
            } catch (preservationError) {
              preservePackedWorkspaceAfterSignal = true;
              failure = new AggregateError(
                [cleanupError, preservationError],
                "packed CLI 清理失败，保存诊断材料时又发生错误。",
                { cause: cleanupError },
              );
            }
          }
        }
        if (failed) throw failure;
      } finally {
        activePackedRun = undefined;
      }
      passedPackedConsumers += 1;
    },
  );
});
