// Private implementation bridge for setup.sh; it is not a supported entrypoint.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";
import parseSpdxExpression from "spdx-expression-parse";

import { publicationPackagePath as packagePath } from "../configuration.ts";
import {
  inspectTarget as inspectPublicationTarget,
  readAcceptedArtifact,
} from "../publication.ts";
import { PublicationFailure, runDirectOidcPublication } from "../publish.ts";
import { runImmutableGithubRelease } from "../release.ts";
import { readAcceptedRemoteArtifact } from "../remote-context.ts";

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

type NpmClient = { readonly repositoryRoot: string };
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
    const packageRoot = path.join(root, packagePath);
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as Manifest;
    const result = await inspectPublicationTarget({ packageRoot });
    if (result.kind === "ready") {
      readiness = "ready";
      publication = {
        packageName: result.packageName,
        version: result.packageVersion,
        commandName: Object.keys(manifest.bin ?? {})[0] ?? null,
        repository: manifest.repository ?? null,
      };
    } else if (manifest.private === true) {
      readiness = "safe-unconfigured";
    } else {
      readiness = "public-intent-blocked";
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
    blockers.some((blocker) => blocker.code === "publication-manifest-missing");
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
  let manifest: Manifest;
  let inspection;
  try {
    const packageRoot = path.join(root, packagePath);
    manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as Manifest;
    inspection = await inspectPublicationTarget({ packageRoot });
  } catch {
    stop(
      "readiness-unavailable",
      "无法读取当前发布目标的 package.json",
      "Readable local publication facts",
      "Correct the repository facts and retry.",
      5,
    );
  }
  if (inspection.kind === "ready") return;
  if (manifest.private === true) {
    if (
      typeof manifest.version !== "string" ||
      semver.valid(manifest.version) === null
    )
      stop(
        "package-version-required",
        manifest.version ?? "missing",
        "an existing valid package.json version",
        "Set the first public version through normal review, then rerun setup.",
      );
    return;
  }
  const blocker = inspection.blockers[0];
  if (blocker === undefined) throw new Error("共享发布诊断未返回阻断原因。");
  stop(blocker.code, blocker.observed, blocker.expected, blocker.nextAction);
}

async function configured() {
  const packageRoot = path.join(root, packagePath);
  const result = await inspectPublicationTarget({ packageRoot });
  if (result.kind !== "ready") {
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as Manifest;
  const repository =
    typeof manifest.repository === "object" && manifest.repository !== null
      ? manifest.repository.url
      : manifest.repository;
  const licensePath = [
    path.join(root, "LICENSE"),
    path.join(packageRoot, "LICENSE"),
  ].find(existsSync);
  const holder =
    licensePath === undefined
      ? undefined
      : readFileSync(licensePath, "utf8")
          .match(/^Copyright(?: \(c\))?\s+(.+)$/mu)?.[1]
          ?.trim();
  const licenseNeedsHolder =
    manifest.license === "MIT" || manifest.license === "Apache-2.0";
  process.exitCode =
    typeof manifest.description === "string" &&
    manifest.description.trim().length > 0 &&
    typeof manifest.license === "string" &&
    manifest.license.trim().length > 0 &&
    canonicalGitHubRepository(repository) !== null &&
    (!licenseNeedsHolder || (holder !== undefined && holder.length > 0))
      ? 0
      : 1;
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

function receiptLines(artifact: {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly sha512: string;
}): string[] {
  return [
    `Package: ${oneLine(artifact.packageName)}@${oneLine(artifact.packageVersion)}`,
    `Archive version: ${oneLine(artifact.artifactVersion)}`,
    `Artifact: ${oneLine(path.basename(artifact.artifactPath))}`,
    `SHA512: ${oneLine(artifact.sha512)}`,
    `ACCEPT ${oneLine(artifact.packageName)}@${oneLine(artifact.artifactVersion)} sha512-${Buffer.from(artifact.sha512, "hex").toString("base64")}`,
  ];
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
    const git = gitFacts();
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (
      git.unavailable ||
      git.detached ||
      git.facts.workingTree !== "clean" ||
      git.facts.currentBranch !== git.facts.defaultBranch ||
      !git.facts.headMatchesRemoteDefault ||
      !/^[0-9a-f]{40}$/u.test(sourceSha)
    ) {
      throw new Error("新远端原件必须来自干净且同步的默认分支。");
    }
    execFileSync("pnpm", ["run", "publication:remote:artifact"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: outputDirectory,
        TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR: outputDirectory,
        PUBLICATION_SOURCE_SHA: sourceSha,
        GITHUB_DEFAULT_BRANCH: git.facts.defaultBranch!,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await readAcceptedArtifact({
      packageRoot: path.join(root, packagePath),
      artifactDirectory: outputDirectory,
    });
    if (result.kind !== "prepared") {
      throw new Error("正式共享发布目标尚未通过诊断。");
    }
    const repository = canonicalGitHubRepository(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
    if (repository === null) {
      throw new Error("当前 origin 不是共享原件的公共 GitHub 来源仓库。");
    }
    const remote = await readAcceptedRemoteArtifact({
      repositoryRoot: root,
      packageRoot: path.join(root, packagePath),
      artifactDirectory: outputDirectory,
      githubRepository: repository,
      environment: process.env,
      run: setupRemoteCommand,
    });
    if (remote.sha512 !== result.sha512 || remote.sourceSha !== sourceSha) {
      throw new Error("远端原件身份与本地验收回执不一致。");
    }
    process.stdout.write(`${receiptLines(remote).join("\n")}\n`);
  } catch (error) {
    reportFailure(
      new SetupFailure(
        "artifact-verification-failed",
        error instanceof Error ? error.message : String(error),
        "正式共享 publication:prepare 与 publication:accept 生成的同一份原件",
        "修复报告中的目标配置或消费验收错误后重试。",
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

const setupAssetsDirectory = fileURLToPath(
  new URL("../../resources/setup/assets/", import.meta.url),
);

function asset(file: string): string {
  return readFileSync(path.join(setupAssetsDirectory, file), "utf8");
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
  const existingBins = Object.entries(manifest.bin ?? {});
  if (
    existingBins.length === 0 ||
    existingBins.some(
      ([, value]) => typeof value !== "string" || value.length === 0,
    )
  )
    stop(
      "command-target-required",
      "package bin target is missing or invalid",
      "an existing executable target in package.json#bin",
      "Declare the executable target through normal review before running setup.",
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
  const manifestVersion =
    typeof manifest.version === "string" ? manifest.version : "";
  const releaseVersion = semver.valid(manifestVersion);
  if (releaseVersion === null)
    stop(
      "public-fact-required",
      manifestVersion.length === 0
        ? "package version is missing"
        : `package version is invalid: ${manifestVersion}`,
      "an existing valid manifest version",
      "Set the first public version through normal review before running setup.",
      3,
    );
  const date = new Date().toISOString().slice(0, 10);
  const render = (file: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replaceAll(placeholder(key), value),
      asset(file),
    );
  const nextManifest = {
    ...manifest,
    name: facts.name,
    version: manifestVersion,
    description: facts.description,
    license: facts.license,
    homepage: `${facts.repository}#readme`,
    bugs: { url: `${facts.repository}/issues` },
    repository: {
      type: "git",
      url: `git+${facts.repository}.git`,
      directory: packagePath,
    },
    bin: (() => {
      const currentBin = manifest.bin?.[facts.command] ?? existingBins[0]?.[1];
      const nextBin = { ...manifest.bin };
      if (existingBins[0] !== undefined && existingBins[0][0] !== facts.command)
        delete nextBin[existingBins[0][0]];
      nextBin[facts.command] = currentBin!;
      return nextBin;
    })(),
  };
  delete nextManifest.private;
  const generated = new Map([
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
          RELEASE_VERSION: releaseVersion,
        }),
      ),
    ],
  ]);
  const target = new Map(generated);
  for (const file of files.slice(2))
    if (before.get(file) !== null && before.get(file) !== undefined)
      target.set(file, before.get(file)!);
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
    const plannedRoot = path.join(overlay, packagePath);
    const planned = await inspectPublicationTarget({
      packageRoot: plannedRoot,
    });
    if (planned.kind !== "ready")
      stop(
        "configuration-plan-blocked",
        planned.blockers[0]?.code ?? "blocked",
        "共享发布目标的身份、版本和消费验收配置",
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
    const actualRoot = path.join(root, packagePath);
    const actual = await inspectPublicationTarget({ packageRoot: actualRoot });
    const actualManifest = JSON.parse(
      readFileSync(path.join(actualRoot, "package.json"), "utf8"),
    ) as Manifest;
    if (
      actual.kind !== "ready" ||
      actual.packageName !== facts.name ||
      typeof actualManifest.bin?.[facts.command] !== "string" ||
      actualManifest.bin[facts.command]!.length === 0 ||
      canonicalGitHubRepository(actualManifest.repository) !== facts.repository
    )
      stop(
        "configuration-actual-readiness-blocked",
        actual.kind === "ready"
          ? "public identity did not match the applied plan"
          : (actual.blockers[0]?.code ?? "blocked"),
        "与本次配置计划一致的共享发布目标",
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
  return { repositoryRoot: root };
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
    command: "corepack",
    arguments: [
      "pnpm",
      "--dir",
      client.repositoryRoot,
      "exec",
      "npm",
      ...arguments_,
      ...npmFlags(isolation),
    ],
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
    command: "corepack",
    arguments: [
      "pnpm",
      "--dir",
      client.repositoryRoot,
      "exec",
      "npm",
      ...arguments_,
      ...npmFlags(isolation),
    ],
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
        "Update the locked npm adapter before retrying.",
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
        "Update the locked npm adapter before retrying.",
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
        "Update the locked npm adapter before retrying.",
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
        "Update the locked npm adapter before retrying.",
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
      "the locked npm trust shape",
      "Update the locked npm adapter before retrying.",
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

async function setupRemoteCommand(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  if (
    command !== "pnpm" &&
    command !== "npm" &&
    command !== "git" &&
    command !== "gh"
  ) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: "unsupported external command",
    };
  }
  const result = await runChild({
    command: command === "pnpm" ? "corepack" : command,
    arguments: command === "pnpm" ? ["pnpm", ...arguments_] : arguments_,
    cwd: options.cwd,
    env: options.env,
    captured: true,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function external() {
  const artifactRoot = ownedArtifactRoot(process.env.ARTIFACT_ROOT);
  let isolationRoot: string | undefined;
  let isolation: Isolation | undefined;
  let client: NpmClient | undefined;
  let loginStarted = false;
  let githubReleaseVerified = false;
  let primary: unknown;
  let cleanupError: unknown;
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
    const packageRoot = path.join(root, packagePath);
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const remoteRepository = canonicalGitHubRepository(remote);
    if (remoteRepository === null) {
      throw externalFailure(
        "repository-remote-conflict",
        "current origin is not a public GitHub repository",
        "the accepted artifact repository",
        "Restore the public package repository origin and retry.",
        4,
      );
    }
    const accepted = await readAcceptedRemoteArtifact({
      repositoryRoot: root,
      packageRoot,
      artifactDirectory: artifactRoot,
      githubRepository: remoteRepository,
      environment: process.env,
      run: setupRemoteCommand,
    });
    if (accepted.repositoryUrl !== remoteRepository) {
      throw externalFailure(
        "repository-remote-conflict",
        "current origin differs from the accepted source repository",
        accepted.repositoryUrl,
        "Restore the public package repository origin and retry.",
        4,
      );
    }
    const prerelease = accepted.artifactVersion.includes("-");
    const requestedTag = process.env.PUBLICATION_DIST_TAG?.trim() ?? "";
    if (prerelease && requestedTag.length === 0) {
      throw externalFailure(
        "prerelease-dist-tag-required",
        "accepted version is a prerelease and has no selected npm channel",
        "an explicit non-latest dist-tag such as beta",
        "Resume this accepted artifact with --dist-tag <channel>.",
        4,
      );
    }
    const distTag = requestedTag || "latest";

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
    if (receivedSignal || login.signal || login.status !== 0) {
      throw externalFailure(
        "npm-login-failed",
        "npm web login did not complete",
        "a successful npm web login",
        "Complete npm authentication and retry the same accepted artifact.",
        4,
      );
    }
    const whoamiResult = await capturedNpm(client, isolation, ["whoami"]);
    if (
      whoamiResult.status !== 0 ||
      whoamiResult.stderr !== "" ||
      !/^[^\s]+\n?$/u.test(whoamiResult.stdout)
    ) {
      throw externalFailure(
        "npm-whoami-failed",
        "npm whoami did not return one username",
        "one logged-in npm username",
        "Complete npm web login and retry the same accepted artifact.",
        4,
      );
    }

    process.stdout.write(
      "OK npm-authenticated\nSTAGE 6/9 Publish " +
        accepted.packageName +
        "@" +
        accepted.artifactVersion +
        " with npm tag " +
        distTag +
        "\n",
    );
    process.stdout.write(
      "Original artifact: " +
        accepted.artifactPath +
        "\nIntegrity: " +
        accepted.integrity +
        "\n",
    );
    await readExactPhrase(
      "PUBLISH " +
        accepted.packageName +
        "@" +
        accepted.artifactVersion +
        " " +
        accepted.integrity +
        " --tag=" +
        distTag,
    );
    throwIfSignalled();
    const interactiveEnvironment = isolatedEnvironment(isolation);
    await runDirectOidcPublication({
      repositoryRoot: root,
      packageRoot,
      artifactDirectory: artifactRoot,
      environment: interactiveEnvironment,
      credentialMode: "interactive",
      distTag,
      run: setupRemoteCommand,
    });
    process.stdout.write("OK npm-publish-exact\n");

    process.stdout.write("STAGE 7/9 Configure trusted publishing\n");
    await configureTrust(client, isolation, {
      packageName: accepted.packageName,
      repository: accepted.repository,
    });
    process.stdout.write(
      "OK trusted-publishing-configured\nSTAGE 8/9 Create the GitHub Release\n",
    );
    await readExactPhrase(
      "RELEASE " +
        accepted.packageName +
        "@" +
        accepted.packageVersion +
        " " +
        accepted.integrity +
        " TO " +
        accepted.repository +
        " " +
        accepted.packageName +
        "@" +
        accepted.packageVersion +
        " AT " +
        accepted.sourceSha,
      "github-release-confirmation-required",
    );
    await runImmutableGithubRelease({
      repositoryRoot: root,
      packageRoot,
      artifactDirectory: artifactRoot,
      environment: process.env,
      run: setupRemoteCommand,
    });
    githubReleaseVerified = true;
  } catch (error) {
    if (error instanceof PublicationFailure) {
      primary = new SetupFailure(
        error.code,
        error.message,
        "the exact accepted local artifact and its original source commit",
        "Resume the retained artifact after checking the reported remote state.",
        4,
      );
    } else {
      primary = error;
    }
  }
  if (isolation !== undefined && loginStarted && client !== undefined) {
    const logout = await capturedNpm(client, isolation, ["logout"], true);
    if (logout.status !== 0 && primary === undefined) {
      cleanupError = externalFailure(
        "npm-session-cleanup-failed",
        "npm logout failed",
        "a completed npm logout",
        "Confirm the npm session is closed before retrying the accepted artifact.",
        5,
      );
    }
  }
  if (isolationRoot !== undefined) {
    try {
      removeOwnedDirectory(isolationRoot);
    } catch {
      if (primary === undefined) {
        cleanupError = externalFailure(
          "npm-session-cleanup-failed",
          "isolated npm files could not be removed",
          "removed owned temporary files",
          "Remove the owned temporary files and retry.",
          5,
        );
      }
    }
  }
  for (const [signal, handler] of signalHandlers)
    process.removeListener(signal, handler);
  if (receivedSignal !== undefined) process.kill(process.pid, receivedSignal);

  if (
    githubReleaseVerified &&
    primary === undefined &&
    cleanupError === undefined
  ) {
    try {
      removeOwnedDirectory(artifactRoot);
    } catch {
      cleanupError = externalFailure(
        "artifact-cleanup-failed",
        "completed artifact could not be removed",
        "removed the accepted local artifact",
        "Remove the owned temporary artifact after verifying the release.",
        5,
      );
    }
  } else {
    process.stderr.write(
      "已验收的本地原件保留在 " +
        artifactRoot +
        "。续办命令：./scripts/npm-publication-setup/setup.sh --resume-artifact " +
        artifactRoot +
        (process.env.PUBLICATION_DIST_TAG?.trim()
          ? " --dist-tag " + process.env.PUBLICATION_DIST_TAG.trim()
          : "") +
        "\n",
    );
  }

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
    "configured",
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
  else if (process.argv[2] === "configured") await configured();
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
