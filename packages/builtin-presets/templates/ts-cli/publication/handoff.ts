import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

export type AcceptedPublicationArtifact = {
  readonly receipt: Receipt;
  readonly tgz: string;
  readonly checksum: string;
  readonly sha512: string;
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

export function fail(code: string, message: string): never {
  throw new PublicationFailure(code, message);
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(code, "command returned invalid JSON");
  }
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

async function readArtifact(directory: string): Promise<{
  readonly receipt: Receipt;
  readonly tgz: string;
  readonly checksum: string;
  readonly sha512: string;
}> {
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
    !Number.isSafeInteger(receipt.artifact.size) ||
    receipt.artifact.size !== tgzStat.size
  ) {
    fail("artifact-integrity-invalid", "receipt size differs from tgz");
  }
  const bytes = await readFile(tgzPath);
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  if (
    receipt.artifact.integrity !==
    `sha512-${Buffer.from(sha512, "hex").toString("base64")}`
  ) {
    fail("artifact-integrity-invalid", "receipt SRI differs from tgz");
  }
  const checksum = path.join(directory, receipt.artifact.checksumFile);
  const checksumBytes = await readFile(checksum, "utf8");
  if (checksumBytes !== `${sha512}  ${tgz.name}\n`)
    fail("artifact-integrity-invalid", "checksum file differs from tgz");
  return { receipt, tgz: tgzPath, checksum, sha512 };
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

const ticket09ReceiptFilePaths = [
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli-command-identity.js",
  "package/dist/cli.js",
  "package/dist/main.js",
  "package/package.json",
] as const;

function hasCanonicalReceiptFiles(files: Receipt["files"]): boolean {
  if (
    files.length !== ticket09ReceiptFilePaths.length ||
    files.some((file, index) => file.path !== ticket09ReceiptFilePaths[index])
  ) {
    return false;
  }
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

function hasStableSemverShape(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}

async function assertArtifactIdentity(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly receipt: Receipt;
  readonly githubRepository: string;
}): Promise<void> {
  const { receipt } = options;
  const manifest = parseJson(
    await readFile(
      path.join(options.repositoryRoot, options.packagePath, "package.json"),
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
    packedRepository.directory !== options.packagePath ||
    sourceRepository?.type !== "git" ||
    sourceRepository.url !== publication.repository ||
    sourceRepository.directory !== options.packagePath ||
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

export async function acceptDownloadedPublicationArtifact(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly artifactDirectory: string;
  readonly githubRepository: unknown;
}): Promise<AcceptedPublicationArtifact> {
  const artifact = await readArtifact(options.artifactDirectory);
  if (
    typeof options.githubRepository !== "string" ||
    options.githubRepository.length === 0
  ) {
    fail("identity-invalid", "expected string");
  }
  await assertArtifactIdentity({
    ...options,
    githubRepository: options.githubRepository,
    receipt: artifact.receipt,
  });
  return artifact;
}
