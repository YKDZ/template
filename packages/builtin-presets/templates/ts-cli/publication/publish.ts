#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Direct npm/OIDC adapter.  It deliberately imports Node built-ins only. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  lstat,
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
  readonly schemaVersion: 1;
  readonly publication: {
    readonly packageName: string;
    readonly version: string;
    readonly commandName: string;
    readonly repository: string;
    readonly releaseDate: string;
    readonly releaseNotes: string;
  };
  readonly packedManifest: {
    readonly name: string;
    readonly version: string;
    readonly bin: Record<string, string>;
    readonly repository: {
      readonly type: "git";
      readonly url: string;
      readonly directory: string;
    };
  };
  readonly artifact: {
    readonly file: string;
    readonly checksumFile: "SHA512SUMS";
    readonly integrity: string;
    readonly size: number;
  };
  readonly files: readonly {
    readonly path: string;
    readonly mode: number;
    readonly size: number;
  }[];
  readonly bin: {
    readonly path: "package/dist/cli.js";
    readonly shebang: "#!/usr/bin/env node";
    readonly mode: number;
    readonly posixExecutableChecked: boolean;
  };
  readonly smokes: readonly {
    readonly name: string;
    readonly args: readonly string[];
    readonly stdout: string;
  }[];
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

function hasStableSemverShape(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}

type LockedSemver = {
  readonly valid: (value: string) => string | null;
  readonly prerelease: (value: string) => readonly unknown[] | null;
  readonly gt: (left: string, right: string) => boolean;
};

async function loadLockedSemver(): Promise<LockedSemver> {
  return (await import("semver")) as unknown as LockedSemver;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function repositoryObject(
  value: unknown,
):
  | { readonly type: string; readonly url: string; readonly directory: string }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.url !== "string" ||
    typeof record.directory !== "string"
  )
    return undefined;
  return { type: record.type, url: record.url, directory: record.directory };
}

function canonicalGithubRepository(value: string): string | undefined {
  const match =
    /^(?:git\+)?https:\/\/github\.com\/([^/]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/u.exec(
      value,
    );
  return match?.[1];
}

function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  const publication = value.publication;
  const packedManifest = value.packedManifest;
  const artifact = value.artifact;
  const bin = value.bin;
  if (
    !isRecord(publication) ||
    !isRecord(packedManifest) ||
    !isRecord(artifact) ||
    !isRecord(bin) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.smokes)
  )
    return false;
  const releaseDate = publication.releaseDate;
  const releaseNotes = publication.releaseNotes;
  if (
    ![
      "packageName",
      "version",
      "commandName",
      "repository",
      "releaseDate",
      "releaseNotes",
    ].every((key) => stringField(publication, key)) ||
    typeof releaseDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate) ||
    typeof releaseNotes !== "string" ||
    releaseNotes.trim().length === 0 ||
    !stringField(packedManifest, "name") ||
    !stringField(packedManifest, "version") ||
    !isRecord(packedManifest.bin) ||
    Object.values(packedManifest.bin).some(
      (entry) => typeof entry !== "string",
    ) ||
    repositoryObject(packedManifest.repository) === undefined
  )
    return false;
  const artifactSize = artifact.size;
  if (
    !safeBasename(artifact.file) ||
    artifact.checksumFile !== "SHA512SUMS" ||
    typeof artifact.integrity !== "string" ||
    typeof artifactSize !== "number" ||
    !Number.isSafeInteger(artifactSize) ||
    artifactSize < 0 ||
    value.files.length === 0 ||
    value.files.some(
      (file) =>
        !isRecord(file) ||
        typeof file.path !== "string" ||
        !Number.isSafeInteger(file.mode) ||
        !Number.isSafeInteger(file.size),
    ) ||
    typeof bin.path !== "string" ||
    typeof bin.shebang !== "string" ||
    !Number.isSafeInteger(bin.mode) ||
    typeof bin.posixExecutableChecked !== "boolean" ||
    value.smokes.some(
      (smoke) =>
        !isRecord(smoke) ||
        typeof smoke.name !== "string" ||
        !Array.isArray(smoke.args) ||
        smoke.args.some((argument) => typeof argument !== "string") ||
        typeof smoke.stdout !== "string",
    )
  )
    return false;
  return true;
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
  );
  if (
    !isReceipt(receipt) ||
    receipt.artifact.file !== tgz.name ||
    receipt.artifact.checksumFile !== "SHA512SUMS"
  ) {
    fail(
      "artifact-receipt-invalid",
      "receipt schema or artifact references are invalid",
    );
  }
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
  const checksum = await readFile(
    path.join(directory, receipt.artifact.checksumFile),
    "utf8",
  );
  const expectedChecksum = `${createHash("sha512").update(bytes).digest("hex")}  ${tgz.name}\n`;
  if (checksum !== expectedChecksum)
    fail("artifact-integrity-invalid", "checksum file differs from tgz");
  return { receipt, tgz: tgzPath };
}

function safeBasename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]+$/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function sameArguments(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isCanonicalPackageFilePath(value: string): boolean {
  const segments = value.split("/");
  return (
    segments[0] === "package" &&
    segments.length > 1 &&
    segments.slice(1).every(safeBasename)
  );
}

function hasCanonicalReceiptFiles(files: Receipt["files"]): boolean {
  let previousPath: string | undefined;
  for (const file of files) {
    if (
      !isCanonicalPackageFilePath(file.path) ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (previousPath !== undefined && previousPath >= file.path)
    ) {
      return false;
    }
    previousPath = file.path;
  }
  return true;
}

function hasStableSmokeEvidence(receipt: Receipt): boolean {
  const [runtimeImport, help, version, greet] = receipt.smokes;
  return (
    receipt.smokes.length === 4 &&
    runtimeImport?.name === "runtime-import" &&
    sameArguments(runtimeImport.args, []) &&
    runtimeImport.stdout === "" &&
    help?.name === "help" &&
    sameArguments(help.args, ["--help"]) &&
    help.stdout.includes(`Usage: ${receipt.publication.commandName}`) &&
    help.stdout.includes("greet") &&
    version?.name === "version" &&
    sameArguments(version.args, ["--version"]) &&
    version.stdout === `${receipt.publication.version}\n` &&
    greet?.name === "greet" &&
    sameArguments(greet.args, ["greet", "  Ada Lovelace  "]) &&
    greet.stdout === "Hello, Ada Lovelace\n"
  );
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
  );
  if (!isRecord(manifest))
    fail("identity-invalid", "checkout manifest is not an object");
  const packed = receipt.packedManifest;
  const publication = receipt.publication;
  const bin = packed?.bin;
  const sourceBin = manifest.bin;
  const command = publication?.commandName;
  const packedBinEntries =
    bin !== null && typeof bin === "object" ? Object.entries(bin) : [];
  const sourceBinEntries =
    sourceBin !== null && typeof sourceBin === "object"
      ? Object.entries(sourceBin as Record<string, unknown>)
      : [];
  const packedRepository = repositoryObject(packed?.repository);
  const sourceRepository = repositoryObject(manifest.repository);
  const packedBinTarget = packedBinEntries[0]?.[1];
  const binFile = receipt.files.find((file) => file.path === receipt.bin.path);
  const posixExecutableChecked = process.platform !== "win32";
  if (
    !packed ||
    !publication ||
    packed.name !== publication.packageName ||
    packed.version !== publication.version ||
    manifest.name !== publication.packageName ||
    manifest.version !== publication.version ||
    packedBinEntries.length !== 1 ||
    sourceBinEntries.length !== 1 ||
    packedBinEntries[0]![0] !== command ||
    sourceBinEntries[0]![0] !== command ||
    typeof packedBinEntries[0]![1] !== "string" ||
    packedBinEntries[0]![1] !== sourceBinEntries[0]![1] ||
    packedBinTarget !== "./dist/cli.js" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(publication.releaseDate) ||
    publication.releaseNotes.trim().length === 0 ||
    receipt.files.length === 0 ||
    !hasCanonicalReceiptFiles(receipt.files) ||
    receipt.bin.path !== "package/dist/cli.js" ||
    receipt.bin.shebang !== "#!/usr/bin/env node" ||
    binFile === undefined ||
    receipt.bin.mode !== binFile.mode ||
    receipt.bin.posixExecutableChecked !== posixExecutableChecked ||
    (posixExecutableChecked && (receipt.bin.mode & 0o111) === 0) ||
    !hasStableSmokeEvidence(receipt) ||
    packedRepository?.type !== "git" ||
    packedRepository.url !== publication.repository ||
    packedRepository.directory !== packagePath ||
    sourceRepository?.type !== "git" ||
    sourceRepository.url !== publication.repository ||
    sourceRepository.directory !== packagePath ||
    !hasStableSemverShape(publication.version)
  ) {
    fail(
      "identity-invalid",
      "receipt, packed manifest, and checkout manifest disagree",
    );
  }
  const receiptRepository = canonicalGithubRepository(publication.repository);
  const packedRepositoryName = canonicalGithubRepository(
    packedRepository?.url ?? "",
  );
  const sourceRepositoryName = canonicalGithubRepository(
    sourceRepository?.url ?? "",
  );
  if (
    receiptRepository !== options.githubRepository ||
    packedRepositoryName !== receiptRepository ||
    sourceRepositoryName !== receiptRepository
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
