import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";

import { tsCliDefinition } from "../ts-cli/definition.ts";
import { tsLibDefinition } from "../ts-lib/definition.ts";

type ArtifactModule =
  typeof import("../../templates/ts-cli/publication/artifact.ts");

const mitLicense = `MIT License

Copyright (c) 2026 Ada Lovelace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function configurePublicOwnerFacts(options: {
  readonly repositoryRoot: string;
  readonly packageName: string;
}): Promise<void> {
  const packagePath = "packages/cli";
  const manifestPath = path.join(
    options.repositoryRoot,
    packagePath,
    "package.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  const unpublishedManifest = { ...manifest };
  delete unpublishedManifest.private;
  await writeJson(manifestPath, {
    name: options.packageName,
    version: "1.0.0",
    description: "A focused command-line release tool.",
    homepage: "https://github.com/publisher/tool#readme",
    bugs: { url: "https://github.com/publisher/tool/issues" },
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/publisher/tool.git",
      directory: packagePath,
    },
    bin: { ship: "./dist/cli.js" },
    files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    type: unpublishedManifest.type,
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    scripts: unpublishedManifest.scripts,
    dependencies: unpublishedManifest.dependencies,
    devDependencies: unpublishedManifest.devDependencies,
    engines: unpublishedManifest.engines,
  });

  const blueprintPath = path.join(
    options.repositoryRoot,
    ".template/blueprint.json",
  );
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
    readonly packages: readonly Record<string, unknown>[];
  } & Record<string, unknown>;
  await writeJson(blueprintPath, {
    ...blueprint,
    packages: blueprint.packages.map((item) =>
      item.path === packagePath ? { ...item, name: options.packageName } : item,
    ),
  });

  await writeFile(path.join(options.repositoryRoot, "LICENSE"), mitLicense);
  await writeFile(
    path.join(options.repositoryRoot, packagePath, "LICENSE"),
    mitLicense,
  );
  await writeFile(
    path.join(options.repositoryRoot, packagePath, "README.md"),
    "# Tool\n\nInstall the package and run `ship lookup ada`.\n",
  );
  await writeFile(
    path.join(options.repositoryRoot, packagePath, "CHANGELOG.md"),
    `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-26

### Added

- Publish the first stable CLI.

[Unreleased]: https://github.com/publisher/tool/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/publisher/tool/releases/tag/v1.0.0
`,
  );
}

async function requireReady(repositoryRoot: string): Promise<void> {
  const result = await execa(
    "pnpm",
    ["run", "publication:readiness", "--require-ready"],
    { cwd: repositoryRoot, reject: false },
  );
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes("npm publication readiness: ready"));
}

void describe("ts-cli publication owner-fact integration", () => {
  void it("starts with a fix-stable publication projection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-publication-fix-stability-"),
    );
    const repositoryRoot = path.join(workspace, "generated-repository");
    const plan = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: createGenerationContext({
        targetDir: repositoryRoot,
        defaultPackageScope: "seed",
        toolchain: {
          nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
            0,
            releaseToolchainSnapshot.nodeVersion.indexOf("."),
          ),
          packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
        },
      }),
    });

    try {
      await renderNewProject({
        targetRoot: repositoryRoot,
        operations: [...plan.operations],
      });
      await execa("git", ["init", "--quiet"], { cwd: repositoryRoot });
      await execa("pnpm", ["install"], { cwd: repositoryRoot });
      await execa("git", ["add", "--all", "--", "."], {
        cwd: repositoryRoot,
      });
      const beforeFix = await execa("git", ["write-tree"], {
        cwd: repositoryRoot,
      });

      await execa("pnpm", ["run", "fix"], { cwd: repositoryRoot });
      await execa("git", ["add", "--all", "--", "."], {
        cwd: repositoryRoot,
      });
      const afterFix = await execa("git", ["write-tree"], {
        cwd: repositoryRoot,
      });

      assert.strictEqual(
        (
          await execa("git", ["diff", beforeFix.stdout, afterFix.stdout], {
            cwd: repositoryRoot,
          })
        ).stdout,
        "",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it(
    "verifies the one packed artifact and records its installed CLI evidence",
    { timeout: 240_000 },
    async (t) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-artifact-"),
      );
      const repositoryRoot = path.join(workspace, "recorded-repository");
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir: repositoryRoot,
          defaultPackageScope: "seed",
          toolchain: {
            nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
              0,
              releaseToolchainSnapshot.nodeVersion.indexOf("."),
            ),
            packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        }),
      });

      try {
        await renderNewProject({
          targetRoot: repositoryRoot,
          operations: [...plan.operations],
        });
        await execa("pnpm", ["install"], { cwd: repositoryRoot });
        const rootManifest = JSON.parse(
          await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
        ) as { readonly engines?: { readonly node?: unknown } };
        const publicManifest = JSON.parse(
          await readFile(
            path.join(repositoryRoot, "packages/cli/package.json"),
            "utf8",
          ),
        ) as { readonly engines?: { readonly node?: unknown } };
        assert.strictEqual(
          rootManifest.engines?.node,
          releaseToolchainSnapshot.nodeVersion,
        );
        assert.strictEqual(
          publicManifest.engines?.node,
          `^${releaseToolchainSnapshot.nodeVersion}`,
        );
        assert.strictEqual(
          (
            await execa("pnpm", ["exec", "npm", "--version"], {
              cwd: repositoryRoot,
            })
          ).stdout,
          "12.2.0",
        );
        const npmSession = path.join(workspace, "isolated-npm-session");
        await mkdir(npmSession);
        const userConfig = path.join(npmSession, "user-npmrc");
        const globalConfig = path.join(npmSession, "global-npmrc");
        const npmCache = path.join(npmSession, "npm-cache");
        await Promise.all([
          writeFile(
            path.join(npmSession, ".npmrc"),
            "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
          ),
          writeFile(userConfig, ""),
          writeFile(globalConfig, ""),
          mkdir(npmCache),
        ]);
        const sessionConfigArguments = [
          `--prefix=${npmSession}`,
          `--userconfig=${userConfig}`,
          `--globalconfig=${globalConfig}`,
          `--cache=${npmCache}`,
        ];
        assert.strictEqual(
          (
            await execa(
              "pnpm",
              [
                "exec",
                "npm",
                ...sessionConfigArguments,
                "config",
                "get",
                "fetch-retries",
              ],
              { cwd: repositoryRoot },
            )
          ).stdout,
          "1",
        );
        assert.strictEqual(
          (
            await execa(
              "pnpm",
              [
                "exec",
                "npm",
                ...sessionConfigArguments,
                "config",
                "get",
                "registry",
              ],
              { cwd: repositoryRoot },
            )
          ).stdout,
          "https://registry.npmjs.org/",
        );
        const consumer = path.join(npmSession, "consumer");
        await mkdir(consumer);
        await writeFile(
          path.join(consumer, ".npmrc"),
          "registry=https://registry.npmjs.org/\nfetch-retries=1\n",
        );
        assert.strictEqual(
          (
            await execa(
              "pnpm",
              [
                "exec",
                "npm",
                `--prefix=${consumer}`,
                `--userconfig=${userConfig}`,
                `--globalconfig=${globalConfig}`,
                `--cache=${npmCache}`,
                "config",
                "get",
                "fetch-retries",
              ],
              { cwd: repositoryRoot },
            )
          ).stdout,
          "1",
        );
        const artifactModule = (await import(
          `${pathToFileURL(path.join(repositoryRoot, "scripts/npm-publication/artifact.ts")).href}?test=${crypto.randomUUID()}`
        )) as ArtifactModule;

        const safeOutput = path.join(workspace, "safe-output");
        await mkdir(safeOutput);
        const safe = await artifactModule.verifyNpmPublicationArtifact({
          repositoryRoot,
          packagePath: "packages/cli",
          outputDirectory: safeOutput,
        });
        assert.partialDeepStrictEqual(safe, {
          kind: "blocked",
          readiness: { mode: "safe-unconfigured" },
        });
        assert.deepStrictEqual(await readdir(safeOutput), []);

        const overlappingTarget = path.join(repositoryRoot, ".artifact-output");
        await mkdir(overlappingTarget);
        const overlappingOutput = path.join(workspace, "overlapping-output");
        await symlink(overlappingTarget, overlappingOutput, "dir");
        assert.partialDeepStrictEqual(
          await artifactModule.verifyNpmPublicationArtifact({
            repositoryRoot,
            packagePath: "packages/cli",
            outputDirectory: overlappingOutput,
          }),
          {
            kind: "failed",
            failure: { code: "artifact-output-invalid" },
          },
        );

        const candidateManifestPath = path.join(
          repositoryRoot,
          "packages/cli/package.json",
        );
        const publicIntentManifest = JSON.parse(
          await readFile(candidateManifestPath, "utf8"),
        ) as Record<string, unknown>;
        publicIntentManifest.version = "1.0.0";
        await writeJson(candidateManifestPath, publicIntentManifest);
        const publicIntentOutput = path.join(workspace, "public-intent-output");
        await mkdir(publicIntentOutput);
        const publicIntent = await artifactModule.verifyNpmPublicationArtifact({
          repositoryRoot,
          packagePath: "packages/cli",
          outputDirectory: publicIntentOutput,
        });
        assert.partialDeepStrictEqual(publicIntent, {
          kind: "blocked",
          readiness: { mode: "public-intent" },
        });
        assert.deepStrictEqual(await readdir(publicIntentOutput), []);

        await configurePublicOwnerFacts({
          repositoryRoot,
          packageName: "@publisher/tool",
        });
        const sourceManifestPath = path.join(
          repositoryRoot,
          "packages/cli/package.json",
        );
        const sourceManifest = JSON.parse(
          await readFile(sourceManifestPath, "utf8"),
        ) as Record<string, unknown>;
        const scripts = sourceManifest.scripts as Record<string, string>;
        const canonicalPrepack = scripts.prepack!;
        scripts.prepack = "true";
        await writeJson(sourceManifestPath, sourceManifest);

        const invalidPrepackOutput = path.join(
          workspace,
          "invalid-prepack-output",
        );
        await mkdir(invalidPrepackOutput);
        const invalidPrepack =
          await artifactModule.verifyNpmPublicationArtifact({
            repositoryRoot,
            packagePath: "packages/cli",
            outputDirectory: invalidPrepackOutput,
          });
        assert.strictEqual(invalidPrepack.kind, "blocked");
        if (invalidPrepack.kind === "blocked") {
          assert.strictEqual(invalidPrepack.readiness.mode, "public-intent");
          assert.ok(
            invalidPrepack.readiness.blockers.some(
              (blocker) => blocker.code === "manifest-contract",
            ),
          );
        }
        assert.deepStrictEqual(await readdir(invalidPrepackOutput), []);

        scripts.prepack = canonicalPrepack;
        scripts.postbuild = `${scripts.postbuild} && node -e "require('node:fs').appendFileSync('.build-witness', 'build\\n')"`;
        scripts.postpack =
          "node -e \"const fs=require('node:fs');const value=JSON.parse(fs.readFileSync('package.json','utf8'));value.description='Changed after pack';fs.writeFileSync('package.json',JSON.stringify(value,null,2)+'\\n')\"";
        await writeJson(sourceManifestPath, sourceManifest);

        const mainSourcePath = path.join(
          repositoryRoot,
          "packages/cli/src/main.ts",
        );
        const mainSource = await readFile(mainSourcePath, "utf8");
        await writeFile(
          mainSourcePath,
          mainSource.replace("/^[a-z]+$/", "/^[a-z ]+$/"),
        );
        const invalidBehaviorOutput = path.join(
          workspace,
          "invalid-behavior-output",
        );
        await mkdir(invalidBehaviorOutput);
        assert.partialDeepStrictEqual(
          await artifactModule.verifyNpmPublicationArtifact({
            repositoryRoot,
            packagePath: "packages/cli",
            outputDirectory: invalidBehaviorOutput,
          }),
          {
            kind: "failed",
            failure: { code: "consumer-smoke-failed" },
          },
        );
        assert.deepStrictEqual(await readdir(invalidBehaviorOutput), []);
        await writeFile(mainSourcePath, mainSource);
        await rm(path.join(repositoryRoot, "packages/cli/.build-witness"), {
          force: true,
        });

        const refreshedManifest = JSON.parse(
          await readFile(sourceManifestPath, "utf8"),
        ) as Record<string, unknown>;
        refreshedManifest.description = "A focused command-line release tool.";
        await writeJson(sourceManifestPath, refreshedManifest);

        const outputDirectory = path.join(workspace, "verified-output");
        await mkdir(outputDirectory);
        const ambient = {
          NPM_CONFIG_BIN_LINKS: process.env.NPM_CONFIG_BIN_LINKS,
          npm_config_package_lock_only:
            process.env.npm_config_package_lock_only,
          NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
          NODE_OPTIONS: process.env.NODE_OPTIONS,
        };
        const restoreAmbient = () => {
          for (const [key, value] of Object.entries(ambient)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        };
        t.after(restoreAmbient);
        process.env.NPM_CONFIG_BIN_LINKS = "false";
        process.env.npm_config_package_lock_only = "true";
        process.env.NPM_CONFIG_REGISTRY = "https://invalid.example/";
        process.env.NODE_OPTIONS =
          "--require=/definitely/missing-node-options.cjs";
        let verified;
        try {
          verified = await artifactModule.verifyNpmPublicationArtifact({
            repositoryRoot,
            packagePath: "packages/cli",
            outputDirectory,
          });
        } finally {
          restoreAmbient();
        }

        assert.ok(verified?.kind === "verified");
        assert.partialDeepStrictEqual(verified, {
          kind: "verified",
          receipt: {
            schemaVersion: 1,
            publication: {
              packageName: "@publisher/tool",
              version: "1.0.0",
              commandName: "ship",
            },
            files: [
              { path: "package/CHANGELOG.md" },
              { path: "package/LICENSE" },
              { path: "package/README.md" },
              { path: "package/dist/cli-command-identity.js" },
              { path: "package/dist/cli.js" },
              { path: "package/dist/main.js" },
              { path: "package/dist/standard-schema.js" },
              { path: "package/package.json" },
            ],
            bin: {
              path: "package/dist/cli.js",
              shebang: "#!/usr/bin/env node",
            },
          },
        });
        assert.strictEqual(verified.receipt.files.length, 8);
        assert.strictEqual(verified.receipt.smokes.length, 5);
        assert.deepStrictEqual(
          verified.receipt.smokes.map(({ name }) => name),
          ["runtime-import", "help", "version", "lookup", "schema"],
        );
        const [runtimeImport, help, version, lookup, schema] =
          verified.receipt.smokes;
        assert.strictEqual(runtimeImport?.stdout, "");
        assert.ok(help?.stdout.includes("lookup"));
        assert.strictEqual(version?.stdout, "ship 1.0.0\n");
        assert.ok(lookup?.stdout.includes("Ada Lovelace"));
        assert.ok(schema?.stdout.includes("notFound"));
        const artifactBytes = await readFile(verified.artifactPath);
        const digest = createHash("sha512").update(artifactBytes).digest();
        assert.partialDeepStrictEqual(verified.receipt.artifact, {
          size: artifactBytes.byteLength,
          integrity: `sha512-${digest.toString("base64")}`,
        });
        assert.strictEqual(
          await readFile(verified.checksumPath, "utf8"),
          `${digest.toString("hex")}  ${path.basename(verified.artifactPath)}\n`,
        );
        assert.deepStrictEqual(
          JSON.parse(await readFile(verified.receiptPath, "utf8")),
          verified.receipt,
        );
        assert.deepStrictEqual(
          await readdir(outputDirectory),
          [
            "SHA512SUMS",
            path.basename(verified.artifactPath),
            "verified-publication-artifact.json",
          ].toSorted(),
        );
        assert.strictEqual(
          await readFile(
            path.join(repositoryRoot, "packages/cli/.build-witness"),
            "utf8",
          ),
          "build\n",
        );
        assert.partialDeepStrictEqual(
          JSON.parse(await readFile(sourceManifestPath, "utf8")),
          { description: "Changed after pack" },
        );
        assert.partialDeepStrictEqual(verified.receipt.packedManifest, {
          description: "A focused command-line release tool.",
        });

        const callerOutput = path.join(workspace, "caller-output");
        await mkdir(callerOutput);
        const caller = await execa(
          "pnpm",
          [
            "run",
            "publication:artifact",
            "--",
            "--output-directory",
            callerOutput,
          ],
          { cwd: repositoryRoot, reject: false },
        );
        assert.strictEqual(caller.exitCode, 0);
        assert.ok(caller.stdout.includes("npm publication artifact: verified"));
        assert.strictEqual((await readdir(callerOutput)).length, 3);

        const workflowOutput = path.join(workspace, "workflow-output");
        await mkdir(workflowOutput);
        const workflowCaller = await execa(
          "pnpm",
          ["run", "publication:artifact"],
          {
            cwd: repositoryRoot,
            env: {
              ...process.env,
              PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: workflowOutput,
            },
            reject: false,
          },
        );
        assert.strictEqual(workflowCaller.exitCode, 0);
        assert.strictEqual((await readdir(workflowOutput)).length, 3);

        const invalidCaller = await execa(
          "pnpm",
          ["run", "publication:artifact", "--", "--output-directory"],
          { cwd: repositoryRoot, reject: false },
        );
        assert.strictEqual(invalidCaller.exitCode, 2);
        assert.ok(
          invalidCaller.stderr.includes("ERROR publication-artifact-usage"),
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "keeps scoped and unscoped public identity ready across a later addition",
    { timeout: 240_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-publication-owner-facts-"),
      );
      const repositoryRoot = path.join(workspace, "recorded-repository");
      const plan = planGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        context: createGenerationContext({
          targetDir: repositoryRoot,
          defaultPackageScope: "seed",
          toolchain: {
            nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
              0,
              releaseToolchainSnapshot.nodeVersion.indexOf("."),
            ),
            packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
            nodeVersion: releaseToolchainSnapshot.nodeVersion,
          },
        }),
      });
      const initialCandidate = plan.blueprint.packages.find(
        (item) => item.path === "packages/cli",
      )!;
      const initialGenerationRecord = plan.generationRecord.packages.find(
        (item) => item.path === "packages/cli",
      )!;

      try {
        await renderNewProject({
          targetRoot: repositoryRoot,
          operations: [...plan.operations],
        });
        await execa("pnpm", ["install"], { cwd: repositoryRoot });

        await configurePublicOwnerFacts({
          repositoryRoot,
          packageName: "@publisher/tool",
        });
        await requireReady(repositoryRoot);

        await configurePublicOwnerFacts({
          repositoryRoot,
          packageName: "tool",
        });
        await requireReady(repositoryRoot);

        const publicManifestPath = path.join(
          repositoryRoot,
          "packages/cli/package.json",
        );
        const publicManifestBytes = await readFile(publicManifestPath, "utf8");
        const addition = planGeneratedRepositoryPackageAddition({
          definition: tsLibDefinition,
          localTemplateMetadata: loadLocalTemplateMetadata(repositoryRoot),
          packageLeafName: "lib",
        });
        const applied = await reconcileAndApplyProjectProjections({
          targetRoot: repositoryRoot,
          ...addition.projectProjections,
        });
        if (!applied.ok) throw new Error(JSON.stringify(applied, null, 2));

        assert.strictEqual(
          await readFile(publicManifestPath, "utf8"),
          publicManifestBytes,
        );
        assert.partialDeepStrictEqual(
          JSON.parse(
            await readFile(
              path.join(repositoryRoot, "packages/lib/package.json"),
              "utf8",
            ),
          ),
          { name: "@seed/lib", private: true },
        );
        const blueprint = JSON.parse(
          await readFile(
            path.join(repositoryRoot, ".template/blueprint.json"),
            "utf8",
          ),
        ) as { readonly packages: readonly Record<string, unknown>[] };
        assert.deepStrictEqual(
          blueprint.packages.find((item) => item.path === "packages/cli"),
          { ...initialCandidate, name: "tool" },
        );
        const generation = JSON.parse(
          await readFile(
            path.join(repositoryRoot, ".template/generation.json"),
            "utf8",
          ),
        ) as {
          readonly repositoryName: string;
          readonly defaultPackageScope: string;
          readonly packages: readonly Record<string, unknown>[];
        };
        assert.partialDeepStrictEqual(generation, {
          repositoryName: "recorded-repository",
          defaultPackageScope: "seed",
        });
        assert.deepStrictEqual(
          generation.packages.find((item) => item.path === "packages/cli"),
          initialGenerationRecord,
        );

        await execa("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: repositoryRoot,
        });
        await requireReady(repositoryRoot);
        const rootCandidateManifest = JSON.parse(
          await readFile(publicManifestPath, "utf8"),
        ) as Record<string, unknown>;
        const rootCandidateScripts = rootCandidateManifest.scripts as Record<
          string,
          string
        >;
        rootCandidateScripts.postbuild = `${rootCandidateScripts.postbuild} && node -e "require('node:fs').appendFileSync('.build-witness', 'build\\n')"`;
        await writeJson(publicManifestPath, rootCandidateManifest);
        const rootCheck = await execa("pnpm", ["run", "check"], {
          cwd: repositoryRoot,
          reject: false,
        });
        assert.strictEqual(
          rootCheck.exitCode,
          0,
          `${rootCheck.stdout}\n${rootCheck.stderr}`,
        );
        assert.strictEqual(
          typeof (
            await stat(path.join(repositoryRoot, "packages/lib/dist/index.js"))
          ).mode,
          "number",
        );
        assert.strictEqual(
          await readFile(
            path.join(repositoryRoot, "packages/cli/.build-witness"),
            "utf8",
          ),
          "build\n",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
