import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

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
    "# Tool\n\nInstall the package and run `ship greet Ada`.\n",
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
  expect({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("npm publication readiness: ready"),
  });
}

describe("ts-cli publication owner-fact integration", () => {
  it("verifies the one packed artifact and records its installed CLI evidence", async () => {
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
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.21.0",
        },
      }),
    });

    try {
      await renderNewProject({
        targetRoot: repositoryRoot,
        operations: [...plan.operations],
      });
      await execa("pnpm", ["install"], { cwd: repositoryRoot });
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
      expect(safe).toMatchObject({
        kind: "blocked",
        readiness: { mode: "safe-unconfigured" },
      });
      expect(await readdir(safeOutput)).toEqual([]);

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
      expect(publicIntent).toMatchObject({
        kind: "blocked",
        readiness: { mode: "public-intent" },
      });
      expect(await readdir(publicIntentOutput)).toEqual([]);

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
      const buildWitnessPath = path.join(workspace, "prepack-count.txt");
      const scripts = sourceManifest.scripts as Record<string, string>;
      scripts.prepack = `node -e "require('node:fs').appendFileSync(process.env.TEMPLATE_TEST_BUILD_WITNESS, 'build\\n')" && ${scripts.prepack}`;
      await writeJson(sourceManifestPath, sourceManifest);

      const outputDirectory = path.join(workspace, "verified-output");
      await mkdir(outputDirectory);
      const ambient = {
        NPM_CONFIG_BIN_LINKS: process.env.NPM_CONFIG_BIN_LINKS,
        npm_config_package_lock_only: process.env.npm_config_package_lock_only,
        NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
        TEMPLATE_TEST_BUILD_WITNESS: process.env.TEMPLATE_TEST_BUILD_WITNESS,
      };
      process.env.NPM_CONFIG_BIN_LINKS = "false";
      process.env.npm_config_package_lock_only = "true";
      process.env.NPM_CONFIG_REGISTRY = "https://invalid.example/";
      process.env.TEMPLATE_TEST_BUILD_WITNESS = buildWitnessPath;
      let verified;
      try {
        verified = await artifactModule.verifyNpmPublicationArtifact({
          repositoryRoot,
          packagePath: "packages/cli",
          outputDirectory,
        });
      } finally {
        for (const [key, value] of Object.entries(ambient)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(verified).toMatchObject({
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
            { path: "package/package.json" },
          ],
          bin: {
            path: "package/dist/cli.js",
            shebang: "#!/usr/bin/env node",
          },
          smokes: [
            { name: "runtime-import", stdout: "" },
            { name: "help", stdout: expect.stringContaining("greet") },
            { name: "version", stdout: "1.0.0\n" },
            { name: "greet", stdout: "Hello, Ada Lovelace\n" },
          ],
        },
      });
      if (verified?.kind !== "verified")
        throw new Error("Expected verified artifact");
      const artifactBytes = await readFile(verified.artifactPath);
      const digest = createHash("sha512").update(artifactBytes).digest();
      expect(verified.receipt.artifact).toMatchObject({
        size: artifactBytes.byteLength,
        integrity: `sha512-${digest.toString("base64")}`,
      });
      expect(await readFile(verified.checksumPath, "utf8")).toBe(
        `${digest.toString("hex")}  ${path.basename(verified.artifactPath)}\n`,
      );
      expect(JSON.parse(await readFile(verified.receiptPath, "utf8"))).toEqual(
        verified.receipt,
      );
      expect(await readdir(outputDirectory)).toEqual(
        [
          "SHA512SUMS",
          path.basename(verified.artifactPath),
          "verified-publication-artifact.json",
        ].toSorted(),
      );
      expect(await readFile(buildWitnessPath, "utf8")).toBe("build\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);

  it("keeps scoped and unscoped public identity ready across a later addition", async () => {
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
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.21.0",
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

      expect(await readFile(publicManifestPath, "utf8")).toBe(
        publicManifestBytes,
      );
      expect(
        JSON.parse(
          await readFile(
            path.join(repositoryRoot, "packages/lib/package.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ name: "@seed/lib", private: true });
      const blueprint = JSON.parse(
        await readFile(
          path.join(repositoryRoot, ".template/blueprint.json"),
          "utf8",
        ),
      ) as { readonly packages: readonly Record<string, unknown>[] };
      expect(
        blueprint.packages.find((item) => item.path === "packages/cli"),
      ).toEqual({ ...initialCandidate, name: "tool" });
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
      expect(generation).toMatchObject({
        repositoryName: "recorded-repository",
        defaultPackageScope: "seed",
      });
      expect(
        generation.packages.find((item) => item.path === "packages/cli"),
      ).toEqual(initialGenerationRecord);

      await execa("pnpm", ["install"], { cwd: repositoryRoot });
      await requireReady(repositoryRoot);
      const rootCandidateManifest = JSON.parse(
        await readFile(publicManifestPath, "utf8"),
      ) as Record<string, unknown>;
      const rootCandidateScripts = rootCandidateManifest.scripts as Record<
        string,
        string
      >;
      rootCandidateScripts.prepack = `node -e "require('node:fs').appendFileSync('.build-witness', 'build\\n')" && ${rootCandidateScripts.prepack}`;
      await writeJson(publicManifestPath, rootCandidateManifest);
      const rootCheck = await execa("pnpm", ["run", "check"], {
        cwd: repositoryRoot,
        reject: false,
      });
      expect(
        rootCheck.exitCode,
        `${rootCheck.stdout}\n${rootCheck.stderr}`,
      ).toBe(0);
      await expect(
        stat(path.join(repositoryRoot, "packages/lib/dist/index.js")),
      ).resolves.toMatchObject({ mode: expect.any(Number) });
      await expect(
        readFile(
          path.join(repositoryRoot, "packages/cli/.build-witness"),
          "utf8",
        ),
      ).resolves.toBe("build\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});
