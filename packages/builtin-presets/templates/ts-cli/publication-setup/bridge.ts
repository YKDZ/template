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
    manifest = parsedManifest as Manifest;
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
  const configured = process.env.TMPDIR ?? tmpdir();
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

async function readExactPhrase(expected: string): Promise<void> {
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
        "npm-confirmation-required",
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
) {
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
    `--pack-destination=${isolation.download}`,
  ]);
  if (result.status !== 0 || result.stderr !== "")
    throw externalFailure(
      "npm-remote-artifact-unavailable",
      "could not download a clean registry tarball",
      "one downloadable registry tarball",
      "Correct the registry failure and retry.",
      5,
    );
  const entries = readdirSync(isolation.download, { withFileTypes: true });
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    !entry.isFile() ||
    !entry.name.endsWith(".tgz")
  )
    throw externalFailure(
      "npm-remote-artifact-invalid",
      "download did not contain one regular tgz",
      "one registry tarball",
      "Investigate the registry package outside this wizard.",
      4,
    );
  const remotePath = path.join(isolation.download, entry.name);
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

async function external() {
  const artifactRoot = ownedArtifactRoot(process.env.ARTIFACT_ROOT);
  let isolationRoot: string | undefined;
  let isolation: Isolation | undefined;
  let client: NpmClient | undefined;
  let loginStarted = false;
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
    process.stdout.write("STAGE 5/7 Authenticate with npm\n");
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
      "OK npm-authenticated\nSTAGE 6/7 Publish version 1.0.0\n",
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
    process.stdout.write("STAGE 7/7 Configure trusted publishing\n");
    await configureTrust(client, isolation, {
      packageName: accepted.receipt.publication.packageName,
      repository,
    });
    process.stdout.write(
      "OK trusted-publishing-configured\nNext action: Continue with Ticket 14 release completion work.\n",
    );
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
