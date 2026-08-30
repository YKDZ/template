// Private implementation bridge for setup.sh; it is not a supported entrypoint.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import parseSpdxExpression from "spdx-expression-parse";

import {
  verifyNpmPublicationArtifact,
  type VerifiedPublicationArtifactReceipt,
} from "#npm-publication/artifact";
import {
  acceptDownloadedPublicationArtifact,
  type AcceptedPublicationArtifact,
} from "#npm-publication/handoff";
import { inspectNpmPublicationReadiness } from "#npm-publication/readiness";

type JsonObject = Record<string, unknown>;

type SetupFacts = {
  workingTree: "clean" | "dirty" | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  headMatchesRemoteDefault: boolean | null;
};

type Manifest = JsonObject & {
  private?: boolean;
  name?: string;
  description?: string;
  license?: string;
  repository?: string | { readonly url?: string };
  bin?: Record<string, string>;
};
type Blueprint = JsonObject & {
  packages: readonly (JsonObject & { readonly path?: string })[];
};

type Isolation = {
  readonly root: string;
  readonly home: string;
  readonly pnpmConfig: string;
  readonly pnpmStore: string;
  readonly npmCache: string;
  readonly session: string;
  readonly download: string;
  readonly userConfig: string;
  readonly globalConfig: string;
};

type NpmClient = { readonly node: string; readonly cli: string };
type NpmResult = {
  readonly status: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};
type InteractiveResult = {
  readonly status: number;
  readonly signal: string | null;
};
type RegistryExactArtifact = {
  readonly tgz: string;
  readonly size: number;
  readonly integrity: string;
};
type TrustExpectation = {
  readonly packageName: string;
  readonly repository: string;
};
type TrustRecord =
  | {
      readonly id: string;
      readonly type: "github";
      readonly repository: string;
      readonly file: "release.yml";
      readonly environment: null;
      readonly permissions: readonly ["createPackage"];
    }
  | {
      readonly package: string;
      readonly type: "github";
      readonly repository: string;
      readonly file: "release.yml";
      readonly environment: null;
      readonly permissions: readonly ["createPackage"];
    };

let activeChild: ChildProcess | undefined;
let activePrompt: { abort(): void } | undefined;
let receivedSignal: NodeJS.Signals | undefined;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const root = process.env.REPOSITORY_ROOT ?? "";
const packagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";
const oneLine = (value: unknown): string =>
  (typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value)
  )
    .replaceAll(/[\p{Cc}]/gu, "")
    .replace(/(https?:\/\/)[^/@\s]+@/gu, "$1[REDACTED]@")
    .replace(
      /(token|password|otp|session|authorization|auth|config)[=:][^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/(bearer|basic)\s+[^\s]+/giu, "$1 [REDACTED]");
const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

class SetupFailure extends Error {
  readonly code: string;
  readonly observed: unknown;
  readonly expected: unknown;
  readonly next: unknown;
  readonly exitCode: number;

  constructor(
    code: string,
    observed: unknown,
    expected: unknown,
    next: unknown,
    exitCode = 4,
  ) {
    super(code);
    this.code = code;
    this.observed = observed;
    this.expected = expected;
    this.next = next;
    this.exitCode = exitCode;
  }
}

function gitFacts() {
  const facts: SetupFacts = {
    workingTree: null,
    currentBranch: null,
    defaultBranch: null,
    headMatchesRemoteDefault: null,
  };
  let unavailable = false;
  let remote = null;
  let detached = false;
  try {
    const run = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    facts.workingTree = run("status", "--porcelain") === "" ? "clean" : "dirty";
    try {
      facts.currentBranch =
        run("symbolic-ref", "--quiet", "--short", "HEAD") || null;
    } catch (error) {
      if (isObject(error) && error.status === 1) detached = true;
      else throw error;
    }
    remote = run("remote", "get-url", "origin");
    const remoteListing = run("ls-remote", "--symref", "origin", "HEAD").split(
      "\n",
    );
    facts.defaultBranch =
      remoteListing
        .find((line) => line.startsWith("ref: "))
        ?.match(/refs\/heads\/([^\t]+)/u)?.[1] ?? null;
    const remoteHead = remoteListing
      .find((line) => /^[0-9a-f]{40}\s+HEAD$/u.test(line))
      ?.split(/\s+/u)[0];
    facts.headMatchesRemoteDefault =
      remoteHead === undefined ? null : run("rev-parse", "HEAD") === remoteHead;
  } catch {
    unavailable = true;
  }
  return { facts, unavailable, remote, detached };
}

async function status() {
  let readiness = "unavailable";
  let blockers: {
    readonly code: string;
    readonly observed: string;
    readonly expected: string;
    readonly nextAction: string;
  }[] = [];
  let publication;
  let statusExitCode = 0;
  try {
    const result = await inspectNpmPublicationReadiness({
      repositoryRoot: root,
      packagePath,
    });
    if (result.kind === "ready") {
      readiness = "ready";
      publication = result.publication;
    } else {
      readiness =
        result.mode === "safe-unconfigured"
          ? "safe-unconfigured"
          : "public-intent-blocked";
      blockers = result.blockers.map((item) => ({
        code: item.code,
        observed: oneLine(item.observed),
        expected: oneLine(item.expected),
        nextAction: oneLine(item.nextAction),
      }));
    }
  } catch (error) {
    statusExitCode = 5;
    blockers = [
      {
        code: "readiness-unavailable",
        observed: oneLine(error),
        expected: "Readable local publication facts",
        nextAction: "Correct the repository facts and retry.",
      },
    ];
  }
  const {
    facts: git,
    unavailable: gitUnavailable,
    remote,
    detached,
  } = gitFacts();
  if (readiness === "ready" && gitUnavailable) {
    statusExitCode = 5;
    blockers = [
      ...blockers,
      {
        code: "git-status-unavailable",
        observed: "Git facts could not be read",
        expected: "Readable public Git default branch facts",
        nextAction: "Correct the Git or network failure and retry.",
      },
    ];
  }
  if (
    readiness === "ready" &&
    !gitUnavailable &&
    !remoteMatchesPublicOwner(remote)
  ) {
    statusExitCode = 4;
    blockers = [
      ...blockers,
      {
        code: "repository-remote-conflict",
        observed: oneLine(redactRemote(remote)),
        expected: "The public package owner GitHub repository",
        nextAction: "Correct the normal Git remote and retry.",
      },
    ];
  }
  if (readiness === "ready" && !gitUnavailable && detached) {
    statusExitCode = 3;
    blockers = [
      ...blockers,
      {
        code: "git-handoff-required",
        observed: "HEAD is detached",
        expected: "A checked-out public default branch",
        nextAction: "Complete the normal Git handoff and rerun setup.",
      },
    ];
  }
  const prerequisiteBlocked =
    readiness === "unavailable" ||
    blockers.some(
      (blocker) =>
        blocker.code.startsWith("local-template-metadata-") ||
        blocker.code === "private-runtime-dependency",
    );
  const currentStage = prerequisiteBlocked
    ? {
        id: "check-prerequisites",
        number: 1,
        name: "Check prerequisites",
      }
    : readiness === "ready" &&
        git.workingTree === "clean" &&
        git.currentBranch !== null &&
        git.currentBranch === git.defaultBranch &&
        git.headMatchesRemoteDefault
      ? {
          id: "verify-first-release-artifact",
          number: 4,
          name: "Verify the first release artifact",
        }
      : readiness === "ready"
        ? {
            id: "commit-publication-configuration",
            number: 3,
            name: "Commit the publication configuration",
          }
        : {
            id: "configure-public-package",
            number: 2,
            name: "Configure the public package",
          };
  if (blockers.length === 0 && currentStage.number === 3)
    blockers = [
      {
        code: "git-handoff-required",
        observed: oneLine(git.workingTree),
        expected: "A clean synchronized public default branch",
        nextAction:
          "Use the normal Git review and merge flow, then rerun setup.",
      },
    ];
  print({
    schemaVersion: 1,
    currentStage,
    observations: {
      packagePath,
      packageName: publication?.packageName ?? null,
      commandName: publication?.commandName ?? null,
      version: publication?.version ?? null,
      repository: publication?.repository ?? null,
      readiness,
      git,
    },
    blockers,
    nextAction: {
      kind:
        currentStage.number === 1
          ? "retry-external-check"
          : currentStage.number === 2
            ? "provide-public-facts"
            : currentStage.number === 3
              ? "normal-git-handoff"
              : "verify-artifact",
      command: "./scripts/npm-publication-setup/setup.sh",
    },
  });
  process.exitCode = statusExitCode;
}

async function preflight() {
  let readiness;
  try {
    readiness = await inspectNpmPublicationReadiness({
      repositoryRoot: root,
      packagePath,
    });
  } catch {
    stop(
      "readiness-unavailable",
      "Ticket 08 readiness could not read local publication facts",
      "Readable local publication facts",
      "Correct the repository facts and retry.",
      5,
    );
  }
  if (readiness.kind === "ready") return;
  const nonConfigurationBlocker = readiness.blockers.find(
    (item) =>
      item.code.startsWith("local-template-metadata-") ||
      item.code === "private-runtime-dependency",
  );
  if (nonConfigurationBlocker !== undefined)
    stop(
      nonConfigurationBlocker.code,
      nonConfigurationBlocker.observed,
      nonConfigurationBlocker.expected,
      nonConfigurationBlocker.nextAction,
    );
  if (readiness.mode === "safe-unconfigured") return;
  const blocker = readiness.blockers[0];
  stop(blocker.code, blocker.observed, blocker.expected, blocker.nextAction);
}

function canonicalGitHubRepository(value: unknown): string | null {
  try {
    if (typeof value !== "string") return null;
    const candidate = value
      .replace(/^git\+/u, "")
      .replace(/^git@github\.com:/u, "https://github.com/");
    const url = new URL(candidate);
    if (url.username.length > 0 || url.password.length > 0) return null;
    const pathname = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    return url.hostname.toLowerCase() === "github.com" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pathname)
      ? `https://github.com/${pathname}`
      : null;
  } catch {
    return null;
  }
}

function redactRemote(value: unknown): string {
  return oneLine(value);
}

function repositoryOwner() {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, packagePath, "package.json"), "utf8"),
    );
    const repository =
      typeof manifest.repository === "object" && manifest.repository !== null
        ? manifest.repository.url
        : manifest.repository;
    return canonicalGitHubRepository(repository);
  } catch {
    return null;
  }
}

function remoteMatchesPublicOwner(remote: unknown): boolean {
  const owner = repositoryOwner();
  return owner !== null && owner === canonicalGitHubRepository(remote);
}

function remoteMatchesOwner() {
  process.exitCode = remoteMatchesPublicOwner(process.env.REMOTE_URL) ? 0 : 1;
}

function receiptLines(receipt: VerifiedPublicationArtifactReceipt): string[] {
  const lines = [
    `Package: ${oneLine(receipt.publication.packageName)}@${oneLine(receipt.publication.version)}`,
    `Command: ${oneLine(receipt.publication.commandName)}`,
    `Repository: ${oneLine(receipt.publication.repository)}`,
    `Release date: ${oneLine(receipt.publication.releaseDate)}`,
    `Release notes: ${oneLine(receipt.publication.releaseNotes)}`,
    `Artifact: ${oneLine(receipt.artifact.file)} (${receipt.artifact.size} bytes)`,
    `Integrity: ${oneLine(receipt.artifact.integrity)}`,
    `Checksum: ${oneLine(receipt.artifact.checksumFile)}`,
    `Packed manifest: ${oneLine(JSON.stringify(receipt.packedManifest))}`,
  ];
  for (const file of receipt.files)
    lines.push(
      `File: ${oneLine(file.path)} mode ${file.mode} size ${file.size}`,
    );
  lines.push(
    `Bin: ${oneLine(receipt.bin.path)} mode ${receipt.bin.mode}`,
    `Bin shebang: ${oneLine(receipt.bin.shebang)}`,
  );
  for (const smoke of receipt.smokes)
    lines.push(
      `Smoke: ${oneLine(smoke.name)} args ${oneLine(JSON.stringify(smoke.args))} stdout ${oneLine(smoke.stdout)}`,
    );
  lines.push(
    `ACCEPT ${oneLine(receipt.publication.packageName)}@${oneLine(receipt.publication.version)} ${oneLine(receipt.artifact.integrity)}`,
  );
  return lines;
}

async function artifact() {
  const outputDirectory = process.env.ARTIFACT_OUTPUT_DIRECTORY;
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    reportFailure(
      new SetupFailure(
        "artifact-temporary-output",
        "artifact output directory is unavailable",
        "an owned local temporary directory",
        "Correct temporary directory permissions and retry.",
        5,
      ),
    );
    return;
  }
  try {
    const result = await verifyNpmPublicationArtifact({
      repositoryRoot: root,
      packagePath,
      outputDirectory,
    });
    if (result.kind === "blocked") {
      for (const blocker of result.readiness.blockers)
        process.stdout.write(
          `ERROR ${oneLine(blocker.code)}\nObserved: ${oneLine(blocker.observed)}\nExpected: ${oneLine(blocker.expected)}\nNext action: ${oneLine(blocker.nextAction)}\n`,
        );
      process.exitCode = 4;
      return;
    }
    if (result.kind === "failed") {
      const { failure } = result;
      process.stdout.write(
        `ERROR ${oneLine(failure.code)}\nObserved: ${oneLine(failure.observed)}\nExpected: ${oneLine(failure.expected)}\nNext action: ${oneLine(failure.nextAction)}\n`,
      );
      process.exitCode = 5;
      return;
    }
    process.stdout.write(`${receiptLines(result.receipt).join("\n")}\n`);
  } catch {
    reportFailure(
      new SetupFailure(
        "artifact-verification-failed",
        "the Ticket 09 artifact verifier could not complete",
        "a verified local publication artifact",
        "Correct the local artifact failure and retry.",
        5,
      ),
    );
  }
}

function stop(
  code: string,
  observed: unknown,
  expected: unknown,
  next: unknown,
  exitCode = 4,
): never {
  throw new SetupFailure(code, observed, expected, next, exitCode);
}

function reportFailure(failure: SetupFailure): void {
  process.stderr.write(
    `${failure.exitCode === 3 ? "ACTION REQUIRED" : "ERROR"} ${failure.code}\nObserved: ${oneLine(failure.observed)}\nExpected: ${oneLine(failure.expected)}\nNext action: ${oneLine(failure.next)}\n`,
  );
  process.exitCode = failure.exitCode;
}

function placeholder(key: string): string {
  return `{{${key}}}`;
}

function validGregorianDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function asset(file: string): string {
  const setupDirectory = process.env.SETUP_DIR;
  if (setupDirectory === undefined)
    throw new Error("setup directory is unavailable");
  return readFileSync(path.join(setupDirectory, "assets", file), "utf8");
}

async function configure() {
  const packageRoot = path.join(root, packagePath);
  const files: readonly [string, string, string, string, string, string] = [
    path.join(packageRoot, "package.json"),
    path.join(root, ".template/blueprint.json"),
    path.join(root, "LICENSE"),
    path.join(packageRoot, "LICENSE"),
    path.join(packageRoot, "README.md"),
    path.join(packageRoot, "CHANGELOG.md"),
  ];
  const beforeExists = new Map(files.map((file) => [file, existsSync(file)]));
  const before = new Map(
    files.map((file) => [
      file,
      beforeExists.get(file) ? readFileSync(file) : null,
    ]),
  );
  let manifest: Manifest;
  let blueprint: Blueprint;
  try {
    const parsedManifest: unknown = JSON.parse(readFileSync(files[0], "utf8"));
    const parsedBlueprint: unknown = JSON.parse(readFileSync(files[1], "utf8"));
    if (
      !isObject(parsedManifest) ||
      !isObject(parsedBlueprint) ||
      !Array.isArray(parsedBlueprint.packages)
    )
      stop(
        "owner-fact-invalid",
        "owner JSON has an unsupported shape",
        "readable owner JSON",
        "Repair the owner file and retry.",
        5,
      );
    manifest = parsedManifest;
    blueprint = parsedBlueprint as Blueprint;
  } catch (error) {
    stop(
      "owner-fact-invalid",
      error,
      "readable owner JSON",
      "Repair the owner file and retry.",
    );
  }
  const input = {
    packageName: process.env.PACKAGE_NAME,
    commandName: process.env.COMMAND_NAME,
    description: process.env.DESCRIPTION,
    license: process.env.LICENSE_NAME,
    copyrightHolder: process.env.COPYRIGHT_HOLDER,
    repository: process.env.REPOSITORY_URL,
  };
  const existingRepository =
    typeof manifest.repository === "object" && manifest.repository !== null
      ? manifest.repository.url?.replace(/^git\+/u, "").replace(/\.git$/u, "")
      : undefined;
  const existingHolder = before
    .get(files[2])
    ?.toString()
    .match(/^Copyright(?: \(c\))?\s+(.+)$/mu)?.[1];
  const facts = {
    name: input.packageName || manifest.name,
    command: input.commandName || Object.keys(manifest.bin ?? {})[0],
    description: input.description || manifest.description,
    license: input.license || manifest.license,
    holder: input.copyrightHolder || existingHolder,
    repository: input.repository || existingRepository,
  };
  const initialPrivateBin =
    typeof manifest.bin === "object" &&
    manifest.bin !== null &&
    !Array.isArray(manifest.bin) &&
    Object.keys(manifest.bin).length === 1 &&
    manifest.bin.cli === "./dist/cli.js";
  if (manifest.private === true && !initialPrivateBin)
    stop(
      "owner-fact-conflict",
      "package bin has reviewed private intent",
      "the generated placeholder CLI bin before public configuration",
      "Resolve the package bin through normal review.",
    );
  const publicOwnerConflicts = [
    ["description", input.description, manifest.description],
    ["license", input.license, manifest.license],
    ["repository", input.repository, existingRepository],
    ["copyright holder", input.copyrightHolder, existingHolder],
  ].filter(
    ([, supplied, existing]) => supplied && existing && supplied !== existing,
  );
  const publicManifestConflicts = [
    ["package name", input.packageName, manifest.name],
    ["command", input.commandName, Object.keys(manifest.bin ?? {})[0]],
  ].filter(
    ([, supplied, existing]) =>
      !manifest.private && supplied && existing && supplied !== existing,
  );
  const explicitConflicts = [
    ...publicOwnerConflicts,
    ...publicManifestConflicts,
  ];
  if (explicitConflicts.length > 0) {
    const [field, supplied, existing] = explicitConflicts[0] ?? [];
    stop(
      "owner-fact-conflict",
      `${field}: ${supplied}`,
      `${field}: ${existing}`,
      "Use the existing public owner fact or resolve the conflict through normal review.",
    );
  }
  const holderRequired =
    facts.license === "MIT" || facts.license === "Apache-2.0";
  if (
    !facts.name ||
    !facts.command ||
    !facts.description?.trim() ||
    !facts.license?.trim() ||
    !facts.repository ||
    (holderRequired && !facts.holder?.trim())
  )
    stop(
      "public-fact-required",
      "missing public fact",
      "six valid public facts",
      "Provide public flags or run interactively.",
      3,
    );
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(facts.name) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      facts.repository,
    )
  )
    stop(
      "public-fact-invalid",
      "invalid package name or repository",
      "a valid public npm package name and GitHub HTTPS repository",
      "Correct the supplied public fact and retry.",
      2,
    );
  try {
    const identity = await import(
      pathToFileURL(
        path.join(root, packagePath, "src", "cli-command-identity.ts"),
      ).href
    );
    identity.validateCliCommandName(facts.command);
  } catch {
    stop(
      "public-fact-invalid",
      "invalid command name",
      "a portable unreserved CLI command name",
      "Correct --bin and retry.",
      2,
    );
  }
  try {
    parseSpdxExpression(facts.license);
  } catch {
    stop(
      "public-fact-invalid",
      facts.license,
      "a valid SPDX license expression",
      "Provide a valid --license value.",
      2,
    );
  }
  if (!manifest.private && manifest.name !== facts.name)
    stop(
      "owner-fact-conflict",
      manifest.name,
      facts.name,
      "Use the existing public package name.",
    );
  let licenseBytes: string | Buffer;
  if (facts.license === "MIT")
    licenseBytes = asset("LICENSE-MIT.txt").replaceAll(
      placeholder("COPYRIGHT_HOLDER"),
      facts.holder ?? "",
    );
  else if (facts.license === "Apache-2.0")
    licenseBytes = asset("LICENSE-APACHE-2.0.txt").replaceAll(
      "   Copyright [yyyy] [name of copyright owner]",
      `Copyright (c) ${facts.holder}`,
    );
  else {
    if (!before.get(files[2]))
      stop(
        "license-owner-required",
        "missing root LICENSE",
        "existing custom SPDX license",
        "Add the custom license through normal review.",
      );
    licenseBytes = before.get(files[2]) ?? Buffer.alloc(0);
  }
  const oldChangelog = before.get(files[5])?.toString() ?? "";
  const dates: string[] = [
    ...oldChangelog.matchAll(/^## \[1\.0\.0\] - (\d{4}-\d{2}-\d{2})$/gmu),
  ].flatMap((item) => (item[1] === undefined ? [] : [item[1]]));
  if (
    dates.length > 1 ||
    dates.some((date) => !validGregorianDate(date)) ||
    (oldChangelog.includes("## [1.0.0]") && dates.length !== 1)
  )
    stop(
      "owner-fact-conflict",
      "invalid or duplicate 1.0.0 date",
      "one valid owner date",
      "Correct CHANGELOG through normal review.",
    );
  const date = dates[0] ?? new Date().toISOString().slice(0, 10);
  const render = (file: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replaceAll(placeholder(key), value),
      asset(file),
    );
  const nextManifest = {
    ...manifest,
    name: facts.name,
    version: "1.0.0",
    description: facts.description,
    license: facts.license,
    homepage: `${facts.repository}#readme`,
    bugs: { url: `${facts.repository}/issues` },
    repository: {
      type: "git",
      url: `git+${facts.repository}.git`,
      directory: packagePath,
    },
    bin: { [facts.command]: "./dist/cli.js" },
    files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
  };
  delete nextManifest.private;
  const target = new Map([
    [files[0], Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`)],
    [
      files[1],
      Buffer.from(
        `${JSON.stringify({ ...blueprint, packages: blueprint.packages.map((item) => (item.path === packagePath ? { ...item, name: facts.name } : item)) }, null, 2)}\n`,
      ),
    ],
    [files[2], Buffer.from(licenseBytes)],
    [files[3], Buffer.from(licenseBytes)],
    [
      files[4],
      Buffer.from(
        render("README.md.template", {
          PACKAGE_NAME: facts.name,
          DESCRIPTION: facts.description,
          COMMAND_NAME: facts.command,
        }),
      ),
    ],
    [
      files[5],
      Buffer.from(
        render("CHANGELOG.md.template", {
          RELEASE_DATE: date,
          REPOSITORY_URL: facts.repository,
        }),
      ),
    ],
  ]);
  for (const file of files.slice(2)) {
    const source = before.get(file);
    if (
      source !== null &&
      source !== undefined &&
      source.byteLength > 0 &&
      Buffer.compare(source, target.get(file) ?? Buffer.alloc(0)) !== 0
    )
      stop(
        "owner-fact-conflict",
        path.relative(root, file),
        "a missing owner file or the exact partial setup owner bytes",
        "Resolve reviewed owner content through normal review.",
      );
  }
  if (
    dates.length === 1 &&
    Buffer.compare(
      before.get(files[5]) ?? Buffer.alloc(0),
      target.get(files[5]) ?? Buffer.alloc(0),
    ) !== 0
  )
    stop(
      "owner-fact-conflict",
      "CHANGELOG is not an exact previous target",
      "an exact partial setup owner fact",
      "Resolve CHANGELOG through normal review.",
    );
  const overlay = mkdtempSync(
    path.join(tmpdir(), "npm-publication-setup-overlay-"),
  );
  const ownerTemporaryPaths = new Set<string>();
  const ownsOverlay =
    path.dirname(overlay) === path.resolve(tmpdir()) &&
    path.basename(overlay).startsWith("npm-publication-setup-overlay-");
  const ownsTemporary = (temporary: string): boolean =>
    files.some(
      (file) => temporary === `${file}.npm-publication-setup-${process.pid}`,
    );
  try {
    rmSync(overlay, { recursive: true, force: true });
    cpSync(root, overlay, {
      recursive: true,
      filter: (source) =>
        !source.includes("/.git") && !source.includes("/node_modules"),
    });
    for (const [file, bytes] of target)
      writeFileSync(path.join(overlay, path.relative(root, file)), bytes);
    const readiness = await inspectNpmPublicationReadiness({
      repositoryRoot: overlay,
      packagePath,
    });
    if (readiness.kind !== "ready")
      stop(
        "configuration-plan-blocked",
        readiness.blockers[0]?.code ?? "blocked",
        "Ticket 08 readiness",
        "Correct the public facts and retry.",
      );
    for (const [file, bytes] of before)
      if (
        existsSync(file) !== beforeExists.get(file) ||
        Buffer.compare(
          existsSync(file) ? readFileSync(file) : Buffer.alloc(0),
          bytes ?? Buffer.alloc(0),
        ) !== 0
      )
        stop(
          "configuration-preimage-changed",
          path.relative(root, file),
          "unchanged owner preimages",
          "Retry from a stable working tree.",
        );
    for (const [file, bytes] of target)
      if (Buffer.compare(before.get(file) ?? Buffer.alloc(0), bytes) !== 0) {
        const temporary = `${file}.npm-publication-setup-${process.pid}`;
        ownerTemporaryPaths.add(temporary);
        writeFileSync(temporary, bytes);
        renameSync(temporary, file);
        ownerTemporaryPaths.delete(temporary);
      }
    const actualReadiness = await inspectNpmPublicationReadiness({
      repositoryRoot: root,
      packagePath,
    });
    if (
      actualReadiness.kind !== "ready" ||
      actualReadiness.publication.packageName !== facts.name ||
      actualReadiness.publication.commandName !== facts.command ||
      actualReadiness.publication.repository !== `git+${facts.repository}.git`
    )
      stop(
        "configuration-actual-readiness-blocked",
        actualReadiness.kind === "ready"
          ? "public identity did not match the applied plan"
          : (actualReadiness.blockers[0]?.code ?? "blocked"),
        "the Ticket 08 actual repository readiness result for this plan",
        "Correct the owner facts through normal review and retry.",
      );
  } finally {
    for (const temporary of ownerTemporaryPaths)
      if (ownsTemporary(temporary)) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Best-effort cleanup must not replace the structured failure.
        }
      }
    if (ownsOverlay)
      try {
        rmSync(overlay, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup must not replace the structured failure.
      }
  }
}

const publicRegistry = "https://registry.npmjs.org/";

function externalFailure(
  code: string,
  observed: unknown,
  expected: unknown,
  next: unknown,
  exitCode = 4,
): SetupFailure {
  return new SetupFailure(code, observed, expected, next, exitCode);
}

function requireExternalTty() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    throw externalFailure(
      "npm-interactive-terminal-required",
      "stdin, stdout, and stderr are not all terminals",
      "an interactive terminal for npm authentication and confirmation",
      "Run setup directly from a terminal.",
      3,
    );
}

function rejectAmbientCredentials() {
  for (const key of Object.keys(process.env)) {
    const canonical = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    const credentialKey =
      canonical === "nodeauthtoken" ||
      canonical === "npmtoken" ||
      canonical === "npmauthtoken" ||
      ((canonical.startsWith("npmconfig") ||
        canonical.startsWith("pnpmconfig")) &&
        /(auth|token|password|username|certificate|key)/u.test(canonical));
    if (credentialKey)
      throw externalFailure(
        "ambient-npm-credential-rejected",
        `environment key ${key}`,
        "no ambient npm or pnpm credential configuration",
        "Remove the credential environment variable and retry.",
        4,
      );
  }
  try {
    lstatSync(path.join(root, ".npmrc"));
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return;
    throw externalFailure(
      "repository-npmrc-unreadable",
      "repository .npmrc could not be checked",
      "no repository .npmrc",
      "Correct the repository filesystem and retry.",
      5,
    );
  }
  throw externalFailure(
    "repository-npmrc-rejected",
    "repository .npmrc exists",
    "no repository .npmrc file, directory, or symlink",
    "Remove the repository npm configuration and retry.",
    4,
  );
}

function regularRealpath(value: string, code: string): string {
  let resolved;
  try {
    resolved = realpathSync(value);
    if (!statSync(resolved).isFile()) throw new Error("not a regular file");
  } catch {
    throw externalFailure(
      code,
      value,
      "a readable regular file within the generated repository",
      "Restore the locked npm client and retry.",
      5,
    );
  }
  return resolved;
}

function directoryRealpath(value: string, code: string): string {
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw externalFailure(
      code,
      value,
      "a readable npm package directory",
      "Restore the locked npm client and retry.",
      5,
    );
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}

function controlledTemporaryParent(): string {
  const configured = process.env.TMPDIR || "/tmp";
  try {
    const parent = realpathSync(path.resolve(configured));
    if (!lstatSync(parent).isDirectory()) throw new Error("not a directory");
    return parent;
  } catch {
    throw externalFailure(
      "npm-temporary-directory-invalid",
      "TMPDIR is not a readable temporary directory",
      "a readable local temporary directory",
      "Correct TMPDIR and retry.",
      5,
    );
  }
}

function createIsolationRoot(register: (root: string) => void): string {
  const base = mkdtempSync(
    path.join(controlledTemporaryParent(), "npm-publication-setup-session-"),
  );
  // Registration is deliberately the first operation after mkdtemp: every
  // later validation or construction failure still has one external owner.
  register(base);
  const isolationRoot = realpathSync(base);
  if (!lstatSync(isolationRoot).isDirectory())
    throw externalFailure(
      "npm-temporary-directory-invalid",
      "created isolation root is not a directory",
      "an owned temporary directory",
      "Correct temporary directory permissions and retry.",
      5,
    );
  return isolationRoot;
}

function completeIsolation(isolationRoot: string): Isolation {
  const home = path.join(isolationRoot, "home");
  const pnpmConfig = path.join(isolationRoot, "pnpm-config");
  const pnpmStore = path.join(isolationRoot, "pnpm-store");
  const npmCache = path.join(isolationRoot, "npm-cache");
  const session = path.join(isolationRoot, "session");
  const download = path.join(isolationRoot, "download");
  for (const directory of [
    home,
    pnpmConfig,
    pnpmStore,
    npmCache,
    session,
    download,
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const userConfig = path.join(isolationRoot, "npm-userconfig");
  const globalConfig = path.join(isolationRoot, "npm-globalconfig");
  writeFileSync(userConfig, "", { mode: 0o600 });
  writeFileSync(globalConfig, "", { mode: 0o600 });
  writeFileSync(path.join(session, ".npmrc"), `registry=${publicRegistry}\n`, {
    mode: 0o600,
  });
  return {
    root: isolationRoot,
    home,
    pnpmConfig,
    pnpmStore,
    npmCache,
    session,
    download,
    userConfig,
    globalConfig,
  };
}

function isolatedEnvironment(isolation: Isolation): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR"])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return {
    ...environment,
    HOME: isolation.home,
    XDG_CONFIG_HOME: isolation.pnpmConfig,
    PNPM_HOME: path.join(isolation.root, "pnpm-home"),
    NPM_CONFIG_USERCONFIG: isolation.userConfig,
    NPM_CONFIG_GLOBALCONFIG: isolation.globalConfig,
    NPM_CONFIG_CACHE: isolation.npmCache,
    NPM_CONFIG_REGISTRY: publicRegistry,
  };
}

function throwIfSignalled(): void {
  if (receivedSignal !== undefined)
    throw new Error("external setup interrupted");
}

async function runChild(options: {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly captured: boolean;
  readonly allowSignal?: boolean;
}): Promise<NpmResult> {
  if (!options.allowSignal) throwIfSignalled();
  return new Promise((resolve) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const settle = (result: NpmResult): void => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      resolve(result);
    };
    let child: ChildProcess | undefined;
    try {
      child = spawn(options.command, [...options.arguments], {
        cwd: options.cwd,
        env: options.env,
        stdio: options.captured ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      activeChild = child;
      child.stdout?.on("data", (chunk: Buffer) =>
        stdout.push(Buffer.from(chunk)),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        stderr.push(Buffer.from(chunk)),
      );
      child.once("error", (error) =>
        settle({
          status: 5,
          signal: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          error,
        }),
      );
      child.once("close", (status, signal) =>
        settle({
          status: status ?? 5,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          error: undefined,
        }),
      );
    } catch (error) {
      settle({
        status: 5,
        signal: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error("child spawn failed"),
      });
    }
  });
}

async function bootstrapClient(isolation: Isolation): Promise<NpmClient> {
  const result = await runChild({
    command: "corepack",
    arguments: [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      `--registry=${publicRegistry}`,
      `--store-dir=${isolation.pnpmStore}`,
      `--config-dir=${isolation.pnpmConfig}`,
    ],
    cwd: root,
    env: isolatedEnvironment(isolation),
    captured: true,
  });
  throwIfSignalled();
  if (result.error || result.status !== 0)
    throw externalFailure(
      "npm-client-pin-invalid",
      "isolated Corepack bootstrap failed",
      "a successful frozen, lifecycle-free npm client bootstrap",
      "Correct the generated dependency installation and retry.",
      5,
    );
  const npmRoot = directoryRealpath(
    path.join(root, "node_modules", "npm"),
    "npm-client-pin-invalid",
  );
  let packageJson;
  try {
    packageJson = JSON.parse(
      readFileSync(path.join(npmRoot, "package.json"), "utf8"),
    );
  } catch {
    throw externalFailure(
      "npm-client-pin-invalid",
      "npm package metadata is unreadable",
      "npm@11.19.1",
      "Restore the locked npm client and retry.",
      5,
    );
  }
  if (
    packageJson.version !== "11.19.1" ||
    typeof packageJson.bin?.npm !== "string"
  )
    throw externalFailure(
      "npm-client-pin-invalid",
      "npm client is not version 11.19.1",
      "npm@11.19.1",
      "Restore the locked npm client and retry.",
      5,
    );
  const cli = regularRealpath(
    path.join(npmRoot, packageJson.bin.npm),
    "npm-client-pin-invalid",
  );
  if (!isInside(npmRoot, cli))
    throw externalFailure(
      "npm-client-pin-invalid",
      "npm CLI escapes its npm package root",
      "the pinned npm CLI within node_modules/npm",
      "Restore the locked npm client and retry.",
      5,
    );
  const node = regularRealpath(process.execPath, "npm-client-pin-invalid");
  return { node, cli };
}

function npmFlags(isolation: Isolation): string[] {
  return [
    `--registry=${publicRegistry}`,
    `--prefix=${isolation.session}`,
    `--userconfig=${isolation.userConfig}`,
    `--globalconfig=${isolation.globalConfig}`,
    `--cache=${isolation.npmCache}`,
  ];
}

async function capturedNpm(
  client: NpmClient,
  isolation: Isolation,
  arguments_: readonly string[],
  allowSignal = false,
): Promise<NpmResult> {
  const result = await runChild({
    command: client.node,
    arguments: [client.cli, ...arguments_, ...npmFlags(isolation)],
    cwd: isolation.session,
    env: isolatedEnvironment(isolation),
    captured: true,
    allowSignal,
  });
  if (!allowSignal) throwIfSignalled();
  return result;
}

async function interactiveNpm(
  client: NpmClient,
  isolation: Isolation,
  name: string,
  arguments_: readonly string[],
): Promise<InteractiveResult> {
  process.stdout.write(`INTERACTIVE ${name} BEGIN\n`);
  const result = await runChild({
    command: client.node,
    arguments: [client.cli, ...arguments_, ...npmFlags(isolation)],
    cwd: isolation.session,
    env: isolatedEnvironment(isolation),
    captured: false,
  });
  process.stdout.write(
    `INTERACTIVE ${name} END ${result.signal ?? result.status}\n`,
  );
  return { status: result.status, signal: result.signal };
}

async function readExactPhrase(
  expected: string,
  code = "npm-confirmation-required",
): Promise<void> {
  throwIfSignalled();
  const { createInterface } = await import("node:readline/promises");
  const lineReader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const controller = new AbortController();
  activePrompt = controller;
  try {
    const entered = await lineReader.question("Confirmation: ", {
      signal: controller.signal,
    });
    throwIfSignalled();
    if (entered !== expected)
      throw externalFailure(
        code,
        "confirmation did not match",
        expected,
        "Review the displayed registry action and enter the exact confirmation.",
        3,
      );
  } catch (error) {
    throwIfSignalled();
    throw error;
  } finally {
    activePrompt = undefined;
    lineReader.close();
  }
}

function strictJsonObject(result: NpmResult, code: string): JsonObject {
  if (result.status !== 0 || result.stderr !== "")
    throw externalFailure(
      code,
      "npm command did not return clean JSON",
      "exit 0 with JSON only on stdout",
      "Correct the registry or account state and retry.",
      5,
    );
  try {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not object");
    return value;
  } catch {
    throw externalFailure(
      code,
      "npm command returned invalid JSON",
      "one top-level JSON object",
      "Correct the registry response and retry.",
      5,
    );
  }
}

async function classifyPackageExistence(
  client: NpmClient,
  isolation: Isolation,
  packageName: string,
): Promise<"absent" | "present" | "unknown"> {
  const result = await capturedNpm(client, isolation, [
    "view",
    packageName,
    "--json",
  ]);
  if (result.status === 0) {
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (
        !isObject(value) ||
        value.name !== packageName ||
        result.stderr !== ""
      )
        return "unknown";
      return "present";
    } catch {
      return "unknown";
    }
  }
  if (result.stdout !== "") return "unknown";
  try {
    const error: unknown = JSON.parse(result.stderr);
    return isObject(error) &&
      error.code === "E404" &&
      error.pkgid === packageName
      ? "absent"
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function classifyVersion(
  client: NpmClient,
  isolation: Isolation,
  packageName: string,
): Promise<
  | { readonly kind: "absent" | "unknown" }
  | { readonly kind: "present"; readonly value: JsonObject }
  | { readonly kind: "package-present-version-absent" }
> {
  const result = await capturedNpm(client, isolation, [
    "view",
    `${packageName}@1.0.0`,
    "--json",
  ]);
  if (result.status === 0)
    return {
      kind: "present",
      value: strictJsonObject(result, "npm-registry-schema-unsupported"),
    };
  if (result.stdout !== "") return { kind: "unknown" };
  try {
    const error = JSON.parse(result.stderr);
    if (
      isObject(error) &&
      error.code === "E404" &&
      error.pkgid === `${packageName}@1.0.0`
    ) {
      const packageExistence = await classifyPackageExistence(
        client,
        isolation,
        packageName,
      );
      return packageExistence === "absent"
        ? { kind: "absent" }
        : packageExistence === "present"
          ? { kind: "package-present-version-absent" }
          : { kind: "unknown" };
    }
  } catch {
    // Only a structured target-specific E404 is absence.
  }
  return { kind: "unknown" };
}

async function assertCollaboratorWrite(
  client: NpmClient,
  isolation: Isolation,
  packageName: string,
  whoami: string,
): Promise<void> {
  const value = strictJsonObject(
    await capturedNpm(client, isolation, [
      "access",
      "list",
      "collaborators",
      packageName,
      "--json",
    ]),
    "npm-access-schema-unsupported",
  );
  if (!Object.hasOwn(value, whoami) || value[whoami] !== "read-write")
    throw externalFailure(
      "npm-write-permission-required",
      "current npm user has no exact read-write collaborator fact",
      "an own JSON property for the current username with value read-write",
      "Grant package write access through npm and retry.",
      4,
    );
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function repositoryNameFromReceipt(repository: unknown): string | null {
  const url = canonicalGitHubRepository(repository);
  return url?.replace("https://github.com/", "") ?? null;
}

async function exactRemoteArtifact(
  client: NpmClient,
  isolation: Isolation,
  accepted: AcceptedPublicationArtifact,
  packageName: string,
  metadata: JsonObject,
): Promise<RegistryExactArtifact> {
  // Every reacceptance receives a new owned directory. A previous registry
  // download must never be mistaken for this attempt's single remote tgz.
  const download = mkdtempSync(path.join(isolation.root, "registry-download-"));
  const dist = isObject(metadata.dist) ? metadata.dist : undefined;
  const repository = isObject(metadata.repository)
    ? metadata.repository
    : undefined;
  const expectedRepository = accepted.receipt.packedManifest.repository;
  const tags = strictJsonObject(
    await capturedNpm(client, isolation, [
      "view",
      packageName,
      "dist-tags",
      "--json",
    ]),
    "npm-registry-schema-unsupported",
  );
  if (
    metadata.name !== packageName ||
    metadata.version !== "1.0.0" ||
    !isObject(expectedRepository) ||
    repository === undefined ||
    Object.keys(repository).length !== 3 ||
    repository.type !== expectedRepository.type ||
    repository.url !== expectedRepository.url ||
    repository.directory !== expectedRepository.directory ||
    dist?.integrity !== accepted.receipt.artifact.integrity ||
    tags.latest !== "1.0.0"
  )
    throw externalFailure(
      "npm-existing-version-conflict",
      "registry metadata differs from the accepted artifact",
      "matching repository, SRI, and latest 1.0.0",
      "Investigate the existing npm package outside this wizard.",
      4,
    );
  const result = await capturedNpm(client, isolation, [
    "pack",
    `${packageName}@1.0.0`,
    `--pack-destination=${download}`,
  ]);
  if (result.status !== 0 || result.stderr !== "")
    throw externalFailure(
      "npm-remote-artifact-unavailable",
      "could not download a clean registry tarball",
      "one downloadable registry tarball",
      "Correct the registry failure and retry.",
      5,
    );
  const entries = readdirSync(download, { withFileTypes: true });
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    !entry.isFile() ||
    entry.name !== accepted.receipt.artifact.file
  )
    throw externalFailure(
      "npm-remote-artifact-invalid",
      "download did not contain one regular tgz",
      "one registry tarball",
      "Investigate the registry package outside this wizard.",
      4,
    );
  const remotePath = path.join(download, entry.name);
  const remoteBytes = readFileSync(remotePath);
  const localBytes = readFileSync(accepted.tgz);
  if (
    remoteBytes.byteLength !== accepted.receipt.artifact.size ||
    sha512Integrity(remoteBytes) !== accepted.receipt.artifact.integrity ||
    !remoteBytes.equals(localBytes)
  )
    throw externalFailure(
      "npm-existing-version-conflict",
      "downloaded registry bytes differ from the accepted artifact",
      "the exact accepted npm tarball",
      "Investigate the existing npm package outside this wizard.",
      4,
    );
  return {
    tgz: remotePath,
    size: remoteBytes.byteLength,
    integrity: sha512Integrity(remoteBytes),
  };
}

function parseTrustObjectStream(raw: string): JsonObject[] {
  const isAsciiWhitespace = (character: string): boolean =>
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f";
  if (raw.split("").every(isAsciiWhitespace)) return [];
  const objects: JsonObject[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "{")
      throw externalFailure(
        "npm-trust-schema-unsupported",
        "trust JSON is not an object stream",
        "blank output or whitespace-separated top-level objects",
        "Update the pinned npm adapter before retrying.",
        5,
      );
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth < 0) break;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0 || inString || escaped)
      throw externalFailure(
        "npm-trust-schema-unsupported",
        "trust JSON object is incomplete",
        "complete JSON objects",
        "Update the pinned npm adapter before retrying.",
        5,
      );
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, index));
      if (!isObject(parsed)) throw new Error("not object");
      objects.push(parsed);
    } catch {
      throw externalFailure(
        "npm-trust-schema-unsupported",
        "trust JSON object is invalid",
        "valid JSON objects",
        "Update the pinned npm adapter before retrying.",
        5,
      );
    }
    if (index === raw.length) break;
    const whitespaceStart = index;
    while (index < raw.length && isAsciiWhitespace(raw[index] ?? ""))
      index += 1;
    if (
      index === whitespaceStart ||
      (index === raw.length && whitespaceStart === index)
    )
      throw externalFailure(
        "npm-trust-schema-unsupported",
        "trust objects are not whitespace-separated",
        "ASCII whitespace between JSON objects",
        "Update the pinned npm adapter before retrying.",
        5,
      );
  }
  return objects;
}

function normalizeTrust(
  record: JsonObject,
  expected: TrustExpectation,
  dryRun: boolean,
): TrustRecord | null {
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return null;
  const allowed = dryRun
    ? new Set(["package", "type", "repository", "file", "permissions"])
    : new Set(["id", "type", "repository", "file", "permissions"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    Object.hasOwn(record, "environment")
  )
    return null;
  const id = stringValue(record.id);
  if (
    (!dryRun && (id === undefined || id.length === 0)) ||
    (dryRun && record.package !== expected.packageName) ||
    record.type !== "github" ||
    record.repository !== expected.repository ||
    record.file !== "release.yml" ||
    !Array.isArray(record.permissions) ||
    record.permissions.length !== 1 ||
    record.permissions[0] !== "createPackage"
  )
    return null;
  return dryRun
    ? {
        package: expected.packageName,
        type: "github",
        repository: expected.repository,
        file: "release.yml",
        environment: null,
        permissions: ["createPackage"],
      }
    : {
        id: id ?? "",
        type: "github",
        repository: expected.repository,
        file: "release.yml",
        environment: null,
        permissions: ["createPackage"],
      };
}

async function trustList(
  client: NpmClient,
  isolation: Isolation,
  expected: TrustExpectation,
): Promise<TrustRecord[]> {
  const result = await capturedNpm(client, isolation, [
    "trust",
    "list",
    expected.packageName,
    "--json",
  ]);
  if (result.status !== 0 || result.stderr !== "")
    throw externalFailure(
      "npm-trust-schema-unsupported",
      "trust list did not return clean JSON",
      "exit 0 with JSON only on stdout",
      "Correct the npm registry response and retry.",
      5,
    );
  const values = parseTrustObjectStream(result.stdout);
  const normalized = values.map((value) =>
    normalizeTrust(value, expected, false),
  );
  if (normalized.some((value) => value === null))
    throw externalFailure(
      "npm-trust-schema-unsupported",
      "trust list has an unsupported item shape",
      "the pinned npm 11.19.1 trust shape",
      "Update the pinned npm adapter before retrying.",
      5,
    );
  return normalized.filter((value): value is TrustRecord => value !== null);
}

async function configureTrust(
  client: NpmClient,
  isolation: Isolation,
  expected: TrustExpectation,
): Promise<void> {
  const existing = await trustList(client, isolation, expected);
  if (existing.length === 1) {
    const confirmed = await trustList(client, isolation, expected);
    if (confirmed.length === 1) return;
    throw externalFailure(
      "npm-trust-conflict",
      "trusted publisher changed during exact resume confirmation",
      "one exact trusted publisher relationship",
      "Resolve the npm trust configuration manually.",
      4,
    );
  }
  if (existing.length !== 0)
    throw externalFailure(
      "npm-trust-conflict",
      "a different or extra trusted publisher exists",
      "no trusted publisher or one exact relationship",
      "Resolve the npm trust configuration manually.",
      4,
    );
  const dryRun = await capturedNpm(client, isolation, [
    "trust",
    "github",
    expected.packageName,
    `--repository=${expected.repository}`,
    "--file=release.yml",
    "--allow-publish",
    "--dry-run",
    "--json",
  ]);
  if (dryRun.status !== 0 || dryRun.stderr !== "")
    throw externalFailure(
      "npm-trust-schema-unsupported",
      "trust dry run did not return clean JSON",
      "one clean JSON object",
      "Correct the npm registry response and retry.",
      5,
    );
  const preview = parseTrustObjectStream(dryRun.stdout);
  if (
    preview.length !== 1 ||
    normalizeTrust(preview[0] ?? {}, expected, true) === null
  )
    throw externalFailure(
      "npm-trust-schema-unsupported",
      "trust dry run differs from the required direct publish relationship",
      "one exact GitHub release.yml createPackage object",
      "Correct the npm trust facts and retry.",
      4,
    );
  process.stdout.write("TRUST PREVIEW no Environment; no stage publish.\n");
  await readExactPhrase(
    `TRUST ${expected.packageName} GITHUB ${expected.repository} release.yml createPackage`,
  );
  throwIfSignalled();
  const raced = await trustList(client, isolation, expected);
  if (raced.length === 1) return;
  if (raced.length !== 0)
    throw externalFailure(
      "npm-trust-conflict",
      "trusted publisher changed before write",
      "an empty or exact trusted publisher list",
      "Resolve the npm trust configuration manually.",
      4,
    );
  const write = await interactiveNpm(client, isolation, "npm-trust-write", [
    "trust",
    "github",
    expected.packageName,
    `--repository=${expected.repository}`,
    "--file=release.yml",
    "--allow-publish",
    "--yes",
  ]);
  throwIfSignalled();
  const readback = await trustList(client, isolation, expected);
  if (readback.length !== 1 || write.signal)
    throw externalFailure(
      "npm-trust-readback-failed",
      "trusted publisher write did not read back exactly",
      "one exact trusted publisher relationship",
      "Inspect npm trusted publishing outside this wizard.",
      4,
    );
}

function ownedArtifactRoot(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw externalFailure(
      "artifact-unavailable",
      "accepted artifact root is unavailable",
      "the accepted Stage 4 artifact root",
      "Rerun setup from Stage 1.",
      5,
    );
  const parent = controlledTemporaryParent();
  let resolved: string;
  try {
    const entry = lstatSync(value);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("not an owned directory");
    resolved = realpathSync(value);
    if (
      path.dirname(resolved) !== parent ||
      !/^npm-publication-setup-artifact\.[A-Za-z0-9]+$/u.test(
        path.basename(resolved),
      ) ||
      lstatSync(resolved).isSymbolicLink()
    )
      throw new Error("outside owned artifact parent");
  } catch {
    throw externalFailure(
      "artifact-unavailable",
      "accepted artifact root is not an owned temporary artifact directory",
      "an exact non-symlink npm-publication-setup-artifact directory",
      "Rerun setup from Stage 1.",
      5,
    );
  }
  return resolved;
}

function removeOwnedDirectory(value: string): void {
  const entry = lstatSync(value);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error("owned path changed before cleanup");
  rmSync(value, { recursive: true, force: true });
}

type GithubAsset = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly label: string | null;
  readonly state: "uploaded";
};
type GithubRelease = {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly immutable: boolean;
  readonly publishedAt: string | null;
  readonly assets: readonly GithubAsset[];
};
type GithubState = "Fresh" | "ExactTagOnly" | "ExactDraft" | "ExactPublic";

function githubFailure(
  code: string,
  observed: unknown,
  expected: unknown,
): SetupFailure {
  return externalFailure(
    code,
    observed,
    expected,
    "Inspect the GitHub repository outside this wizard and rerun setup.",
    4,
  );
}

async function capturedGh(arguments_: readonly string[]): Promise<NpmResult> {
  const environment: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: "1",
    PAGER: "cat",
    NO_COLOR: "1",
  };
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  const result = await runChild({
    command: "gh",
    arguments:
      arguments_[0] === "api"
        ? ["api", "--hostname", "github.com", ...arguments_.slice(1)]
        : arguments_,
    cwd: root,
    env: environment,
    captured: true,
  });
  throwIfSignalled();
  return result;
}

function ghJson(result: NpmResult, code: string): JsonObject {
  if (result.status !== 0 || result.stderr !== "")
    throw githubFailure(
      code,
      "GitHub did not return clean JSON",
      "one exact GitHub JSON response",
    );
  return strictJsonObject(result, code);
}

function githubAsset(value: unknown): GithubAsset | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    (value.label !== null && typeof value.label !== "string") ||
    value.state !== "uploaded"
  )
    return undefined;
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    label: value.label,
    state: "uploaded",
  };
}

function githubRelease(value: unknown): GithubRelease | undefined {
  if (
    !isObject(value) ||
    typeof value.tag_name !== "string" ||
    typeof value.name !== "string" ||
    typeof value.body !== "string" ||
    typeof value.draft !== "boolean" ||
    typeof value.prerelease !== "boolean" ||
    typeof value.immutable !== "boolean" ||
    (value.published_at !== null && typeof value.published_at !== "string") ||
    !Array.isArray(value.assets)
  )
    return undefined;
  const assets = value.assets.map(githubAsset);
  if (!assets.every((asset): asset is GithubAsset => asset !== undefined))
    return undefined;
  return {
    tag: value.tag_name,
    title: value.name,
    body: value.body,
    draft: value.draft,
    prerelease: value.prerelease,
    immutable: value.immutable,
    publishedAt: value.published_at,
    assets,
  };
}

function isGithubTimestamp(value: string | null): value is string {
  if (
    value === null ||
    !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.test(value)
  )
    return false;
  const [, year, month, day, hour, minute, second] =
    /^(.{4})-(.{2})-(.{2})T(.{2}):(.{2}):(.{2})Z$/u.exec(value)!;
  const instant = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return (
    !Number.isNaN(instant.valueOf()) &&
    instant.toISOString() === `${value.slice(0, -1)}.000Z`
  );
}

async function githubImmutable(
  repository: string,
): Promise<"enabled" | "disabled"> {
  const result = await capturedGh([
    "api",
    "--include",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    `repos/${repository}/immutable-releases`,
  ]);
  const included =
    /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*\r?\n(?:[^\r\n]*\r?\n)*\r?\n([\s\S]*)$/u.exec(
      result.stdout,
    );
  const status = included?.[1];
  const body = included?.[2] ?? "";
  if (result.status !== 0 || status !== "200") {
    if (status === "404") return "disabled";
    if (status === "401" || status === "403")
      throw githubFailure(
        "github-administration-permission-required",
        "immutable releases endpoint denied administration access",
        "repository administration permission",
      );
    if (status === "409")
      throw githubFailure(
        "github-immutable-setting-conflict",
        "immutable releases endpoint reported a conflict",
        "one stable immutable releases setting",
      );
    throw githubFailure(
      "github-immutable-state-unknown",
      "immutable releases endpoint was unavailable",
      "an exact enabled or disabled immutable-releases response",
    );
  }
  if (result.stderr !== "")
    throw githubFailure(
      "github-immutable-state-unknown",
      "immutable releases response had stderr",
      "one clean HTTP 200 immutable releases response",
    );
  let value: unknown;
  try {
    value = JSON.parse(body ?? "");
  } catch {
    throw githubFailure(
      "github-immutable-state-unknown",
      "immutable releases response was not JSON",
      "{ enabled: true, enforced_by_owner: boolean }",
    );
  }
  if (
    !isObject(value) ||
    value.enabled !== true ||
    typeof value.enforced_by_owner !== "boolean"
  )
    throw githubFailure(
      "github-immutable-state-unknown",
      "immutable releases response was not exact",
      "{ enabled: true, enforced_by_owner: boolean }",
    );
  return "enabled";
}

async function ensureGithubPreimage(
  repository: string,
  sha: string,
  expectedBranch: string,
): Promise<void> {
  const status = await capturedGh([
    "auth",
    "status",
    "--active",
    "--hostname",
    "github.com",
  ]);
  if (status.status !== 0)
    throw githubFailure(
      "github-session-required",
      "no active github.com gh session",
      "an authenticated github.com gh session",
    );
  const user = ghJson(
    await capturedGh(["api", "user"]),
    "github-identity-unknown",
  );
  if (typeof user.login !== "string")
    throw githubFailure(
      "github-identity-unknown",
      "GitHub user response was not exact",
      "one authenticated GitHub login",
    );
  const viewed = ghJson(
    await capturedGh([
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,visibility,defaultBranchRef,viewerCanAdminister,viewerPermission",
    ]),
    "github-repository-unknown",
  );
  if (
    viewed.nameWithOwner !== repository ||
    viewed.visibility !== "PUBLIC" ||
    viewed.viewerCanAdminister !== true ||
    viewed.viewerPermission !== "ADMIN" ||
    !isObject(viewed.defaultBranchRef) ||
    typeof viewed.defaultBranchRef.name !== "string" ||
    typeof viewed.defaultBranchRef.target !== "object"
  )
    throw githubFailure(
      "github-repository-conflict",
      "GitHub repository identity or visibility differs",
      `public repository ${repository}`,
    );
  const branch = viewed.defaultBranchRef.name;
  if (branch !== expectedBranch)
    throw githubFailure(
      "github-branch-conflict",
      `GitHub default branch ${branch}`,
      `local and origin default branch ${expectedBranch}`,
    );
  const apiRepository = ghJson(
    await capturedGh(["api", `repos/${repository}`]),
    "github-repository-unknown",
  );
  if (
    apiRepository.full_name !== repository ||
    apiRepository.visibility !== "public" ||
    apiRepository.default_branch !== expectedBranch ||
    !isObject(apiRepository.permissions) ||
    apiRepository.permissions.admin !== true ||
    apiRepository.permissions.push !== true
  )
    throw githubFailure(
      "github-repository-conflict",
      "GitHub repository permissions or default branch differ",
      `public repository ${repository} with administration and contents write facts`,
    );
  const ref = ghJson(
    await capturedGh([
      "api",
      `repos/${repository}/git/ref/heads/${expectedBranch}`,
    ]),
    "github-branch-unknown",
  );
  if (
    !isObject(ref.object) ||
    ref.object.type !== "commit" ||
    ref.object.sha !== sha
  )
    throw githubFailure(
      "github-branch-conflict",
      "GitHub default branch commit differs",
      `default branch commit ${sha}`,
    );
}

async function githubTag(
  repository: string,
  tag: string,
  sha: string,
  annotation: string,
): Promise<"absent" | "exact"> {
  const ref = await capturedGh([
    "api",
    "--include",
    `repos/${repository}/git/ref/tags/${tag}`,
  ]);
  if (ref.status !== 0) {
    if (/^HTTP\/\d(?:\.\d)? 404(?:\s|$)/mu.test(ref.stdout)) return "absent";
    throw githubFailure(
      "github-release-state-unknown",
      "tag reference could not be classified",
      "an absent or exact annotated tag",
    );
  }
  const body = /\r?\n\r?\n([\s\S]*)$/u.exec(ref.stdout)?.[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw githubFailure(
      "github-release-state-unknown",
      "tag reference was not JSON",
      "an exact annotated tag",
    );
  }
  if (
    !isObject(parsed) ||
    !isObject(parsed.object) ||
    parsed.object.type !== "tag" ||
    typeof parsed.object.sha !== "string"
  )
    throw githubFailure(
      "github-release-conflict",
      "tag is not annotated",
      "an exact annotated tag",
    );
  const object = ghJson(
    await capturedGh([
      "api",
      `repos/${repository}/git/tags/${parsed.object.sha}`,
    ]),
    "github-release-state-unknown",
  );
  if (
    object.tag !== tag ||
    object.message !== annotation ||
    !isObject(object.object) ||
    object.object.type !== "commit" ||
    object.object.sha !== sha
  )
    throw githubFailure(
      "github-release-conflict",
      "tag differs from the accepted artifact preimage",
      "the exact annotated first-release tag",
    );
  return "exact";
}

async function githubReleaseForTag(
  repository: string,
  tag: string,
): Promise<GithubRelease | undefined> {
  const result = await capturedGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/releases?per_page=100`,
  ]);
  if (result.status !== 0 || result.stderr !== "")
    throw githubFailure(
      "github-release-state-unknown",
      "releases could not be listed",
      "one complete release listing",
    );
  let pages: unknown;
  try {
    pages = JSON.parse(result.stdout);
  } catch {
    throw githubFailure(
      "github-release-state-unknown",
      "release listing was not JSON",
      "one complete release listing",
    );
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw githubFailure(
      "github-release-state-unknown",
      "release listing had an unsupported shape",
      "one complete release listing",
    );
  const matches = pages
    .flat()
    .filter((item) => isObject(item) && item.tag_name === tag)
    .map(githubRelease);
  if (matches.length > 1 || matches.some((item) => item === undefined))
    throw githubFailure(
      "github-release-conflict",
      "release state is ambiguous",
      "at most one exact first release",
    );
  return matches[0];
}

async function githubWriteFailure(
  repository: string,
  tag: string,
  sha: string,
  annotation: string,
  accepted: AcceptedPublicationArtifact,
  downloads: string,
  observed: unknown,
  expected: unknown,
): Promise<never> {
  // A failed or indeterminate write gets exactly one bounded, read-only target
  // diagnosis. It is evidence for a human; it never becomes a repair loop.
  const diagnosis: string[] = [];
  let remoteImmutable: "enabled" | "disabled" | "unknown" = "unknown";
  try {
    remoteImmutable = await githubImmutable(repository);
    diagnosis.push(`immutable=${remoteImmutable}`);
  } catch (error) {
    diagnosis.push(
      `immutable=${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  try {
    const remoteTag = await githubTag(repository, tag, sha, annotation);
    const release = await githubReleaseForTag(repository, tag);
    if (remoteTag === "absent" && release === undefined)
      diagnosis.push("state=Fresh");
    else if (remoteTag === "exact" && release === undefined)
      diagnosis.push("state=ExactTagOnly");
    else if (remoteTag === "exact" && release?.draft) {
      await assertGithubRelease(
        repository,
        release,
        accepted,
        tag,
        true,
        downloads,
      );
      diagnosis.push("state=ExactDraft");
    } else if (
      remoteTag === "exact" &&
      release !== undefined &&
      !release.draft &&
      release.immutable &&
      isGithubTimestamp(release.publishedAt) &&
      remoteImmutable === "enabled"
    ) {
      await assertGithubRelease(
        repository,
        release,
        accepted,
        tag,
        false,
        downloads,
      );
      for (const arguments_ of [
        ["release", "verify", tag, "--repo", repository],
        ["release", "verify-asset", tag, accepted.tgz, "--repo", repository],
        [
          "release",
          "verify-asset",
          tag,
          accepted.checksum,
          "--repo",
          repository,
        ],
      ] as const)
        if ((await capturedGh(arguments_)).status !== 0)
          throw new Error("public-attestation-invalid");
      diagnosis.push("state=ExactPublic");
    } else diagnosis.push("state=Conflict");
  } catch (error) {
    const code = error instanceof SetupFailure ? error.code : "unknown";
    const state = [
      "github-release-conflict",
      "github-release-asset-conflict",
      "github-immutable-setting-conflict",
    ].includes(code)
      ? "Conflict"
      : code === "github-release-attestation-invalid"
        ? "Incident"
        : "Unknown";
    diagnosis.push(`state=${state}:${code}`);
  }
  throw githubFailure(
    "github-release-write-failed",
    `${String(observed)}; read-only diagnosis: ${diagnosis.join(", ")}`,
    expected,
  );
}

async function assertGithubRelease(
  repository: string,
  release: GithubRelease,
  accepted: AcceptedPublicationArtifact,
  tag: string,
  draft: boolean,
  downloads: string,
): Promise<void> {
  const checksum = readFileSync(accepted.checksum);
  const expected = new Map([
    [path.basename(accepted.tgz), accepted.receipt.artifact.size],
    ["SHA512SUMS", checksum.byteLength],
  ]);
  if (
    release.tag !== tag ||
    release.title !== tag ||
    release.body !== accepted.receipt.publication.releaseNotes ||
    release.draft !== draft ||
    release.prerelease ||
    release.assets.length !== 2 ||
    release.assets.some(
      (asset) =>
        expected.get(asset.name) !== asset.size ||
        asset.label !== null ||
        asset.state !== "uploaded" ||
        release.assets.filter((candidate) => candidate.name === asset.name)
          .length !== 1,
    )
  )
    throw githubFailure(
      "github-release-conflict",
      "release identity or assets differ",
      "the exact first-release draft",
    );
  for (const asset of release.assets) {
    const destination = path.join(downloads, `asset-${asset.id}`);
    const result = await capturedGh([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${asset.id}`,
      `--output=${destination}`,
    ]);
    if (result.status !== 0)
      throw githubFailure(
        "github-release-asset-conflict",
        "release asset could not be downloaded",
        "exact release asset bytes",
      );
    const bytes = readFileSync(destination);
    const local =
      asset.name === "SHA512SUMS" ? checksum : readFileSync(accepted.tgz);
    if (!bytes.equals(local))
      throw githubFailure(
        "github-release-asset-conflict",
        "release asset bytes differ",
        "the accepted artifact bytes",
      );
    rmSync(destination, { force: true });
  }
}

async function runGithubFirstRelease(options: {
  readonly isolation: Isolation;
  readonly client: NpmClient;
  readonly accepted: AcceptedPublicationArtifact;
  readonly repository: string;
  readonly sha: string;
  readonly branch: string;
}): Promise<void> {
  const { isolation, client, accepted, repository, sha, branch } = options;
  // Stage 8 deliberately receives a new registry download, even after Stage 6
  // already proved publication. ExactPublic therefore never verifies a stale
  // handoff tarball.
  const initialView = await classifyVersion(
    client,
    isolation,
    accepted.receipt.publication.packageName,
  );
  if (initialView.kind !== "present")
    throw githubFailure(
      "github-preimage-changed",
      "registry publication is no longer the accepted exact version",
      "the exact published registry artifact",
    );
  const initialRegistryArtifact = await exactRemoteArtifact(
    client,
    isolation,
    accepted,
    accepted.receipt.publication.packageName,
    initialView.value,
  );
  const initialExactArtifact: AcceptedPublicationArtifact = {
    ...accepted,
    tgz: initialRegistryArtifact.tgz,
  };
  const tag = "v1.0.0";
  const annotation = `npm artifact SHA-512: ${accepted.sha512}`;
  await ensureGithubPreimage(repository, sha, branch);
  const initialImmutable = await githubImmutable(repository);
  let immutable = initialImmutable;
  const tagState = await githubTag(repository, tag, sha, annotation);
  let release = await githubReleaseForTag(repository, tag);
  let state: GithubState;
  if (tagState === "absent" && release === undefined) state = "Fresh";
  else if (tagState === "exact" && release === undefined)
    state = "ExactTagOnly";
  else if (tagState === "exact" && release !== undefined && release.draft)
    state = "ExactDraft";
  else if (
    tagState === "exact" &&
    release !== undefined &&
    !release.draft &&
    release.immutable &&
    isGithubTimestamp(release.publishedAt)
  )
    state = "ExactPublic";
  else
    throw githubFailure(
      "github-release-conflict",
      "remote tag and release state is not an exact resumable state",
      "Fresh, ExactTagOnly, ExactDraft, or ExactPublic",
    );
  const downloads = mkdtempSync(
    path.join(isolation.root, "github-release-assets-"),
  );
  if (state === "ExactPublic") {
    if (immutable !== "enabled")
      throw githubFailure(
        "github-immutable-state-unknown",
        "immutable releases is not enabled",
        "enabled immutable releases",
      );
    await assertGithubRelease(
      repository,
      release!,
      initialExactArtifact,
      tag,
      false,
      downloads,
    );
    for (const arguments_ of [
      ["release", "verify", tag, "--repo", repository],
      [
        "release",
        "verify-asset",
        tag,
        initialExactArtifact.tgz,
        "--repo",
        repository,
      ],
      [
        "release",
        "verify-asset",
        tag,
        initialExactArtifact.checksum,
        "--repo",
        repository,
      ],
    ] as const)
      if ((await capturedGh(arguments_)).status !== 0)
        throw githubFailure(
          "github-release-attestation-invalid",
          "GitHub release attestation was not accepted",
          "three successful GitHub release verification commands",
        );
    return;
  }
  if (state === "ExactDraft")
    await assertGithubRelease(
      repository,
      release!,
      initialExactArtifact,
      tag,
      true,
      downloads,
    );
  const phrase = `RELEASE ${accepted.receipt.publication.packageName}@1.0.0 ${accepted.receipt.artifact.integrity} TO ${repository} ${tag} AT ${sha}`;
  process.stdout.write(
    `GitHub release preview: ${state}; immutable releases ${immutable}.\n`,
  );
  await readExactPhrase(phrase, "github-release-confirmation-required");
  // A confirmation authorizes one bounded attempt only. Re-observe every fact
  // before its first GitHub write and never repair a partial remote result.
  const refreshed = await acceptDownloadedPublicationArtifact({
    repositoryRoot: root,
    packagePath,
    artifactDirectory: process.env.ARTIFACT_ROOT!,
    githubRepository: repository,
  }).catch(() => {
    throw githubFailure(
      "github-preimage-changed",
      "accepted artifact changed after confirmation",
      "the accepted receipt-bound artifact",
    );
  });
  if (
    refreshed.tgz !== accepted.tgz ||
    refreshed.checksum !== accepted.checksum ||
    refreshed.sha512 !== accepted.sha512 ||
    JSON.stringify(refreshed.receipt) !== JSON.stringify(accepted.receipt)
  )
    throw githubFailure(
      "github-preimage-changed",
      "receipt, notes, checksum, or artifact identity changed after confirmation",
      "the original confirmation-bound publication preimage",
    );
  const registryArtifact = await exactRemoteArtifact(
    client,
    isolation,
    accepted,
    accepted.receipt.publication.packageName,
    strictJsonObject(
      await capturedNpm(client, isolation, [
        "view",
        `${accepted.receipt.publication.packageName}@1.0.0`,
        "--json",
      ]),
      "npm-registry-schema-unsupported",
    ),
  );
  const exactArtifact: AcceptedPublicationArtifact = {
    ...accepted,
    tgz: registryArtifact.tgz,
  };
  await ensureGithubPreimage(repository, sha, branch);
  const recheckedGit = gitFacts();
  if (
    recheckedGit.unavailable ||
    recheckedGit.detached ||
    recheckedGit.facts.workingTree !== "clean" ||
    recheckedGit.facts.currentBranch !== branch ||
    recheckedGit.facts.defaultBranch !== branch ||
    !recheckedGit.facts.headMatchesRemoteDefault ||
    !remoteMatchesPublicOwner(recheckedGit.remote) ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() !== sha
  )
    throw githubFailure(
      "github-preimage-changed",
      "local Git handoff facts changed after confirmation",
      "the accepted clean synchronized default-branch preimage",
    );
  immutable = await githubImmutable(repository);
  if (immutable !== initialImmutable)
    throw githubFailure(
      "github-preimage-changed",
      "immutable releases classification changed after confirmation",
      `unchanged immutable releases ${initialImmutable}`,
    );
  const afterTag = await githubTag(repository, tag, sha, annotation);
  release = await githubReleaseForTag(repository, tag);
  if (
    (state === "Fresh" && (afterTag !== "absent" || release !== undefined)) ||
    (state === "ExactTagOnly" &&
      (afterTag !== "exact" || release !== undefined)) ||
    (state === "ExactDraft" &&
      (afterTag !== "exact" || release === undefined || !release.draft))
  )
    throw githubFailure(
      "github-preimage-changed",
      "GitHub release classification changed after confirmation",
      `unchanged ${state} classification`,
    );
  if (state === "ExactDraft")
    await assertGithubRelease(
      repository,
      release!,
      exactArtifact,
      tag,
      true,
      downloads,
    );
  if (immutable === "disabled") {
    const enabled = await capturedGh([
      "api",
      "--include",
      "--method",
      "PUT",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      `repos/${repository}/immutable-releases`,
    ]);
    if (
      enabled.status !== 0 ||
      !/^HTTP\/\d(?:\.\d)? 204[^\r\n]*\r?\n(?:[^\r\n]*\r?\n)*\r?\n$/u.test(
        enabled.stdout,
      )
    )
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "immutable releases enable failed",
        "an exact bodyless HTTP 204 followed by an enabled readback",
      );
    if ((await githubImmutable(repository)) !== "enabled")
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "immutable releases did not read back enabled",
        "an enabled immutable-releases response",
      );
  }
  if (state === "Fresh") {
    const tagObjectResult = await capturedGh([
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/tags`,
      "-f",
      `tag=${tag}`,
      "-f",
      `message=${annotation}`,
      "-f",
      `object=${sha}`,
      "-f",
      "type=commit",
    ]);
    if (tagObjectResult.status !== 0 || tagObjectResult.stderr !== "")
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "tag object write failed",
        "one annotated tag object SHA",
      );
    const object = ghJson(tagObjectResult, "github-release-write-failed");
    if (typeof object.sha !== "string")
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "tag object write returned no SHA",
        "one annotated tag object SHA",
      );
    const objectSha = String(object.sha);
    if (
      (
        await capturedGh([
          "api",
          "--method",
          "POST",
          `repos/${repository}/git/refs`,
          "-f",
          `ref=refs/tags/${tag}`,
          "-f",
          `sha=${objectSha}`,
        ])
      ).status !== 0
    )
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "tag ref write failed",
        "one annotated tag reference",
      );
    if ((await githubTag(repository, tag, sha, annotation)) !== "exact")
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "annotated tag did not read back exactly",
        "one exact annotated tag reference",
      );
  }
  if (state === "Fresh" || state === "ExactTagOnly") {
    const notes = path.join(isolation.root, "github-release-notes.md");
    writeFileSync(notes, accepted.receipt.publication.releaseNotes);
    if (
      (
        await capturedGh([
          "release",
          "create",
          tag,
          exactArtifact.tgz,
          exactArtifact.checksum,
          "--draft",
          "--verify-tag",
          "--title",
          tag,
          `--notes-file=${notes}`,
          "--repo",
          repository,
        ])
      ).status !== 0
    )
      await githubWriteFailure(
        repository,
        tag,
        sha,
        annotation,
        exactArtifact,
        downloads,
        "draft release write failed",
        "one exact draft release with two assets",
      );
  }
  const draft = await githubReleaseForTag(repository, tag);
  if (draft === undefined || !draft.draft)
    await githubWriteFailure(
      repository,
      tag,
      sha,
      annotation,
      exactArtifact,
      downloads,
      "draft release did not read back",
      "one exact draft release",
    );
  await assertGithubRelease(
    repository,
    draft!,
    exactArtifact,
    tag,
    true,
    downloads,
  );
  if ((await githubImmutable(repository)) !== "enabled")
    throw githubFailure(
      "github-release-immutability-unproven",
      "immutable releases was not enabled immediately before publication",
      "an enabled immutable releases setting",
    );
  if ((await githubTag(repository, tag, sha, annotation)) !== "exact")
    throw githubFailure(
      "github-preimage-changed",
      "annotated tag changed immediately before publication",
      "the exact confirmation-bound annotated tag",
    );
  const finalDraft = await githubReleaseForTag(repository, tag);
  if (finalDraft === undefined || !finalDraft.draft)
    throw githubFailure(
      "github-preimage-changed",
      "draft release changed immediately before publication",
      "the exact confirmation-bound draft release",
    );
  await assertGithubRelease(
    repository,
    finalDraft,
    exactArtifact,
    tag,
    true,
    downloads,
  );
  if (
    (
      await capturedGh([
        "release",
        "edit",
        tag,
        "--draft=false",
        "--repo",
        repository,
      ])
    ).status !== 0
  )
    await githubWriteFailure(
      repository,
      tag,
      sha,
      annotation,
      exactArtifact,
      downloads,
      "public release transition failed",
      "one successful draft-to-public transition",
    );
  const publicRelease = await githubReleaseForTag(repository, tag);
  if ((await githubImmutable(repository)) !== "enabled")
    throw githubFailure(
      "github-release-immutability-unproven",
      "immutable releases was not enabled after publication",
      "an enabled immutable releases setting",
    );
  if ((await githubTag(repository, tag, sha, annotation)) !== "exact")
    throw githubFailure(
      "github-release-immutability-unproven",
      "annotated tag changed after publication",
      "the exact annotated tag",
    );
  if (
    publicRelease === undefined ||
    publicRelease.draft ||
    !publicRelease.immutable ||
    !isGithubTimestamp(publicRelease.publishedAt)
  )
    throw githubFailure(
      "github-release-immutability-unproven",
      "public release did not read back immutable",
      "one immutable public release",
    );
  await assertGithubRelease(
    repository,
    publicRelease,
    exactArtifact,
    tag,
    false,
    downloads,
  );
  for (const arguments_ of [
    ["release", "verify", tag, "--repo", repository],
    ["release", "verify-asset", tag, exactArtifact.tgz, "--repo", repository],
    [
      "release",
      "verify-asset",
      tag,
      exactArtifact.checksum,
      "--repo",
      repository,
    ],
  ] as const)
    if ((await capturedGh(arguments_)).status !== 0)
      throw githubFailure(
        "github-release-attestation-invalid",
        "GitHub release attestation was not accepted",
        "three successful GitHub release verification commands",
      );
}

async function external() {
  const artifactRoot = ownedArtifactRoot(process.env.ARTIFACT_ROOT);
  let isolationRoot: string | undefined;
  let isolation: Isolation | undefined;
  let client: NpmClient | undefined;
  let loginStarted = false;
  let githubReleaseVerified = false;
  let primary: unknown;
  const handlers: readonly NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];
  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    activePrompt?.abort();
    activeChild?.kill(signal);
  };
  const signalHandlers = new Map(
    handlers.map((signal) => [signal, () => onSignal(signal)]),
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    requireExternalTty();
    rejectAmbientCredentials();
    const readiness = await inspectNpmPublicationReadiness({
      repositoryRoot: root,
      packagePath,
    });
    const git = gitFacts();
    if (
      readiness.kind !== "ready" ||
      git.unavailable ||
      git.detached ||
      git.facts.workingTree !== "clean" ||
      git.facts.currentBranch !== git.facts.defaultBranch ||
      !git.facts.headMatchesRemoteDefault ||
      !remoteMatchesPublicOwner(git.remote)
    )
      throw externalFailure(
        "external-preflight-required",
        "public package or Git handoff facts changed after Stage 4",
        "a ready package on the clean synchronized public default branch",
        "Restore the public handoff facts and rerun setup.",
        4,
      );
    const repository = repositoryNameFromReceipt(
      readiness.publication.repository,
    );
    if (repository === null)
      throw externalFailure(
        "identity-invalid",
        "public package repository is not GitHub",
        "a public GitHub repository",
        "Correct the reviewed package metadata and retry.",
        4,
      );
    const accepted = await acceptDownloadedPublicationArtifact({
      repositoryRoot: root,
      packagePath,
      artifactDirectory: artifactRoot,
      githubRepository: repository,
    });
    if (accepted.receipt.publication.version !== "1.0.0")
      throw externalFailure(
        "identity-invalid",
        "accepted artifact is not version 1.0.0",
        "the reviewed first-release artifact",
        "Correct the package publication facts and retry.",
        4,
      );
    const githubSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{40}$/u.test(githubSha))
      throw externalFailure(
        "github-branch-conflict",
        "local HEAD is not an exact commit SHA",
        "one exact default-branch commit SHA",
        "Restore the public Git handoff and rerun setup.",
        4,
      );
    process.stdout.write("STAGE 5/9 Authenticate with npm\n");
    isolationRoot = createIsolationRoot((created) => {
      isolationRoot = created;
    });
    isolation = completeIsolation(isolationRoot);
    client = await bootstrapClient(isolation);
    await readExactPhrase("CONFIRM NPM 2FA AND RECOVERY CODES READY");
    throwIfSignalled();
    loginStarted = true;
    const login = await interactiveNpm(client, isolation, "npm-login", [
      "login",
      "--auth-type=web",
    ]);
    if (receivedSignal || login.signal || login.status !== 0)
      throw externalFailure(
        "npm-login-failed",
        "npm web login did not complete",
        "a successful npm web login",
        "Complete npm authentication and rerun setup.",
        4,
      );
    const whoamiResult = await capturedNpm(client, isolation, ["whoami"]);
    if (
      whoamiResult.status !== 0 ||
      whoamiResult.stderr !== "" ||
      !/^[^\s]+\n?$/u.test(whoamiResult.stdout)
    )
      throw externalFailure(
        "npm-whoami-failed",
        "npm whoami did not return one username",
        "one logged-in npm username",
        "Complete npm web login and retry.",
        4,
      );
    const whoami = whoamiResult.stdout.trim();
    process.stdout.write(
      "OK npm-authenticated\nSTAGE 6/9 Publish version 1.0.0\n",
    );
    const firstView = await classifyVersion(
      client,
      isolation,
      accepted.receipt.publication.packageName,
    );
    if (firstView.kind === "unknown")
      throw externalFailure(
        "npm-version-state-unknown",
        "registry did not prove package absence or presence",
        "a structured npm registry fact",
        "Correct the registry failure and retry.",
        5,
      );
    if (firstView.kind === "package-present-version-absent")
      throw externalFailure(
        "npm-existing-version-conflict",
        "the package exists but does not contain version 1.0.0",
        "a nonexistent package or the exact accepted 1.0.0 version",
        "Investigate the existing npm package outside this wizard.",
        4,
      );
    if (firstView.kind === "present") {
      await assertCollaboratorWrite(
        client,
        isolation,
        accepted.receipt.publication.packageName,
        whoami,
      );
      await exactRemoteArtifact(
        client,
        isolation,
        accepted,
        accepted.receipt.publication.packageName,
        firstView.value,
      );
      process.stdout.write("OK npm-publish-resumed-exact\n");
    } else {
      process.stdout.write(
        `Publish artifact: ${accepted.tgz}\nIntegrity: ${accepted.receipt.artifact.integrity}\nNo OIDC provenance is expected for this manual first publish.\n`,
      );
      await readExactPhrase(
        `PUBLISH ${accepted.receipt.publication.packageName}@1.0.0 ${accepted.receipt.artifact.integrity}`,
      );
      throwIfSignalled();
      let refreshed: AcceptedPublicationArtifact;
      try {
        refreshed = await acceptDownloadedPublicationArtifact({
          repositoryRoot: root,
          packagePath,
          artifactDirectory: artifactRoot,
          githubRepository: repository,
        });
      } catch {
        throw externalFailure(
          "artifact-preimage-changed",
          "accepted artifact could not be reverified after confirmation",
          "the accepted receipt-bound artifact",
          "Rerun setup from Stage 1.",
          4,
        );
      }
      if (
        refreshed.tgz !== accepted.tgz ||
        refreshed.receipt.artifact.integrity !==
          accepted.receipt.artifact.integrity
      )
        throw externalFailure(
          "artifact-preimage-changed",
          "accepted artifact changed after confirmation",
          "the accepted receipt-bound artifact",
          "Rerun setup from Stage 1.",
          4,
        );
      const race = await classifyVersion(
        client,
        isolation,
        accepted.receipt.publication.packageName,
      );
      if (race.kind !== "absent")
        throw externalFailure(
          race.kind === "present" ||
            race.kind === "package-present-version-absent"
            ? "npm-publish-race"
            : "npm-version-state-unknown",
          "registry version changed before publish",
          "target version absent immediately before publish",
          "Investigate the npm package and rerun setup.",
          race.kind === "present" ||
            race.kind === "package-present-version-absent"
            ? 4
            : 5,
        );
      const published = await interactiveNpm(client, isolation, "npm-publish", [
        "publish",
        accepted.tgz,
        "--access=public",
        "--tag=latest",
      ]);
      throwIfSignalled();
      const readback = await classifyVersion(
        client,
        isolation,
        accepted.receipt.publication.packageName,
      );
      if (published.signal || readback.kind !== "present")
        throw externalFailure(
          "npm-publish-readback-failed",
          "publish did not read back as an existing version",
          "the exact published 1.0.0 version",
          "Inspect npm before retrying.",
          4,
        );
      await assertCollaboratorWrite(
        client,
        isolation,
        accepted.receipt.publication.packageName,
        whoami,
      );
      await exactRemoteArtifact(
        client,
        isolation,
        accepted,
        accepted.receipt.publication.packageName,
        readback.value,
      );
      process.stdout.write("OK npm-published-exact\n");
    }
    process.stdout.write("STAGE 7/9 Configure trusted publishing\n");
    await configureTrust(client, isolation, {
      packageName: accepted.receipt.publication.packageName,
      repository,
    });
    process.stdout.write(
      "OK trusted-publishing-configured\nSTAGE 8/9 Create the first GitHub release\n",
    );
    await runGithubFirstRelease({
      isolation,
      client,
      accepted,
      repository,
      sha: githubSha,
      branch: git.facts.currentBranch!,
    });
    githubReleaseVerified = true;
  } catch (error) {
    primary = error;
  }
  let cleanupError;
  if (isolation !== undefined) {
    if (loginStarted && client !== undefined) {
      const logout = await capturedNpm(client, isolation, ["logout"], true);
      if (logout.status !== 0 && primary === undefined)
        cleanupError = externalFailure(
          "npm-session-cleanup-failed",
          "npm logout failed",
          "a completed npm logout",
          "Retry only after confirming the npm session is closed.",
          5,
        );
    }
  }
  if (isolationRoot !== undefined)
    try {
      removeOwnedDirectory(isolationRoot);
    } catch {
      if (primary === undefined)
        cleanupError = externalFailure(
          "npm-session-cleanup-failed",
          "isolated npm files could not be removed",
          "removed owned temporary files",
          "Remove the owned temporary files and retry.",
          5,
        );
    }
  try {
    removeOwnedDirectory(artifactRoot);
  } catch {
    if (primary === undefined)
      cleanupError = externalFailure(
        "npm-session-cleanup-failed",
        "accepted artifact files could not be removed",
        "removed owned temporary files",
        "Remove the owned temporary files and retry.",
        5,
      );
  }
  for (const [signal, handler] of signalHandlers)
    process.removeListener(signal, handler);
  if (receivedSignal !== undefined) process.kill(process.pid, receivedSignal);
  if (primary !== undefined) throw primary;
  if (cleanupError !== undefined) throw cleanupError;
  if (githubReleaseVerified)
    process.stdout.write(
      "STAGE 9/9 Finish setup\nOK setup-complete\nYou may now delete scripts/npm-publication-setup/ manually.\n",
    );
}

if (
  !root ||
  ![
    "status",
    "preflight",
    "configure",
    "remote-matches-owner",
    "artifact",
    "external",
  ].includes(process.argv[2] ?? "")
) {
  process.stderr.write(
    "private setup bridge requires REPOSITORY_ROOT and a supported action\n",
  );
  process.exitCode = 5;
} else {
  if (process.argv[2] === "status") await status();
  else if (process.argv[2] === "preflight" || process.argv[2] === "configure") {
    try {
      if (process.argv[2] === "preflight") await preflight();
      else await configure();
    } catch (error) {
      if (error instanceof SetupFailure) reportFailure(error);
      else
        reportFailure(
          new SetupFailure(
            "configuration-platform-failure",
            "a local owner-file or temporary-directory operation failed",
            "a readable and writable local repository",
            "Correct the platform failure and retry.",
            5,
          ),
        );
    }
  } else if (process.argv[2] === "artifact") await artifact();
  else if (process.argv[2] === "external") {
    try {
      await external();
    } catch (error) {
      if (error instanceof SetupFailure) reportFailure(error);
      else
        reportFailure(
          new SetupFailure(
            "npm-publication-platform-failure",
            oneLine(
              error instanceof Error
                ? error.message
                : "the private npm publication bridge failed unexpectedly",
            ),
            "a stable local npm publication environment",
            "Correct the local platform failure and retry.",
            5,
          ),
        );
    }
  } else remoteMatchesOwner();
}
