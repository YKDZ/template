#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Direct npm/OIDC adapter.  It deliberately imports Node built-ins only. */
import { randomUUID } from "node:crypto";
import { mkdtemp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acceptDownloadedPublicationArtifact,
  fail,
  PublicationFailure,
} from "./handoff.ts";

export { PublicationFailure } from "./handoff.ts";

const packagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";
const npmVersion = "11.19.1";
const registry = "https://registry.npmjs.org/";

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type DirectPublicationOptions = {
  readonly repositoryRoot: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly run?: (
    command: string,
    arguments_: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<ProcessResult>;
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
  readonly prerelease: (value: string) => readonly unknown[] | null;
  readonly gt: (left: string, right: string) => boolean;
};

async function loadLockedSemver(): Promise<LockedSemver> {
  return await import("semver");
}

function isStableSemver(semver: LockedSemver, value: string): boolean {
  return semver.valid(value) !== null && semver.prerelease(value) === null;
}

async function defaultRun(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
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

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(code, "command returned invalid JSON");
  }
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(code, "expected string");
  return value;
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
    "GITHUB_EVENT_NAME",
    "GITHUB_ACTIONS",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SERVER_URL",
    "GITHUB_RUN_ID",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
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

async function command(
  run: NonNullable<DirectPublicationOptions["run"]>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  arguments_: readonly string[],
  code: string,
): Promise<string> {
  const result = await run("corepack", ["pnpm", "exec", "npm", ...arguments_], {
    cwd,
    env,
  });
  if (result.exitCode !== 0) fail(code, "npm command failed");
  return result.stdout.trim();
}

function npmArguments(
  prefix: string,
  configurationRoot = prefix,
): readonly string[] {
  return [
    `--prefix=${prefix}`,
    `--registry=${registry}`,
    `--userconfig=${path.join(configurationRoot, "user-npmrc")}`,
    `--globalconfig=${path.join(configurationRoot, "global-npmrc")}`,
    `--cache=${path.join(configurationRoot, "npm-cache")}`,
  ];
}

function isExplicitNotFound(result: ProcessResult): boolean {
  return /^npm error code E404\s*$/mu.test(result.stderr);
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

export async function runDirectOidcPublication(
  options: DirectPublicationOptions,
): Promise<void> {
  assertNoAmbientCredentials(options.environment);
  await assertNoCheckoutNpmrc(options.repositoryRoot);
  assertOidcAvailable(options.environment);
  const { receipt, tgz } = await acceptDownloadedPublicationArtifact({
    repositoryRoot: options.repositoryRoot,
    packagePath,
    artifactDirectory: options.artifactDirectory,
    githubRepository: options.environment.GITHUB_REPOSITORY,
  });

  const session = await mkdtemp(
    path.join(options.environment.RUNNER_TEMP ?? tmpdir(), "npm-publication-"),
  );
  const run = options.run ?? defaultRun;
  const env = isolatedEnvironment(options.environment, session);
  try {
    await Promise.all([
      mkdir(path.join(session, "home")),
      mkdir(path.join(session, "corepack")),
      mkdir(path.join(session, "npm-cache")),
      mkdir(path.join(session, "pnpm-home")),
      mkdir(path.join(session, "pnpm-store")),
    ]);
    await writeFile(
      path.join(session, ".npmrc"),
      `registry=${registry}\nfetch-retries=1\n`,
    );
    await writeFile(path.join(session, "user-npmrc"), "");
    await writeFile(path.join(session, "global-npmrc"), "");
    const install = await run(
      "corepack",
      [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        `--registry=${registry}`,
        `--store-dir=${path.join(session, "pnpm-store")}`,
      ],
      { cwd: options.repositoryRoot, env },
    );
    if (install.exitCode !== 0)
      fail("isolated-install-failed", "frozen install failed");
    const common = npmArguments(session);
    const semver = await loadLockedSemver();
    if (
      (await command(
        run,
        options.repositoryRoot,
        env,
        [...common, "--version"],
        "npm-client-pin-invalid",
      )) !== npmVersion
    ) {
      fail("npm-client-pin-invalid", `locked npm must be ${npmVersion}`);
    }
    if (
      (await command(
        run,
        options.repositoryRoot,
        env,
        [...common, "config", "get", "fetch-retries"],
        "effective-config-invalid",
      )) !== "1"
    ) {
      fail(
        "effective-config-invalid",
        "session fetch-retries marker is not active",
      );
    }
    if (
      (await command(
        run,
        options.repositoryRoot,
        env,
        [...common, "config", "get", "registry"],
        "effective-config-invalid",
      )) !== registry
    ) {
      fail("effective-config-invalid", "session registry is not active");
    }
    const publication = receipt.publication;
    const latestRaw = await command(
      run,
      options.repositoryRoot,
      env,
      [...common, "view", publication.packageName, "dist-tags", "--json"],
      "registry-preflight-failed",
    );
    const latest = (
      parseJson(latestRaw, "registry-preflight-failed") as { latest?: unknown }
    ).latest;
    if (typeof latest !== "string" || !isStableSemver(semver, latest))
      fail("latest-invalid", "daily lane needs stable latest");
    const exact = await run(
      "corepack",
      [
        "pnpm",
        "exec",
        "npm",
        ...common,
        "view",
        `${publication.packageName}@${publication.version}`,
        "dist.integrity",
        "--json",
      ],
      { cwd: options.repositoryRoot, env },
    );
    const attempt = Number(options.environment.GITHUB_RUN_ATTEMPT);
    if (!Number.isInteger(attempt) || attempt < 1)
      fail("registry-preflight-failed", "invalid run attempt");
    const exactExists = exact.exitCode === 0;
    if (!exactExists && !isExplicitNotFound(exact)) {
      fail(
        "registry-preflight-failed",
        exact.stderr ||
          exact.stdout ||
          "exact version lookup was not a not-found response",
      );
    }
    let alreadyWritten = false;
    if (attempt === 1 && exactExists)
      fail("fresh-version-exists", "fresh run cannot reuse a version");
    if (exactExists && attempt > 1) {
      const integrity = stringValue(
        parseJson(exact.stdout, "rerun-integrity-conflict"),
        "rerun-integrity-conflict",
      );
      if (integrity !== receipt.artifact.integrity)
        fail("rerun-integrity-conflict", "existing integrity differs");
      if (latest !== publication.version)
        fail("rerun-latest-conflict", "latest differs from candidate");
      alreadyWritten = true;
    }
    if (!exactExists && !semver.gt(publication.version, latest))
      fail("latest-stale", "candidate must be newer than latest");
    if (!alreadyWritten) {
      await command(
        run,
        options.repositoryRoot,
        env,
        [...common, "publish", tgz, "--access=public", "--provenance"],
        "publish-failed",
      );
    }
    const readIntegrity = stringValue(
      parseJson(
        await command(
          run,
          options.repositoryRoot,
          env,
          [
            ...common,
            "view",
            `${publication.packageName}@${publication.version}`,
            "dist.integrity",
            "--json",
          ],
          "postwrite-integrity-conflict",
        ),
        "postwrite-integrity-conflict",
      ),
      "postwrite-integrity-conflict",
    );
    const postTags = parseJson(
      await command(
        run,
        options.repositoryRoot,
        env,
        [...common, "view", publication.packageName, "dist-tags", "--json"],
        "postwrite-integrity-conflict",
      ),
      "postwrite-integrity-conflict",
    ) as { latest?: unknown };
    if (
      readIntegrity !== receipt.artifact.integrity ||
      postTags.latest !== publication.version
    )
      fail(
        "postwrite-integrity-conflict",
        "registry does not point to receipt artifact",
      );
    const consumer = path.join(session, `consumer-${randomUUID()}`);
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { [publication.packageName]: publication.version },
      }),
    );
    await writeFile(
      path.join(consumer, ".npmrc"),
      `registry=${registry}\nfetch-retries=1\n`,
    );
    const consumerArguments = npmArguments(consumer, session);
    await command(
      run,
      options.repositoryRoot,
      env,
      [...consumerArguments, "install", "--ignore-scripts"],
      "exact-install-failed",
    );
    const audit = parseJson(
      await command(
        run,
        options.repositoryRoot,
        env,
        [
          ...consumerArguments,
          "audit",
          "signatures",
          "--json",
          "--include-attestations",
        ],
        "signature-audit-invalid",
      ),
      "signature-audit-invalid",
    ) as { invalid?: unknown; missing?: unknown; verified?: unknown };
    if (
      typeof audit !== "object" ||
      audit === null ||
      !Array.isArray(audit.invalid) ||
      audit.invalid.length !== 0 ||
      !Array.isArray(audit.missing) ||
      audit.missing.length !== 0 ||
      !Array.isArray(audit.verified)
    ) {
      fail(
        "signature-audit-invalid",
        "npm audit schema is incomplete or invalid",
      );
    }
    const matches = audit.verified.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as { name?: unknown }).name === publication.packageName &&
        (item as { version?: unknown }).version === publication.version,
    );
    if (matches.length !== 1)
      fail(
        "signature-audit-invalid",
        "exact package attestation is missing or ambiguous",
      );
    const exactVerified = matches[0] as { attestationBundles?: unknown };
    if (
      !Array.isArray(exactVerified.attestationBundles) ||
      exactVerified.attestationBundles.length === 0
    ) {
      fail(
        "signature-audit-invalid",
        "exact package attestation bundle is missing",
      );
    }
  } finally {
    await rm(session, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const artifactDirectory = process.env.PUBLICATION_ARTIFACT_DIRECTORY;
  if (artifactDirectory === undefined || !path.isAbsolute(artifactDirectory)) {
    throw new PublicationFailure(
      "artifact-unavailable",
      "PUBLICATION_ARTIFACT_DIRECTORY must be absolute",
    );
  }
  try {
    await runDirectOidcPublication({
      repositoryRoot: process.cwd(),
      artifactDirectory,
      environment: process.env,
    });
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    console.error(`ERROR ${error.code}`);
    console.error("Observed: publication precondition was not accepted");
    console.error(
      "Expected: a verified artifact and isolated GitHub OIDC session",
    );
    console.error(
      "Next action: correct the reported publication precondition and rerun the failed job",
    );
    process.exitCode = 1;
  }
}
