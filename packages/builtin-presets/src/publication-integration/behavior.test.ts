import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
      const rootCheck = await execa("pnpm", ["run", "check"], {
        cwd: repositoryRoot,
        reject: false,
      });
      expect(rootCheck.exitCode).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});
