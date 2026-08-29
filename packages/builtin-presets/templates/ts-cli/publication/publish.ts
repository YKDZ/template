#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Direct npm/OIDC adapter.  It deliberately imports Node built-ins only. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";
const npmVersion = "11.19.1";
const registry = "https://registry.npmjs.org/";
const expectedFiles = new Set([
  "SHA512SUMS",
  "verified-publication-artifact.json",
]);

export class PublicationFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

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

type Receipt = {
  readonly publication: {
    readonly packageName: string;
    readonly version: string;
    readonly commandName: string;
    readonly repository: string;
  };
  readonly packedManifest: {
    readonly name: string;
    readonly version: string;
    readonly bin: Record<string, string>;
    readonly repository: unknown;
  };
  readonly artifact: { readonly integrity: string; readonly size: number };
  readonly files: readonly { readonly path: string }[];
};

function fail(code: string, message: string): never {
  throw new PublicationFailure(code, message);
}

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

function stableSemver(value: string): readonly number[] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match?.slice(1).map(Number);
}

function isGreaterStableSemver(candidate: string, current: string): boolean {
  const left = stableSemver(candidate);
  const right = stableSemver(current);
  if (left === undefined || right === undefined) return false;
  return left.some((part, index) =>
    left
      .slice(0, index)
      .every((prefix, prefixIndex) => prefix === right[prefixIndex])
      ? part > right[index]!
      : false,
  );
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

function repositoryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string"
  )
    return (value as { url: string }).url;
  return undefined;
}

function canonicalGithubRepository(value: string): string | undefined {
  const match =
    /^(?:git\+)?https:\/\/github\.com\/([^/]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/u.exec(
      value,
    );
  return match?.[1];
}

async function readArtifact(
  directory: string,
): Promise<{ receipt: Receipt; tgz: string }> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() =>
    fail("artifact-unavailable", "verified artifact directory is unavailable"),
  );
  if (entries.length !== 3 || entries.some((entry) => !entry.isFile())) {
    fail(
      "artifact-set-invalid",
      "artifact must contain exactly three regular files",
    );
  }
  const tgz = entries.find((entry) => entry.name.endsWith(".tgz"));
  if (
    tgz === undefined ||
    entries.some((entry) => entry.name.startsWith("."))
  ) {
    fail("artifact-set-invalid", "artifact must contain one non-hidden tgz");
  }
  for (const name of expectedFiles)
    if (!entries.some((entry) => entry.name === name)) {
      fail("artifact-set-invalid", `artifact misses ${name}`);
    }
  const receiptPath = path.join(
    directory,
    "verified-publication-artifact.json",
  );
  const receipt = parseJson(
    await readFile(receiptPath, "utf8"),
    "artifact-receipt-invalid",
  ) as Receipt;
  const tgzPath = path.resolve(directory, tgz.name);
  const tgzStat = await stat(tgzPath);
  if (
    !Number.isSafeInteger(receipt?.artifact?.size) ||
    receipt.artifact.size !== tgzStat.size
  ) {
    fail("artifact-integrity-invalid", "receipt size differs from tgz");
  }
  const bytes = await readFile(tgzPath);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (receipt?.artifact?.integrity !== integrity) {
    fail("artifact-integrity-invalid", "receipt SRI differs from tgz");
  }
  const checksum = await readFile(path.join(directory, "SHA512SUMS"), "utf8");
  const expectedChecksum = `${createHash("sha512").update(bytes).digest("hex")}  ${tgz.name}\n`;
  if (checksum !== expectedChecksum)
    fail("artifact-integrity-invalid", "checksum file differs from tgz");
  return { receipt, tgz: tgzPath };
}

async function assertArtifactIdentity(options: {
  readonly repositoryRoot: string;
  readonly receipt: Receipt;
  readonly githubRepository: string;
}): Promise<void> {
  const { receipt } = options;
  const manifest = parseJson(
    await readFile(
      path.join(options.repositoryRoot, packagePath, "package.json"),
      "utf8",
    ),
    "identity-invalid",
  ) as Record<string, unknown>;
  const packed = receipt?.packedManifest;
  const publication = receipt?.publication;
  const bin = packed?.bin;
  if (
    !packed ||
    !publication ||
    packed.name !== publication.packageName ||
    packed.version !== publication.version ||
    manifest.name !== publication.packageName ||
    manifest.version !== publication.version ||
    !bin ||
    Object.keys(bin).length !== 1 ||
    Object.keys(bin)[0] !== publication.commandName ||
    !stableSemver(publication.version)
  ) {
    fail(
      "identity-invalid",
      "receipt, packed manifest, and checkout manifest disagree",
    );
  }
  const receiptRepository = canonicalGithubRepository(publication.repository);
  const packedRepository = canonicalGithubRepository(
    repositoryName(packed.repository) ?? "",
  );
  const sourceRepository = canonicalGithubRepository(
    repositoryName(manifest.repository) ?? "",
  );
  if (
    receiptRepository !== options.githubRepository ||
    packedRepository !== receiptRepository ||
    sourceRepository !== receiptRepository
  ) {
    fail(
      "identity-invalid",
      "publication repository is not the current GitHub repository",
    );
  }
}

function isolatedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  session: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const canonical = canonicalEnvironmentKey(key);
    if (
      !canonical.startsWith("npmconfig") &&
      !canonical.startsWith("pnpmconfig") &&
      !canonical.startsWith("corepack") &&
      canonical !== "pnpmhome" &&
      value !== undefined
    )
      environment[key] = value;
  }
  const home = path.join(session, "home");
  const config = path.join(session, "npmrc");
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    COREPACK_HOME: path.join(session, "corepack"),
    COREPACK_NPM_REGISTRY: registry,
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_GLOBALCONFIG: path.join(session, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(session, "npm-cache"),
    NPM_CONFIG_REGISTRY: registry,
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
  if (result.exitCode !== 0)
    fail(code, result.stderr || result.stdout || "npm command failed");
  return result.stdout.trim();
}

function npmArguments(session: string): readonly string[] {
  return [
    `--prefix=${session}`,
    `--registry=${registry}`,
    `--userconfig=${path.join(session, "npmrc")}`,
    `--globalconfig=${path.join(session, "global-npmrc")}`,
    `--cache=${path.join(session, "npm-cache")}`,
  ];
}

function isExplicitNotFound(result: ProcessResult): boolean {
  return /(?:\bE404\b|\b404\b|not found)/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

export async function runDirectOidcPublication(
  options: DirectPublicationOptions,
): Promise<void> {
  assertNoAmbientCredentials(options.environment);
  if (existsSync(path.join(options.repositoryRoot, ".npmrc"))) {
    fail("checkout-npmrc-conflict", "checkout root .npmrc is forbidden");
  }
  const { receipt, tgz } = await readArtifact(options.artifactDirectory);
  const githubRepository = stringValue(
    options.environment.GITHUB_REPOSITORY,
    "identity-invalid",
  );
  await assertArtifactIdentity({
    repositoryRoot: options.repositoryRoot,
    receipt,
    githubRepository,
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
      path.join(session, "npmrc"),
      `registry=${registry}\nfetch-retries=1\n`,
    );
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
      fail(
        "isolated-install-failed",
        install.stderr || "frozen install failed",
      );
    const common = npmArguments(session);
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
    if (typeof latest !== "string" || stableSemver(latest) === undefined)
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
    if (!exactExists && !isGreaterStableSemver(publication.version, latest))
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
    const consumerArguments = npmArguments(consumer);
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
    ) as { verified?: unknown };
    const verified = Array.isArray(audit.verified) ? audit.verified : [];
    const matches = verified.filter((item) => {
      const value = item as {
        name?: unknown;
        version?: unknown;
        attestationBundles?: unknown;
      };
      return (
        value.name === publication.packageName &&
        value.version === publication.version &&
        Array.isArray(value.attestationBundles) &&
        value.attestationBundles.length > 0
      );
    });
    if (matches.length !== 1)
      fail(
        "signature-audit-invalid",
        "exact package attestation is missing or ambiguous",
      );
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
  await runDirectOidcPublication({
    repositoryRoot: process.cwd(),
    artifactDirectory,
    environment: process.env,
  });
}
