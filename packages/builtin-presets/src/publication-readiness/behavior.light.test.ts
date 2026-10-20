import assert from "node:assert/strict";
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
import { afterEach, describe, it } from "node:test";

import { referencePackage } from "@ykdz/reference-ts-cli/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, templatePresets } from "@ykdz/template-content";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { execa } from "execa";

const workspaces: string[] = [];
const metadataSnapshots = new Map<
  string,
  { readonly blueprint: string; readonly generation: string }
>();

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function generatedRepository(
  options: {
    readonly manifest?: Readonly<Record<string, unknown>>;
    readonly rootNode?: string;
  } = {},
): Promise<string> {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "template-publication-readiness-"),
  );
  workspaces.push(repositoryRoot);
  const cliPreset = templatePresets.find(
    (preset) => preset.owner?.packageName === "@ykdz/preset-ts-cli",
  );
  assert.ok(cliPreset);
  const result = await createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  }).init({
    targetRoot: repositoryRoot,
    selection: { roots: [{ preset: cliPreset }] },
    strategyInput: {
      repositoryName: "demo-cli",
      defaultPackageScope: "demo",
    },
  });
  assert.strictEqual(result.status, "success");
  metadataSnapshots.set(repositoryRoot, {
    blueprint: await readFile(
      path.join(repositoryRoot, ".template/blueprint.json"),
      "utf8",
    ),
    generation: await readFile(
      path.join(repositoryRoot, ".template/generation.json"),
      "utf8",
    ),
  });
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(repositoryRoot, "node_modules"),
    "dir",
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const rootEngines =
    typeof rootManifest.engines === "object" && rootManifest.engines !== null
      ? (rootManifest.engines as Record<string, unknown>)
      : {};
  await writeJson(path.join(repositoryRoot, "package.json"), {
    ...rootManifest,
    engines: { ...rootEngines, node: options.rootNode ?? "26" },
  });
  if (options.manifest !== undefined) {
    const manifestPath = path.join(repositoryRoot, "packages/cli/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeJson(manifestPath, { ...manifest, ...options.manifest });
  }
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
    dependencies: {
      "@ykdz/cli-contract": "catalog:",
      "@valibot/to-json-schema": "catalog:",
      valibot: "catalog:",
    },
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
  await writeBlueprintPackageName(repositoryRoot, packageName);
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
    "# CLI\n\nInstall the package and run `cli lookup ada`.\n",
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

async function writeLocalTemplateMetadata(
  repositoryRoot: string,
  packageName: string,
): Promise<void> {
  const snapshot = metadataSnapshots.get(repositoryRoot);
  assert.ok(snapshot);
  await mkdir(path.join(repositoryRoot, ".template"), { recursive: true });
  await writeFile(
    path.join(repositoryRoot, ".template/blueprint.json"),
    snapshot.blueprint,
  );
  await writeFile(
    path.join(repositoryRoot, ".template/generation.json"),
    snapshot.generation,
  );
  await writeBlueprintPackageName(repositoryRoot, packageName);
}

async function writeBlueprintPackageName(
  repositoryRoot: string,
  packageName: string,
): Promise<void> {
  const blueprintPath = path.join(repositoryRoot, ".template/blueprint.json");
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
    readonly packages: readonly Record<string, unknown>[];
  } & Record<string, unknown>;
  await writeJson(blueprintPath, {
    ...blueprint,
    packages: blueprint.packages.map((item) =>
      item.path === "packages/cli" ? { ...item, name: packageName } : item,
    ),
  });
}

async function runReadinessCaller(
  repositoryRoot: string,
  args: readonly string[] = [],
) {
  const moduleRoot = path.join(repositoryRoot, "scripts/npm-publication");
  await mkdir(moduleRoot, { recursive: true });
  await Promise.all([
    ...["readiness", "changelog", "check-readiness", "configuration"].map(
      (name) =>
        cp(
          new URL(
            import.meta.resolve(`@ykdz/template-workspace/publication/${name}`),
          ),
          path.join(moduleRoot, `${name}.ts`),
        ),
    ),
    (() => {
      const source = referencePackage.publicationIdentitySource;
      assert.ok(source);
      return cp(
        resolveTemplateSource(source, "."),
        path.join(moduleRoot, "cli-command-identity.ts"),
      );
    })(),
  ]);
  const callerPath = path.join(
    repositoryRoot,
    "scripts/npm-publication/check-readiness.ts",
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
    env: { ...process.env, pnpm_config_verify_deps_before_run: "warn" },
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

void describe("Generated Repository npm publication readiness", () => {
  void it("reports the initial private versionless candidate as safely unconfigured", async () => {
    const repositoryRoot = await generatedRepository();
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.strictEqual(result.mode, "safe-unconfigured");
    for (const code of [
      "description",
      "version",
      "private",
      "license-id",
      "repository",
      "readme-missing",
      "license-missing",
      "changelog-missing",
    ]) {
      assert.ok(result.blockers.some((blocker) => blocker.code === code));
    }
    assert.deepStrictEqual(
      result.blockers,
      result.blockers.toSorted((left, right) =>
        [left.owner.path, left.owner.pointer ?? "", left.code].join("\u0000") <
        [right.owner.path, right.owner.pointer ?? "", right.code].join("\u0000")
          ? -1
          : 1,
      ),
    );
  });

  for (const packageName of ["@demo/cli", "demo-cli"]) {
    void it(`accepts a ready scoped or unscoped package from owner facts: ${packageName}`, async () => {
      const repositoryRoot = await generatedRepository();
      await writeReadyFacts(repositoryRoot, packageName);
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.deepStrictEqual(result, {
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
    });
  }

  for (const [state, dependencies] of [
    ["removed", {}],
    ["empty", { "@ykdz/cli-contract": "" }],
  ] as const) {
    void it(`blocks a ${state} fixed CLI runtime dependency specifier`, async () => {
      const repositoryRoot = await generatedRepository();
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
        ...readyManifest("@demo/cli"),
        dependencies,
      });
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.strictEqual(result.kind, "blocked");
      if (result.kind !== "blocked") throw new Error("Expected blockers");
      assert.ok(
        result.blockers.some((blocker) => blocker.code === "manifest-contract"),
      );
    });
  }

  for (const { root, nodeRange } of [
    { root: "24", nodeRange: ">=24" },
    { root: "24.16.0", nodeRange: "^24.16.0" },
  ]) {
    void it(`checks the public CLI engine against root engines.node ${root}`, async () => {
      const repositoryRoot = await generatedRepository({ rootNode: root });
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
        ...readyManifest("@demo/cli"),
        engines: { node: nodeRange },
      });
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.strictEqual(result.kind, "ready");
    });
  }

  for (const nodeRange of [">=24", "^24.15.0", ">=26"]) {
    void it(`blocks public CLI engine ${nodeRange} that does not match an exact root version`, async () => {
      const repositoryRoot = await generatedRepository({ rootNode: "24.16.0" });
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
        ...readyManifest("@demo/cli"),
        engines: { node: nodeRange },
      });
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.strictEqual(result.kind, "blocked");
      if (result.kind !== "blocked") throw new Error("Expected blockers");
      assert.deepStrictEqual(
        result.blockers.map(({ code }) => code),
        ["manifest-contract"],
      );
    });
  }

  for (const root of [">=24", "24.16", "v24", "24.16.0-beta.1", ""]) {
    void it(`blocks an unsupported root engines.node declaration ${root} without substituting a baseline`, async () => {
      const repositoryRoot = await generatedRepository({ rootNode: root });
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.strictEqual(result.kind, "blocked");
      if (result.kind !== "blocked") throw new Error("Expected blockers");
      assert.ok(
        result.blockers.some(
          (blocker) =>
            blocker.code === "manifest-contract" &&
            blocker.owner.path === "packages/cli/package.json",
        ),
      );
    });
  }

  void it("shares one inspection across safe baseline, public intent, and require-ready callers", async () => {
    const baselineRoot = await generatedRepository();
    const ordinaryBaseline = await runReadinessCaller(baselineRoot);
    const requiredBaseline = await runReadinessCaller(baselineRoot, [
      "--require-ready",
    ]);
    assert.strictEqual(ordinaryBaseline.exitCode, 0);
    assert.ok(
      ordinaryBaseline.stdout.includes("npm publication readiness: blocked"),
    );
    assert.strictEqual(requiredBaseline.exitCode, 1);
    assert.ok(requiredBaseline.stdout.includes("BLOCKER version"));

    const publicIntentRoot = await generatedRepository({
      manifest: { version: "1.0.0" },
    });
    const publicIntent = await runReadinessCaller(publicIntentRoot);
    assert.strictEqual(publicIntent.exitCode, 1);
    assert.ok(publicIntent.stdout.includes("Mode: public-intent"));

    const readyRoot = await generatedRepository();
    await writeReadyFacts(readyRoot, "@demo/cli");
    const ready = await runReadinessCaller(readyRoot, ["--require-ready"]);
    assert.strictEqual(ready.exitCode, 0);
    assert.ok(ready.stdout.includes("npm publication readiness: ready"));
    assert.ok(ready.stdout.includes("Package: @demo/cli@1.0.0"));
  });

  void it("supports pnpm argument forwarding without accepting ambiguous arguments", async () => {
    const repositoryRoot = await generatedRepository();

    const throughPnpm = await runReadinessThroughPnpm(repositoryRoot, [
      "--require-ready",
    ]);
    assert.strictEqual(throughPnpm.exitCode, 1);
    assert.ok(throughPnpm.stdout.includes("BLOCKER version"), throughPnpm.all);

    for (const args of [
      ["--require-ready", "--require-ready"],
      ["--", "--require-ready"],
      ["--unknown"],
    ]) {
      const rejected = await runReadinessCaller(repositoryRoot, args);
      assert.strictEqual(rejected.exitCode, 2);
      assert.ok(rejected.stderr.includes("ERROR publication-readiness-usage"));
    }
  });

  void it("接受完全缺席的本地模板元数据，并拒绝残缺或矛盾的所有者事实", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "demo-cli");
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    await rm(path.join(repositoryRoot, ".template"), {
      recursive: true,
      force: true,
    });
    const absent = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(absent.kind, "ready");

    await mkdir(path.join(repositoryRoot, ".template"));
    const partial = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(partial.kind, "blocked");
    if (partial.kind !== "blocked") throw new Error("Expected blockers");
    assert.deepStrictEqual(
      partial.blockers.map(({ code }) => code),
      ["local-template-metadata-missing", "local-template-metadata-missing"],
    );

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    const consistent = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(consistent.kind, "ready");

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
    assert.strictEqual(contradictory.kind, "blocked");
    if (contradictory.kind !== "blocked") throw new Error("Expected blockers");
    assert.deepStrictEqual(
      contradictory.blockers.map(({ code }) => code),
      ["local-template-metadata-mismatch"],
    );

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    const generationPath = path.join(
      repositoryRoot,
      ".template/generation.json",
    );
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as {
      strategyState: Record<string, unknown>;
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
    assert.strictEqual(duplicateRecord.kind, "blocked");
    if (duplicateRecord.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    assert.deepStrictEqual(
      duplicateRecord.blockers.map(({ code }) => code),
      ["local-template-metadata-mismatch"],
    );

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    const packageRecord = generation.packages[0]!;
    assert.ok(
      typeof packageRecord.definition === "object" &&
        packageRecord.definition !== null,
    );
    await writeJson(generationPath, {
      ...generation,
      packages: [
        {
          ...packageRecord,
          definition: { ...packageRecord.definition, path: "packages/other" },
        },
      ],
    });
    const pathMismatch = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(pathMismatch.kind, "blocked");
    if (pathMismatch.kind !== "blocked") throw new Error("Expected blockers");
    assert.deepStrictEqual(
      pathMismatch.blockers.map(({ code }) => code),
      ["local-template-metadata-mismatch"],
    );

    await writeLocalTemplateMetadata(repositoryRoot, "demo-cli");
    await rm(blueprintPath);
    await mkdir(blueprintPath);
    const unreadableMetadata = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(unreadableMetadata.kind, "blocked");
    if (unreadableMetadata.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    assert.deepStrictEqual(
      unreadableMetadata.blockers.map(({ code }) => code),
      ["local-template-metadata-invalid"],
    );

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
    assert.strictEqual(nonDirectoryMetadataRoot.kind, "blocked");
    if (nonDirectoryMetadataRoot.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    assert.ok(
      nonDirectoryMetadataRoot.blockers.some(
        (blocker) =>
          blocker.code === "local-template-metadata-invalid" &&
          blocker.owner.path === ".template",
      ),
    );
  });

  void it("要求发布目标与唯一的初始化候选和蓝图身份一致", async () => {
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
      readonly strategyState: Record<string, unknown>;
      readonly packages: readonly Record<string, unknown>[];
    };
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

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
    assert.strictEqual(duplicateTargetId.kind, "blocked");
    if (duplicateTargetId.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    assert.ok(
      duplicateTargetId.blockers.some(
        (blocker) => blocker.code === "local-template-metadata-mismatch",
      ),
    );

    await writeJson(blueprintPath, blueprint);
    for (const changedRecord of [
      { ...generation.packages[0]!, createdBy: "addition" },
      {
        ...generation.packages[0]!,
        creationInput: { variant: "private" },
      },
    ]) {
      await writeJson(generationPath, {
        ...generation,
        packages: [changedRecord, ...generation.packages.slice(1)],
      });
      const rejectedCandidate = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });
      assert.strictEqual(rejectedCandidate.kind, "blocked");
      if (rejectedCandidate.kind !== "blocked") {
        throw new Error("Expected blockers");
      }
      assert.ok(
        rejectedCandidate.blockers.some(
          (blocker) => blocker.code === "local-template-metadata-mismatch",
        ),
      );
    }

    await writeJson(generationPath, {
      ...generation,
      strategyState: {
        ...(generation.strategyState as Record<string, unknown>),
        repositoryName: "different-root",
      },
    });
    const wrongRepository = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(wrongRepository.kind, "blocked");
    if (wrongRepository.kind !== "blocked") {
      throw new Error("Expected blockers");
    }
    assert.ok(
      wrongRepository.blockers.some(
        (blocker) => blocker.code === "local-template-metadata-mismatch",
      ),
    );
  });

  void it("fails closed when actual workspace membership cannot be inspected", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await rm(path.join(repositoryRoot, "pnpm-workspace.yaml"));
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      result.blockers.some(
        (blocker) =>
          blocker.code === "manifest-contract" &&
          blocker.owner.path === "pnpm-workspace.yaml",
      ),
    );
  });

  void it("fails closed when a declared workspace collection cannot be enumerated", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n",
    );
    await writeFile(path.join(repositoryRoot, "apps"), "not a directory\n");
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      result.blockers.some(
        (blocker) =>
          blocker.code === "manifest-contract" && blocker.owner.path === "apps",
      ),
    );
  });

  void it("checks built-in license owner facts without duplicating canonical license text", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    const reviewedOwnerFact = "Copyright (c) 2026 Ada Lovelace\n";
    await writeFile(path.join(repositoryRoot, "LICENSE"), reviewedOwnerFact);
    await writeFile(
      path.join(repositoryRoot, "packages/cli/LICENSE"),
      reviewedOwnerFact,
    );
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const ownerReady = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(ownerReady.kind, "ready");

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
    assert.strictEqual(blocked.kind, "blocked");
    if (blocked.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      blocked.blockers.map(({ code }) => code).includes("license-content"),
    );
  });

  void it("accepts documentation that teaches legitimate HTML and Mustache syntax", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "packages/cli/README.md"),
      "# CLI\n\nPress <kbd>Enter</kbd> to render `Hello {{name}}`.\n",
    );
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "ready");
  });

  for (const { license, source } of [
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
  ]) {
    void it(`accepts reviewed ${license} owner facts`, async () => {
      const repositoryRoot = await generatedRepository();
      await writeReadyFacts(repositoryRoot, "@demo/cli");
      await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
        ...readyManifest("@demo/cli"),
        license,
      });
      await writeFile(path.join(repositoryRoot, "LICENSE"), source);
      await writeFile(
        path.join(repositoryRoot, "packages/cli/LICENSE"),
        source,
      );
      const { inspectNpmPublicationReadiness } =
        await import("@ykdz/template-workspace/publication/readiness");

      const result = await inspectNpmPublicationReadiness({
        repositoryRoot,
        packagePath: "packages/cli",
      });

      assert.strictEqual(result.kind, "ready");
    });
  }

  void it("blocks a public runtime edge from the actual private workspace manifest", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      dependencies: {
        "@ykdz/cli-contract": "catalog:",
        "@valibot/to-json-schema": "catalog:",
        valibot: "catalog:",
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
      await import("@ykdz/template-workspace/publication/readiness");

    const blocked = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(blocked.kind, "blocked");
    if (blocked.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      blocked.blockers.some(
        (blocker) =>
          blocker.code === "private-runtime-dependency" &&
          blocker.owner.path === "packages/cli/package.json" &&
          blocker.owner.pointer === "/dependencies/@demo~1runtime" &&
          blocker.observed ===
            "@demo/runtime resolves to private workspace package packages/runtime",
      ),
    );

    await writeJson(runtimeManifestPath, {
      name: "@demo/runtime",
      version: "1.0.0",
    });
    const publicDependency = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });
    assert.strictEqual(publicDependency.kind, "ready");
  });

  void it("cannot hide a private runtime edge behind a same-name public workspace package", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...readyManifest("@demo/cli"),
      dependencies: {
        "@ykdz/cli-contract": "catalog:",
        "@valibot/to-json-schema": "catalog:",
        valibot: "catalog:",
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
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      result.blockers.some(
        (blocker) =>
          blocker.code === "private-runtime-dependency" &&
          blocker.observed ===
            "@demo/runtime resolves to private workspace package packages/aaa-private",
      ),
    );
  });

  void it("returns stable repair-owner blocker codes for malformed publication facts", async () => {
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
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.deepStrictEqual(
      new Set(result.blockers.map(({ code }) => code)),
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

  void it("blocks a public CLI whose prepack no longer owns the canonical build", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    const manifest = readyManifest("@demo/cli");
    await writeJson(path.join(repositoryRoot, "packages/cli/package.json"), {
      ...manifest,
      scripts: {
        ...(manifest.scripts as Record<string, string>),
        prepack: "true",
      },
    });
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.ok(
      result.blockers.some((blocker) => blocker.code === "manifest-contract"),
    );
  });

  void it("maps release-critical changelog failures into readiness blockers", async () => {
    const repositoryRoot = await generatedRepository();
    await writeReadyFacts(repositoryRoot, "@demo/cli");
    await writeFile(
      path.join(repositoryRoot, "packages/cli/CHANGELOG.md"),
      "# Changelog\n\nNo release sections yet.\n",
    );
    const { inspectNpmPublicationReadiness } =
      await import("@ykdz/template-workspace/publication/readiness");

    const result = await inspectNpmPublicationReadiness({
      repositoryRoot,
      packagePath: "packages/cli",
    });

    assert.strictEqual(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("Expected blockers");
    assert.deepStrictEqual(
      result.blockers.map(({ code }) => code),
      ["changelog-target-release-missing", "changelog-unreleased-missing"],
    );
    assert.strictEqual(
      result.blockers.every(({ owner }) => owner.path.endsWith("CHANGELOG.md")),
      true,
    );
  });
});
