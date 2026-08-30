#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acceptDownloadedPublicationArtifact,
  type AcceptedPublicationArtifact,
  PublicationFailure,
} from "./handoff.ts";

const packagePath = "{{PUBLIC_CLI_PACKAGE_PATH}}";

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ReleaseContext = {
  readonly repository: string;
  readonly sha: string;
  readonly runAttempt: number;
  readonly childEnvironment: NodeJS.ProcessEnv;
};

type RemoteAsset = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
};

type RemoteRelease = {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly immutable: boolean;
  readonly publishedAt: string | null;
  readonly assets: readonly RemoteAsset[];
};

export type ImmutableGithubReleaseOptions = {
  readonly repositoryRoot: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly run?: (
    command: string,
    arguments_: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<ProcessResult>;
};

function fail(code: string): never {
  throw new PublicationFailure(code, "release precondition was not accepted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function noControl(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      codePoint >= 0x20 &&
      codePoint !== 0x7f &&
      (codePoint < 0x80 || codePoint > 0x9f)
    );
  });
}

function exactEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || !noControl(value))
    fail("release-context-invalid");
  return value;
}

function releaseContext(
  environment: Readonly<Record<string, string | undefined>>,
): ReleaseContext {
  const repository = exactEnvironmentValue(environment, "GITHUB_REPOSITORY");
  const sha = exactEnvironmentValue(environment, "GITHUB_SHA");
  const branch = exactEnvironmentValue(environment, "GITHUB_DEFAULT_BRANCH");
  const ref = exactEnvironmentValue(environment, "GITHUB_REF");
  const eventName = exactEnvironmentValue(environment, "GITHUB_EVENT_NAME");
  const runId = exactEnvironmentValue(environment, "GITHUB_RUN_ID");
  const attempt = exactEnvironmentValue(environment, "GITHUB_RUN_ATTEMPT");
  const token = exactEnvironmentValue(environment, "GH_TOKEN");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[0-9a-f]{40}$/u.test(sha) ||
    !/^[A-Za-z0-9._/-]+$/u.test(branch) ||
    eventName !== "workflow_dispatch" ||
    ref !== `refs/heads/${branch}` ||
    !/^\d+$/u.test(runId) ||
    !/^[1-9]\d*$/u.test(attempt)
  ) {
    fail("release-context-invalid");
  }
  const runAttempt = Number(attempt);
  if (!Number.isSafeInteger(runAttempt)) fail("release-context-invalid");
  const childEnvironment: NodeJS.ProcessEnv = { GH_TOKEN: token };
  if (environment.PATH !== undefined) childEnvironment.PATH = environment.PATH;
  return { repository, sha, runAttempt, childEnvironment };
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

async function gh(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly arguments_: readonly string[];
}): Promise<ProcessResult> {
  try {
    return await options.run("gh", options.arguments_, {
      cwd: options.repositoryRoot,
      env: options.context.childEnvironment,
    });
  } catch {
    fail("release-remote-unavailable");
  }
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(code);
  }
}

function responseBody(value: string): string | undefined {
  const match =
    /^HTTP\/\d(?:\.\d)? 200[^\r\n]*\r?\n(?:[^\r\n]*\r?\n)*\r?\n([\s\S]*)$/u.exec(
      value,
    );
  return match?.[1];
}

function isExplicitNotFound(value: string): boolean {
  return /^HTTP\/\d(?:\.\d)? 404(?:\s|$)/mu.test(value);
}

async function tagReference(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
}): Promise<string | undefined> {
  const result = await gh({
    ...options,
    arguments_: [
      "api",
      "--include",
      "--method",
      "GET",
      `repos/${options.context.repository}/git/ref/tags/${options.tag}`,
    ],
  });
  if (result.exitCode !== 0) {
    if (isExplicitNotFound(result.stdout)) return undefined;
    fail("release-remote-unavailable");
  }
  const body = responseBody(result.stdout);
  if (body === undefined) fail("release-remote-unavailable");
  const value = parseJson(body, "release-remote-unavailable");
  if (
    !isRecord(value) ||
    !isRecord(value.object) ||
    value.object.type !== "tag" ||
    stringField(value.object.sha) === undefined
  ) {
    fail("release-tag-conflict");
  }
  return stringField(value.object.sha)!;
}

async function assertAnnotatedTag(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
  readonly annotation: string;
}): Promise<void> {
  const reference = await tagReference(options);
  if (reference === undefined) fail("release-tag-conflict");
  const result = await gh({
    ...options,
    arguments_: [
      "api",
      "--method",
      "GET",
      `repos/${options.context.repository}/git/tags/${reference}`,
    ],
  });
  if (result.exitCode !== 0) fail("release-remote-unavailable");
  const value = parseJson(result.stdout, "release-remote-unavailable");
  if (
    !isRecord(value) ||
    value.tag !== options.tag ||
    value.message !== options.annotation ||
    !isRecord(value.object) ||
    value.object.type !== "commit" ||
    value.object.sha !== options.context.sha
  ) {
    fail("release-tag-conflict");
  }
}

function remoteAsset(value: unknown): RemoteAsset | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const name = stringField(value.name);
  const size = value.size;
  if (
    !Number.isSafeInteger(id) ||
    typeof id !== "number" ||
    id <= 0 ||
    name === undefined ||
    !Number.isSafeInteger(size) ||
    typeof size !== "number" ||
    size < 0
  ) {
    return undefined;
  }
  return { id, name, size };
}

function remoteRelease(value: unknown): RemoteRelease | undefined {
  if (!isRecord(value)) return undefined;
  const tag = stringField(value.tag_name);
  const title = stringField(value.name);
  const body = typeof value.body === "string" ? value.body : undefined;
  const publishedAt =
    value.published_at === null ? null : stringField(value.published_at);
  if (
    tag === undefined ||
    title === undefined ||
    body === undefined ||
    typeof value.draft !== "boolean" ||
    typeof value.immutable !== "boolean" ||
    publishedAt === undefined ||
    !Array.isArray(value.assets)
  ) {
    return undefined;
  }
  const assets = value.assets.map(remoteAsset);
  if (!assets.every((asset): asset is RemoteAsset => asset !== undefined))
    return undefined;
  return {
    tag,
    title,
    body,
    draft: value.draft,
    immutable: value.immutable,
    publishedAt,
    assets,
  };
}

async function taggedRelease(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
}): Promise<RemoteRelease | undefined> {
  const result = await gh({
    ...options,
    arguments_: [
      "api",
      "--paginate",
      "--slurp",
      `repos/${options.context.repository}/releases?per_page=100`,
    ],
  });
  if (result.exitCode !== 0) fail("release-remote-unavailable");
  const pages = parseJson(result.stdout, "release-remote-unavailable");
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    fail("release-remote-unavailable");
  const matches = pages
    .flat()
    .filter((item) => isRecord(item) && item.tag_name === options.tag)
    .map(remoteRelease);
  if (matches.some((item) => item === undefined))
    fail("release-remote-unavailable");
  if (matches.length > 1) fail("release-draft-conflict");
  return matches[0];
}

async function assertReleaseIdentity(options: {
  readonly release: RemoteRelease;
  readonly artifact: AcceptedPublicationArtifact;
  readonly tag: string;
  readonly draft: boolean;
  readonly identityFailure: string;
  readonly assetCountFailure: string;
}): Promise<readonly RemoteAsset[]> {
  const checksum = await readFile(options.artifact.checksum);
  const expected = [
    {
      name: path.basename(options.artifact.tgz),
      size: options.artifact.receipt.artifact.size,
    },
    { name: "SHA512SUMS", size: checksum.byteLength },
  ];
  const assets = options.release.assets.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const sortedExpected = expected.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (
    options.release.tag !== options.tag ||
    options.release.title !== options.tag ||
    options.release.body !==
      options.artifact.receipt.publication.releaseNotes ||
    options.release.draft !== options.draft
  ) {
    fail(options.identityFailure);
  }
  if (assets.length !== sortedExpected.length) fail(options.assetCountFailure);
  if (
    assets.some(
      (asset, index) =>
        asset.name !== sortedExpected[index]!.name ||
        asset.size !== sortedExpected[index]!.size ||
        assets.findIndex((candidate) => candidate.name === asset.name) !==
          index,
    )
  ) {
    fail(options.identityFailure);
  }
  return assets;
}

async function verifyAssetBytes(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly artifact: AcceptedPublicationArtifact;
  readonly assets: readonly RemoteAsset[];
  readonly temporaryDirectory: string;
}): Promise<void> {
  const expected = new Map([
    [path.basename(options.artifact.tgz), options.artifact.tgz],
    ["SHA512SUMS", options.artifact.checksum],
  ]);
  const downloaded = new Map<string, string>();
  for (const asset of options.assets) {
    const source = expected.get(asset.name);
    if (source === undefined) fail("release-asset-conflict");
    const destination = path.join(
      options.temporaryDirectory,
      `asset-${asset.id}`,
    );
    const result = await gh({
      ...options,
      arguments_: [
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/octet-stream",
        `repos/${options.context.repository}/releases/assets/${asset.id}`,
        `--output=${destination}`,
      ],
    });
    if (result.exitCode !== 0) fail("release-asset-conflict");
    downloaded.set(asset.name, destination);
  }
  const tgz = downloaded.get(path.basename(options.artifact.tgz));
  const checksum = downloaded.get("SHA512SUMS");
  if (tgz === undefined || checksum === undefined)
    fail("release-asset-conflict");
  const [downloadedTgz, downloadedChecksum, localChecksum] = await Promise.all([
    readFile(tgz),
    readFile(checksum),
    readFile(options.artifact.checksum),
  ]);
  if (
    downloadedTgz.byteLength !== options.artifact.receipt.artifact.size ||
    createHash("sha512").update(downloadedTgz).digest("hex") !==
      options.artifact.sha512 ||
    !downloadedChecksum.equals(localChecksum)
  ) {
    fail("release-asset-conflict");
  }
  try {
    await Promise.all([...downloaded.values()].map((filePath) => rm(filePath)));
  } catch {
    fail("release-remote-unavailable");
  }
}

async function createTag(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
  readonly annotation: string;
}): Promise<void> {
  const tagObject = await gh({
    ...options,
    arguments_: [
      "api",
      "--method",
      "POST",
      `repos/${options.context.repository}/git/tags`,
      "-f",
      `tag=${options.tag}`,
      "-f",
      `message=${options.annotation}`,
      "-f",
      `object=${options.context.sha}`,
      "-f",
      "type=commit",
    ],
  });
  if (tagObject.exitCode !== 0) fail("release-write-failed");
  const tagObjectValue = parseJson(tagObject.stdout, "release-write-failed");
  const tagObjectSha = isRecord(tagObjectValue)
    ? stringField(tagObjectValue.sha)
    : undefined;
  if (tagObjectSha === undefined) fail("release-write-failed");
  const reference = await gh({
    ...options,
    arguments_: [
      "api",
      "--method",
      "POST",
      `repos/${options.context.repository}/git/refs`,
      "-f",
      `ref=refs/tags/${options.tag}`,
      "-f",
      `sha=${tagObjectSha}`,
    ],
  });
  if (reference.exitCode !== 0) fail("release-write-failed");
}

async function createDraft(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly artifact: AcceptedPublicationArtifact;
  readonly tag: string;
  readonly notesPath: string;
}): Promise<void> {
  const result = await gh({
    ...options,
    arguments_: [
      "release",
      "create",
      options.tag,
      options.artifact.tgz,
      options.artifact.checksum,
      "--draft",
      "--verify-tag",
      "--title",
      options.tag,
      `--notes-file=${options.notesPath}`,
    ],
  });
  if (result.exitCode !== 0) fail("release-write-failed");
}

async function publishDraft(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
}): Promise<void> {
  const result = await gh({
    ...options,
    arguments_: ["release", "edit", options.tag, "--draft=false"],
  });
  if (result.exitCode !== 0) fail("release-write-failed");
}

async function verifyAttestations(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly artifact: AcceptedPublicationArtifact;
  readonly tag: string;
}): Promise<void> {
  for (const arguments_ of [
    ["release", "verify", options.tag],
    ["release", "verify-asset", options.tag, options.artifact.tgz],
    ["release", "verify-asset", options.tag, options.artifact.checksum],
  ] as const) {
    const result = await gh({ ...options, arguments_ });
    if (result.exitCode !== 0) fail("release-attestation-invalid");
  }
}

async function acceptedArtifact(options: {
  readonly repositoryRoot: string;
  readonly artifactDirectory: string;
  readonly repository: string;
}): Promise<AcceptedPublicationArtifact> {
  try {
    return await acceptDownloadedPublicationArtifact({
      repositoryRoot: options.repositoryRoot,
      packagePath,
      artifactDirectory: options.artifactDirectory,
      githubRepository: options.repository,
    });
  } catch {
    fail("release-artifact-invalid");
  }
}

async function requireRelease(options: {
  readonly run: NonNullable<ImmutableGithubReleaseOptions["run"]>;
  readonly repositoryRoot: string;
  readonly context: ReleaseContext;
  readonly tag: string;
}): Promise<RemoteRelease> {
  const release = await taggedRelease(options);
  if (release === undefined) fail("release-write-failed");
  return release;
}

export async function runImmutableGithubRelease(
  options: ImmutableGithubReleaseOptions,
): Promise<void> {
  const context = releaseContext(options.environment);
  const artifact = await acceptedArtifact({
    repositoryRoot: options.repositoryRoot,
    artifactDirectory: options.artifactDirectory,
    repository: context.repository,
  });
  const tag = `v${artifact.receipt.packedManifest.version}`;
  const annotation = `npm artifact SHA-512: ${artifact.sha512}`;
  const run = options.run ?? defaultRun;
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "npm-github-release-"),
  ).catch(() => fail("release-remote-unavailable"));
  let completed = false;
  try {
    const notesPath = path.join(temporaryDirectory, "notes.md");
    await writeFile(notesPath, artifact.receipt.publication.releaseNotes);
    let alreadyImmutable = false;
    const remoteTag = await tagReference({
      run,
      repositoryRoot: options.repositoryRoot,
      context,
      tag,
    });
    const remoteRelease = await taggedRelease({
      run,
      repositoryRoot: options.repositoryRoot,
      context,
      tag,
    });

    if (context.runAttempt === 1) {
      if (remoteTag !== undefined || remoteRelease !== undefined)
        fail("fresh-release-conflict");
      await createTag({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
        annotation,
      });
      await assertAnnotatedTag({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
        annotation,
      });
      await createDraft({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        artifact,
        tag,
        notesPath,
      });
    } else {
      if (remoteTag === undefined || remoteRelease === undefined)
        fail("release-incomplete-conflict");
      await assertAnnotatedTag({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
        annotation,
      });
      if (!remoteRelease.draft) {
        if (!remoteRelease.immutable || remoteRelease.publishedAt === null)
          fail("release-immutability-unproven");
        const assets = await assertReleaseIdentity({
          release: remoteRelease,
          artifact,
          tag,
          draft: false,
          identityFailure: "release-asset-conflict",
          assetCountFailure: "release-incomplete-conflict",
        });
        await verifyAssetBytes({
          run,
          repositoryRoot: options.repositoryRoot,
          context,
          artifact,
          assets,
          temporaryDirectory,
        });
        await verifyAttestations({
          run,
          repositoryRoot: options.repositoryRoot,
          context,
          artifact,
          tag,
        });
        alreadyImmutable = true;
      }
    }

    if (!alreadyImmutable) {
      const draft = await requireRelease({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
      });
      const draftAssets = await assertReleaseIdentity({
        release: draft,
        artifact,
        tag,
        draft: true,
        identityFailure:
          context.runAttempt === 1
            ? "release-write-failed"
            : "release-draft-conflict",
        assetCountFailure:
          context.runAttempt === 1
            ? "release-write-failed"
            : "release-incomplete-conflict",
      });
      await verifyAssetBytes({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        artifact,
        assets: draftAssets,
        temporaryDirectory,
      });
      await assertAnnotatedTag({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
        annotation,
      });
      await publishDraft({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
      });
      const published = await requireRelease({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
      });
      if (published.draft) fail("release-write-failed");
      const publishedAssets = await assertReleaseIdentity({
        release: published,
        artifact,
        tag,
        draft: false,
        identityFailure: "release-write-failed",
        assetCountFailure: "release-write-failed",
      });
      if (!published.immutable || published.publishedAt === null)
        fail("release-immutability-unproven");
      await verifyAssetBytes({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        artifact,
        assets: publishedAssets,
        temporaryDirectory,
      });
      await assertAnnotatedTag({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        tag,
        annotation,
      });
      await verifyAttestations({
        run,
        repositoryRoot: options.repositoryRoot,
        context,
        artifact,
        tag,
      });
    }
    completed = true;
  } finally {
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch {
      if (completed) fail("release-remote-unavailable");
    }
  }
  if (completed) console.log(`Immutable GitHub Release verified: ${tag}`);
}

if (import.meta.main) {
  try {
    const artifactDirectory = process.env.PUBLICATION_ARTIFACT_DIRECTORY;
    if (
      artifactDirectory === undefined ||
      !path.isAbsolute(artifactDirectory)
    ) {
      throw new PublicationFailure(
        "release-artifact-invalid",
        "PUBLICATION_ARTIFACT_DIRECTORY must be absolute",
      );
    }
    await runImmutableGithubRelease({
      repositoryRoot: process.cwd(),
      artifactDirectory,
      environment: process.env,
    });
  } catch (error) {
    const code =
      error instanceof PublicationFailure ? error.code : "release-failed";
    console.error(`ERROR ${code}`);
    console.error("Observed: GitHub release evidence was not accepted");
    console.error("Expected: one immutable release for the accepted artifact");
    console.error(
      "Next action: preserve the release state and contact a maintainer",
    );
    process.exitCode = 1;
  }
}
