import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse as parseSemver } from "semver";
import * as tar from "tar";

type NpmNameValidation = {
  readonly validForNewPackages: boolean;
  readonly validForOldPackages?: boolean;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
};

const require = createRequire(import.meta.url);
const validateNpmPackageName = require("validate-npm-package-name") as (
  name: string,
) => NpmNameValidation;
const execFileAsync = promisify(execFile);
const packageManifestName = "package.json";
const consumerScriptName = "publication:consume";

export type PublicationBlocker = {
  readonly code: string;
  readonly target: string;
  readonly field: string;
  readonly observed: string;
  readonly expected: string;
  readonly nextAction: string;
};

export type PublicationManifest = {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
  readonly scripts?: unknown;
  readonly [key: string]: unknown;
};

export type PublicationInspection =
  | {
      readonly kind: "ready";
      readonly packageRoot: string;
      readonly manifest: PublicationManifest;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly consumerCommand: string;
    }
  | {
      readonly kind: "blocked";
      readonly packageRoot: string;
      readonly blockers: readonly PublicationBlocker[];
    };

export type PublicationExecution = {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
};

export type PreparedArtifact = {
  readonly kind: "prepared";
  readonly packageRoot: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly sha512: string;
  readonly pack: PublicationExecution;
};

export type PublicationPreparationReceipt = {
  readonly schemaVersion: 1;
  /** 远端候选绑定的原始 Git 提交；普通本地候选可省略。 */
  readonly sourceSha?: string;
  /** 原件上传尝试前写入同一回执，防止不可见时本地盲目重发。 */
  readonly npmPublicationAttempt?: {
    readonly artifactSha512: string;
    readonly distTag: string;
    readonly workflowRunId?: string;
    readonly workflowRunAttempt?: number;
  };
  readonly target: {
    readonly name: string;
    readonly version: string;
  };
  readonly pack: {
    readonly count: 1;
    readonly command: string;
    readonly arguments: readonly string[];
  };
  readonly artifact: {
    readonly path: string;
    readonly name: string;
    readonly version: string;
    readonly sha512: string;
  };
  readonly acceptance?: {
    readonly packageName: string;
    readonly artifactVersion: string;
    readonly sha512: string;
    readonly installation: "passed";
    readonly consumption: "passed";
  };
};

export type ReadPreparedArtifactResult =
  | {
      readonly kind: "prepared";
      readonly receiptPath: string;
      readonly artifactPath: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly artifactVersion: string;
      readonly sha512: string;
      readonly packedManifest: PublicationManifest;
      readonly receipt: PublicationPreparationReceipt;
    }
  | {
      readonly kind: "blocked";
      readonly inspection: Extract<PublicationInspection, { kind: "blocked" }>;
    };

export type PrepareArtifactResult =
  | PreparedArtifact
  | {
      readonly kind: "blocked";
      readonly inspection: Extract<PublicationInspection, { kind: "blocked" }>;
    };

export type AcceptedArtifact = {
  readonly kind: "accepted";
  readonly packageRoot: string;
  readonly packageName: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly sha512: string;
  readonly installation: PublicationExecution;
  readonly consumption: PublicationExecution;
  readonly receiptPath?: string;
};

export type AcceptArtifactResult =
  | AcceptedArtifact
  | {
      readonly kind: "blocked";
      readonly inspection: Extract<PublicationInspection, { kind: "blocked" }>;
    };

export type PackAdapter = (options: {
  readonly packageRoot: string;
  readonly outputDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}) => Promise<{
  readonly artifactPath: string;
  readonly execution: PublicationExecution;
}>;

function blocker(options: PublicationBlocker): PublicationBlocker {
  return options;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function packageManifest(
  packageRoot: string,
): Promise<
  | { readonly kind: "parsed"; readonly manifest: PublicationManifest }
  | { readonly kind: "blocked"; readonly blocker: PublicationBlocker }
> {
  const manifestPath = path.join(packageRoot, packageManifestName);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    return {
      kind: "blocked",
      blocker: blocker({
        code: "publication-manifest-missing",
        target: packageRoot,
        field: packageManifestName,
        observed: error instanceof Error ? error.message : String(error),
        expected: `可读取的 ${packageManifestName}`,
        nextAction: `在 ${packageRoot} 创建有效的 ${packageManifestName}，声明 npm 包名称、版本及消费验收命令。`,
      }),
    };
  }
  try {
    const manifest = objectValue(JSON.parse(raw));
    if (manifest === undefined) throw new Error("根值不是 JSON 对象");
    return { kind: "parsed", manifest };
  } catch (error) {
    return {
      kind: "blocked",
      blocker: blocker({
        code: "publication-manifest-invalid",
        target: packageRoot,
        field: packageManifestName,
        observed: error instanceof Error ? error.message : String(error),
        expected: "有效的 npm package.json JSON 对象",
        nextAction: `修复 ${manifestPath} 的 JSON 语法后重新运行发布诊断。`,
      }),
    };
  }
}

async function digestFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha512").update(bytes).digest("hex");
}

async function execute(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly operation: string;
  },
): Promise<PublicationExecution> {
  try {
    const result = await execFileAsync(command, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      command,
      arguments: [...arguments_],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const record = objectValue(error);
    const exitCode = record?.code;
    const stdout = typeof record?.stdout === "string" ? record.stdout : "";
    const stderr = typeof record?.stderr === "string" ? record.stderr : "";
    throw new Error(
      `${options.operation}失败：${command} ${arguments_.join(" ")}；退出状态 ${String(exitCode)}。\n${stderr || stdout}`,
      { cause: error },
    );
  }
}

function archiveFromPackOutput(stdout: string): string | undefined {
  const firstObject = stdout.indexOf("{");
  if (firstObject < 0) return undefined;
  try {
    const value = JSON.parse(stdout.slice(firstObject)) as unknown;
    const record = Array.isArray(value) ? value[0] : value;
    const filename = objectValue(record)?.filename;
    return typeof filename === "string" ? filename : undefined;
  } catch {
    return undefined;
  }
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function packedManifest(
  artifactPath: string,
): Promise<PublicationManifest> {
  const extractionRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "npm-publication-manifest-")),
  );
  const manifestPath = path.join(
    extractionRoot,
    "package",
    packageManifestName,
  );
  try {
    await tar.extract({
      file: artifactPath,
      cwd: extractionRoot,
      filter: (entryPath) => entryPath === `package/${packageManifestName}`,
    });
    const raw = await readFile(manifestPath, "utf8");
    const manifest = objectValue(JSON.parse(raw));
    if (manifest === undefined) throw new Error("package.json 根值不是对象");
    return manifest;
  } catch (error) {
    throw new Error(
      `无法从 npm tgz 读取 package/package.json：${artifactPath}；${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function verifiedPackedManifest(options: {
  readonly artifactPath: string;
  readonly packageName: string;
  readonly packageVersion: string;
}): Promise<PublicationManifest> {
  const manifest = await packedManifest(options.artifactPath);
  const packedVersion = parseSemver(options.packageVersion)?.version;
  if (
    manifest.name !== options.packageName ||
    manifest.version !== packedVersion
  ) {
    throw new Error(
      `npm tgz 身份与目标不一致：目标 ${options.packageName}@${options.packageVersion}；制品 ${String(manifest.name)}@${String(manifest.version)}。npm pack 会移除版本 build metadata；其余 name、prerelease 和版本坐标必须匹配。修正目标 package.json 或打包 adapter。`,
    );
  }
  return manifest;
}

async function verifyArtifactIdentity(options: {
  readonly artifactPath: string;
  readonly packageName: string;
  readonly packageVersion: string;
}): Promise<string> {
  const manifest = await verifiedPackedManifest(options);
  return manifest.version as string;
}

async function recordAcceptance(options: {
  readonly artifactPath: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly sha512: string;
}): Promise<string | undefined> {
  const receiptPath = path.join(
    path.dirname(options.artifactPath),
    "publication-preparation.json",
  );
  if (!(await regularFile(receiptPath))) return undefined;

  const parsed = objectValue(JSON.parse(await readFile(receiptPath, "utf8")));
  const target = objectValue(parsed?.target);
  const artifact = objectValue(parsed?.artifact);
  if (
    parsed === undefined ||
    target?.name !== options.packageName ||
    target.version !== options.packageVersion ||
    artifact?.path !== path.basename(options.artifactPath) ||
    artifact.name !== options.packageName ||
    artifact.version !== options.artifactVersion ||
    artifact.sha512 !== options.sha512
  ) {
    throw new Error(
      `共享制品回执与已验收原件不一致：${receiptPath}。保留原始 receipt 与 tgz 一起续办，不能混用候选。`,
    );
  }

  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          ...parsed,
          acceptance: {
            packageName: options.packageName,
            artifactVersion: options.artifactVersion,
            sha512: options.sha512,
            installation: "passed",
            consumption: "passed",
          },
        },
        null,
        2,
      )}\n`,
    );
    await rename(temporaryPath, receiptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(
      `无法把共享消费验收结果写回原制品回执：${receiptPath}；${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return receiptPath;
}

/** 重读共享准备回执，并核对其引用的原始 tgz 字节和实际 npm 身份。 */
export async function readPreparedArtifact(options: {
  readonly packageRoot: string;
  readonly artifactDirectory?: string;
  readonly artifactPath?: string;
  /** 续办时按回执与 tgz 读取原目标，不把当前 checkout 当成原提交。 */
  readonly preserveReceiptTarget?: boolean;
}): Promise<ReadPreparedArtifactResult> {
  if (
    (options.artifactDirectory === undefined) ===
    (options.artifactPath === undefined)
  ) {
    throw new Error("读取共享原件必须且只能指定制品目录或原始 tgz 路径。");
  }
  const directory = path.resolve(
    options.artifactDirectory ?? path.dirname(options.artifactPath!),
  );
  const receiptPath = path.join(directory, "publication-preparation.json");
  const value = objectValue(JSON.parse(await readFile(receiptPath, "utf8")));
  const target = objectValue(value?.target);
  const pack = objectValue(value?.pack);
  const artifact = objectValue(value?.artifact);
  const npmPublicationAttempt = objectValue(value?.npmPublicationAttempt);
  const hasWorkflowRunId =
    typeof npmPublicationAttempt?.workflowRunId === "string";
  const hasWorkflowRunAttempt =
    typeof npmPublicationAttempt?.workflowRunAttempt === "number";
  if (
    value?.schemaVersion !== 1 ||
    target === undefined ||
    typeof target.name !== "string" ||
    typeof target.version !== "string" ||
    pack?.count !== 1 ||
    typeof pack.command !== "string" ||
    !Array.isArray(pack.arguments) ||
    pack.arguments.some((argument) => typeof argument !== "string") ||
    artifact === undefined ||
    typeof artifact.path !== "string" ||
    typeof artifact.name !== "string" ||
    typeof artifact.version !== "string" ||
    typeof artifact.sha512 !== "string" ||
    (value.sourceSha !== undefined &&
      (typeof value.sourceSha !== "string" ||
        !/^[0-9a-f]{40}$/u.test(value.sourceSha))) ||
    (value.npmPublicationAttempt !== undefined &&
      (npmPublicationAttempt?.artifactSha512 !== artifact?.sha512 ||
        typeof npmPublicationAttempt?.distTag !== "string" ||
        npmPublicationAttempt.distTag.length === 0 ||
        hasWorkflowRunId !== hasWorkflowRunAttempt ||
        (hasWorkflowRunId &&
          (!/^\d+$/u.test(npmPublicationAttempt.workflowRunId as string) ||
            !Number.isSafeInteger(
              npmPublicationAttempt.workflowRunAttempt as number,
            ) ||
            (npmPublicationAttempt.workflowRunAttempt as number) < 1))))
  ) {
    throw new Error(`共享制品准备回执格式无效：${receiptPath}`);
  }
  const artifactPath = path.resolve(
    options.artifactPath ?? path.join(directory, artifact.path),
  );
  if (
    path.dirname(artifactPath) !== directory ||
    path.basename(artifactPath) !== artifact.path
  ) {
    throw new Error(
      `共享制品回执路径必须指向其目录中的原始 tgz：${artifact.path}`,
    );
  }
  let packageName: string;
  let packageVersion: string;
  if (options.preserveReceiptTarget === true) {
    packageName = target.name;
    packageVersion = target.version;
    if (artifact.name !== packageName) {
      throw new Error(`共享制品回执目标与 tgz 包名不一致：${target.name}。`);
    }
  } else {
    const inspection = await inspectTarget({
      packageRoot: options.packageRoot,
    });
    if (inspection.kind === "blocked") {
      return { kind: "blocked", inspection };
    }
    if (
      target.name !== inspection.packageName ||
      target.version !== inspection.packageVersion ||
      artifact.name !== inspection.packageName
    ) {
      throw new Error(
        `共享制品回执目标与当前包配置不一致：回执 ${target.name}@${target.version}，当前 ${inspection.packageName}@${inspection.packageVersion}。`,
      );
    }
    packageName = inspection.packageName;
    packageVersion = inspection.packageVersion;
  }
  if (!(await regularFile(artifactPath))) {
    throw new Error(`共享制品回执引用的 tgz 不存在：${artifactPath}`);
  }
  const sha512 = await digestFile(artifactPath);
  if (artifact.sha512 !== sha512) {
    throw new Error(
      `共享制品回执与原始 tgz 字节不一致：${artifactPath}。保留的原件已变化。`,
    );
  }
  const packedManifest = await verifiedPackedManifest({
    artifactPath,
    packageName,
    packageVersion,
  });
  const artifactVersion = packedManifest.version as string;
  if (artifact.version !== artifactVersion) {
    throw new Error(
      `共享制品回执与原始 tgz 身份不一致：${artifactPath}。保留的 npm 身份已变化。`,
    );
  }
  return {
    kind: "prepared",
    receiptPath,
    artifactPath,
    packageName,
    packageVersion,
    artifactVersion,
    sha512,
    packedManifest,
    receipt: value as unknown as PublicationPreparationReceipt,
  };
}

/** 重读已消费验收的原件；外部写入方必须使用此入口。 */
export async function readAcceptedArtifact(options: {
  readonly packageRoot: string;
  readonly artifactDirectory?: string;
  readonly artifactPath?: string;
  readonly preserveReceiptTarget?: boolean;
}): Promise<ReadPreparedArtifactResult> {
  const prepared = await readPreparedArtifact(options);
  if (prepared.kind === "blocked") return prepared;
  const acceptance = prepared.receipt.acceptance;
  if (
    acceptance === undefined ||
    acceptance.packageName !== prepared.packageName ||
    acceptance.artifactVersion !== prepared.artifactVersion ||
    acceptance.sha512 !== prepared.sha512 ||
    acceptance.installation !== "passed" ||
    acceptance.consumption !== "passed"
  ) {
    throw new Error(
      `共享制品消费验收尚未通过或与原件不一致：${prepared.receiptPath}。先通过正式安装和包自有消费命令验收，再执行外部写入。`,
    );
  }
  return prepared;
}

/** 检查 npm 目标本身需要的身份、版本与包自有消费验收命令。 */
export async function inspectTarget(options: {
  readonly packageRoot: string;
}): Promise<PublicationInspection> {
  const packageRoot = path.resolve(options.packageRoot);
  const manifestResult = await packageManifest(packageRoot);
  if (manifestResult.kind === "blocked") {
    return {
      kind: "blocked",
      packageRoot,
      blockers: [manifestResult.blocker],
    };
  }
  const parsed = manifestResult.manifest;

  const blockers: PublicationBlocker[] = [];
  const name = parsed.name;
  const nameValidation =
    typeof name === "string"
      ? validateNpmPackageName(name)
      : { validForNewPackages: false };
  if (
    !nameValidation.validForNewPackages &&
    !nameValidation.validForOldPackages
  ) {
    blockers.push({
      code: "publication-package-name-invalid",
      target: packageRoot,
      field: `${packageManifestName}#/name`,
      observed: `${String(name)}${nameValidation.errors?.length ? `（${nameValidation.errors.join("；")}）` : ""}`,
      expected: "npm 接受的现有或新包名称",
      nextAction: `按 npm 包名规则修正 ${path.join(packageRoot, packageManifestName)} 的 name 字段。`,
    });
  }
  const version = parsed.version;
  if (
    typeof version !== "string" ||
    version.trim().length === 0 ||
    parseSemver(version)?.raw !== version
  ) {
    const missing = typeof version !== "string" || version.trim().length === 0;
    blockers.push({
      code: missing
        ? "publication-package-version-missing"
        : "publication-package-version-invalid",
      target: packageRoot,
      field: `${packageManifestName}#/version`,
      observed: String(version),
      expected: "有效的 SemVer 发布版本（可包含预发布标识和 build metadata）",
      nextAction: `在 ${path.join(packageRoot, packageManifestName)} 的 version 字段填写有效的 SemVer 版本，例如 1.2.3、1.2.3-rc.1 或 1.2.3+build.4。`,
    });
  }
  if (parsed.private === true) {
    blockers.push({
      code: "publication-package-private",
      target: packageRoot,
      field: `${packageManifestName}#/private`,
      observed: "true",
      expected: "可打包发布的 npm 目标（未设置 private: true）",
      nextAction: `移除 ${path.join(packageRoot, packageManifestName)} 中的 private: true，或改用非发布工作区包。`,
    });
  }
  const scripts = objectValue(parsed.scripts);
  const consumerCommand = scripts?.[consumerScriptName];
  if (
    typeof consumerCommand !== "string" ||
    consumerCommand.trim().length === 0
  ) {
    blockers.push({
      code: "publication-consumer-command-missing",
      target: packageRoot,
      field: `${packageManifestName}#/scripts/${consumerScriptName}`,
      observed: String(consumerCommand),
      expected: `包自有的 ${consumerScriptName} 消费验收命令`,
      nextAction: `在 ${path.join(packageRoot, packageManifestName)} 声明 scripts.${consumerScriptName}，让它通过安装后的 tgz 验证该包的实际用途。`,
    });
  }
  if (blockers.length > 0) return { kind: "blocked", packageRoot, blockers };

  return {
    kind: "ready",
    packageRoot,
    manifest: parsed,
    packageName: name as string,
    packageVersion: version as string,
    consumerCommand: consumerCommand as string,
  };
}

/** 只打包一次；默认路径使用 pnpm 原生 pack 与包自身生命周期。 */
export async function prepareArtifact(options: {
  readonly packageRoot: string;
  readonly outputDirectory: string;
  readonly sourceSha?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pack?: PackAdapter;
}): Promise<PrepareArtifactResult> {
  if (
    options.sourceSha !== undefined &&
    !/^[0-9a-f]{40}$/u.test(options.sourceSha)
  ) {
    throw new Error("共享制品 sourceSha 必须是完整的小写 Git commit SHA。");
  }
  const inspection = await inspectTarget(options);
  if (inspection.kind === "blocked") return { kind: "blocked", inspection };

  const outputDirectory = path.resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0) {
    throw new Error(
      `制品输出目录必须为空：${outputDirectory}；现有内容：${existing.join("、")}`,
    );
  }

  const env = { ...process.env, ...options.env };
  let artifactPath: string;
  let execution: PublicationExecution;
  if (options.pack !== undefined) {
    const packed = await options.pack({
      packageRoot: inspection.packageRoot,
      outputDirectory,
      env,
    });
    artifactPath = path.resolve(packed.artifactPath);
    execution = packed.execution;
  } else {
    const packed = await execute(
      "pnpm",
      ["pack", "--json", "--pack-destination", outputDirectory],
      {
        cwd: inspection.packageRoot,
        env,
        operation: `${inspection.packageName}@${inspection.packageVersion} 原生打包`,
      },
    );
    const filename = archiveFromPackOutput(packed.stdout);
    if (filename === undefined) {
      throw new Error(
        `pnpm pack 未返回可识别的 tgz 文件名：${inspection.packageName}@${inspection.packageVersion}\n${packed.stdout}\n${packed.stderr}`,
      );
    }
    artifactPath = path.resolve(outputDirectory, filename);
    execution = packed;
  }

  if (!(await regularFile(artifactPath))) {
    throw new Error(
      `打包命令没有生成普通 tgz 文件：${artifactPath}。检查目标包的 pack/prepack 生命周期及其输出位置。`,
    );
  }
  const artifactVersion = await verifyArtifactIdentity({
    artifactPath,
    packageName: inspection.packageName,
    packageVersion: inspection.packageVersion,
  });
  if (path.dirname(artifactPath) !== outputDirectory) {
    throw new Error(
      `打包 adapter 必须把原始 tgz 写入声明的输出目录：目标 ${artifactPath}；目录 ${outputDirectory}。`,
    );
  }

  const sha512 = await digestFile(artifactPath);
  const receiptPath = path.join(
    outputDirectory,
    "publication-preparation.json",
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...(options.sourceSha === undefined
          ? {}
          : { sourceSha: options.sourceSha }),
        target: {
          name: inspection.packageName,
          version: inspection.packageVersion,
        },
        pack: {
          count: 1,
          command: execution.command,
          arguments: execution.arguments,
        },
        artifact: {
          path: path.basename(artifactPath),
          name: inspection.packageName,
          version: artifactVersion,
          sha512,
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    kind: "prepared",
    packageRoot: inspection.packageRoot,
    packageName: inspection.packageName,
    packageVersion: inspection.packageVersion,
    artifactVersion,
    artifactPath,
    sha512,
    pack: execution,
  };
}

/** 正常安装原始 tgz，再运行目标清单声明的消费验收命令。 */
export async function acceptArtifact(options: {
  readonly packageRoot: string;
  readonly artifactPath: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<AcceptArtifactResult> {
  const inspection = await inspectTarget(options);
  if (inspection.kind === "blocked") return { kind: "blocked", inspection };

  const artifactPath = path.resolve(options.artifactPath);
  if (!(await regularFile(artifactPath))) {
    throw new Error(`待验收原始 tgz 不存在或不是普通文件：${artifactPath}`);
  }
  const artifactVersion = await verifyArtifactIdentity({
    artifactPath,
    packageName: inspection.packageName,
    packageVersion: inspection.packageVersion,
  });
  const sha512 = await digestFile(artifactPath);
  const { mkdtemp } = await import("node:fs/promises");
  const consumerRoot = await mkdtemp(
    path.join(tmpdir(), "npm-publication-consumer-"),
  );
  const env = { ...process.env, ...options.env };

  try {
    await writeFile(
      path.join(consumerRoot, packageManifestName),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    const installation = await execute(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--foreground-scripts",
        artifactPath,
      ],
      {
        cwd: consumerRoot,
        env,
        operation: `${inspection.packageName} 原始 tgz 正常安装`,
      },
    );
    const consumption = await execute(
      "npm",
      ["run", "--silent", consumerScriptName],
      {
        cwd: inspection.packageRoot,
        env: {
          ...env,
          NPM_PUBLICATION_ARTIFACT_PATH: artifactPath,
          NPM_PUBLICATION_CONSUMER_ROOT: consumerRoot,
          NPM_PUBLICATION_PACKAGE_NAME: inspection.packageName,
        },
        operation: `${inspection.packageName} 包自有消费验收`,
      },
    );
    const acceptedSha512 = await digestFile(artifactPath);
    if (acceptedSha512 !== sha512) {
      throw new Error(
        `消费验收期间原始 tgz 字节发生变化：验收前 ${sha512}，验收后 ${acceptedSha512}。`,
      );
    }
    const receiptPath = await recordAcceptance({
      artifactPath,
      packageName: inspection.packageName,
      packageVersion: inspection.packageVersion,
      artifactVersion,
      sha512,
    });
    return {
      kind: "accepted",
      packageRoot: inspection.packageRoot,
      packageName: inspection.packageName,
      artifactVersion,
      artifactPath,
      sha512,
      installation,
      consumption,
      ...(receiptPath === undefined ? {} : { receiptPath }),
    };
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
}

/** 在首次外部 npm 上传之前把单次尝试写入同一 accepted receipt。 */
export async function recordNpmPublicationAttempt(options: {
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly distTag: string;
  readonly workflowRunId?: string;
  readonly workflowRunAttempt?: number;
}): Promise<void> {
  if (
    (options.workflowRunId === undefined) !==
      (options.workflowRunAttempt === undefined) ||
    (options.workflowRunId !== undefined &&
      (!/^\d+$/u.test(options.workflowRunId) ||
        !Number.isSafeInteger(options.workflowRunAttempt) ||
        options.workflowRunAttempt! < 1))
  ) {
    throw new Error("工作流尝试信息必须包含有效的运行编号");
  }
  const accepted = await readAcceptedArtifact({
    packageRoot: options.packageRoot,
    artifactDirectory: options.artifactDirectory,
    preserveReceiptTarget: true,
  });
  if (accepted.kind !== "prepared") {
    throw new Error("npm 上传前必须读取已验收的原始 tgz。");
  }
  if (accepted.receipt.sourceSha === undefined) {
    throw new Error("npm 上传前必须从原件回执读取 sourceSha。");
  }
  if (accepted.receipt.npmPublicationAttempt !== undefined) {
    throw new Error("原件回执已记录 npm 上传尝试，远端不可见时不能盲目重发。");
  }
  const temporaryPath = `${accepted.receiptPath}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          ...accepted.receipt,
          npmPublicationAttempt: {
            artifactSha512: accepted.sha512,
            distTag: options.distTag,
            ...(options.workflowRunId === undefined
              ? {}
              : {
                  workflowRunId: options.workflowRunId,
                  workflowRunAttempt: options.workflowRunAttempt,
                }),
          },
        },
        null,
        2,
      )}\n`,
    );
    await rename(temporaryPath, accepted.receiptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(
      `无法在原件回执中记录 npm 上传尝试：${accepted.receiptPath}；${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
