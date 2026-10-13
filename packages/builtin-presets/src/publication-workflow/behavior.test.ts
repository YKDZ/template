import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
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
import { pathToFileURL } from "node:url";

import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { parseDocument } from "yaml";

import {
  any,
  arrayContaining,
  assertMatches,
  assertMatchesPartial,
  assertThrows,
  objectContaining,
  testEach,
} from "../../test-support/assertions.ts";
import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "../foundation.ts";
import { tsCliDefinition } from "../ts-cli/definition.ts";

type PublishModule =
  typeof import("../../templates/ts-cli/publication/publish.ts");

type ReleaseModule =
  typeof import("../../templates/ts-cli/publication/release.ts");

type PublicationYamlChecker = {
  readonly assertPublicationWorkflowContract: (
    plan: ReturnType<typeof planGeneratedRepositoryInitialization>,
    source: string,
    workflow: Record<string, unknown>,
  ) => void;
};

async function loadPublicationYamlChecker(): Promise<PublicationYamlChecker> {
  return (await import(
    `${pathToFileURL(path.resolve(import.meta.dirname, "../../../checks/src/check-builtin-preset-github-yaml.ts")).href}?test=${crypto.randomUUID()}`
  )) as PublicationYamlChecker;
}

async function loadPublishModule(workspace: string): Promise<PublishModule> {
  const moduleRoot = path.join(workspace, "module");
  await mkdir(moduleRoot);
  await Promise.all([
    cp(
      path.resolve(
        import.meta.dirname,
        "../../templates/ts-cli/publication/publish.ts",
      ),
      path.join(moduleRoot, "publish.ts"),
    ),
    cp(
      path.resolve(
        import.meta.dirname,
        "../../templates/ts-cli/publication/handoff.ts",
      ),
      path.join(moduleRoot, "handoff.ts"),
    ),
  ]);
  const publishPath = path.join(moduleRoot, "publish.ts");
  await writeFile(
    publishPath,
    (await readFile(publishPath, "utf8")).replace(
      "{{PUBLIC_CLI_PACKAGE_PATH}}",
      "packages/cli",
    ),
  );
  await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  return (await import(
    `${pathToFileURL(publishPath).href}?test=${crypto.randomUUID()}`
  )) as PublishModule;
}

async function loadReleaseModule(workspace: string): Promise<ReleaseModule> {
  const moduleRoot = path.join(workspace, "release-module");
  await mkdir(moduleRoot);
  await Promise.all([
    cp(
      path.resolve(
        import.meta.dirname,
        "../../templates/ts-cli/publication/release.ts",
      ),
      path.join(moduleRoot, "release.ts"),
    ),
    cp(
      path.resolve(
        import.meta.dirname,
        "../../templates/ts-cli/publication/handoff.ts",
      ),
      path.join(moduleRoot, "handoff.ts"),
    ),
  ]);
  const releasePath = path.join(moduleRoot, "release.ts");
  await writeFile(
    releasePath,
    (await readFile(releasePath, "utf8")).replace(
      "{{PUBLIC_CLI_PACKAGE_PATH}}",
      "packages/cli",
    ),
  );
  await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  return (await import(
    `${pathToFileURL(releasePath).href}?test=${crypto.randomUUID()}`
  )) as ReleaseModule;
}

async function writeVerifiedArtifact(
  workspace: string,
  version = "1.0.1",
): Promise<{ readonly directory: string; readonly integrity: string }> {
  const packageRoot = path.join(workspace, "packages", "cli");
  const artifact = path.join(workspace, "artifact");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(artifact);
  const repository = {
    type: "git",
    url: "git+https://github.com/publisher/tool.git",
    directory: "packages/cli",
  };
  const manifest = {
    name: "@publisher/tool",
    version,
    bin: { ship: "./dist/cli.js" },
    repository,
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest),
  );
  const tgz = Buffer.from("verified-tgz-bytes");
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  const artifactName = `tool-${version.replaceAll("+", "-")}.tgz`;
  await writeFile(path.join(artifact, artifactName), tgz);
  await writeFile(
    path.join(artifact, "SHA512SUMS"),
    `${createHash("sha512").update(tgz).digest("hex")}  ${artifactName}\n`,
  );
  await writeFile(
    path.join(artifact, "verified-publication-artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifact: {
        file: artifactName,
        checksumFile: "SHA512SUMS",
        integrity,
        size: tgz.byteLength,
      },
      publication: {
        packageName: "@publisher/tool",
        version,
        commandName: "ship",
        repository: "git+https://github.com/publisher/tool.git",
        releaseDate: "2026-08-26",
        releaseNotes: "Publish the stable CLI.",
      },
      packedManifest: manifest,
      files: [
        { path: "package/CHANGELOG.md", mode: 420, size: 1 },
        { path: "package/LICENSE", mode: 420, size: 1 },
        { path: "package/README.md", mode: 420, size: 1 },
        {
          path: "package/dist/cli-command-identity.js",
          mode: 420,
          size: 1,
        },
        { path: "package/dist/cli.js", mode: 493, size: 1 },
        { path: "package/dist/main.js", mode: 420, size: 1 },
        { path: "package/dist/standard-schema.js", mode: 420, size: 1 },
        { path: "package/package.json", mode: 420, size: 1 },
      ],
      bin: {
        path: "package/dist/cli.js",
        shebang: "#!/usr/bin/env node",
        mode: 493,
        posixExecutableChecked: true,
      },
      smokes: [
        { name: "runtime-import", args: [], stdout: "" },
        { name: "help", args: ["--help"], stdout: `${"ship"} lookup schema\n` },
        {
          name: "version",
          args: ["--version"],
          stdout: `${"ship"} ${version}\n`,
        },
        {
          name: "lookup",
          args: ["lookup", "ada"],
          stdout: JSON.stringify({
            schemaVersion: "1",
            command: "lookup",
            kind: "data",
            variant: "found",
            data: { name: "ada", title: "Ada Lovelace" },
          }),
        },
        {
          name: "schema",
          args: ["schema"],
          stdout: JSON.stringify({
            schemaVersion: "1",
            command: "schema",
            kind: "data",
            variant: "exported",
            data: {
              manifest: {
                root: "cli",
                commands: {
                  cli: { name: "ship" },
                  schema: { name: "schema" },
                  lookup: {
                    name: "lookup",
                    input: { inputSchema: { type: "object" } },
                    success: { variants: { found: { exitCode: 0 } } },
                    failures: { notFound: { exitCode: 1 } },
                  },
                },
              },
            },
          }),
        },
      ],
    }),
  );
  return { directory: artifact, integrity };
}

type FakePublicationScenario = {
  readonly attempt?: number;
  readonly exact?: "absent" | "ambiguous" | "same" | "different";
  readonly latest?: string | undefined;
  readonly postIntegrity?: "same" | "different";
  readonly postLatest?: string;
  readonly audit?: unknown;
  readonly version?: string;
  readonly mutateReceipt?: (receipt: Record<string, unknown>) => void;
  readonly mutateSourceManifest?: (manifest: Record<string, unknown>) => void;
};

async function executeFakePublication(
  workspace: string,
  scenario: FakePublicationScenario = {},
): Promise<{
  readonly writes: number;
  readonly spawns: number;
  readonly initialInstalls: number;
}> {
  const version = scenario.version ?? "1.0.1";
  const artifact = await writeVerifiedArtifact(workspace, version);
  if (scenario.mutateReceipt !== undefined) {
    const receiptPath = path.join(
      artifact.directory,
      "verified-publication-artifact.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    scenario.mutateReceipt(receipt);
    await writeFile(receiptPath, JSON.stringify(receipt));
  }
  if (scenario.mutateSourceManifest !== undefined) {
    const manifestPath = path.join(
      workspace,
      "packages",
      "cli",
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    scenario.mutateSourceManifest(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  const { runDirectOidcPublication } = await loadPublishModule(workspace);
  const exact = scenario.exact ?? "absent";
  const latest = "latest" in scenario ? scenario.latest : "1.0.0";
  const audit = scenario.audit ?? {
    invalid: [],
    missing: [],
    verified: [
      {
        name: "@publisher/tool",
        version,
        attestationBundles: [{}],
      },
    ],
  };
  let writes = 0;
  let exactReads = 0;
  let spawns = 0;
  let initialInstalls = 0;
  let sessionRoot: string | undefined;
  try {
    await runDirectOidcPublication({
      repositoryRoot: workspace,
      artifactDirectory: artifact.directory,
      environment: {
        GITHUB_REPOSITORY: "publisher/tool",
        GITHUB_RUN_ATTEMPT: String(scenario.attempt ?? 1),
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test-token",
        GITHUB_WORKFLOW_REF:
          "publisher/tool/.github/workflows/release.yml@refs/heads/main",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "123",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_REPOSITORY_ID: "456",
        GITHUB_REPOSITORY_OWNER_ID: "789",
        DEPLOY_TOKEN: "must-not-reach-child-processes",
      },
      async run(command, arguments_, options) {
        spawns += 1;
        assert.strictEqual(command, "corepack");
        assert.strictEqual(options.env.DEPLOY_TOKEN, undefined);
        assert.strictEqual(
          options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
          "oidc-test-token",
        );
        assert.strictEqual(options.env.NPM_CONFIG_REGISTRY, undefined);
        assertMatchesPartial(options.env, {
          GITHUB_WORKFLOW_REF:
            "publisher/tool/.github/workflows/release.yml@refs/heads/main",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "123",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_REPOSITORY_ID: "456",
          GITHUB_REPOSITORY_OWNER_ID: "789",
        });
        if (arguments_[0] === "pnpm" && arguments_[1] === "install") {
          initialInstalls += 1;
          assert.strictEqual(options.cwd, workspace);
          assertMatches(
            arguments_,
            arrayContaining([
              "--frozen-lockfile",
              "--ignore-scripts",
              "--registry=https://registry.npmjs.org/",
            ]),
          );
          assert.strictEqual(
            arguments_.some((argument) => argument.startsWith("--store-dir=")),
            true,
          );
          const userConfig = options.env.NPM_CONFIG_USERCONFIG!;
          const session = path.dirname(userConfig);
          sessionRoot = session;
          assert.strictEqual(
            await readFile(path.join(session, ".npmrc"), "utf8"),
            "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
          );
          assert.strictEqual(await readFile(userConfig, "utf8"), "");
          assert.strictEqual(
            await readFile(options.env.NPM_CONFIG_GLOBALCONFIG!, "utf8"),
            "",
          );
          assert.strictEqual(
            options.env.NPM_CONFIG_CACHE,
            path.join(session, "npm-cache"),
          );
          assert.strictEqual(options.env.HOME, path.join(session, "home"));
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const joined = arguments_.join(" ");
        if (joined.includes(" --version"))
          return { exitCode: 0, stdout: "11.19.1\n", stderr: "" };
        if (joined.includes(" config get fetch-retries"))
          return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (joined.includes(" config get registry"))
          return {
            exitCode: 0,
            stdout: "https://registry.npmjs.org/\n",
            stderr: "",
          };
        if (joined.includes("view @publisher/tool dist-tags"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              latest: writes === 0 ? latest : (scenario.postLatest ?? version),
            }),
            stderr: "",
          };
        if (joined.includes("view @publisher/tool@")) {
          exactReads += 1;
          if (exactReads === 1) {
            if (exact === "absent")
              return {
                exitCode: 1,
                stdout: "",
                stderr: "npm error code E404\n",
              };
            if (exact === "ambiguous")
              return {
                exitCode: 1,
                stdout: "",
                stderr: "npm error code E500\n",
              };
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                exact === "same" ? artifact.integrity : "sha512-conflict",
              ),
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              scenario.postIntegrity === "different"
                ? "sha512-conflict"
                : artifact.integrity,
            ),
            stderr: "",
          };
        }
        if (joined.includes(" publish ")) {
          writes += 1;
          return { exitCode: 0, stdout: "published", stderr: "" };
        }
        if (joined.includes(" install --ignore-scripts")) {
          const prefix = arguments_.find((argument) =>
            argument.startsWith("--prefix="),
          )!;
          const consumer = prefix.slice("--prefix=".length);
          assert.notStrictEqual(consumer, sessionRoot);
          assert.strictEqual(options.cwd, workspace);
          assertMatches(
            arguments_,
            arrayContaining([
              `--prefix=${consumer}`,
              "--registry=https://registry.npmjs.org/",
              `--userconfig=${path.join(sessionRoot!, "user-npmrc")}`,
              `--globalconfig=${path.join(sessionRoot!, "global-npmrc")}`,
              `--cache=${path.join(sessionRoot!, "npm-cache")}`,
              "install",
              "--ignore-scripts",
            ]),
          );
          assert.strictEqual(
            await readFile(path.join(consumer, ".npmrc"), "utf8"),
            "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
          );
          assert.strictEqual(
            options.env.NPM_CONFIG_USERCONFIG,
            path.join(sessionRoot!, "user-npmrc"),
          );
          assert.strictEqual(
            options.env.NPM_CONFIG_GLOBALCONFIG,
            path.join(sessionRoot!, "global-npmrc"),
          );
          assert.strictEqual(
            options.env.NPM_CONFIG_CACHE,
            path.join(sessionRoot!, "npm-cache"),
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (joined.includes(" audit signatures"))
          return { exitCode: 0, stdout: JSON.stringify(audit), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      Object.assign(error, { writes, spawns, initialInstalls });
    }
    throw error;
  }
  assert.strictEqual(initialInstalls, 1);
  return { writes, spawns, initialInstalls };
}

void describe("manual npm publication capability", () => {
  void it("projects a source-backed release workflow and caller only for the public CLI candidate", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated", "cli"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.21.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    });

    assertMatches(
      plan.operations,
      arrayContaining([
        objectContaining({
          kind: "copyFile",
          from: "publication/release.yml",
          to: ".github/workflows/release.yml",
        }),
        objectContaining({
          kind: "writeTextTemplate",
          from: "publication/publish.ts",
          to: "scripts/npm-publication/publish.ts",
          replacements: { PUBLIC_CLI_PACKAGE_PATH: "packages/cli" },
        }),
        objectContaining({
          kind: "writeTextTemplate",
          from: "publication/release.ts",
          to: "scripts/npm-publication/release.ts",
          replacements: { PUBLIC_CLI_PACKAGE_PATH: "packages/cli" },
        }),
        objectContaining({
          kind: "copyFile",
          from: "publication/handoff.ts",
          to: "scripts/npm-publication/handoff.ts",
        }),
      ]),
    );
  });

  void it("creates and proves one immutable release from the accepted artifact", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-release-"),
    );
    try {
      const artifact = await writeVerifiedArtifact(workspace);
      const { runImmutableGithubRelease } = await loadReleaseModule(workspace);
      const tag = "v1.0.1";
      const targetCommit = "a".repeat(40);
      const annotation = `npm artifact SHA-512: ${createHash("sha512").update("verified-tgz-bytes").digest("hex")}`;
      const commands: readonly (readonly string[])[] = [];
      let tagCreated = false;
      let releaseState: "absent" | "draft" | "public" = "absent";
      const assets = [
        { id: 11, name: "tool-1.0.1.tgz", size: 18 },
        { id: 12, name: "SHA512SUMS", size: 145 },
      ];
      const response = (value: unknown) => ({
        exitCode: 0,
        stdout: JSON.stringify(value),
        stderr: "",
      });
      const release = () =>
        releaseState === "absent"
          ? []
          : [
              {
                id: 7,
                tag_name: tag,
                name: tag,
                body: "Publish the stable CLI.",
                draft: releaseState === "draft",
                immutable: releaseState === "public",
                published_at:
                  releaseState === "public" ? "2026-08-30T00:00:00Z" : null,
                assets,
              },
            ];

      await runImmutableGithubRelease({
        repositoryRoot: workspace,
        artifactDirectory: artifact.directory,
        environment: {
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: "publisher/tool",
          GITHUB_SHA: targetCommit,
          GITHUB_REF: "refs/heads/main",
          GITHUB_DEFAULT_BRANCH: "main",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GH_TOKEN: "must-not-escape-gh",
          PATH: process.env.PATH,
        },
        async run(command, arguments_, options) {
          (commands as (readonly string[])[]).push([command, ...arguments_]);
          if (command === "git") {
            assert.deepStrictEqual(arguments_, [
              "rev-parse",
              "--verify",
              "HEAD",
            ]);
            assert.deepStrictEqual(options.env, { PATH: process.env.PATH });
            return { exitCode: 0, stdout: `${targetCommit}\n`, stderr: "" };
          }
          assert.deepStrictEqual(options.env, {
            GH_TOKEN: "must-not-escape-gh",
            PATH: process.env.PATH,
          });
          const request = arguments_.join(" ");
          if (request.includes("/git/ref/tags/")) {
            return tagCreated
              ? {
                  exitCode: 0,
                  stdout: `HTTP/2 200\n\n${JSON.stringify({ object: { type: "tag", sha: "tag-object" } })}`,
                  stderr: "",
                }
              : { exitCode: 1, stdout: "HTTP/2 404\n\n", stderr: "" };
          }
          if (request.includes("/git/tags/tag-object")) {
            return response({
              tag,
              message: annotation,
              object: { type: "commit", sha: targetCommit },
            });
          }
          if (request.includes("/releases?per_page=100"))
            return response([release()]);
          if (request.includes("/git/tags") && request.includes("POST")) {
            tagCreated = true;
            return response({ sha: "tag-object" });
          }
          if (request.includes("/git/refs") && request.includes("POST"))
            return response({});
          if (arguments_[0] === "release" && arguments_[1] === "create") {
            releaseState = "draft";
            return response({});
          }
          if (request.includes("/releases/assets/")) {
            const output = arguments_.find((value) =>
              value.startsWith("--output="),
            );
            if (output === undefined)
              throw new Error("Expected gh asset output path");
            const assetId = Number(request.match(/assets\/(\d+)/u)?.[1]);
            await writeFile(
              output.slice("--output=".length),
              assetId === 11
                ? "verified-tgz-bytes"
                : await readFile(path.join(artifact.directory, "SHA512SUMS")),
            );
            return response({});
          }
          if (arguments_[0] === "release" && arguments_[1] === "edit") {
            releaseState = "public";
            return response({});
          }
          if (
            arguments_[0] === "release" &&
            (arguments_[1] === "verify" || arguments_[1] === "verify-asset")
          )
            return response({});
          throw new Error(`Unexpected gh command: ${request}`);
        },
      });

      const writes = commands.filter((command) =>
        [
          "api --method POST repos/publisher/tool/git/tags",
          "api --method POST repos/publisher/tool/git/refs",
          "release create v1.0.1",
          "release edit v1.0.1 --draft=false",
        ].some((prefix) => command.join(" ").startsWith(`gh ${prefix}`)),
      );
      assert.strictEqual(writes.length, 4);
      assertMatches(
        writes[2],
        arrayContaining([
          "release",
          "create",
          tag,
          "--draft",
          "--verify-tag",
          "--title",
          tag,
        ]),
      );
      assert.deepStrictEqual(writes[3], [
        "gh",
        "release",
        "edit",
        tag,
        "--draft=false",
      ]);
      assertMatches(commands.slice(-3), [
        ["gh", "release", "verify", tag],
        ["gh", "release", "verify-asset", tag, any(String)],
        ["gh", "release", "verify-asset", tag, any(String)],
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  testEach(
    [
      {
        name: "rejects a fresh dispatch that finds existing state",
        attempt: "1",
        initialState: "draft",
        initialTag: true,
        expectedCode: "fresh-release-conflict",
        expectedWrites: 0,
      },
      {
        name: "rejects a rerun with no tag or release",
        attempt: "2",
        initialState: "absent",
        initialTag: false,
        expectedCode: "release-incomplete-conflict",
        expectedWrites: 0,
      },
      {
        name: "rejects a rerun with only an annotated tag",
        attempt: "2",
        initialState: "absent",
        initialTag: true,
        expectedCode: "release-incomplete-conflict",
        expectedWrites: 0,
      },
      {
        name: "rejects a rerun with a partial draft without repairing it",
        attempt: "2",
        initialState: "draft",
        initialTag: true,
        partialDraft: true,
        expectedCode: "release-incomplete-conflict",
        expectedWrites: 0,
      },
      {
        name: "resumes the exact draft without recreating it",
        attempt: "2",
        initialState: "draft",
        initialTag: true,
        expectedWrites: 1,
      },
      {
        name: "only proves an exact immutable public release on rerun",
        attempt: "2",
        initialState: "public",
        initialTag: true,
        expectedWrites: 0,
      },
      {
        name: "stops before publication when a draft asset differs",
        attempt: "2",
        initialState: "draft",
        initialTag: true,
        corruptAsset: true,
        expectedCode: "release-asset-conflict",
        expectedWrites: 0,
      },
      {
        name: "stops before a draft when the existing tag annotation differs",
        attempt: "2",
        initialState: "draft",
        initialTag: true,
        mismatchedTag: true,
        expectedCode: "release-tag-conflict",
        expectedWrites: 0,
      },
      {
        name: "does not claim a failed public conversion completed",
        attempt: "1",
        initialState: "absent",
        initialTag: false,
        publicConversionFails: true,
        expectedCode: "release-write-failed",
        expectedWrites: 4,
      },
      {
        name: "stops after an unproven immutable public transition",
        attempt: "1",
        initialState: "absent",
        initialTag: false,
        immutableFalse: true,
        expectedCode: "release-immutability-unproven",
        expectedWrites: 4,
      },
      {
        name: "fails closed when GitHub's documented attestation command fails",
        attempt: "1",
        initialState: "absent",
        initialTag: false,
        attestationFails: true,
        expectedCode: "release-attestation-invalid",
        expectedWrites: 4,
      },
      {
        name: "rejects an invalid dispatch context before starting gh",
        attempt: "1",
        initialState: "absent",
        initialTag: false,
        invalidContext: true,
        expectedCode: "release-context-invalid",
        expectedWrites: 0,
      },
      {
        name: "rejects a checkout whose checked-out HEAD is not the dispatch SHA",
        attempt: "1",
        initialState: "absent",
        initialTag: false,
        checkoutMismatch: true,
        expectedCode: "release-context-invalid",
        expectedWrites: 0,
      },
    ],
    "%s",
    async (scenario) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-release-state-"),
      );
      try {
        const artifact = await writeVerifiedArtifact(workspace);
        const { runImmutableGithubRelease } =
          await loadReleaseModule(workspace);
        const tag = "v1.0.1";
        const targetCommit = "a".repeat(40);
        const annotation = `npm artifact SHA-512: ${createHash("sha512").update("verified-tgz-bytes").digest("hex")}`;
        const commands: (readonly string[])[] = [];
        let tagCreated = scenario.initialTag;
        let releaseState: "absent" | "draft" | "public" =
          scenario.initialState as "absent" | "draft" | "public";
        const assets = [
          { id: 11, name: "tool-1.0.1.tgz", size: 18 },
          { id: 12, name: "SHA512SUMS", size: 145 },
        ];
        const response = (value: unknown, exitCode = 0) => ({
          exitCode,
          stdout: JSON.stringify(value),
          stderr: "GITHUB_TOKEN=must-not-escape-gh",
        });
        const release = () =>
          releaseState === "absent"
            ? []
            : [
                {
                  id: 7,
                  tag_name: tag,
                  name: tag,
                  body: "Publish the stable CLI.",
                  draft: releaseState === "draft",
                  immutable:
                    releaseState === "public" && !scenario.immutableFalse,
                  published_at:
                    releaseState === "public" ? "2026-08-30T00:00:00Z" : null,
                  assets:
                    scenario.partialDraft && releaseState === "draft"
                      ? assets.slice(0, 1)
                      : assets,
                },
              ];

        const execution = runImmutableGithubRelease({
          repositoryRoot: workspace,
          artifactDirectory: artifact.directory,
          environment: {
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_SHA: targetCommit,
            GITHUB_REF: scenario.invalidContext
              ? "refs/heads/not-main"
              : "refs/heads/main",
            GITHUB_DEFAULT_BRANCH: "main",
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: scenario.attempt,
            GH_TOKEN: "must-not-escape-gh",
            PATH: process.env.PATH,
          },
          async run(command, arguments_, options) {
            commands.push([command, ...arguments_]);
            if (command === "git") {
              assert.deepStrictEqual(arguments_, [
                "rev-parse",
                "--verify",
                "HEAD",
              ]);
              assert.deepStrictEqual(options.env, { PATH: process.env.PATH });
              return {
                exitCode: 0,
                stdout: `${scenario.checkoutMismatch ? "b" : targetCommit}\n`,
                stderr: "",
              };
            }
            assert.deepStrictEqual(options.env, {
              GH_TOKEN: "must-not-escape-gh",
              PATH: process.env.PATH,
            });
            const request = arguments_.join(" ");
            if (request.includes("/git/ref/tags/")) {
              return tagCreated
                ? {
                    exitCode: 0,
                    stdout: `HTTP/2 200\n\n${JSON.stringify({ object: { type: "tag", sha: "tag-object" } })}`,
                    stderr: "",
                  }
                : { exitCode: 1, stdout: "HTTP/2 404\n\n", stderr: "" };
            }
            if (request.includes("/git/tags/tag-object")) {
              return response({
                tag,
                message: scenario.mismatchedTag
                  ? "different annotation"
                  : annotation,
                object: { type: "commit", sha: targetCommit },
              });
            }
            if (request.includes("/releases?per_page=100"))
              return response([release()]);
            if (request.includes("/git/tags") && request.includes("POST")) {
              tagCreated = true;
              return response({ sha: "tag-object" });
            }
            if (request.includes("/git/refs") && request.includes("POST"))
              return response({});
            if (arguments_[0] === "release" && arguments_[1] === "create") {
              releaseState = "draft";
              return response({});
            }
            if (request.includes("/releases/assets/")) {
              const output = arguments_.find((value) =>
                value.startsWith("--output="),
              );
              if (output === undefined)
                throw new Error("Expected gh asset output path");
              const assetId = Number(request.match(/assets\/(\d+)/u)?.[1]);
              await writeFile(
                output.slice("--output=".length),
                assetId === 11 && scenario.corruptAsset
                  ? "different-tgz-bytes"
                  : assetId === 11
                    ? "verified-tgz-bytes"
                    : await readFile(
                        path.join(artifact.directory, "SHA512SUMS"),
                      ),
              );
              return response({});
            }
            if (arguments_[0] === "release" && arguments_[1] === "edit") {
              if (!scenario.publicConversionFails) releaseState = "public";
              return response({}, scenario.publicConversionFails ? 1 : 0);
            }
            if (
              arguments_[0] === "release" &&
              (arguments_[1] === "verify" || arguments_[1] === "verify-asset")
            )
              return response({}, scenario.attestationFails ? 1 : 0);
            throw new Error(`Unexpected gh command: ${request}`);
          },
        });

        if (scenario.expectedCode === undefined)
          assert.strictEqual(await execution, undefined);
        else
          await assert.rejects(execution, (error) => {
            assertMatchesPartial(error, {
              code: scenario.expectedCode,
            });
            return true;
          });
        const writes = commands.filter((command) =>
          [
            "api --method POST repos/publisher/tool/git/tags",
            "api --method POST repos/publisher/tool/git/refs",
            "release create v1.0.1",
            "release edit v1.0.1 --draft=false",
          ].some((prefix) => command.join(" ").startsWith(`gh ${prefix}`)),
        );
        assert.strictEqual(writes.length, scenario.expectedWrites);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("rejects semantic release mutations at their parsed YAML location", async () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated", "cli"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.21.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    });
    const source = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../templates/ts-cli/publication/release.yml",
      ),
      "utf8",
    );
    const { assertPublicationWorkflowContract } =
      await loadPublicationYamlChecker();
    for (const mutate of [
      (workflow: Record<string, unknown>) => {
        const verify = (workflow.jobs as Record<string, unknown>)
          .verify as Record<string, unknown>;
        verify["timeout-minutes"] = 29;
      },
      (workflow: Record<string, unknown>) => {
        (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: unknown[];
          }
        ).steps[1] = {
          ...(
            (workflow.jobs as Record<string, unknown>).verify as {
              steps: Record<string, unknown>[];
            }
          ).steps[1]!,
          with: { ref: "main", "persist-credentials": false, "fetch-depth": 1 },
        };
      },
      (workflow: Record<string, unknown>) => {
        const upload = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[7]!;
        upload.with = {
          ...(upload.with as Record<string, unknown>),
          path: "wrong.tgz",
        };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).publish as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.env = {};
      },
      (workflow: Record<string, unknown>) => {
        const node = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[2]!;
        node.if = "false";
      },
      (workflow: Record<string, unknown>) => {
        const staging = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[5]!;
        staging.run = "true";
      },
      (workflow: Record<string, unknown>) => {
        const rootCheck = (
          (workflow.jobs as Record<string, unknown>).verify as {
            steps: Record<string, unknown>[];
          }
        ).steps[6]!;
        rootCheck.env = { PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: "wrong" };
      },
      (workflow: Record<string, unknown>) => {
        (workflow.jobs as Record<string, unknown>).release = {
          ...((workflow.jobs as Record<string, unknown>).release as Record<
            string,
            unknown
          >),
          needs: "verify",
        };
      },
      (workflow: Record<string, unknown>) => {
        const download = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[2]!;
        download.with = {
          ...(download.with as Record<string, unknown>),
          name: "different-artifact",
        };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "pnpm run check";
      },
      (workflow: Record<string, unknown>) => {
        const release = (workflow.jobs as Record<string, unknown>)
          .release as Record<string, unknown>;
        release.permissions = { contents: "write", "id-token": "write" };
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release create v1.0.1 --draft=false";
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release create v1.0.1 --generate-notes";
      },
      (workflow: Record<string, unknown>) => {
        const caller = (
          (workflow.jobs as Record<string, unknown>).release as {
            steps: Record<string, unknown>[];
          }
        ).steps[3]!;
        caller.run = "gh release upload v1.0.1 artifact.tgz --clobber";
      },
      (workflow: Record<string, unknown>) => {
        const release = (workflow.jobs as Record<string, unknown>).release as {
          steps: Record<string, unknown>[];
        };
        release.steps.push({
          name: "Upload assets after public release",
          run: "gh release upload v1.0.1 artifact.tgz",
        });
      },
    ]) {
      const workflow = parseDocument(source).toJS() as Record<string, unknown>;
      mutate(workflow);
      assertThrows(
        () => assertPublicationWorkflowContract(plan, source, workflow),
        "publication workflow",
      );
    }
  });

  void it("rejects an ambient npm credential before spawning a package manager", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: workspace,
          artifactDirectory: path.join(workspace, "artifact"),
          environment: {
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_RUN_ATTEMPT: "1",
            NPM_TOKEN: "poison",
          },
          async run(command) {
            spawns.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error) => {
          assertMatchesPartial(error, { code: "credential-fallback" });
          return true;
        },
      );
      assert.deepStrictEqual(spawns, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a checkout .npmrc before spawning a package manager", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await writeFile(
        path.join(workspace, ".npmrc"),
        "registry=https://registry.npmjs.org/\n",
      );
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: workspace,
          artifactDirectory: path.join(workspace, "artifact"),
          environment: {
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_RUN_ATTEMPT: "1",
          },
          async run(command) {
            spawns.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error) => {
          assertMatchesPartial(error, { code: "checkout-npmrc-conflict" });
          return true;
        },
      );
      assert.deepStrictEqual(spawns, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a broken checkout .npmrc symlink before spawning a package manager", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await symlink("missing-npmrc", path.join(workspace, ".npmrc"));
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: workspace,
          artifactDirectory: path.join(workspace, "artifact"),
          environment: {
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_RUN_ATTEMPT: "1",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test-token",
          },
          async run(command) {
            spawns.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error) => {
          assertMatchesPartial(error, { code: "checkout-npmrc-conflict" });
          return true;
        },
      );
      assert.deepStrictEqual(spawns, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("requires both GitHub OIDC request variables before artifact or tool work", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifactDirectory = (await writeVerifiedArtifact(workspace))
        .directory;
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: workspace,
          artifactDirectory,
          environment: {
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_RUN_ATTEMPT: "1",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
          },
          async run(command) {
            spawns.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error) => {
          assertMatchesPartial(error, { code: "oidc-unavailable" });
          return true;
        },
      );
      assert.deepStrictEqual(spawns, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects a receipt without the fixed schema and artifact file bindings before spawning", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifactDirectory = (await writeVerifiedArtifact(workspace))
        .directory;
      const receiptPath = path.join(
        artifactDirectory,
        "verified-publication-artifact.json",
      );
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
        string,
        unknown
      >;
      receipt.schemaVersion = 2;
      await writeFile(receiptPath, JSON.stringify(receipt));
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot: workspace,
          artifactDirectory,
          environment: {
            GITHUB_REPOSITORY: "publisher/tool",
            GITHUB_RUN_ATTEMPT: "1",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test-token",
          },
          async run(command) {
            spawns.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        (error) => {
          assertMatchesPartial(error, { code: "artifact-receipt-invalid" });
          return true;
        },
      );
      assert.deepStrictEqual(spawns, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  testEach(
    [
      [
        "release notes",
        "artifact-receipt-invalid",
        (receipt: Record<string, unknown>) => {
          delete (receipt.publication as Record<string, unknown>).releaseNotes;
        },
      ],
      [
        "release date",
        "artifact-receipt-invalid",
        (receipt: Record<string, unknown>) => {
          delete (receipt.publication as Record<string, unknown>).releaseDate;
        },
      ],
      [
        "non-empty files",
        "artifact-receipt-invalid",
        (receipt: Record<string, unknown>) => {
          receipt.files = [];
        },
      ],
      [
        "bin evidence",
        "artifact-receipt-invalid",
        (receipt: Record<string, unknown>) => {
          delete receipt.bin;
        },
      ],
      [
        "smoke evidence",
        "artifact-receipt-invalid",
        (receipt: Record<string, unknown>) => {
          delete receipt.smokes;
        },
      ],
      [
        "packed repository type",
        "identity-invalid",
        (receipt: Record<string, unknown>) => {
          (
            (receipt.packedManifest as Record<string, unknown>)
              .repository as Record<string, unknown>
          ).type = "npm";
        },
      ],
      [
        "packed package directory",
        "identity-invalid",
        (receipt: Record<string, unknown>) => {
          (
            (receipt.packedManifest as Record<string, unknown>)
              .repository as Record<string, unknown>
          ).directory = "packages/other";
        },
      ],
    ] as const,
    "rejects a Ticket 09 receipt without %s before spawning",
    async (
      _name: string,
      code: string,
      mutateReceipt: (receipt: Record<string, unknown>) => void,
    ) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        await assert.rejects(
          executeFakePublication(workspace, { mutateReceipt }),
          (error) => {
            assertMatchesPartial(error, { code, writes: 0, spawns: 0 });
            return true;
          },
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("rejects a source package directory mismatch before spawning", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await assert.rejects(
        executeFakePublication(workspace, {
          mutateSourceManifest(manifest) {
            (manifest.repository as Record<string, unknown>).directory =
              "packages/other";
          },
        }),
        (error) => {
          assertMatchesPartial(error, {
            code: "identity-invalid",
            writes: 0,
            spawns: 0,
          });
          return true;
        },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  testEach(
    [
      [
        "the fixed help arguments",
        (receipt: Record<string, unknown>) => {
          (receipt.smokes as Record<string, unknown>[])[1]!.args = [];
        },
      ],
      [
        "a canonical package file path",
        (receipt: Record<string, unknown>) => {
          (receipt.files as Record<string, unknown>[])[0]!.path =
            "CHANGELOG.md";
        },
      ],
      [
        "one fixed packed file",
        (receipt: Record<string, unknown>) => {
          (receipt.files as Record<string, unknown>[]).splice(2, 1);
        },
      ],
      [
        "an otherwise sorted extra packed file",
        (receipt: Record<string, unknown>) => {
          (receipt.files as Record<string, unknown>[]).splice(5, 0, {
            path: "package/dist/extra.js",
            mode: 420,
            size: 1,
          });
        },
      ],
      [
        "the packed executable mode",
        (receipt: Record<string, unknown>) => {
          (receipt.bin as Record<string, unknown>).mode = 420;
        },
      ],
    ] as const,
    "rejects a Ticket 09 receipt that changes %s before spawning",
    async (
      _name: string,
      mutateReceipt: (receipt: Record<string, unknown>) => void,
    ) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        await assert.rejects(
          executeFakePublication(workspace, { mutateReceipt }),
          (error) => {
            assertMatchesPartial(error, {
              code: "identity-invalid",
              spawns: 0,
              writes: 0,
            });
            return true;
          },
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  testEach(
    [
      [
        "an extra artifact member",
        "artifact-set-invalid",
        async (workspace: string, artifact: string) => {
          await writeFile(path.join(artifact, "unexpected"), "not allowed");
        },
      ],
      [
        "a source manifest identity mismatch",
        "identity-invalid",
        async (workspace: string) => {
          const manifestPath = path.join(
            workspace,
            "packages/cli/package.json",
          );
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          manifest.name = "@publisher/other";
          await writeFile(manifestPath, JSON.stringify(manifest));
        },
      ],
      [
        "a packed bin target mismatch",
        "identity-invalid",
        async (_workspace: string, artifact: string) => {
          const receiptPath = path.join(
            artifact,
            "verified-publication-artifact.json",
          );
          const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
            packedManifest: { bin: Record<string, string> };
          };
          receipt.packedManifest.bin.ship = "./dist/other.js";
          await writeFile(receiptPath, JSON.stringify(receipt));
        },
      ],
      [
        "a receipt artifact basename mismatch",
        "artifact-receipt-invalid",
        async (_workspace: string, artifact: string) => {
          const receiptPath = path.join(
            artifact,
            "verified-publication-artifact.json",
          );
          const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
            artifact: { file: string };
          };
          receipt.artifact.file = "different.tgz";
          await writeFile(receiptPath, JSON.stringify(receipt));
        },
      ],
    ] as const,
    "rejects %s before spawning",
    async (
      _name: string,
      code: string,
      mutate: (workspace: string, artifact: string) => Promise<void>,
    ) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        const artifact = await writeVerifiedArtifact(workspace);
        await mutate(workspace, artifact.directory);
        const { runDirectOidcPublication } = await loadPublishModule(workspace);
        const spawns: string[] = [];
        await assert.rejects(
          runDirectOidcPublication({
            repositoryRoot: workspace,
            artifactDirectory: artifact.directory,
            environment: {
              GITHUB_REPOSITORY: "publisher/tool",
              GITHUB_RUN_ATTEMPT: "1",
              ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
              ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test-token",
            },
            async run(command) {
              spawns.push(command);
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          }),
          (error) => {
            assertMatchesPartial(error, { code });
            return true;
          },
        );
        assert.deepStrictEqual(spawns, []);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("publishes once, then requires matching integrity, latest, and audit evidence", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifactDirectory = (await writeVerifiedArtifact(workspace))
        .directory;
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      let writes = 0;
      let exactReads = 0;
      await runDirectOidcPublication({
        repositoryRoot: workspace,
        artifactDirectory,
        environment: {
          GITHUB_REPOSITORY: "publisher/tool",
          GITHUB_RUN_ATTEMPT: "1",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test-token",
        },
        async run(_command, arguments_) {
          const joined = arguments_.join(" ");
          if (arguments_[0] === "pnpm" && arguments_[1] === "install")
            return { exitCode: 0, stdout: "", stderr: "" };
          if (joined.includes(" --version"))
            return { exitCode: 0, stdout: "11.19.1\n", stderr: "" };
          if (joined.includes(" config get fetch-retries"))
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          if (joined.includes(" config get registry"))
            return {
              exitCode: 0,
              stdout: "https://registry.npmjs.org/\n",
              stderr: "",
            };
          if (joined.includes("view @publisher/tool dist-tags")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                latest: writes === 0 ? "1.0.0" : "1.0.1",
              }),
              stderr: "",
            };
          }
          if (joined.includes("view @publisher/tool@1.0.1 dist.integrity")) {
            exactReads += 1;
            return exactReads === 1
              ? { exitCode: 1, stdout: "", stderr: "npm error code E404\n" }
              : {
                  exitCode: 0,
                  stdout: JSON.stringify(
                    `sha512-${createHash("sha512").update("verified-tgz-bytes").digest("base64")}`,
                  ),
                  stderr: "",
                };
          }
          if (joined.includes(" publish ")) {
            writes += 1;
            return { exitCode: 0, stdout: "published", stderr: "" };
          }
          if (joined.includes(" audit signatures")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                invalid: [],
                missing: [],
                verified: [
                  {
                    name: "@publisher/tool",
                    version: "1.0.1",
                    attestationBundles: [{}],
                  },
                ],
              }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      assert.strictEqual(writes, 1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  testEach(
    [
      ["latest is absent", { latest: undefined }, "latest-invalid", 0],
      [
        "candidate is not newer than latest",
        { latest: "1.0.1" },
        "latest-stale",
        0,
      ],
      [
        "exact lookup is not an explicit E404",
        { exact: "ambiguous" },
        "registry-preflight-failed",
        0,
      ],
      [
        "fresh exact version exists",
        { exact: "same" },
        "fresh-version-exists",
        0,
      ],
      [
        "rerun integrity conflicts",
        { attempt: 2, exact: "different" },
        "rerun-integrity-conflict",
        0,
      ],
      [
        "rerun latest conflicts",
        { attempt: 2, exact: "same", latest: "1.0.0" },
        "rerun-latest-conflict",
        0,
      ],
      [
        "post-write integrity conflicts",
        { postIntegrity: "different" },
        "postwrite-integrity-conflict",
        1,
      ],
      [
        "audit invalid is non-empty",
        { audit: { invalid: [{}], missing: [], verified: [] } },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit missing is non-empty",
        { audit: { invalid: [], missing: [{}], verified: [] } },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit target is missing",
        { audit: { invalid: [], missing: [], verified: [] } },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit target is duplicated",
        {
          audit: {
            invalid: [],
            missing: [],
            verified: [
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [{}],
              },
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [{}],
              },
            ],
          },
        },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit target has mixed empty and non-empty duplicate bundles",
        {
          audit: {
            invalid: [],
            missing: [],
            verified: [
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [],
              },
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [{}],
              },
            ],
          },
        },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit target bundle is empty",
        {
          audit: {
            invalid: [],
            missing: [],
            verified: [
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [],
              },
            ],
          },
        },
        "signature-audit-invalid",
        1,
      ],
      [
        "audit omits invalid and missing arrays",
        {
          audit: {
            verified: [
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [{}],
              },
            ],
          },
        },
        "signature-audit-invalid",
        1,
      ],
      [
        "post-write latest conflicts",
        { postLatest: "1.0.0" },
        "postwrite-integrity-conflict",
        1,
      ],
    ] as const,
    "fails closed when %s",
    async (
      _name: string,
      scenario: FakePublicationScenario,
      code: string,
      writes: number,
    ) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        let failure: unknown;
        try {
          await executeFakePublication(workspace, scenario);
        } catch (error) {
          failure = error;
        }
        assertMatchesPartial(failure, { code, writes });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it("allows rerun absence once and resumes an identical rerun without rewriting", async () => {
    const absentWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    const identicalWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      assertMatchesPartial(
        await executeFakePublication(absentWorkspace, {
          attempt: 2,
          exact: "absent",
        }),
        { writes: 1, initialInstalls: 1 },
      );
      assertMatchesPartial(
        await executeFakePublication(identicalWorkspace, {
          attempt: 2,
          exact: "same",
          latest: "1.0.1",
        }),
        { writes: 0, initialInstalls: 1 },
      );
    } finally {
      await Promise.all([
        rm(absentWorkspace, { recursive: true, force: true }),
        rm(identicalWorkspace, { recursive: true, force: true }),
      ]);
    }
  });

  void it("handles primitive audit entries without weakening the exact identity gate", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      assertMatchesPartial(
        await executeFakePublication(workspace, {
          audit: {
            invalid: [],
            missing: [],
            verified: [
              null,
              "unrelated",
              {
                name: "@publisher/tool",
                version: "1.0.1",
                attestationBundles: [{}],
              },
            ],
          },
        }),
        { writes: 1, initialInstalls: 1 },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("treats build metadata as stable while SemVer precedence ignores it", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      assertMatchesPartial(
        await executeFakePublication(workspace, { version: "1.0.1+build.7" }),
        { writes: 1 },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects prereleases and compares large SemVer components with the locked parser", async () => {
    const prereleaseWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    const largeWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await assert.rejects(
        executeFakePublication(prereleaseWorkspace, {
          version: "1.0.1-beta.1",
        }),
        (error) => {
          assertMatchesPartial(error, { code: "identity-invalid", writes: 0 });
          return true;
        },
      );
      assertMatchesPartial(
        await executeFakePublication(largeWorkspace, {
          version: "4294967297.0.0",
          latest: "4294967296.0.0",
        }),
        { writes: 1 },
      );
    } finally {
      await Promise.all([
        rm(prereleaseWorkspace, { recursive: true, force: true }),
        rm(largeWorkspace, { recursive: true, force: true }),
      ]);
    }
  });
});
