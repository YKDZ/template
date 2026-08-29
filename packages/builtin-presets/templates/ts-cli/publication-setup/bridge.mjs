// Private implementation bridge for setup.sh; it is not a supported entrypoint.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import parseSpdxExpression from "spdx-expression-parse";

import { inspectNpmPublicationReadiness } from "../npm-publication/readiness.ts";

const root = process.env.REPOSITORY_ROOT;
const packagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";
const oneLine = (value) => String(value ?? "").replaceAll(/[\r\n]+/gu, " ");
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function gitFacts() {
  const facts = {
    workingTree: null,
    currentBranch: null,
    defaultBranch: null,
    headMatchesRemoteDefault: null,
  };
  let unavailable = false;
  let remote = null;
  try {
    const run = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    facts.workingTree = run("status", "--porcelain") === "" ? "clean" : "dirty";
    facts.currentBranch =
      run("symbolic-ref", "--quiet", "--short", "HEAD") || null;
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
  return { facts, unavailable, remote };
}

async function status() {
  let readiness = "unavailable";
  let blockers = [];
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
        result.mode === "safe" ? "safe-unconfigured" : "public-intent-blocked";
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
  const { facts: git, unavailable: gitUnavailable, remote } = gitFacts();
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
  const currentStage =
    readiness === "ready" &&
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
        currentStage.number === 2
          ? "provide-public-facts"
          : currentStage.number === 3
            ? "normal-git-handoff"
            : "verify-artifact",
      command: "./scripts/npm-publication-setup/setup.sh",
    },
  });
  process.exitCode = statusExitCode;
}

function canonicalGitHubRepository(value) {
  try {
    const candidate = String(value ?? "")
      .replace(/^git\+/u, "")
      .replace(/^git@github\.com:/u, "https://github.com/");
    const url = new URL(candidate);
    const pathname = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    return url.hostname.toLowerCase() === "github.com" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pathname)
      ? `https://github.com/${pathname}`
      : null;
  } catch {
    return null;
  }
}

function redactRemote(value) {
  return String(value ?? "").replace(
    /(https?:\/\/)[^/@\s]+@/u,
    "$1[REDACTED]@",
  );
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

function remoteMatchesPublicOwner(remote) {
  const owner = repositoryOwner();
  return owner !== null && owner === canonicalGitHubRepository(remote);
}

function remoteMatchesOwner() {
  process.exitCode = remoteMatchesPublicOwner(process.env.REMOTE_URL) ? 0 : 1;
}

function stop(code, observed, expected, next, exitCode = 4) {
  process.stderr.write(
    `${exitCode === 3 ? "ACTION REQUIRED" : "ERROR"} ${code}\nObserved: ${oneLine(observed)}\nExpected: ${oneLine(expected)}\nNext action: ${oneLine(next)}\n`,
  );
  process.exit(exitCode);
}

function placeholder(key) {
  return `{${"{"}${key}}}`;
}

function validGregorianDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

async function configure() {
  const packageRoot = path.join(root, packagePath);
  const files = [
    path.join(packageRoot, "package.json"),
    path.join(root, ".template/blueprint.json"),
    path.join(root, "LICENSE"),
    path.join(packageRoot, "LICENSE"),
    path.join(packageRoot, "README.md"),
    path.join(packageRoot, "CHANGELOG.md"),
  ];
  const before = new Map(
    files.map((file) => [file, existsSync(file) ? readFileSync(file) : null]),
  );
  let manifest;
  let blueprint;
  try {
    manifest = JSON.parse(readFileSync(files[0], "utf8"));
    blueprint = JSON.parse(readFileSync(files[1], "utf8"));
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
  const facts = {
    name: input.packageName || manifest.name,
    command: input.commandName || Object.keys(manifest.bin ?? {})[0],
    description: input.description || manifest.description,
    license: input.license || manifest.license,
    holder:
      input.copyrightHolder ||
      before
        .get(files[2])
        ?.toString()
        .match(/^Copyright(?: \(c\))?\s+(.+)$/mu)?.[1],
    repository: input.repository || existingRepository,
  };
  const explicitConflicts = [
    ["package name", input.packageName, manifest.name],
    ["description", input.description, manifest.description],
    ["license", input.license, manifest.license],
    ["repository", input.repository, existingRepository],
    ["command", input.commandName, Object.keys(manifest.bin ?? {})[0]],
  ].filter(
    ([, supplied, existing]) =>
      !manifest.private && supplied && existing && supplied !== existing,
  );
  if (explicitConflicts.length > 0) {
    const [field, supplied, existing] = explicitConflicts[0];
    stop(
      "owner-fact-conflict",
      `${field}: ${supplied}`,
      `${field}: ${existing}`,
      "Use the existing public owner fact or resolve the conflict through normal review.",
    );
  }
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(facts.name) ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(facts.command) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      facts.repository,
    ) ||
    !facts.description?.trim() ||
    !facts.license?.trim() ||
    !facts.holder?.trim()
  )
    stop(
      "public-fact-required",
      "missing or invalid public fact",
      "six valid public facts",
      "Provide public flags or run interactively.",
      3,
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
  const asset = (file) =>
    readFileSync(path.join(process.env.SETUP_DIR, "assets", file), "utf8");
  let licenseBytes;
  if (facts.license === "MIT")
    licenseBytes = asset("LICENSE-MIT.txt").replaceAll(
      placeholder("COPYRIGHT_HOLDER"),
      facts.holder,
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
    licenseBytes = before.get(files[2]);
  }
  const oldChangelog = before.get(files[5])?.toString() ?? "";
  const dates = [
    ...oldChangelog.matchAll(/^## \[1\.0\.0\] - (\d{4}-\d{2}-\d{2})$/gmu),
  ].map((item) => item[1]);
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
  const render = (file, values) =>
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
  if (
    dates.length === 1 &&
    Buffer.compare(before.get(files[5]), target.get(files[5])) !== 0
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
        writeFileSync(temporary, bytes);
        renameSync(temporary, file);
      }
  } finally {
    rmSync(overlay, { recursive: true, force: true });
  }
}

if (
  !root ||
  !["status", "configure", "remote-matches-owner"].includes(process.argv[2])
) {
  process.stderr.write(
    "private setup bridge requires REPOSITORY_ROOT and a supported action\n",
  );
  process.exitCode = 5;
} else {
  if (process.argv[2] === "status") await status();
  else if (process.argv[2] === "configure") await configure();
  else remoteMatchesOwner();
}
