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
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "../foundation.ts";
import { tsCliDefinition } from "../ts-cli/definition.ts";

type PublishModule =
  typeof import("../../templates/ts-cli/publication/publish.ts");

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
  await cp(
    path.resolve(
      import.meta.dirname,
      "../../templates/ts-cli/publication/publish.ts",
    ),
    path.join(moduleRoot, "publish.ts"),
  );
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
        { name: "help", args: ["--help"], stdout: "Usage: ship\ngreet\n" },
        { name: "version", args: ["--version"], stdout: `${version}\n` },
        {
          name: "greet",
          args: ["greet", "  Ada Lovelace  "],
          stdout: "Hello, Ada Lovelace\n",
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
        expect(command).toBe("corepack");
        expect(options.env.DEPLOY_TOKEN).toBeUndefined();
        expect(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
          "oidc-test-token",
        );
        expect(options.env.NPM_CONFIG_REGISTRY).toBeUndefined();
        expect(options.env).toMatchObject({
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
          expect(options.cwd).toBe(workspace);
          expect(arguments_).toEqual(
            expect.arrayContaining([
              "--frozen-lockfile",
              "--ignore-scripts",
              "--registry=https://registry.npmjs.org/",
            ]),
          );
          expect(
            arguments_.some((argument) => argument.startsWith("--store-dir=")),
          ).toBe(true);
          const userConfig = options.env.NPM_CONFIG_USERCONFIG!;
          const session = path.dirname(userConfig);
          sessionRoot = session;
          expect(await readFile(path.join(session, ".npmrc"), "utf8")).toBe(
            "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
          );
          expect(await readFile(userConfig, "utf8")).toBe("");
          expect(
            await readFile(options.env.NPM_CONFIG_GLOBALCONFIG!, "utf8"),
          ).toBe("");
          expect(options.env.NPM_CONFIG_CACHE).toBe(
            path.join(session, "npm-cache"),
          );
          expect(options.env.HOME).toBe(path.join(session, "home"));
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
          expect(consumer).not.toBe(sessionRoot);
          expect(options.cwd).toBe(workspace);
          expect(arguments_).toEqual(
            expect.arrayContaining([
              `--prefix=${consumer}`,
              "--registry=https://registry.npmjs.org/",
              `--userconfig=${path.join(sessionRoot!, "user-npmrc")}`,
              `--globalconfig=${path.join(sessionRoot!, "global-npmrc")}`,
              `--cache=${path.join(sessionRoot!, "npm-cache")}`,
              "install",
              "--ignore-scripts",
            ]),
          );
          expect(await readFile(path.join(consumer, ".npmrc"), "utf8")).toBe(
            "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
          );
          expect(options.env.NPM_CONFIG_USERCONFIG).toBe(
            path.join(sessionRoot!, "user-npmrc"),
          );
          expect(options.env.NPM_CONFIG_GLOBALCONFIG).toBe(
            path.join(sessionRoot!, "global-npmrc"),
          );
          expect(options.env.NPM_CONFIG_CACHE).toBe(
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
  expect(initialInstalls).toBe(1);
  return { writes, spawns, initialInstalls };
}

describe("manual npm publication capability", () => {
  it("projects a source-backed release workflow and caller only for the public CLI candidate", () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated", "cli"),
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.21.0" },
      }),
    });

    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "copyFile",
          from: "publication/release.yml",
          to: ".github/workflows/release.yml",
        }),
        expect.objectContaining({
          kind: "writeTextTemplate",
          from: "publication/publish.ts",
          to: "scripts/npm-publication/publish.ts",
          replacements: { PUBLIC_CLI_PACKAGE_PATH: "packages/cli" },
        }),
      ]),
    );
  });

  it("rejects semantic release mutations at their parsed YAML location", async () => {
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: path.join("generated", "cli"),
        defaultPackageScope: "demo",
        toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.21.0" },
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
    ]) {
      const workflow = parseDocument(source).toJS() as Record<string, unknown>;
      mutate(workflow);
      expect(() =>
        assertPublicationWorkflowContract(plan, source, workflow),
      ).toThrow("publication workflow");
    }
  });

  it("rejects an ambient npm credential before spawning a package manager", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await expect(
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
      ).rejects.toMatchObject({ code: "credential-fallback" });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a checkout .npmrc before spawning a package manager", async () => {
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
      await expect(
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
      ).rejects.toMatchObject({ code: "checkout-npmrc-conflict" });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a broken checkout .npmrc symlink before spawning a package manager", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await symlink("missing-npmrc", path.join(workspace, ".npmrc"));
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await expect(
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
      ).rejects.toMatchObject({ code: "checkout-npmrc-conflict" });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires both GitHub OIDC request variables before artifact or tool work", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifactDirectory = (await writeVerifiedArtifact(workspace))
        .directory;
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await expect(
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
      ).rejects.toMatchObject({ code: "oidc-unavailable" });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a receipt without the fixed schema and artifact file bindings before spawning", async () => {
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
      await expect(
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
      ).rejects.toMatchObject({ code: "artifact-receipt-invalid" });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
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
  ] as const)(
    "rejects a Ticket 09 receipt without %s before spawning",
    async (_name, code, mutateReceipt) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        await expect(
          executeFakePublication(workspace, { mutateReceipt }),
        ).rejects.toMatchObject({ code, writes: 0, spawns: 0 });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("rejects a source package directory mismatch before spawning", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await expect(
        executeFakePublication(workspace, {
          mutateSourceManifest(manifest) {
            (manifest.repository as Record<string, unknown>).directory =
              "packages/other";
          },
        }),
      ).rejects.toMatchObject({
        code: "identity-invalid",
        writes: 0,
        spawns: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "the fixed help arguments",
      (receipt: Record<string, unknown>) => {
        (receipt.smokes as Record<string, unknown>[])[1]!.args = [];
      },
    ],
    [
      "a canonical package file path",
      (receipt: Record<string, unknown>) => {
        (receipt.files as Record<string, unknown>[])[0]!.path = "CHANGELOG.md";
      },
    ],
    [
      "the packed executable mode",
      (receipt: Record<string, unknown>) => {
        (receipt.bin as Record<string, unknown>).mode = 420;
      },
    ],
  ] as const)(
    "rejects a Ticket 09 receipt that changes %s before spawning",
    async (_name, mutateReceipt) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-caller-"),
      );
      try {
        await expect(
          executeFakePublication(workspace, { mutateReceipt }),
        ).rejects.toMatchObject({
          code: "identity-invalid",
          spawns: 0,
          writes: 0,
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it.each([
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
        const manifestPath = path.join(workspace, "packages/cli/package.json");
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
  ] as const)("rejects %s before spawning", async (_name, code, mutate) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifact = await writeVerifiedArtifact(workspace);
      await mutate(workspace, artifact.directory);
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      const spawns: string[] = [];
      await expect(
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
      ).rejects.toMatchObject({ code });
      expect(spawns).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("publishes once, then requires matching integrity, latest, and audit evidence", async () => {
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
      expect(writes).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
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
  ] as const)("fails closed when %s", async (_name, scenario, code, writes) => {
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
      expect(failure).toMatchObject({ code, writes });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows rerun absence once and resumes an identical rerun without rewriting", async () => {
    const absentWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    const identicalWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await expect(
        executeFakePublication(absentWorkspace, {
          attempt: 2,
          exact: "absent",
        }),
      ).resolves.toMatchObject({ writes: 1, initialInstalls: 1 });
      await expect(
        executeFakePublication(identicalWorkspace, {
          attempt: 2,
          exact: "same",
          latest: "1.0.1",
        }),
      ).resolves.toMatchObject({ writes: 0, initialInstalls: 1 });
    } finally {
      await Promise.all([
        rm(absentWorkspace, { recursive: true, force: true }),
        rm(identicalWorkspace, { recursive: true, force: true }),
      ]);
    }
  });

  it("handles primitive audit entries without weakening the exact identity gate", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await expect(
        executeFakePublication(workspace, {
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
      ).resolves.toMatchObject({ writes: 1, initialInstalls: 1 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("treats build metadata as stable while SemVer precedence ignores it", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await expect(
        executeFakePublication(workspace, { version: "1.0.1+build.7" }),
      ).resolves.toMatchObject({ writes: 1 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects prereleases and compares large SemVer components with the locked parser", async () => {
    const prereleaseWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    const largeWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      await expect(
        executeFakePublication(prereleaseWorkspace, {
          version: "1.0.1-beta.1",
        }),
      ).rejects.toMatchObject({ code: "identity-invalid", writes: 0 });
      await expect(
        executeFakePublication(largeWorkspace, {
          version: "4294967297.0.0",
          latest: "4294967296.0.0",
        }),
      ).resolves.toMatchObject({ writes: 1 });
    } finally {
      await Promise.all([
        rm(prereleaseWorkspace, { recursive: true, force: true }),
        rm(largeWorkspace, { recursive: true, force: true }),
      ]);
    }
  });
});
