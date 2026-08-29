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

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const templateRoot = path.resolve(
  import.meta.dirname,
  "../../templates/ts-cli",
);
const workspaces: string[] = [];

type ReadinessModule =
  typeof import("../../templates/ts-cli/publication/readiness.ts");

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function generatedRepository(
  options: {
    readonly manifest?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<string> {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "template-publication-readiness-"),
  );
  workspaces.push(repositoryRoot);
  await symlink(
    path.resolve(import.meta.dirname, "../../../../node_modules"),
    path.join(repositoryRoot, "node_modules"),
    "dir",
  );
  await writeJson(path.join(repositoryRoot, "package.json"), {
    name: "demo-cli",
    private: true,
    type: "module",
    engines: { node: "26" },
    packageManager: "pnpm@11.11.0",
    scripts: {
      "publication:readiness":
        "node --conditions=source scripts/npm-publication/check-readiness.ts",
    },
  });
  await writeFile(
    path.join(repositoryRoot, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
    name: "@demo/cli",
    private: true,
    files: ["dist"],
    type: "module",
    bin: { cli: "./dist/cli.js" },
    scripts: {
      build: "tsc -p tsconfig.build.json --pretty false",
      prepack: "pnpm exec turbo run build --filter=.",
    },
    dependencies: { commander: "catalog:" },
    engines: { node: ">=26" },
    ...options.manifest,
  });
  return repositoryRoot;
}

function readyManifest(packageName: string): Readonly<Record<string, unknown>> {
  return {
    name: packageName,
    version: "1.0.0",
    description: "A focused command-line tool.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/demo/cli.git",
      directory: "packages/cli",
    },
    homepage: "https://github.com/demo/cli#readme",
    bugs: { url: "https://github.com/demo/cli/issues" },
    files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    type: "module",
    bin: { cli: "./dist/cli.js" },
    scripts: {
      build: "tsc -p tsconfig.build.json --pretty false",
      prepack: "pnpm exec turbo run build --filter=.",
    },
    dependencies: { commander: "catalog:" },
    engines: { node: ">=26" },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    author: "Ada Lovelace",
    keywords: ["cli"],
    funding: "https://github.com/sponsors/demo",
  };
}

async function writeReadyFacts(
  repositoryRoot: string,
  packageName: string,
): Promise<void> {
  await writeJson(
    path.join(repositoryRoot, "packages/cli/package.json"),
    readyManifest(packageName),
  );
  const license = [
    "MIT License",
    "",
    "Copyright (c) 2026 Ada Lovelace",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy.",
    "",
    "The above copyright notice and this permission notice shall be included in all copies.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
    "",
    "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM.",
    "",
  ].join("\n");
  await writeFile(path.join(repositoryRoot, "LICENSE"), license);
  await writeFile(path.join(repositoryRoot, "packages/cli/LICENSE"), license);
  await writeFile(
    path.join(repositoryRoot, "packages/cli/README.md"),
    "# CLI\n\nInstall the package and run `cli greet Ada`.\n",
  );
  await writeFile(
    path.join(repositoryRoot, "packages/cli/CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Added",
      "",
      "- Publish the first stable CLI.",
      "",
      "[Unreleased]: https://github.com/demo/cli/compare/v1.0.0...HEAD",
      "[1.0.0]: https://github.com/demo/cli/releases/tag/v1.0.0",
      "",
    ].join("\n"),
  );
}

const candidatePackageDefinitionId = `package-${"a".repeat(64)}`;

async function writeLocalTemplateMetadata(
  repositoryRoot: string,
  packageName: string,
): Promise<void> {
  await writeJson(path.join(repositoryRoot, ".template/blueprint.json"), {
    schemaVersion: 3,
    packages: [
      {
        packageDefinitionId: candidatePackageDefinitionId,
        name: packageName,
        path: "packages/cli",
        role: "cli-tool",
      },
    ],
  });
  await writeJson(path.join(repositoryRoot, ".template/generation.json"), {
    schemaVersion: 2,
    repositoryName: "demo-cli",
    defaultPackageScope: "original-scope",
    preset: "ts-cli",
    templateVersion: "0.0.0",
    toolchain: {
      nodeLtsMajor: "26",
      packageManagerPin: "pnpm@11.11.0",
    },
    packages: [
      {
        packageDefinitionId: candidatePackageDefinitionId,
        path: "packages/cli",
        definitionName: "ts-cli",
        planningContribution: "planInitialization",
        contributionIdentity: "cli-publication-candidate",
      },
    ],
  });
}

async function loadReadinessModule(
  repositoryRoot: string,
): Promise<ReadinessModule> {
  const moduleRoot = path.join(repositoryRoot, "scripts/npm-publication");
  await mkdir(moduleRoot, { recursive: true });
  await Promise.all([
    cp(
      path.join(templateRoot, "publication/readiness.ts"),
      path.join(moduleRoot, "readiness.ts"),
    ),
    cp(
      path.join(templateRoot, "publication/changelog.ts"),
      path.join(moduleRoot, "changelog.ts"),
    ),
    cp(
      path.join(templateRoot, "src/cli-command-identity.ts"),
      path.join(moduleRoot, "cli-command-identity.ts"),
    ),
  ]);
  return (await import(
    `${pathToFileURL(path.join(moduleRoot, "readiness.ts")).href}?test=${crypto.randomUUID()}`
  )) as ReadinessModule;
}

async function runReadinessCaller(
  repositoryRoot: string,
  args: readonly string[] = [],
) {
  await loadReadinessModule(repositoryRoot);
  const source = await readFile(
    path.join(templateRoot, "publication/check-readiness.ts"),
    "utf8",
  );
  const callerPath = path.join(
    repositoryRoot,
    "scripts/npm-publication/check-readiness.ts",
  );
  await writeFile(
    callerPath,
    source.replaceAll("{{PUBLIC_CLI_PACKAGE_PATH}}", "packages/cli"),
  );
  return await execa("node", [callerPath, ...args], {
    cwd: repositoryRoot,
    reject: false,
    all: true,
  });
}

async function runReadinessThroughPnpm(
  repositoryRoot: string,
  args: readonly string[],
) {
  await runReadinessCaller(repositoryRoot);
  return await execa("pnpm", ["run", "publication:readiness", ...args], {
    cwd: repositoryRoot,
    reject: false,
    all: true,
  });
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("Generated Repository npm publication readiness", () => {
  it("reports the initial private versionless candidate as safely unconfigured", async () => {
    const repositoryRoot = await generatedRepository();
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(result.mode).toBe("safe-unconfigured");
    expect(result.blockers.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "description",
        "version",
        "private",
        "license-id",
        "repository",
        "readme-missing",
        "license-missing",
        "changelog-missing",
      ]),
    );
    expect(result.blockers).toEqual(
      result.blockers.toSorted((left, right) =>
        [left.owner.path, left.owner.pointer ?? "", left.code].join("\u0000") <
        [right.owner.path, right.owner.pointer ?? "", right.code].join("\u0000")
          ? -1
          : 1,
      ),
    );
  });

  it.each(["@demo/cli", "demo-cli"])(
    "accepts a ready scoped or unscoped package from owner facts: %s",
    async (packageName) => {
      const repositoryRoot = await generatedRepository();
      await writeReadyFacts(repositoryRoot, packageName);
      const { inspectNpmPublicationReadiness } =
        await loadReadinessModule(repositoryRoot);

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      expect(result).toEqual({
        kind: "ready",
        target: { packagePath: "packages/cli" },
        blockers: [],
        publication: {
          packagePath: "packages/cli",
          packageName,
          commandName: "cli",
          version: "1.0.0",
          repository: "git+https://github.com/demo/cli.git",
          releaseDate: "2026-08-26",
          releaseNotes: "### Added\n\n- Publish the first stable CLI.\n",
        },
      });
    },
  );

  it.each([
    ["removed", {}],
    ["empty", { commander: "" }],
  ])(
    "blocks a $0 fixed CLI runtime dependency specifier",
    async (_state, dependencies) => {
      const repositoryRoot = await generatedRepository();
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
        ...readyManifest("@demo/cli"),
        dependencies,
      });
      const { inspectNpmPublicationReadiness } =
        await loadReadinessModule(repositoryRoot);

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") throw new Error("Expected blockers");
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "manifest-contract" }),
      );
    },
  );

  it("shares one inspection across safe baseline, public intent, and require-ready callers", async () => {
    const baselineRoot = await generatedRepository();
    const ordinaryBaseline = await runReadinessCaller(baselineRoot);
    const requiredBaseline = await runReadinessCaller(baselineRoot, [
      "--require-ready",
    ]);
    expect(ordinaryBaseline).toMatchObject({ exitCode: 0 });
    expect(ordinaryBaseline.stdout).toContain(
      "npm publication readiness: blocked",
    );
    expect(requiredBaseline).toMatchObject({ exitCode: 1 });
    expect(requiredBaseline.stdout).toContain("BLOCKER version");

    const publicIntentRoot = await generatedRepository({
      manifest: { version: "1.0.0" },
    });
    const publicIntent = await runReadinessCaller(publicIntentRoot);
    expect(publicIntent).toMatchObject({ exitCode: 1 });
    expect(publicIntent.stdout).toContain("Mode: public-intent");

    const readyRoot = await generatedRepository();
    await writeReadyFacts(readyRoot, "@demo/cli");
    const ready = await runReadinessCaller(readyRoot, ["--require-ready"]);
    expect(ready).toMatchObject({ exitCode: 0 });
    expect(ready.stdout).toContain("npm publication readiness: ready");
    expect(ready.stdout).toContain("Package: @demo/cli@1.0.0");
  });

  it("supports pnpm argument forwarding without accepting ambiguous arguments", async () => {
    const repositoryRoot = await generatedRepository();

    const throughPnpm = await runReadinessThroughPnpm(repositoryRoot, [
      "--require-ready",
    ]);
    expect(throughPnpm).toMatchObject({ exitCode: 1 });
    expect(throughPnpm.stdout).toContain("BLOCKER version");

    for (const args of [
      ["--require-ready", "--require-ready"],
      ["--", "--require-ready"],
      ["--unknown"],
    ]) {
      const rejected = await runReadinessCaller(repositoryRoot, args);
      expect(rejected).toMatchObject({ exitCode: 2 });
      expect(rejected.stderr).toContain("ERROR publication-readiness-usage");
    }
  });

  it("accepts entirely absent Local Template Metadata and rejects partial or contradictory owner facts", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "demo-cli");
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    await mkdir(path.join(repositoryRoot, ".template"));
    const partial = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(partial.kind).toBe("blocked");
    if (partial.kind !== "blocked") throw new Error("Expected blockers");
    expect(partial.blockers.map(({ code }) => code)).toEqual([
      "local-template-metadata-missing",
      "local-template-metadata-missing",
    ]);

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    const consistent = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(consistent.kind).toBe("ready");

    const blueprintPath = path.join(repositoryRoot, ".template/blueprint.json");
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      packages: readonly Record<string, unknown>[];
    };
    await writeJson(blueprintPath, {
      ...blueprint,
      packages: [{ ...blueprint.packages[0], name: "@different/identity" }],
    });
    const contradictory = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(contradictory.kind).toBe("blocked");
    if (contradictory.kind !== "blocked") throw new Error("Expected blockers");
    expect(contradictory.blockers.map(({ code }) => code)).toEqual([
      "local-template-metadata-mismatch",
    ]);

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    const generationPath = path.join(
      repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: readonly Record<string, unknown>[];
    };
    await writeJson(generationPath, {
      ...generation,
      packages: [generation.packages[0], generation.packages[0]],
    });
    const duplicateRecord = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(duplicateRecord.kind).toBe("blocked");
    if (duplicateRecord.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    expect(duplicateRecord.blockers.map(({ code }) => code)).toEqual([
      "local-template-metadata-mismatch",
    ]);

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    await writeJson(generationPath, {
      ...generation,
      packages: [{ ...generation.packages[0], path: "packages/other" }],
    });
    const pathMismatch = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(pathMismatch.kind).toBe("blocked");
    if (pathMismatch.kind !== "blocked") throw new Error("Expected blockers");
    expect(pathMismatch.blockers.map(({ code }) => code)).toEqual([
      "local-template-metadata-mismatch",
    ]);

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    await rm(blueprintPath);
    await mkdir(blueprintPath);
    const unreadableMetadata = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(unreadableMetadata.kind).toBe("blocked");
    if (unreadableMetadata.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    expect(unreadableMetadata.blockers.map(({ code }) => code)).toEqual([
      "local-template-metadata-invalid",
    ]);

    await rm(path.join(repositoryRoot, ".template"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      path.join(repositoryRoot, ".template"),
      "not a directory\n",
    );
    const nonDirectoryMetadataRoot = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(nonDirectoryMetadataRoot.kind).toBe("blocked");
    if (nonDirectoryMetadataRoot.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    expect(nonDirectoryMetadataRoot.blockers).toContainEqual(
      expect.objectContaining({
        code: "local-template-metadata-invalid",
        owner: { path: ".template" },
      }),
    );
  });

  it("requires a globally unique metadata target and init candidate provenance", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeLocalTemplateMetadata(repositoryRoot, "@demo/cli");
    const blueprintPath = path.join(repositoryRoot, ".template/blueprint.json");
    const generationPath = path.join(
      repositoryRoot,
      ".template/generation.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      readonly packages: readonly Record<string, unknown>[];
    };
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      readonly packages: readonly Record<string, unknown>[];
    };
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    await writeJson(blueprintPath, {
      ...blueprint,
      packages: [
        ...blueprint.packages,
        {
          ...blueprint.packages[0],
          name: "@demo/other",
          path: "packages/other",
        },
      ],
    });
    const duplicateTargetId = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(duplicateTargetId.kind).toBe("blocked");
    if (duplicateTargetId.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    expect(duplicateTargetId.blockers).toContainEqual(
      expect.objectContaining({ code: "local-template-metadata-mismatch" }),
    );

    await writeJson(blueprintPath, blueprint);
    await writeJson(generationPath, {
      ...generation,
      packages: [
        ...generation.packages,
        {
          ...generation.packages[0],
          packageDefinitionId: `package-${"b".repeat(64)}`,
          path: "packages/other",
          planningContribution: "planPackageAddition",
        },
      ],
    });
    const additionMasquerade = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(additionMasquerade.kind).toBe("blocked");
    if (additionMasquerade.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    expect(additionMasquerade.blockers).toContainEqual(
      expect.objectContaining({ code: "local-template-metadata-mismatch" }),
    );
  });

  it("fails closed when actual workspace membership cannot be inspected", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await rm(path.join(repositoryRoot, "pnpm-workspace.yaml"));
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "manifest-contract",
        owner: { path: "pnpm-workspace.yaml" },
      }),
    );
  });

  it("fails closed when a declared workspace collection cannot be enumerated", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n",
    );
    await writeFile(path.join(repositoryRoot, "apps"), "not a directory\n");
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "manifest-contract",
        owner: { path: "apps" },
      }),
    );
  });

  it("checks built-in license owner facts without duplicating canonical license text", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    const reviewedOwnerFact = "Copyright (c) 2026 Ada Lovelace\n";
    await writeFile(path.join(repositoryRoot, "LICENSE"), reviewedOwnerFact);
    await writeFile(
      path.join(repositoryRoot, "packages/cli/LICENSE"),
      reviewedOwnerFact,
    );
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const ownerReady = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(ownerReady.kind).toBe("ready");

    const placeholderOwner = "Copyright (c) [yyyy] [name of copyright owner]\n";
    await writeFile(path.join(repositoryRoot, "LICENSE"), placeholderOwner);
    await writeFile(
      path.join(repositoryRoot, "packages/cli/LICENSE"),
      placeholderOwner,
    );
    const blocked = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind !== "blocked") throw new Error("Expected blockers");
    expect(blocked.blockers.map(({ code }) => code)).toContain(
      "license-content",
    );
  });

  it("accepts documentation that teaches legitimate HTML and Mustache syntax", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "packages/cli/README.md"),
      "# CLI\n\nPress <kbd>Enter</kbd> to render `Hello {{name}}`.\n",
    );
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("ready");
  });

  it.each([
    {
      license: "Apache-2.0",
      source: [
        "Apache License",
        "Version 2.0, January 2004",
        "http://www.apache.org/licenses/",
        "Copyright 2026 Ada Lovelace",
        "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
        "1. Definitions.",
        "2. Grant of Copyright License.",
        "3. Grant of Patent License.",
        "4. Redistribution.",
        "7. Disclaimer of Warranty.",
        "8. Limitation of Liability.",
        "END OF TERMS AND CONDITIONS",
      ].join("\n\n"),
    },
    {
      license: "BSD-3-Clause",
      source:
        "BSD 3-Clause License\n\nCopyright 2026 Ada Lovelace\n\nRedistribution and use are permitted under the reviewed terms.\n",
    },
  ])("accepts reviewed $license owner facts", async ({ license, source }) => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      license,
    });
    await writeFile(path.join(repositoryRoot, "LICENSE"), source);
    await writeFile(path.join(repositoryRoot, "packages/cli/LICENSE"), source);
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("ready");
  });

  it("blocks a public runtime edge from the actual private workspace manifest", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      dependencies: {
        commander: "catalog:",
        "@demo/runtime": "workspace:*",
      },
    });
    const runtimeManifestPath = path.join(
      repositoryRoot,
      "packages/runtime/package.json",
    );
    await writeJson(runtimeManifestPath, {
      name: "@demo/runtime",
      private: true,
    });
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const blocked = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(blocked.kind).toBe("blocked");
    if (blocked.kind !== "blocked") throw new Error("Expected blockers");
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "private-runtime-dependency",
        owner: {
          path: "packages/cli/package.json",
          pointer: "/dependencies/@demo~1runtime",
        },
        observed:
          "@demo/runtime resolves to private workspace package packages/runtime",
      }),
    );

    await writeJson(runtimeManifestPath, {
      name: "@demo/runtime",
      version: "1.0.0",
    });
    const publicDependency = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    expect(publicDependency.kind).toBe("ready");
  });

  it("cannot hide a private runtime edge behind a same-name public workspace package", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      dependencies: {
        commander: "catalog:",
        "@demo/runtime": "workspace:*",
      },
    });
    await writeJson(
      path.join(repositoryRoot, "packages/aaa-private/package.json"),
      { name: "@demo/runtime", private: true },
    );
    await writeJson(
      path.join(repositoryRoot, "packages/zzz-public/package.json"),
      { name: "@demo/runtime", version: "1.0.0" },
    );
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "private-runtime-dependency",
        observed:
          "@demo/runtime resolves to private workspace package packages/aaa-private",
      }),
    );
  });

  it("returns stable repair-owner blocker codes for malformed publication facts", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      name: "Invalid Name",
      version: "1.0.0-beta.1",
      private: false,
      description: " ",
      license: "Definitely-Not-SPDX",
      repository: "https://example.com/demo/cli",
      homepage: "https://example.com",
      bugs: "https://example.com/issues",
      files: ["dist"],
      bin: {
        cli: "./dist/cli.js",
        other: "./dist/cli.js",
      },
      main: "./dist/cli.js",
    });
    await writeFile(
      path.join(repositoryRoot, "packages/cli/README.md"),
      "TODO: replace this template.",
    );
    await writeFile(
      path.join(repositoryRoot, "packages/cli/LICENSE"),
      "TODO: choose a license.",
    );
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(new Set(result.blockers.map(({ code }) => code))).toEqual(
      new Set([
        "package-name",
        "cli-bin",
        "description",
        "version",
        "private",
        "manifest-contract",
        "license-id",
        "repository",
        "homepage",
        "bugs",
        "readme-content",
        "license-content",
        "license-mismatch",
      ]),
    );
  });

  it("maps release-critical changelog failures into readiness blockers", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "packages/cli/CHANGELOG.md"),
      "# Changelog\n\nNo release sections yet.\n",
    );
    const { inspectNpmPublicationReadiness } =
      await loadReadinessModule(repositoryRoot);

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    expect(result.blockers.map(({ code }) => code)).toEqual([
      "changelog-target-release-missing",
      "changelog-unreleased-missing",
    ]);
    expect(
      result.blockers.every(({ owner }) => owner.path.endsWith("CHANGELOG.md")),
    ).toBe(true);
  });
});
