import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  acceptPreparedArtifacts,
  prepareArtifact,
  readAcceptedArtifact,
  recordNpmPublicationAttempt,
  recordNpmPublicationReady,
} from "@ykdz/reference-npm-publication";

const execFileAsync = promisify(execFile);

type Target = {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly dependency?: string;
  readonly missingRemoteScript?:
    | "publication:remote:npm"
    | "publication:remote:release";
};

type AcceptedArtifact = {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly receiptPath: string;
  readonly sha512: string;
};

type CommandRecord = {
  readonly command?: string;
  readonly arguments?: readonly string[];
  readonly packageName?: string | null;
  readonly route?: string;
  readonly write?: boolean;
  readonly controlled?: boolean;
};

function git(repositoryRoot: string, ...arguments_: string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeTarget(target: Target): Promise<void> {
  await mkdir(target.directory, { recursive: true });
  await writeFile(
    path.join(target.directory, "package.json"),
    `${JSON.stringify(
      {
        name: target.name,
        version: target.version,
        repository: "https://github.com/example/publication.git",
        exports: "./index.cjs",
        files: ["index.cjs", "consume.cjs"],
        scripts: {
          "publication:consume": "node consume.cjs",
          ...(target.missingRemoteScript === "publication:remote:npm"
            ? {}
            : {
                "publication:remote:npm":
                  "node --import @ykdz/reference-npm-publication/publish-target --eval '' --",
              }),
          ...(target.missingRemoteScript === "publication:remote:release"
            ? {}
            : {
                "publication:remote:release":
                  "node --import @ykdz/reference-npm-publication/release-target --eval '' --",
              }),
        },
        ...(target.dependency === undefined
          ? {}
          : { dependencies: { [target.dependency]: "workspace:*" } }),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(target.directory, "index.cjs"),
    `module.exports = { value: ${JSON.stringify(target.name)} };\n`,
  );
  await writeFile(
    path.join(target.directory, "consume.cjs"),
    [
      'const assert = require("node:assert/strict");',
      'const path = require("node:path");',
      "const consumer = process.env.NPM_PUBLICATION_CONSUMER_ROOT;",
      "assert.ok(consumer);",
      `assert.equal(require(require.resolve(${JSON.stringify(target.name)}, { paths: [consumer] })).value, ${JSON.stringify(target.name)});`,
      ...(target.dependency === undefined
        ? []
        : [
            `assert.equal(require(require.resolve(${JSON.stringify(target.dependency)}, { paths: [consumer] })).value, ${JSON.stringify(target.dependency)});`,
          ]),
      "void path;",
    ].join("\n"),
  );
  await writeFile(
    path.join(target.directory, "CHANGELOG.md"),
    `# Changelog\n\n## [${target.version}]\n\nRelease notes for ${target.name}.\n`,
  );
}

async function makeWorkspace(
  root: string,
  options: {
    readonly missingRemoteScript?: Target["missingRemoteScript"];
  } = {},
): Promise<{
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly targets: readonly Target[];
}> {
  const repositoryRoot = path.join(root, "repository");
  const packageRoot = path.join(repositoryRoot, "packages");
  const targets: Target[] = [
    {
      name: "@example/a",
      version: "1.2.3-beta.1",
      directory: path.join(packageRoot, "a"),
    },
    {
      name: "@example/b",
      version: "2.3.4-rc.1+build.2",
      directory: path.join(packageRoot, "b"),
      dependency: "@example/a",
    },
    {
      name: "@example/c",
      version: "3.0.0",
      directory: path.join(packageRoot, "c"),
    },
  ];
  const workspaceTargets = targets.map((target) =>
    target.name === "@example/b" && options.missingRemoteScript !== undefined
      ? { ...target, missingRemoteScript: options.missingRemoteScript }
      : target,
  );
  await mkdir(packageRoot, { recursive: true });
  for (const target of workspaceTargets) await writeTarget(target);
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/publication-workspace",
        private: true,
        packageManager: "pnpm@12.9.1",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n",
  );
  await writeFile(path.join(repositoryRoot, ".gitignore"), "node_modules/\n");
  await execFileAsync("pnpm", ["install", "--ignore-scripts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const ownerRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const ownerScope = path.join(repositoryRoot, "node_modules", "@ykdz");
  await mkdir(ownerScope, { recursive: true });
  await symlink(
    ownerRoot,
    path.join(ownerScope, "reference-npm-publication"),
    "dir",
  );

  const remotePath = path.join(root, "origin.git");
  git(repositoryRoot, "init", "--initial-branch=main");
  git(repositoryRoot, "config", "user.name", "Publication Test");
  git(
    repositoryRoot,
    "config",
    "user.email",
    "publication-test@example.invalid",
  );
  git(root, "init", "--bare", remotePath);
  git(repositoryRoot, "remote", "add", "origin", remotePath);
  git(repositoryRoot, "add", "--all");
  git(repositoryRoot, "commit", "-m", "accepted publication source");
  const sourceSha = git(repositoryRoot, "rev-parse", "HEAD");
  git(repositoryRoot, "push", "--set-upstream", "origin", "main");
  return { repositoryRoot, sourceSha, targets: workspaceTargets };
}

async function prepareAndAccept(options: {
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly targets: readonly Target[];
  readonly artifactRoot: string;
}): Promise<readonly AcceptedArtifact[]> {
  const preparedTargets = [];
  for (const target of options.targets) {
    const outputDirectory = path.join(
      options.artifactRoot,
      encodeURIComponent(target.name),
    );
    const prepared = await prepareArtifact({
      packageRoot: target.directory,
      outputDirectory,
      sourceSha: options.sourceSha,
    });
    assert.equal(prepared.kind, "prepared");
    preparedTargets.push({
      packageRoot: target.directory,
      artifactDirectory: outputDirectory,
    });
  }
  const accepted = await acceptPreparedArtifacts({
    targets: preparedTargets,
    env: { npm_config_offline: "true" },
  });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") {
    throw new Error("A→B、C 原件整批本地验收未完成");
  }
  return accepted.artifacts.map((artifact) => ({
    packageRoot: artifact.packageRoot,
    packageName: artifact.packageName,
    artifactVersion: artifact.artifactVersion,
    artifactPath: artifact.artifactPath,
    receiptPath: artifact.receiptPath!,
    sha512: artifact.sha512,
  }));
}

async function writeAcceptedList(options: {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly artifacts: readonly AcceptedArtifact[];
}): Promise<string> {
  const listPath = path.join(
    options.artifactRoot,
    "publication-accepted-artifacts.json",
  );
  await writeFile(
    listPath,
    `${JSON.stringify(
      {
        artifacts: options.artifacts.map((artifact) => ({
          ...artifact,
          packageRoot: path.relative(
            options.repositoryRoot,
            artifact.packageRoot,
          ),
          artifactPath: path.relative(
            options.artifactRoot,
            artifact.artifactPath,
          ),
          receiptPath: path.relative(
            options.artifactRoot,
            artifact.receiptPath,
          ),
        })),
      },
      null,
      2,
    )}\n`,
  );
  return listPath;
}

async function makeCommandAdapters(options: {
  readonly root: string;
  readonly acceptedListPath: string;
  readonly failNpmPackage?: string;
  readonly failGithubTag?: string;
}): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly eventLog: string;
}> {
  const shimDirectory = path.join(options.root, "command-shims");
  const statePath = path.join(options.root, "registry.json");
  const eventLog = path.join(options.root, "external-commands.jsonl");
  await mkdir(options.root, { recursive: true });
  const acceptedList = JSON.parse(
    await readFile(options.acceptedListPath, "utf8"),
  ) as { readonly artifacts: readonly AcceptedArtifact[] };
  await writeFile(statePath, `${JSON.stringify({ packages: {} })}\n`);
  await writeFile(eventLog, "");
  await mkdir(shimDirectory, { recursive: true });
  const realPnpm = (
    await execFileAsync("which", ["pnpm"], { encoding: "utf8" })
  ).stdout.trim();
  const pnpmShim = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawnSync } = require("node:child_process");',
    `const realPnpm = ${JSON.stringify(realPnpm)};`,
    `const listPath = ${JSON.stringify(options.acceptedListPath)};`,
    `const statePath = ${JSON.stringify(statePath)};`,
    `const eventLog = ${JSON.stringify(eventLog)};`,
    `const failPackage = ${JSON.stringify(options.failNpmPackage ?? "")};`,
    `const artifacts = ${JSON.stringify(acceptedList.artifacts)};`,
    "const args = process.argv.slice(2);",
    "function entryFor(ref) { return artifacts.find((item) => ref === `${item.packageName}@${item.artifactVersion}` || ref === item.packageName || path.resolve(path.dirname(listPath), item.artifactPath) === path.resolve(ref)); }",
    "function log(record) { fs.appendFileSync(eventLog, `${JSON.stringify(record)}\\n`); }",
    'if (args[0] === "view") {',
    "  const item = entryFor(args[1]); if (!item) { log({ command: 'pnpm', arguments: args, packageName: null, controlled: true }); process.exit(96); }",
    "  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); const saved = state.packages[item.packageName] || { visible: false, tags: {} };",
    "  log({ command: 'pnpm', arguments: args, packageName: item.packageName, controlled: true });",
    '  if (args[2] === "dist.integrity") { if (!saved.visible) { process.stderr.write("ERR_PNPM_FETCH_404 404 Not Found\\n"); process.exit(1); } process.stdout.write(JSON.stringify(`sha512-${Buffer.from(item.sha512, "hex").toString("base64")}`)); process.exit(0); }',
    '  if (args[2] === "dist-tags") { process.stdout.write(JSON.stringify(saved.tags)); process.exit(0); }',
    "  process.exit(96);",
    "}",
    'if (args[0] === "publish") {',
    "  const item = entryFor(args[1]); if (!item) { log({ command: 'pnpm', arguments: args, packageName: null, write: true, controlled: true }); process.exit(96); }",
    "  log({ command: 'pnpm', arguments: args, packageName: item.packageName, write: true, controlled: true });",
    "  if (item.packageName === failPackage) { process.stderr.write('controlled npm publish failure\\n'); process.exit(1); }",
    "  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); const saved = state.packages[item.packageName] || { visible: false, tags: {} }; const tag = args.find((value) => value.startsWith('--tag='))?.slice('--tag='.length) || 'latest'; saved.visible = true; saved.tags[tag] = item.artifactVersion; state.packages[item.packageName] = saved; fs.writeFileSync(statePath, JSON.stringify(state)); process.exit(0);",
    "}",
    "log({ command: 'pnpm-native', arguments: args, controlled: false });",
    "const child = spawnSync(realPnpm, args, { stdio: 'inherit', env: process.env });",
    "if (child.error) throw child.error;",
    "process.exit(child.status ?? 1);",
    "",
  ].join("\n");
  const npmShim = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const listPath = ${JSON.stringify(options.acceptedListPath)};`,
    `const eventLog = ${JSON.stringify(eventLog)};`,
    `const artifacts = ${JSON.stringify(acceptedList.artifacts)};`,
    "const args = process.argv.slice(2);",
    "const item = artifacts.find((value) => args[1] === `${value.packageName}@${value.artifactVersion}`);",
    "if (args[0] !== 'pack' || !item) process.exit(96);",
    "fs.appendFileSync(eventLog, `${JSON.stringify({ command: 'npm', arguments: args, packageName: item.packageName, controlled: true })}\\n`);",
    "const directory = args.find((value) => value.startsWith('--pack-destination='))?.slice('--pack-destination='.length);",
    "if (!directory) process.exit(96);",
    "const filename = path.basename(item.artifactPath); fs.copyFileSync(path.resolve(path.dirname(listPath), item.artifactPath), path.join(directory, filename)); process.stdout.write(JSON.stringify([{ filename }]));",
    "",
  ].join("\n");
  const ghShim = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    `const eventLog = ${JSON.stringify(eventLog)};`,
    `const failTag = ${JSON.stringify(options.failGithubTag ?? "")};`,
    "const args = process.argv.slice(2);",
    "const route = args.find((value) => value.startsWith('repos/')) || '';",
    "fs.appendFileSync(eventLog, `${JSON.stringify({ command: 'gh', arguments: args, route, controlled: true, write: args.includes('--method') && ['POST','PATCH','PUT','DELETE'].includes(args[args.indexOf('--method') + 1]) })}\\n`);",
    "if (route === 'repos/example/publication') { process.stdout.write(JSON.stringify({ private: false })); process.exit(0); }",
    "if (route.includes('/git/ref/tags/')) { if (route.endsWith(encodeURIComponent(failTag))) { process.stderr.write('controlled GitHub API failure\\n'); process.exit(1); } process.stdout.write('HTTP/1.1 404 Not Found\\nContent-Length: 0\\n\\n'); process.exit(1); }",
    "if (route.endsWith('/releases?per_page=100')) { process.stdout.write('[]'); process.exit(0); }",
    "if (route.endsWith('/git/tags')) { process.stderr.write('controlled GitHub tag write failure\\n'); process.exit(1); }",
    "process.stderr.write('unexpected controlled GitHub command\\n'); process.exit(96);",
    "",
  ].join("\n");
  for (const [name, contents] of [
    ["pnpm", pnpmShim],
    ["npm", npmShim],
    ["gh", ghShim],
  ] as const) {
    const commandPath = path.join(shimDirectory, name);
    await writeFile(commandPath, contents);
    await chmod(commandPath, 0o755);
  }
  return {
    eventLog,
    environment: {
      ...process.env,
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      PUBLICATION_REPOSITORY_ROOT: path.resolve(
        path.dirname(options.acceptedListPath),
        "../repository",
      ),
      PUBLICATION_ACCEPTED_ARTIFACTS_FILE: options.acceptedListPath,
      PUBLICATION_CREDENTIAL_MODE: "interactive",
      PUBLICATION_DIST_TAGS: JSON.stringify({
        "@example/a": "RC",
        "@example/b": "_beta",
      }),
      NPM_PUBLICATION_CONTROL_DIRECTORY: options.root,
    },
  };
}

async function runOwnerCommand(options: {
  readonly repositoryRoot: string;
  readonly command: "schedule-npm" | "schedule-release";
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        `@ykdz/reference-npm-publication/${options.command}`,
        "--eval",
        "",
        "--",
      ],
      {
        cwd: options.repositoryRoot,
        env: options.environment,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : {};
    return {
      exitCode: typeof value.code === "number" ? value.code : 1,
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
    };
  }
}

async function makeReleaseReadyArtifacts(options: {
  readonly artifactRoot: string;
  readonly artifacts: readonly AcceptedArtifact[];
}): Promise<readonly AcceptedArtifact[]> {
  await mkdir(options.artifactRoot, { recursive: true });
  const releaseArtifacts: AcceptedArtifact[] = [];
  for (const artifact of options.artifacts) {
    const targetDirectory = path.join(
      options.artifactRoot,
      encodeURIComponent(artifact.packageName),
    );
    await mkdir(targetDirectory, { recursive: true });
    await copyFile(
      artifact.artifactPath,
      path.join(targetDirectory, path.basename(artifact.artifactPath)),
    );
    await copyFile(
      artifact.receiptPath,
      path.join(targetDirectory, path.basename(artifact.receiptPath)),
    );
    const copiedArtifactPath = path.join(
      targetDirectory,
      path.basename(artifact.artifactPath),
    );
    await recordNpmPublicationAttempt({
      packageRoot: artifact.packageRoot,
      artifactDirectory: targetDirectory,
      distTag:
        artifact.packageName === "@example/a"
          ? "RC"
          : artifact.packageName === "@example/b"
            ? "_beta"
            : "latest",
    });
    await recordNpmPublicationReady({
      packageRoot: artifact.packageRoot,
      artifactDirectory: targetDirectory,
      sha512: artifact.sha512,
    });
    releaseArtifacts.push({
      ...artifact,
      artifactPath: copiedArtifactPath,
      receiptPath: path.join(
        targetDirectory,
        path.basename(artifact.receiptPath),
      ),
    });
  }
  return releaseArtifacts;
}

void describe("已验收多包原件的原生远端调度", () => {
  void it("已验收目标缺少阶段脚本时先诊断并禁止整批外写", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-missing-remote-script-"),
    );
    try {
      for (const phase of ["npm", "release"] as const) {
        const phaseRoot = path.join(workspace, phase);
        const missingScript =
          phase === "npm"
            ? "publication:remote:npm"
            : "publication:remote:release";
        const { repositoryRoot, sourceSha, targets } = await makeWorkspace(
          phaseRoot,
          { missingRemoteScript: missingScript },
        );
        const artifactRoot = path.join(phaseRoot, "accepted");
        await mkdir(artifactRoot, { recursive: true });
        const artifacts = await prepareAndAccept({
          repositoryRoot,
          sourceSha,
          targets: targets.slice(0, 2),
          artifactRoot,
        });
        assert.deepEqual(
          artifacts.map((artifact) => artifact.packageName),
          ["@example/a", "@example/b"],
        );

        let acceptedListPath: string;
        let command: "schedule-npm" | "schedule-release";
        if (phase === "npm") {
          acceptedListPath = await writeAcceptedList({
            repositoryRoot,
            artifactRoot,
            artifacts,
          });
          command = "schedule-npm";
        } else {
          const releaseArtifactRoot = path.join(phaseRoot, "release-ready");
          const releaseArtifacts = await makeReleaseReadyArtifacts({
            artifactRoot: releaseArtifactRoot,
            artifacts,
          });
          acceptedListPath = await writeAcceptedList({
            repositoryRoot,
            artifactRoot: releaseArtifactRoot,
            artifacts: releaseArtifacts,
          });
          command = "schedule-release";
        }

        const adapter = await makeCommandAdapters({
          root: path.join(phaseRoot, "control"),
          acceptedListPath,
        });
        const result = await runOwnerCommand({
          repositoryRoot,
          command,
          environment: adapter.environment,
        });
        assert.equal(result.exitCode, 1, result.stdout);
        assert.ok(
          result.stderr.includes(
            path.join(targets[1]!.directory, "package.json"),
          ),
          result.stderr,
        );
        assert.ok(result.stderr.includes(`#/scripts/${missingScript}`));
        assert.ok(
          result.stderr.includes(
            "处理方法：请在该目标 package.json 的 scripts 中声明共享发布入口，然后使用当前已验收原件继续运行本阶段",
          ),
          result.stderr,
        );
        assert.equal(await readFile(adapter.eventLog, "utf8"), "");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("npm 失败跳过依赖者但继续独立目标，Release 故障不受依赖顺序阻断", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-scheduler-"),
    );
    try {
      const { repositoryRoot, sourceSha, targets } =
        await makeWorkspace(workspace);
      const artifactRoot = path.join(workspace, "accepted");
      await mkdir(artifactRoot, { recursive: true });
      const artifacts = await prepareAndAccept({
        repositoryRoot,
        sourceSha,
        targets,
        artifactRoot,
      });
      assert.deepEqual(
        artifacts.map((artifact) => artifact.packageName).toSorted(),
        ["@example/a", "@example/b", "@example/c"].toSorted(),
      );
      const acceptedListPath = await writeAcceptedList({
        repositoryRoot,
        artifactRoot,
        artifacts,
      });
      const releaseArtifactRoot = path.join(workspace, "release-ready");
      const releaseArtifacts = await makeReleaseReadyArtifacts({
        artifactRoot: releaseArtifactRoot,
        artifacts,
      });
      const releaseAcceptedListPath = await writeAcceptedList({
        repositoryRoot,
        artifactRoot: releaseArtifactRoot,
        artifacts: releaseArtifacts,
      });
      const npmAdapter = await makeCommandAdapters({
        root: path.join(workspace, "npm-control"),
        acceptedListPath,
        failNpmPackage: "@example/a",
      });
      const npmResult = await runOwnerCommand({
        repositoryRoot,
        command: "schedule-npm",
        environment: npmAdapter.environment,
      });
      assert.equal(npmResult.exitCode, 1, npmResult.stderr);
      const npmCalls = (await readFile(npmAdapter.eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CommandRecord);
      const attemptedPackages = npmCalls
        .filter(
          (call) =>
            call.command === "pnpm" &&
            Array.isArray(call.arguments) &&
            call.arguments[0] === "publish",
        )
        .map((call) => call.packageName)
        .sort((left, right) => (left ?? "").localeCompare(right ?? ""));
      assert.deepEqual(attemptedPackages, ["@example/a", "@example/c"]);
      assert.ok(
        npmCalls
          .filter((call) => call.command === "pnpm")
          .every(
            (call) =>
              !Array.isArray(call.arguments) || call.arguments[0] !== "pack",
          ),
        "远端发布必须沿用已验收 tgz，不能重新本地打包",
      );
      const publishCalls = npmCalls.filter(
        (call) => call.command === "pnpm" && call.arguments?.[0] === "publish",
      );
      assert.ok(
        publishCalls.some(
          (call) =>
            call.packageName === "@example/a" &&
            call.arguments?.includes("--tag=RC"),
        ),
      );
      assert.ok(
        publishCalls.some(
          (call) =>
            call.packageName === "@example/c" &&
            call.arguments?.includes("--tag=latest"),
        ),
      );
      for (const artifact of artifacts) {
        const current = await readAcceptedArtifact({
          packageRoot: artifact.packageRoot,
          artifactPath: artifact.artifactPath,
        });
        assert.equal(current.kind, "prepared");
        if (current.kind !== "prepared") continue;
        assert.equal(current.sha512, artifact.sha512);
        assert.equal(current.receipt.pack.count, 1);
        if (artifact.packageName === "@example/a") {
          assert.notEqual(current.receipt.npmPublicationAttempt?.ready, true);
          assert.equal(current.receipt.npmPublicationAttempt?.distTag, "RC");
        } else if (artifact.packageName === "@example/b") {
          assert.equal(current.receipt.npmPublicationAttempt, undefined);
        } else {
          assert.equal(current.receipt.npmPublicationAttempt?.ready, true);
        }
      }

      const releaseAdapter = await makeCommandAdapters({
        root: path.join(workspace, "release-control"),
        acceptedListPath: releaseAcceptedListPath,
        failGithubTag: "@example/a@1.2.3-beta.1",
      });
      const releaseResult = await runOwnerCommand({
        repositoryRoot,
        command: "schedule-release",
        environment: releaseAdapter.environment,
      });
      assert.equal(releaseResult.exitCode, 1, releaseResult.stderr);
      const releaseCalls = (await readFile(releaseAdapter.eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CommandRecord);
      const tagReads = releaseCalls
        .filter(
          (call) =>
            call.command === "gh" &&
            typeof call.route === "string" &&
            call.route.includes("/git/ref/tags/"),
        )
        .map((call) => call.route)
        .sort((left, right) => (left ?? "").localeCompare(right ?? ""));
      assert.deepEqual(
        tagReads,
        [
          `repos/example/publication/git/ref/tags/${encodeURIComponent("@example/a@1.2.3-beta.1")}`,
          `repos/example/publication/git/ref/tags/${encodeURIComponent("@example/b@2.3.4-rc.1+build.2")}`,
          `repos/example/publication/git/ref/tags/${encodeURIComponent("@example/c@3.0.0")}`,
        ].toSorted(),
      );
      const attemptedTagWrites = releaseCalls.filter(
        (call) =>
          call.command === "gh" &&
          Array.isArray(call.arguments) &&
          call.arguments.some(
            (value) => value === "repos/example/publication/git/tags",
          ),
      );
      assert.equal(attemptedTagWrites.length, 2);
      assert.ok(
        releaseCalls
          .filter((call) => call.command === "gh")
          .every((call) => call.controlled === true),
        "所有 GitHub 命令都应由受控适配器响应",
      );

      const dependentArtifact = artifacts.find(
        (artifact) => artifact.packageName === "@example/b",
      )!;
      const originalBytes = await readFile(dependentArtifact.artifactPath);
      const damagedAdapter = await makeCommandAdapters({
        root: path.join(workspace, "damaged-control"),
        acceptedListPath,
      });
      try {
        await writeFile(
          dependentArtifact.artifactPath,
          Buffer.concat([originalBytes, Buffer.from([0])]),
        );
        const damagedResult = await runOwnerCommand({
          repositoryRoot,
          command: "schedule-npm",
          environment: damagedAdapter.environment,
        });
        assert.equal(damagedResult.exitCode, 1);
        assert.equal(await readFile(damagedAdapter.eventLog, "utf8"), "");
      } finally {
        await writeFile(dependentArtifact.artifactPath, originalBytes);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
