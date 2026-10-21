#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SemVer } from "semver";

import { fail, PublicationFailure } from "./failure.ts";
import { recordNpmPublicationAttempt } from "./publication.ts";
import {
  readAcceptedRemoteArtifact,
  type RemoteCommandRunner,
  type RemoteProcessResult,
} from "./remote-context.ts";

export { PublicationFailure } from "./failure.ts";

const registry = "https://registry.npmjs.org/";
const publishWaitTimeout = "120000";

export type DirectPublicationOptions = {
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly credentialMode?: "oidc" | "interactive";
  readonly distTag?: string;
  readonly run?: RemoteCommandRunner;
};

function canonicalEnvironmentKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function assertNoAmbientCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of Object.keys(environment)) {
    const canonical = canonicalEnvironmentKey(key);
    if (
      canonical === "nodeauthtoken" ||
      ((canonical.startsWith("npm") || canonical.startsWith("pnpm")) &&
        (canonical.includes("auth") ||
          canonical.includes("token") ||
          canonical.includes("password")))
    ) {
      fail(
        "credential-fallback",
        `ambient credential variable is forbidden: ${key}`,
      );
    }
  }
}

type LockedSemver = {
  readonly valid: (value: string) => string | null;
  readonly validRange: (value: string) => string | null;
  readonly parse: (value: string) => SemVer | null;
  readonly gt: (left: string, right: string) => boolean;
  readonly prerelease: (value: string) => readonly unknown[] | null;
};

async function loadLockedSemver(): Promise<LockedSemver> {
  return await import("semver");
}

async function defaultRun(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<RemoteProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value: Buffer) => (stdout += value));
    child.stderr.on("data", (value: Buffer) => (stderr += value));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({ exitCode: exitCode ?? 1, stdout, stderr }),
    );
  });
}

function isolatedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  session: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_DEFAULT_BRANCH",
    "GITHUB_EVENT_NAME",
    "GITHUB_ACTIONS",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SERVER_URL",
    "GITHUB_RUN_ID",
    "RUNNER_ENVIRONMENT",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const home = path.join(session, "home");
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    COREPACK_HOME: path.join(session, "corepack"),
    COREPACK_NPM_REGISTRY: registry,
    NPM_CONFIG_USERCONFIG: path.join(session, "user-npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(session, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(session, "npm-cache"),
    PNPM_HOME: path.join(session, "pnpm-home"),
  };
}

function explicitNotFound(result: RemoteProcessResult): boolean {
  return /(?:^|\s)(?:E404|ERR_PNPM_FETCH_404)(?:\s|$)|\b404 Not Found\b/u.test(
    result.stderr,
  );
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(code, "command returned invalid JSON");
  }
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0)
    return fail(code, "expected string");
  return value;
}

async function assertRemoteTarballMatches(options: {
  readonly artifact: {
    readonly packageName: string;
    readonly artifactVersion: string;
    readonly sha512: string;
  };
  readonly repositoryRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run: RemoteCommandRunner;
}): Promise<void> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "npm-publication-registry-copy-"),
  );
  try {
    let downloaded: RemoteProcessResult;
    try {
      downloaded = await options.run(
        "npm",
        [
          "pack",
          `${options.artifact.packageName}@${options.artifact.artifactVersion}`,
          `--pack-destination=${directory}`,
          "--json",
          "--ignore-scripts",
          `--registry=${registry}`,
        ],
        { cwd: options.repositoryRoot, env: options.env },
      );
    } catch {
      fail(
        "registry-download-failed",
        "exact registry tarball download failed",
      );
    }
    if (downloaded.exitCode !== 0) {
      fail(
        "registry-download-failed",
        "exact registry tarball download failed",
      );
    }
    const packed = parseJson(downloaded.stdout, "registry-download-failed");
    if (!Array.isArray(packed) || packed.length !== 1 || !isRecord(packed[0])) {
      fail("registry-download-failed", "npm pack did not return one tarball");
    }
    const filename = stringValue(
      packed[0].filename,
      "registry-download-failed",
    );
    if (path.basename(filename) !== filename || !filename.endsWith(".tgz")) {
      fail("registry-download-failed", "npm pack returned an invalid filename");
    }
    const hash = createHash("sha512");
    try {
      for await (const chunk of createReadStream(
        path.join(directory, filename),
      )) {
        hash.update(chunk);
      }
    } catch {
      fail(
        "registry-download-failed",
        "downloaded registry tarball is missing",
      );
    }
    const sha512 = hash.digest("hex");
    if (sha512 !== options.artifact.sha512) {
      fail(
        "registry-bytes-conflict",
        "downloaded registry bytes differ from receipt",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDistTag(value: string, semver: LockedSemver): boolean {
  return (
    value.length > 0 &&
    encodeURIComponent(value) === value &&
    semver.validRange(value) === null &&
    value !== "latest"
  );
}

function targetDistTag(options: {
  readonly version: string;
  readonly requested: string | undefined;
  readonly semver: LockedSemver;
}): string {
  const prerelease = options.semver.prerelease(options.version) !== null;
  const tag = options.requested?.trim() ?? "";
  if (prerelease) {
    if (!validateDistTag(tag, options.semver)) {
      fail(
        "prerelease-dist-tag-required",
        "prerelease publication requires an explicit non-latest dist-tag",
      );
    }
    return tag;
  }
  if (tag.length === 0 || tag === "latest") return "latest";
  if (!validateDistTag(tag, options.semver)) {
    fail("dist-tag-invalid", "requested npm dist-tag is invalid");
  }
  return tag;
}

function workflowContext(
  environment: Readonly<Record<string, string | undefined>>,
  artifact: { readonly sourceSha: string },
): void {
  if (environment.GITHUB_ACTIONS !== "true") return;
  const branch = environment.GITHUB_DEFAULT_BRANCH;
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    branch === undefined ||
    environment.GITHUB_REF !== `refs/heads/${branch}` ||
    environment.GITHUB_SHA !== artifact.sourceSha ||
    !/^[0-9a-f]{40}$/u.test(artifact.sourceSha)
  ) {
    fail(
      "release-context-invalid",
      "remote publication must use the original default-branch workflow_dispatch commit",
    );
  }
}

function workflowAttemptMatches(
  environment: Readonly<Record<string, string | undefined>>,
  attempt:
    | {
        readonly workflowRunId?: string;
        readonly workflowRunAttempt?: number;
      }
    | undefined,
): boolean {
  return (
    attempt?.workflowRunId !== undefined &&
    attempt.workflowRunId === environment.GITHUB_RUN_ID &&
    String(attempt.workflowRunAttempt) === environment.GITHUB_RUN_ATTEMPT
  );
}

function workflowAttemptIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly runId: string; readonly runAttempt: number } {
  const runId = environment.GITHUB_RUN_ID;
  const rawAttempt = environment.GITHUB_RUN_ATTEMPT;
  const runAttempt = Number(rawAttempt);
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    runId === undefined ||
    !/^\d+$/u.test(runId) ||
    rawAttempt === undefined ||
    !/^\d+$/u.test(rawAttempt) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  ) {
    fail(
      "release-context-invalid",
      "必须提供当前 GitHub 工作流的运行编号和尝试编号",
    );
  }
  return { runId, runAttempt };
}

type PublicationAttemptOptions = Pick<
  DirectPublicationOptions,
  | "repositoryRoot"
  | "packageRoot"
  | "artifactDirectory"
  | "environment"
  | "distTag"
  | "run"
>;

/** 在远端写入之前，把首次 Actions 尝试写入待上传的同一份原件回执。 */
export async function markNpmPublicationAttempt(
  options: PublicationAttemptOptions,
): Promise<void> {
  const identity = workflowAttemptIdentity(options.environment);
  const runner = options.run ?? defaultRun;
  const artifact = await readAcceptedRemoteArtifact({
    repositoryRoot: options.repositoryRoot,
    packageRoot: path.resolve(options.packageRoot),
    artifactDirectory: options.artifactDirectory,
    ...(options.environment.GITHUB_REPOSITORY === undefined
      ? {}
      : { githubRepository: options.environment.GITHUB_REPOSITORY }),
    environment: options.environment,
    run: runner,
  });
  workflowContext(options.environment, artifact);
  const semver = await loadLockedSemver();
  const canonicalVersion = semver.valid(artifact.artifactVersion);
  if (canonicalVersion !== artifact.artifactVersion) {
    fail("artifact-version-invalid", "packed version is not canonical semver");
  }
  const distTag = targetDistTag({
    version: artifact.artifactVersion,
    requested: options.distTag ?? options.environment.PUBLICATION_DIST_TAG,
    semver,
  });
  await recordNpmPublicationAttempt({
    packageRoot: path.resolve(options.packageRoot),
    artifactDirectory: options.artifactDirectory,
    distTag,
    workflowRunId: identity.runId,
    workflowRunAttempt: identity.runAttempt,
  });
}

async function findReceiptFile(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "publication-preparation.json") {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findReceiptFile(entryPath);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** 从同一 Actions run 的 marker artifact 恢复上次已经持久化的尝试事实。 */
export async function restoreNpmPublicationAttempt(options: {
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly run?: RemoteCommandRunner;
}): Promise<boolean> {
  const identity = workflowAttemptIdentity(options.environment);
  const runner = options.run ?? defaultRun;
  const accepted = await readAcceptedRemoteArtifact({
    repositoryRoot: options.repositoryRoot,
    packageRoot: path.resolve(options.packageRoot),
    artifactDirectory: options.artifactDirectory,
    ...(options.environment.GITHUB_REPOSITORY === undefined
      ? {}
      : { githubRepository: options.environment.GITHUB_REPOSITORY }),
    environment: options.environment,
    run: runner,
  });
  const repository =
    options.environment.GITHUB_REPOSITORY ?? accepted.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("release-context-invalid", "GitHub 仓库标识无效");
  }
  const markerName = `npm-publication-attempt-${identity.runId}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.environment };
  const listed = await runner(
    "gh",
    [
      "api",
      `repos/${repository}/actions/runs/${identity.runId}/artifacts?name=${markerName}`,
    ],
    { cwd: options.repositoryRoot, env },
  );
  if (listed.exitCode !== 0) {
    fail(
      "publication-attempt-marker-unavailable",
      "无法读取本次工作流的制品记录",
    );
  }
  const listing = parseJson(
    listed.stdout,
    "publication-attempt-marker-unavailable",
  );
  if (!isRecord(listing) || !Array.isArray(listing.artifacts)) {
    fail("publication-attempt-marker-unavailable", "本次工作流的制品列表无效");
  }
  const matches = listing.artifacts.filter(
    (item) => isRecord(item) && item.name === markerName,
  );
  if (matches.length === 0) return false;
  if (
    matches.length !== 1 ||
    !isRecord(matches[0]) ||
    matches[0].expired === true
  ) {
    fail(
      "publication-attempt-marker-unavailable",
      "本次工作流的上传尝试标记不唯一或已过期",
    );
  }

  const directory = await mkdtemp(
    path.join(tmpdir(), "npm-publication-attempt-"),
  ).catch(() =>
    fail(
      "publication-attempt-marker-unavailable",
      "无法创建上传尝试标记临时目录",
    ),
  );
  try {
    const downloaded = await runner(
      "gh",
      [
        "run",
        "download",
        identity.runId,
        `--name=${markerName}`,
        `--dir=${directory}`,
      ],
      { cwd: options.repositoryRoot, env },
    );
    if (downloaded.exitCode !== 0) {
      fail(
        "publication-attempt-marker-unavailable",
        "无法下载本次工作流的上传尝试标记",
      );
    }
    const markerPath = await findReceiptFile(directory);
    if (markerPath === undefined) {
      fail(
        "publication-attempt-marker-unavailable",
        "上传尝试标记中缺少原件回执",
      );
    }
    const marker = parseJson(
      await readFile(markerPath, "utf8"),
      "publication-attempt-marker-invalid",
    );
    if (!isRecord(marker)) {
      fail("publication-attempt-marker-invalid", "上传尝试标记回执无效");
    }
    const target = marker.target;
    const artifact = marker.artifact;
    const attempt = marker.npmPublicationAttempt;
    const acceptance = marker.acceptance;
    if (
      !isRecord(target) ||
      !isRecord(artifact) ||
      !isRecord(attempt) ||
      !isRecord(acceptance) ||
      marker.sourceSha !== accepted.sourceSha ||
      target.name !== accepted.packageName ||
      target.version !== accepted.packageVersion ||
      artifact.path !== path.basename(accepted.artifactPath) ||
      artifact.name !== accepted.packageName ||
      artifact.version !== accepted.artifactVersion ||
      artifact.sha512 !== accepted.sha512 ||
      attempt.artifactSha512 !== accepted.sha512 ||
      attempt.workflowRunId !== identity.runId ||
      typeof attempt.workflowRunAttempt !== "number" ||
      attempt.workflowRunAttempt < 1 ||
      attempt.workflowRunAttempt >= identity.runAttempt
    ) {
      fail(
        "publication-attempt-marker-invalid",
        "上传尝试标记与当前原件或工作流尝试不匹配",
      );
    }
    const receiptPath = accepted.receiptPath;
    const temporaryPath = `${receiptPath}.${process.pid}.restore`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`);
      await rename(temporaryPath, receiptPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const restored = await readAcceptedRemoteArtifact({
      repositoryRoot: options.repositoryRoot,
      packageRoot: path.resolve(options.packageRoot),
      artifactDirectory: options.artifactDirectory,
      ...(options.environment.GITHUB_REPOSITORY === undefined
        ? {}
        : { githubRepository: options.environment.GITHUB_REPOSITORY }),
      environment: options.environment,
      run: runner,
    });
    if (
      restored.npmPublicationAttempt?.workflowRunId !== identity.runId ||
      restored.npmPublicationAttempt.workflowRunAttempt !==
        attempt.workflowRunAttempt
    ) {
      fail(
        "publication-attempt-marker-invalid",
        "恢复后的回执与上传尝试标记不一致",
      );
    }
    return true;
  } catch (error) {
    if (error instanceof PublicationFailure) throw error;
    fail(
      "publication-attempt-marker-unavailable",
      "无法恢复本次工作流的上传尝试标记",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepareOidcSession(
  options: DirectPublicationOptions,
): Promise<{ readonly root: string; readonly env: NodeJS.ProcessEnv }> {
  const parent = options.environment.RUNNER_TEMP ?? tmpdir();
  const root = await mkdtemp(path.join(parent, "npm-publication-"));
  const env = isolatedEnvironment(options.environment, root);
  await Promise.all([
    mkdir(path.join(root, "home")),
    mkdir(path.join(root, "corepack")),
    mkdir(path.join(root, "npm-cache")),
    mkdir(path.join(root, "pnpm-home")),
  ]);
  await writeFile(path.join(root, "user-npmrc"), "");
  await writeFile(path.join(root, "global-npmrc"), "");
  await writeFile(path.join(root, ".npmrc"), `registry=${registry}\n`);
  return { root, env };
}

async function assertNoCheckoutNpmrc(repositoryRoot: string): Promise<void> {
  try {
    await lstat(path.join(repositoryRoot, ".npmrc"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("checkout-npmrc-conflict", "checkout .npmrc cannot be inspected");
  }
  fail("checkout-npmrc-conflict", "checkout root .npmrc is forbidden");
}

function assertOidcAvailable(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    environment.ACTIONS_ID_TOKEN_REQUEST_URL === undefined ||
    environment.ACTIONS_ID_TOKEN_REQUEST_URL.length === 0 ||
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined ||
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length === 0
  ) {
    fail("oidc-unavailable", "GitHub OIDC request variables are required");
  }
}

/** 只上传 receipt 接受的 tgz 一次；pnpm 原生等待后只读回核对远端事实。 */
export async function runDirectOidcPublication(
  options: DirectPublicationOptions,
): Promise<void> {
  const credentialMode = options.credentialMode ?? "oidc";
  if (credentialMode === "oidc") {
    assertNoAmbientCredentials(options.environment);
    assertOidcAvailable(options.environment);
  }
  await assertNoCheckoutNpmrc(options.repositoryRoot);
  const runner = options.run ?? defaultRun;
  const artifact = await readAcceptedRemoteArtifact({
    repositoryRoot: options.repositoryRoot,
    packageRoot: path.resolve(options.packageRoot),
    artifactDirectory: options.artifactDirectory,
    ...(options.environment.GITHUB_REPOSITORY === undefined
      ? {}
      : { githubRepository: options.environment.GITHUB_REPOSITORY }),
    environment: options.environment,
    run: runner,
  });
  workflowContext(options.environment, artifact);

  const semver = await loadLockedSemver();
  const canonicalVersion = semver.valid(artifact.artifactVersion);
  if (canonicalVersion !== artifact.artifactVersion) {
    fail("artifact-version-invalid", "packed version is not canonical semver");
  }
  const distTag = targetDistTag({
    version: artifact.artifactVersion,
    requested: options.distTag ?? options.environment.PUBLICATION_DIST_TAG,
    semver,
  });
  let sessionRoot: string | undefined;
  let env: NodeJS.ProcessEnv;
  if (credentialMode === "oidc") {
    const session = await prepareOidcSession(options);
    sessionRoot = session.root;
    env = session.env;
  } else {
    env = { ...process.env, ...options.environment };
  }
  try {
    const common = [`--registry=${registry}`];
    const exact = await runner(
      "pnpm",
      [
        "view",
        `${artifact.packageName}@${artifact.artifactVersion}`,
        "dist.integrity",
        "--json",
        ...common,
      ],
      { cwd: options.repositoryRoot, env },
    );
    const exactExists = exact.exitCode === 0;
    if (!exactExists && !explicitNotFound(exact)) {
      fail("registry-preflight-failed", "exact version lookup failed");
    }
    let exactIntegrity: string | undefined;
    if (exactExists) {
      exactIntegrity = stringValue(
        parseJson(exact.stdout, "registry-preflight-failed"),
        "registry-preflight-failed",
      );
      if (exactIntegrity !== artifact.integrity) {
        fail(
          "registry-integrity-conflict",
          "published bytes differ from receipt",
        );
      }
    } else if (artifact.npmPublicationAttempt !== undefined) {
      if (
        !workflowAttemptMatches(
          options.environment,
          artifact.npmPublicationAttempt,
        )
      ) {
        fail(
          "publish-resume-ambiguous",
          "已验收回执记录了先前上传尝试，但 npm 尚未显示该精确版本",
        );
      }
    } else if (options.environment.GITHUB_ACTIONS === "true") {
      fail(
        "publication-attempt-marker-required",
        "发布已验收 tgz 前，必须先持久化本次工作流尝试标记",
      );
    }

    const tagsResult = await runner(
      "pnpm",
      ["view", artifact.packageName, "dist-tags", "--json", ...common],
      { cwd: options.repositoryRoot, env },
    );
    let tags: Record<string, unknown> = {};
    if (tagsResult.exitCode === 0) {
      const parsed = parseJson(tagsResult.stdout, "registry-preflight-failed");
      if (!isRecord(parsed))
        fail("registry-preflight-failed", "dist-tags are invalid");
      tags = parsed;
    } else if (!explicitNotFound(tagsResult)) {
      fail("registry-preflight-failed", "dist-tag lookup failed");
    }

    if (exactExists) {
      if (tags[distTag] !== artifact.artifactVersion) {
        fail(
          "registry-dist-tag-conflict",
          "published version is not on the requested dist-tag",
        );
      }
      await assertRemoteTarballMatches({
        artifact,
        repositoryRoot: options.repositoryRoot,
        env,
        run: runner,
      });
      return;
    }

    const latest = tags.latest;
    if (
      distTag === "latest" &&
      typeof latest === "string" &&
      semver.parse(latest) !== null &&
      !semver.gt(artifact.artifactVersion, latest)
    ) {
      fail("latest-stale", "candidate must be newer than current latest");
    }
    const lane = tags[distTag];
    if (
      distTag !== "latest" &&
      typeof lane === "string" &&
      semver.parse(lane) !== null &&
      !semver.gt(artifact.artifactVersion, lane)
    ) {
      fail("dist-tag-stale", "candidate must be newer than the selected lane");
    }

    const publishArguments = [
      "publish",
      artifact.artifactPath,
      "--access=public",
      `--tag=${distTag}`,
      `--publish-wait-timeout=${publishWaitTimeout}`,
      ...common,
      ...(credentialMode === "oidc" ? ["--provenance"] : []),
    ];
    if (artifact.npmPublicationAttempt === undefined) {
      await recordNpmPublicationAttempt({
        packageRoot: path.resolve(options.packageRoot),
        artifactDirectory: options.artifactDirectory,
        distTag,
      });
    }
    const published = await runner("pnpm", publishArguments, {
      cwd: options.repositoryRoot,
      env,
    });
    if (published.exitCode !== 0) {
      fail(
        "publish-failed",
        "native pnpm publish failed; the same receipt may be inspected and resumed",
      );
    }

    const readback = await runner(
      "pnpm",
      [
        "view",
        `${artifact.packageName}@${artifact.artifactVersion}`,
        "dist.integrity",
        "--json",
        ...common,
      ],
      { cwd: options.repositoryRoot, env },
    );
    if (readback.exitCode !== 0) {
      fail(
        "publish-wait-incomplete",
        "native publish completed without exact-version visibility",
      );
    }
    const integrity = stringValue(
      parseJson(readback.stdout, "publish-readback-conflict"),
      "publish-readback-conflict",
    );
    if (integrity !== artifact.integrity) {
      fail("publish-readback-conflict", "published bytes differ from receipt");
    }
    await assertRemoteTarballMatches({
      artifact,
      repositoryRoot: options.repositoryRoot,
      env,
      run: runner,
    });
    const tagReadback = await runner(
      "pnpm",
      ["view", artifact.packageName, "dist-tags", "--json", ...common],
      { cwd: options.repositoryRoot, env },
    );
    const parsedTags = parseJson(
      tagReadback.stdout,
      "publish-readback-conflict",
    );
    if (
      !isRecord(parsedTags) ||
      parsedTags[distTag] !== artifact.artifactVersion
    ) {
      fail(
        "publish-readback-conflict",
        "dist-tag does not identify the accepted version",
      );
    }
  } finally {
    if (sessionRoot !== undefined) {
      await rm(sessionRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try {
    const artifactDirectory = process.env.PUBLICATION_ARTIFACT_DIRECTORY;
    const packageRoot = process.env.PUBLICATION_PACKAGE_ROOT;
    if (
      artifactDirectory === undefined ||
      !path.isAbsolute(artifactDirectory) ||
      packageRoot === undefined ||
      !path.isAbsolute(packageRoot)
    ) {
      throw new PublicationFailure(
        "artifact-unavailable",
        "PUBLICATION_ARTIFACT_DIRECTORY must be absolute",
      );
    }
    await runDirectOidcPublication({
      repositoryRoot: path.resolve(
        process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
      ),
      packageRoot,
      artifactDirectory,
      environment: process.env,
      ...(process.env.PUBLICATION_DIST_TAG === undefined
        ? {}
        : { distTag: process.env.PUBLICATION_DIST_TAG }),
    });
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    console.error(`ERROR ${error.code}`);
    console.error("已观察到：发布前置条件未通过");
    console.error("预期结果：使用已验收的 tgz 和其原始源码提交");
    console.error("下一步：检查远端状态，再续办同一份原件");
    process.exitCode = 1;
  }
}
