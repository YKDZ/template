#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SemVer } from "semver";

import { publicationPackagePath } from "./configuration.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDistTag(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(value) && value !== "latest";
}

function targetDistTag(options: {
  readonly version: string;
  readonly requested: string | undefined;
  readonly semver: LockedSemver;
}): string {
  const prerelease = options.semver.prerelease(options.version) !== null;
  const tag = options.requested?.trim() ?? "";
  if (prerelease) {
    if (!validateDistTag(tag)) {
      fail(
        "prerelease-dist-tag-required",
        "prerelease publication requires an explicit non-latest dist-tag",
      );
    }
    return tag;
  }
  if (tag.length === 0 || tag === "latest") return "latest";
  if (!validateDistTag(tag)) {
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
    packageRoot: path.join(options.repositoryRoot, publicationPackagePath),
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
      fail(
        "publish-resume-ambiguous",
        "the accepted receipt records an earlier upload attempt but the exact version is not visible",
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
    await recordNpmPublicationAttempt({
      packageRoot: path.join(options.repositoryRoot, publicationPackagePath),
      artifactDirectory: options.artifactDirectory,
      distTag,
    });
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
    if (
      artifactDirectory === undefined ||
      !path.isAbsolute(artifactDirectory)
    ) {
      throw new PublicationFailure(
        "artifact-unavailable",
        "PUBLICATION_ARTIFACT_DIRECTORY must be absolute",
      );
    }
    await runDirectOidcPublication({
      repositoryRoot: process.cwd(),
      artifactDirectory,
      environment: process.env,
      ...(process.env.PUBLICATION_DIST_TAG === undefined
        ? {}
        : { distTag: process.env.PUBLICATION_DIST_TAG }),
    });
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    console.error(`ERROR ${error.code}`);
    console.error("Observed: publication precondition was not accepted");
    console.error("Expected: one accepted tgz and its original source commit");
    console.error(
      "Next action: inspect remote state before resuming the same artifact",
    );
    process.exitCode = 1;
  }
}
