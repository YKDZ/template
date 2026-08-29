import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "../foundation.ts";
import { tsCliDefinition } from "../ts-cli/definition.ts";

type PublishModule =
  typeof import("../../templates/ts-cli/publication/publish.ts");

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
  return (await import(
    `${pathToFileURL(publishPath).href}?test=${crypto.randomUUID()}`
  )) as PublishModule;
}

async function writeVerifiedArtifact(workspace: string): Promise<string> {
  const packageRoot = path.join(workspace, "packages", "cli");
  const artifact = path.join(workspace, "artifact");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(artifact);
  const manifest = {
    name: "@publisher/tool",
    version: "1.0.1",
    bin: { ship: "./dist/cli.js" },
    repository: "git+https://github.com/publisher/tool.git",
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest),
  );
  const tgz = Buffer.from("verified-tgz-bytes");
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  await writeFile(path.join(artifact, "tool-1.0.1.tgz"), tgz);
  await writeFile(
    path.join(artifact, "SHA512SUMS"),
    `${createHash("sha512").update(tgz).digest("hex")}  tool-1.0.1.tgz\n`,
  );
  await writeFile(
    path.join(artifact, "verified-publication-artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifact: { integrity, size: tgz.byteLength },
      publication: {
        packageName: "@publisher/tool",
        version: "1.0.1",
        commandName: "ship",
        repository: "git+https://github.com/publisher/tool.git",
      },
      packedManifest: manifest,
      files: [],
    }),
  );
  return artifact;
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

  it("publishes once, then requires matching integrity, latest, and audit evidence", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-caller-"),
    );
    try {
      const artifactDirectory = await writeVerifiedArtifact(workspace);
      const { runDirectOidcPublication } = await loadPublishModule(workspace);
      let writes = 0;
      let exactReads = 0;
      await runDirectOidcPublication({
        repositoryRoot: workspace,
        artifactDirectory,
        environment: {
          GITHUB_REPOSITORY: "publisher/tool",
          GITHUB_RUN_ATTEMPT: "1",
        },
        async run(_command, arguments_) {
          const joined = arguments_.join(" ");
          if (joined.includes(" pnpm install "))
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
              ? { exitCode: 1, stdout: "", stderr: "not found" }
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
});
