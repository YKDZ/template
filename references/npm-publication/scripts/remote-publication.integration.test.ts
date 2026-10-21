import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { PublicationFailure } from "./failure.ts";
import { acceptArtifact, prepareArtifact } from "./publication.ts";
import { runDirectOidcPublication } from "./publish.ts";
import { runImmutableGithubRelease } from "./release.ts";
import {
  assertRemotePreparation,
  defaultRemoteCommand,
  readAcceptedRemoteArtifact,
  type RemoteCommandRunner,
  type RemoteProcessResult,
} from "./remote-context.ts";

type Candidate = {
  readonly workspace: string;
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly artifactPath: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly sha512: string;
  readonly sourceSha: string;
  readonly remotePath: string;
  dispose(): Promise<void>;
};

const packageName = "@example/lifecycle-package";
const repository = "example/lifecycle-package";

function git(repositoryRoot: string, ...arguments_: string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createCandidate(version: string): Promise<Candidate> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "npm-remote-publication-"),
  );
  const repositoryRoot = path.join(workspace, "repository");
  const packageRoot = path.join(repositoryRoot, "packages/cli");
  const artifactDirectory = path.join(workspace, "artifacts");
  const remotePath = path.join(workspace, "origin.git");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  const manifest = {
    name: packageName,
    version,
    type: "module",
    repository: `https://github.com/${repository}.git`,
    exports: "./index.mjs",
    files: ["index.mjs", "consume.mjs"],
    scripts: {
      "publication:consume": "node consume.mjs",
    },
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "index.mjs"),
    'export const value = "accepted original";\n',
  );
  await writeFile(
    path.join(packageRoot, "consume.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      "const consumer = process.env.NPM_PUBLICATION_CONSUMER_ROOT;",
      "assert.ok(consumer);",
      'const require = createRequire(path.join(consumer, "package.json"));',
      `assert.equal(require("${packageName}").value, "accepted original");`,
    ].join("\n"),
  );
  await writeFile(
    path.join(packageRoot, "CHANGELOG.md"),
    `# Changelog\n\nMaintainer notes before version sections.\n\n## Unreleased\n\nUpcoming work is not part of this release.\n\n## [${version}]\n\nOriginal release notes for ${version}.\n`,
  );

  git(repositoryRoot, "init", "--initial-branch=main");
  git(repositoryRoot, "config", "user.name", "Publication Test");
  git(
    repositoryRoot,
    "config",
    "user.email",
    "publication-test@example.invalid",
  );
  git(repositoryRoot, "init", "--bare", remotePath);
  git(repositoryRoot, "remote", "add", "origin", remotePath);
  git(repositoryRoot, "add", "--all");
  git(repositoryRoot, "commit", "-m", "accepted publication source");
  const sourceSha = git(repositoryRoot, "rev-parse", "HEAD");
  git(repositoryRoot, "push", "--set-upstream", "origin", "main");

  const prepared = await prepareArtifact({
    packageRoot,
    outputDirectory: artifactDirectory,
    sourceSha,
  });
  if (prepared.kind !== "prepared") {
    await rm(workspace, { recursive: true, force: true });
    throw new Error("正式共享制品准备未完成");
  }
  const accepted = await acceptArtifact({
    packageRoot,
    artifactPath: prepared.artifactPath,
  });
  if (accepted.kind !== "accepted") {
    await rm(workspace, { recursive: true, force: true });
    throw new Error("正式共享制品安装消费验收未完成");
  }
  return {
    workspace,
    repositoryRoot,
    packageRoot,
    artifactDirectory,
    artifactPath: accepted.artifactPath,
    packageName: accepted.packageName,
    packageVersion: prepared.packageVersion,
    artifactVersion: accepted.artifactVersion,
    sha512: accepted.sha512,
    sourceSha,
    remotePath,
    dispose: () => rm(workspace, { recursive: true, force: true }),
  };
}

function response(
  exitCode: number,
  stdout = "",
  stderr = "",
): RemoteProcessResult {
  return { exitCode, stdout, stderr };
}

function publicationFailure(code: string) {
  return (error: unknown): boolean =>
    error instanceof PublicationFailure && error.code === code;
}

function registryAdapter(
  candidate: Candidate,
  options: {
    readonly initialIntegrity?: string;
    readonly initialTags?: Readonly<Record<string, string>>;
    readonly remoteBytes?: Uint8Array;
    readonly remotePackExitCode?: number;
    readonly publishExitCode?: number;
    readonly visibleAfterPublish?: boolean;
  } = {},
): {
  readonly run: RemoteCommandRunner;
  readonly calls: {
    readonly command: string;
    readonly arguments: readonly string[];
  }[];
  readonly publishes: string[][];
} {
  const calls: { command: string; arguments: readonly string[] }[] = [];
  const publishes: string[][] = [];
  let visible = options.initialIntegrity !== undefined;
  let integrity =
    options.initialIntegrity !== undefined
      ? options.initialIntegrity
      : `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`;
  let tags: Record<string, string> = { ...options.initialTags };
  const run: RemoteCommandRunner = async (command, arguments_, request) => {
    calls.push({ command, arguments: [...arguments_] });
    if (command === "git")
      return await defaultRemoteCommand(command, arguments_, request);
    if (command === "npm" && arguments_[0] === "pack") {
      if (options.remotePackExitCode !== undefined) {
        return response(
          options.remotePackExitCode,
          "",
          "controlled exact tarball download failure",
        );
      }
      const destinationArgument = arguments_.find((argument) =>
        argument.startsWith("--pack-destination="),
      );
      const destination = destinationArgument?.slice(
        "--pack-destination=".length,
      );
      if (
        arguments_[1] !==
          `${candidate.packageName}@${candidate.artifactVersion}` ||
        destination === undefined
      )
        return response(1, "", "unexpected npm pack request");
      const filename = `${candidate.packageName.replace(/^@/u, "").replace("/", "-")}-${candidate.artifactVersion}.tgz`;
      await writeFile(
        path.join(destination, filename),
        options.remoteBytes ?? (await readFile(candidate.artifactPath)),
      );
      return response(0, JSON.stringify([{ filename }]));
    }
    if (command !== "pnpm") return response(127, "", "unsupported command");
    if (arguments_[0] === "view") {
      if (
        arguments_[1] ===
          `${candidate.packageName}@${candidate.artifactVersion}` &&
        arguments_[2] === "dist.integrity"
      ) {
        if (!visible)
          return response(1, "", "ERR_PNPM_FETCH_404 version not found");
        return response(0, JSON.stringify(integrity));
      }
      if (
        arguments_[1] === candidate.packageName &&
        arguments_[2] === "dist-tags"
      )
        return response(0, JSON.stringify(tags));
      return response(1, "", "unexpected pnpm view request");
    }
    if (arguments_[0] === "publish") {
      publishes.push([...arguments_]);
      if (
        options.publishExitCode !== undefined &&
        options.publishExitCode !== 0
      )
        return response(
          options.publishExitCode,
          "",
          "controlled publish failure",
        );
      if (options.visibleAfterPublish !== false) {
        visible = true;
        integrity = `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`;
        const tag = arguments_.find((argument) =>
          argument.startsWith("--tag="),
        );
        if (tag !== undefined)
          tags[tag.slice("--tag=".length)] = candidate.artifactVersion;
      }
      return response(0);
    }
    return response(1, "", "unexpected pnpm command");
  };
  return { run, calls, publishes };
}

function githubAdapter(candidate: Candidate): {
  readonly run: RemoteCommandRunner;
  readonly calls: {
    readonly command: string;
    readonly arguments: readonly string[];
  }[];
  readonly writes: string[][];
} {
  const calls: { command: string; arguments: readonly string[] }[] = [];
  const writes: string[][] = [];
  let annotatedTag = false;
  let release:
    | {
        tag_name: string;
        name: string;
        body: string;
        draft: boolean;
        prerelease: boolean;
        immutable: boolean;
        published_at: string | null;
        assets: { id: number; name: string; size: number }[];
      }
    | undefined;
  let artifactSource = candidate.artifactPath;
  let checksumSource: string | undefined;
  const tag = `${candidate.packageName}@${candidate.artifactVersion}`;
  const annotation = `npm artifact SHA-512: ${candidate.sha512}`;
  const tagObjectSha = "0123456789abcdef0123456789abcdef01234567";
  const tagObjectPath = `repos/${repository}/git/tags/`;
  const releaseListPath = `repos/${repository}/releases?per_page=100`;
  const run: RemoteCommandRunner = async (command, arguments_, request) => {
    calls.push({ command, arguments: [...arguments_] });
    if (command === "git")
      return await defaultRemoteCommand(command, arguments_, request);
    if (command !== "gh") return response(127, "", "unsupported command");
    const route = arguments_.find((argument) => argument.startsWith("repos/"));
    if (arguments_[0] === "api" && route === `repos/${repository}`)
      return response(0, JSON.stringify({ private: false }));
    if (arguments_[0] === "api" && route?.includes("/git/ref/tags/")) {
      if (!annotatedTag)
        return response(1, "HTTP/1.1 404 Not Found\nContent-Length: 0\n\n");
      return response(
        0,
        `HTTP/1.1 200 OK\nContent-Type: application/json\n\n${JSON.stringify({ object: { type: "tag", sha: tagObjectSha } })}`,
      );
    }
    if (
      (arguments_[0] === "api" && route === `${repository}/git/tags`) ||
      (arguments_[0] === "api" && route === `repos/${repository}/git/tags`)
    ) {
      writes.push([...arguments_]);
      annotatedTag = true;
      return response(0, JSON.stringify({ sha: tagObjectSha }));
    }
    if (arguments_[0] === "api" && route === `repos/${repository}/git/refs`) {
      writes.push([...arguments_]);
      return response(0, JSON.stringify({ ref: `refs/tags/${tag}` }));
    }
    if (arguments_[0] === "api" && route?.startsWith(tagObjectPath))
      return response(
        0,
        JSON.stringify({
          tag,
          message: annotation,
          object: { type: "commit", sha: candidate.sourceSha },
        }),
      );
    if (arguments_[0] === "api" && route === releaseListPath)
      return response(
        0,
        JSON.stringify(release === undefined ? [] : [[release]]),
      );
    if (arguments_[0] === "release" && arguments_[1] === "create") {
      writes.push([...arguments_]);
      const expectedTag = arguments_[2];
      artifactSource = arguments_[3]!;
      checksumSource = arguments_[4]!;
      const notesArgument = arguments_.find((argument) =>
        argument.startsWith("--notes-file="),
      );
      const notesPath = notesArgument?.slice("--notes-file=".length);
      if (
        expectedTag === undefined ||
        notesPath === undefined ||
        checksumSource === undefined
      )
        return response(1, "", "missing draft assets");
      const [artifactInfo, checksumBytes, body] = await Promise.all([
        stat(artifactSource),
        readFile(checksumSource),
        readFile(notesPath, "utf8"),
      ]);
      release = {
        tag_name: expectedTag,
        name: expectedTag,
        body,
        draft: true,
        prerelease: arguments_.includes("--prerelease"),
        immutable: false,
        published_at: null,
        assets: [
          {
            id: 1001,
            name: path.basename(artifactSource),
            size: artifactInfo.size,
          },
          { id: 1002, name: "SHA512SUMS", size: checksumBytes.byteLength },
        ],
      };
      return response(0);
    }
    if (arguments_[0] === "api" && route?.includes("/releases/assets/")) {
      const assetId = route.split("/").at(-1);
      const outputArgument = arguments_.find((argument) =>
        argument.startsWith("--output="),
      );
      const destination = outputArgument?.slice("--output=".length);
      const source =
        assetId === "1001"
          ? artifactSource
          : assetId === "1002"
            ? checksumSource
            : undefined;
      if (source === undefined || destination === undefined)
        return response(1, "", "unknown release asset");
      await copyFile(source, destination);
      return response(0);
    }
    if (arguments_[0] === "release" && arguments_[1] === "edit") {
      writes.push([...arguments_]);
      if (release === undefined) return response(1, "", "draft is missing");
      release = {
        ...release,
        draft: false,
        immutable: true,
        published_at: "2026-10-21T00:00:00Z",
      };
      return response(0);
    }
    return response(1, "", "unexpected gh command");
  };
  return { run, calls, writes };
}

void describe("单包远端发布与原件续办", () => {
  void it("续办沿用 receipt 绑定的原提交，不把推进后的默认分支当成原件来源", async () => {
    const candidate = await createCandidate("1.2.3-beta.1");
    try {
      await assertRemotePreparation({
        repositoryRoot: candidate.repositoryRoot,
        sourceSha: candidate.sourceSha,
        defaultBranch: "main",
        run: defaultRemoteCommand,
      });
      const manifest = JSON.parse(
        await readFile(
          path.join(candidate.packageRoot, "package.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const changelog = `# Changelog\n\n## [${candidate.packageVersion}]\n\nLater branch notes.\n`;
      await writeFile(
        path.join(candidate.packageRoot, "CHANGELOG.md"),
        changelog,
      );
      git(candidate.repositoryRoot, "add", "--all");
      git(candidate.repositoryRoot, "commit", "-m", "advance default branch");
      git(candidate.repositoryRoot, "push", "origin", "main");
      await assert.rejects(
        assertRemotePreparation({
          repositoryRoot: candidate.repositoryRoot,
          sourceSha: candidate.sourceSha,
          defaultBranch: "main",
          run: defaultRemoteCommand,
        }),
        /当前 sourceSha/u,
      );
      assert.equal(
        (
          JSON.parse(
            await readFile(
              path.join(candidate.packageRoot, "package.json"),
              "utf8",
            ),
          ) as Record<string, unknown>
        ).version,
        manifest.version,
      );

      const accepted = await readAcceptedRemoteArtifact({
        repositoryRoot: candidate.repositoryRoot,
        packageRoot: candidate.packageRoot,
        artifactDirectory: candidate.artifactDirectory,
        environment: { PATH: process.env.PATH },
        run: defaultRemoteCommand,
      });
      assert.equal(accepted.sourceSha, candidate.sourceSha);
      assert.equal(accepted.sourceManifest.version, candidate.packageVersion);
      assert.equal(
        accepted.releaseNotes,
        `Original release notes for ${candidate.packageVersion}.`,
      );

      const registry = registryAdapter(candidate);
      await runDirectOidcPublication({
        repositoryRoot: candidate.repositoryRoot,
        artifactDirectory: candidate.artifactDirectory,
        environment: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_DEFAULT_BRANCH: "main",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: candidate.sourceSha,
          GITHUB_REPOSITORY: repository,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.invalid/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "controlled-token",
          PUBLICATION_DIST_TAG: "beta",
        },
        run: registry.run,
      });
      assert.equal(registry.publishes.length, 1);
      assert.equal(registry.publishes[0]?.[1], candidate.artifactPath);
      assert.ok(registry.publishes[0]?.includes("--access=public"));
      assert.ok(registry.publishes[0]?.includes("--tag=beta"));
      assert.ok(
        registry.publishes[0]?.includes("--publish-wait-timeout=120000"),
      );
      assert.ok(registry.publishes[0]?.includes("--provenance"));
      assert.ok(
        registry.calls.some(
          (call) => call.command === "npm" && call.arguments[0] === "pack",
        ),
      );
      const download = registry.calls.find(
        (call) => call.command === "npm" && call.arguments[0] === "pack",
      );
      assert.ok(download);
      assert.equal(
        download.arguments[1],
        `${candidate.packageName}@${candidate.artifactVersion}`,
      );
      assert.ok(download.arguments.includes("--ignore-scripts"));
      assert.ok(
        !registry.calls.some(
          (call) => call.command === "pnpm" && call.arguments[0] === "pack",
        ),
      );
      assert.equal(
        createHash("sha512")
          .update(await readFile(candidate.artifactPath))
          .digest("hex"),
        candidate.sha512,
      );

      await runDirectOidcPublication({
        repositoryRoot: candidate.repositoryRoot,
        artifactDirectory: candidate.artifactDirectory,
        environment: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_DEFAULT_BRANCH: "main",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: candidate.sourceSha,
          GITHUB_REPOSITORY: repository,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.invalid/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "controlled-token",
          PUBLICATION_DIST_TAG: "beta",
        },
        run: registry.run,
      });
      assert.equal(registry.publishes.length, 1);
      assert.equal(
        registry.calls.filter(
          (call) => call.command === "npm" && call.arguments[0] === "pack",
        ).length,
        2,
      );
    } finally {
      await candidate.dispose();
    }
  });

  void it("稳定版默认使用 latest，预发布缺少渠道时不调用远端命令", async () => {
    const stable = await createCandidate("1.2.3");
    try {
      const registry = registryAdapter(stable);
      await runDirectOidcPublication({
        repositoryRoot: stable.repositoryRoot,
        artifactDirectory: stable.artifactDirectory,
        credentialMode: "interactive",
        environment: { PATH: process.env.PATH },
        run: registry.run,
      });
      assert.equal(registry.publishes.length, 1);
      assert.ok(registry.publishes[0]?.includes("--tag=latest"));
      assert.equal(registry.publishes[0]?.[1], stable.artifactPath);
    } finally {
      await stable.dispose();
    }

    const prerelease = await createCandidate("2.0.0-rc.1");
    try {
      const registry = registryAdapter(prerelease);
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: prerelease.repositoryRoot,
          artifactDirectory: prerelease.artifactDirectory,
          credentialMode: "interactive",
          environment: { PATH: process.env.PATH },
          run: registry.run,
        }),
        publicationFailure("prerelease-dist-tag-required"),
      );
      assert.equal(registry.publishes.length, 0);
      assert.equal(
        registry.calls.filter((call) => call.command === "pnpm").length,
        0,
      );
    } finally {
      await prerelease.dispose();
    }
  });

  void it("远端失败或可见性延迟后不盲目重传", async () => {
    const failed = await createCandidate("1.2.3-beta.1");
    try {
      const registry = registryAdapter(failed, { publishExitCode: 1 });
      const options = {
        repositoryRoot: failed.repositoryRoot,
        artifactDirectory: failed.artifactDirectory,
        credentialMode: "interactive" as const,
        distTag: "beta",
        environment: { PATH: process.env.PATH },
        run: registry.run,
      };
      await assert.rejects(
        runDirectOidcPublication(options),
        publicationFailure("publish-failed"),
      );
      await assert.rejects(
        runDirectOidcPublication(options),
        publicationFailure("publish-resume-ambiguous"),
      );
      assert.equal(registry.publishes.length, 1);
    } finally {
      await failed.dispose();
    }

    const delayed = await createCandidate("2.0.0-beta.2");
    try {
      const registry = registryAdapter(delayed, { visibleAfterPublish: false });
      const options = {
        repositoryRoot: delayed.repositoryRoot,
        artifactDirectory: delayed.artifactDirectory,
        credentialMode: "interactive" as const,
        distTag: "beta",
        environment: { PATH: process.env.PATH },
        run: registry.run,
      };
      await assert.rejects(
        runDirectOidcPublication(options),
        publicationFailure("publish-wait-incomplete"),
      );
      await assert.rejects(
        runDirectOidcPublication(options),
        publicationFailure("publish-resume-ambiguous"),
      );
      assert.equal(registry.publishes.length, 1);
    } finally {
      await delayed.dispose();
    }
  });

  void it("拒绝远端字节或渠道冲突且不上传", async () => {
    const candidate = await createCandidate("1.2.3-beta.1");
    try {
      const differentBytes = registryAdapter(candidate, {
        initialIntegrity: "sha512-different-bytes",
      });
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          credentialMode: "interactive",
          distTag: "beta",
          environment: { PATH: process.env.PATH },
          run: differentBytes.run,
        }),
        publicationFailure("registry-integrity-conflict"),
      );
      assert.equal(differentBytes.publishes.length, 0);

      const sameIntegrityDifferentTarball = registryAdapter(candidate, {
        initialIntegrity: `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`,
        initialTags: { beta: candidate.artifactVersion },
        remoteBytes: Buffer.from("different registry tarball bytes"),
      });
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          credentialMode: "interactive",
          distTag: "beta",
          environment: { PATH: process.env.PATH },
          run: sameIntegrityDifferentTarball.run,
        }),
        publicationFailure("registry-bytes-conflict"),
      );
      assert.equal(sameIntegrityDifferentTarball.publishes.length, 0);
      assert.ok(
        sameIntegrityDifferentTarball.calls.some(
          (call) => call.command === "npm" && call.arguments[0] === "pack",
        ),
      );

      const missingRemoteTarball = registryAdapter(candidate, {
        initialIntegrity: `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`,
        initialTags: { beta: candidate.artifactVersion },
        remotePackExitCode: 1,
      });
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          credentialMode: "interactive",
          distTag: "beta",
          environment: { PATH: process.env.PATH },
          run: missingRemoteTarball.run,
        }),
        publicationFailure("registry-download-failed"),
      );
      assert.equal(missingRemoteTarball.publishes.length, 0);

      const differentTag = registryAdapter(candidate, {
        initialIntegrity: `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`,
        initialTags: { beta: "9.9.9" },
      });
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          credentialMode: "interactive",
          distTag: "beta",
          environment: { PATH: process.env.PATH },
          run: differentTag.run,
        }),
        publicationFailure("registry-dist-tag-conflict"),
      );
      assert.equal(differentTag.publishes.length, 0);
    } finally {
      await candidate.dispose();
    }
  });

  void it("以完整包名@版本发布同一原件并核对不可变 GitHub Release", async () => {
    const candidate = await createCandidate("1.2.3-beta.1");
    try {
      const github = githubAdapter(candidate);
      await runImmutableGithubRelease({
        repositoryRoot: candidate.repositoryRoot,
        artifactDirectory: candidate.artifactDirectory,
        environment: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: repository,
        },
        run: github.run,
      });
      const tag = `${candidate.packageName}@${candidate.artifactVersion}`;
      const createRelease = github.writes.find(
        (arguments_) =>
          arguments_[0] === "release" && arguments_[1] === "create",
      );
      assert.ok(createRelease);
      assert.equal(createRelease[2], tag);
      assert.equal(createRelease[3], candidate.artifactPath);
      assert.ok(createRelease.includes("--draft"));
      assert.ok(createRelease.includes("--verify-tag"));
      assert.ok(createRelease.includes("--prerelease"));
      assert.ok(
        github.writes.some(
          (arguments_) =>
            arguments_[0] === "release" &&
            arguments_[1] === "edit" &&
            arguments_[2] === tag &&
            arguments_.includes("--draft=false"),
        ),
      );
    } finally {
      await candidate.dispose();
    }
  });

  void it("GitHub 查询失败、已有标签冲突和原件缺失均停止在写入之前", async () => {
    const candidate = await createCandidate("1.2.3");
    try {
      const inaccessible: RemoteCommandRunner = async (
        command,
        arguments_,
        request,
      ) => {
        if (command === "git")
          return await defaultRemoteCommand(command, arguments_, request);
        return response(1, "", "controlled GitHub failure");
      };
      await assert.rejects(
        runImmutableGithubRelease({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          environment: {
            PATH: process.env.PATH,
            GITHUB_REPOSITORY: repository,
          },
          run: inaccessible,
        }),
        publicationFailure("release-remote-unavailable"),
      );

      const conflictCalls: string[][] = [];
      const tagConflict: RemoteCommandRunner = async (
        command,
        arguments_,
        request,
      ) => {
        if (command === "git")
          return await defaultRemoteCommand(command, arguments_, request);
        conflictCalls.push([...arguments_]);
        const route = arguments_.find((argument) =>
          argument.startsWith("repos/"),
        );
        if (route === `repos/${repository}`)
          return response(0, JSON.stringify({ private: false }));
        if (route?.includes("/git/ref/tags/"))
          return response(
            0,
            `HTTP/1.1 200 OK\nContent-Type: application/json\n\n${JSON.stringify({ object: { type: "tag", sha: "old-tag-sha" } })}`,
          );
        if (route === `repos/${repository}/releases?per_page=100`)
          return response(0, JSON.stringify([]));
        if (route === `repos/${repository}/git/tags/old-tag-sha`)
          return response(
            0,
            JSON.stringify({
              tag: `${candidate.packageName}@${candidate.artifactVersion}`,
              message: "different accepted artifact",
              object: {
                type: "commit",
                sha: "ffffffffffffffffffffffffffffffffffffffff",
              },
            }),
          );
        return response(1, "", "unexpected GitHub request");
      };
      await assert.rejects(
        runImmutableGithubRelease({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          environment: {
            PATH: process.env.PATH,
            GITHUB_REPOSITORY: repository,
          },
          run: tagConflict,
        }),
        publicationFailure("release-tag-conflict"),
      );
      assert.equal(
        conflictCalls.some(
          (arguments_) =>
            arguments_[0] === "release" && arguments_[1] === "create",
        ),
        false,
      );

      await rm(candidate.artifactPath);
      const missing = registryAdapter(candidate);
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: candidate.repositoryRoot,
          artifactDirectory: candidate.artifactDirectory,
          credentialMode: "interactive",
          environment: { PATH: process.env.PATH },
          run: missing.run,
        }),
      );
      assert.equal(
        missing.calls.some((call) => call.command === "pnpm"),
        false,
      );
    } finally {
      await candidate.dispose();
    }
  });
});
