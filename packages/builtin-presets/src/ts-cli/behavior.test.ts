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

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  prepareGeneratedRepositoryInitialization,
  resolveBuiltInTemplateSource,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { renderNewProject } from "#template-core/renderer";

import { tsCliDefinition } from "./definition.ts";

async function renderInstalledGeneratedRepository(prefix: string): Promise<{
  readonly workspace: string;
  readonly targetDir: string;
  readonly packageRoot: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const targetDir = path.join(workspace, "demo-cli");
  const plan = planGeneratedRepositoryInitialization({
    definition: tsCliDefinition,
    context: createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    }),
  });
  await renderNewProject({
    targetRoot: targetDir,
    operations: [...plan.operations],
  });
  await execa("pnpm", ["install"], { cwd: targetDir });
  return {
    workspace,
    targetDir,
    packageRoot: path.join(targetDir, "packages/cli"),
  };
}

describe("ts-cli Preset Definition behavior", () => {
  it("plans the registered unpublished CLI Tool Package boundary", () => {
    expect(tsCliDefinition.initialPrimaryPackage.defaultLeafName).toBe("cli");
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const contribution =
      tsCliDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "cli",
          definition: {
            name: "@demo/cli",
            path: "packages/cli",
            role: "cli-tool",
          },
        },
      });

    expect(resolveBuiltInTemplateSource(tsCliDefinition.source, ".")).toMatch(
      /templates[\\/]ts-cli$/,
    );
    expect(contribution.definition).toEqual({
      name: "@demo/cli",
      path: "packages/cli",
      role: "cli-tool",
    });
    expect(contribution.manifest).toMatchObject({
      name: "@demo/cli",
      private: true,
      files: ["dist"],
      type: "module",
      bin: { cli: "./dist/cli.js" },
      dependencies: { commander: "catalog:" },
      engines: { node: ">=24" },
      scripts: {
        build: "tsc -p tsconfig.build.json --pretty false",
        prepack: "pnpm exec turbo run build --filter=.",
        test: expect.any(String),
        "test:e2e": expect.any(String),
        postbuild: expect.stringContaining("chmodSync('dist/cli.js', 0o755)"),
        typecheck: "tsc -p tsconfig.json --noEmit --pretty false",
      },
    });
    expect(contribution.exposure).toEqual({ exports: {}, imports: {} });
    for (const publicProgrammaticField of [
      "main",
      "types",
      "exports",
      "imports",
      "publishConfig",
      "version",
    ]) {
      expect(contribution.manifest).not.toHaveProperty(publicProgrammaticField);
    }
    expect(contribution.operations).toEqual(
      expect.arrayContaining([
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/cli.ts",
          to: "packages/cli/src/cli.ts",
        },
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/cli-command-identity.ts",
          to: "packages/cli/src/cli-command-identity.ts",
        },
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/main.ts",
          to: "packages/cli/src/main.ts",
        },
      ]),
    );
    expect(contribution.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "replaceAnchors" }),
      ]),
    );

    expect(
      builtInPresetRegistry
        .all()
        .filter((definition) => definition.metadata.name === "ts-cli"),
    ).toHaveLength(1);
    expect(builtInPresetRegistry.require("ts-cli").metadata).toEqual(
      tsCliDefinition.metadata,
    );
  });

  it("adds a CLI Tool Package at default and explicit two-segment paths", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-workspace"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });

    expect(
      tsCliDefinition.defaultPackagePath?.({
        context,
        packageLeafName: "release",
      }),
    ).toBe("packages/release");
    expect(
      tsCliDefinition.planPackageAddition?.({
        context,
        packageLeafName: "release",
        packagePath: "tools/release",
      }).definition,
    ).toEqual({
      name: "@demo/release",
      path: "tools/release",
      role: "cli-tool",
    });
  });

  it("derives the CLI consumer engine from the Generation Context", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "future-cli"),
      defaultPackageScope: "demo",
      toolchain: {
        nodeLtsMajor: "26",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const contribution =
      tsCliDefinition.initialPrimaryPackage.planInitialContribution({
        context,
        resolvedPackageIdentity: {
          leafName: "cli",
          definition: {
            name: "@demo/cli",
            path: "packages/cli",
            role: "cli-tool",
          },
        },
      });

    expect(contribution.manifest.engines).toEqual({ node: ">=26" });
  });

  it("rejects a reserved command identity before initialization writes", () => {
    expect(() =>
      prepareGeneratedRepositoryInitialization({
        definition: tsCliDefinition,
        targetDir: path.join("generated-repository", "demo-cli"),
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
        overrides: { name: "node" },
      }),
    ).toThrow('CLI command name is a reserved system tool; received "node"');
  });

  it("appears in the public CLI Preset Catalog without exporting planner internals", async () => {
    const publicApi = await import("../index.ts");
    expect(publicApi).not.toHaveProperty("tsCliDefinition");
    expect(publicApi.templateSources).toHaveProperty("tsCli");

    const repositoryRoot = path.resolve(process.cwd(), "..", "..");
    const result = await execa(
      "node",
      [
        "--conditions=source",
        path.join(repositoryRoot, "packages/cli/src/cli.ts"),
        "presets",
      ],
      { cwd: repositoryRoot },
    );
    expect(result.stdout).toContain("Built-in presets");
    expect(result.stdout).toMatch(/\bts-cli\b/u);
  });

  it("runs identity and greet unit tests from TypeScript source without a build", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-unit-",
    );

    try {
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await execa(
        "pnpm",
        ["--dir", project.packageRoot, "exec", "vitest", "run", "test/unit"],
        { cwd: project.targetDir },
      );
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("runs Commander integration tests in process without a build", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-integration-",
    );

    try {
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await execa(
        "pnpm",
        [
          "--dir",
          project.packageRoot,
          "exec",
          "vitest",
          "run",
          "test/integration/command.test.ts",
        ],
        { cwd: project.targetDir },
      );
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("discovers and runs the complete greet journey through source", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-source-e2e-",
    );

    try {
      const manifestPath = path.join(project.packageRoot, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...manifest,
            version: "7.8.9",
            bin: { release: "./dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("7.8.9");
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--help"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toContain("Usage: release [options] [command]");
      await expect(
        readFile(
          path.join(project.packageRoot, "test/e2e/run-journeys.ts"),
          "utf8",
        ),
      ).resolves.not.toContain('"greet"');
      const result = await execa(
        "node",
        ["--conditions=source", "test/e2e/run-journeys.ts", "source"],
        { cwd: project.packageRoot },
      );

      expect(result.stdout).toBe("source:greet:passed");
      await expect(
        stat(path.join(project.packageRoot, "dist")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("builds through Turbo and runs both modes from the package e2e script", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-dist-e2e-",
    );

    try {
      const dryRun = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test",
          "test:e2e",
          "--filter=@demo/cli",
          "--dry-run=json",
        ],
        { cwd: project.targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly {
            taskId: string;
            dependencies: readonly string[];
          }[];
        }
      ).tasks;
      expect(
        tasks.find(({ taskId }) => taskId === "@demo/cli#test")?.dependencies,
      ).not.toContain("@demo/cli#build");
      expect(
        tasks.find(({ taskId }) => taskId === "@demo/cli#test:e2e")
          ?.dependencies,
      ).toContain("@demo/cli#build");

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/cli", "--force"],
        { cwd: project.targetDir },
      );
      await expect(
        readFile(path.join(project.packageRoot, "dist/cli.js"), "utf8"),
      ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      const manifestPath = path.join(project.packageRoot, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          {
            ...manifest,
            version: "4.5.6",
            bin: { deliver: "./dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("4.5.6");
      await expect(
        execa("node", ["dist/cli.js", "--help"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toContain("Usage: deliver [options] [command]");

      const result = await execa("pnpm", ["run", "test:e2e"], {
        cwd: project.packageRoot,
      });
      expect(
        result.stdout
          .split("\n")
          .filter((line) => line.endsWith(":greet:passed")),
      ).toEqual(["source:greet:passed", "distribution:greet:passed"]);
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects invalid journey runner arguments before running a journey", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-e2e-argv-",
    );
    const invalidCases = [
      {
        name: "missing mode",
        args: [],
        message: "missing journey mode",
      },
      {
        name: "unknown mode",
        args: ["preview"],
        message: 'unknown journey mode "preview"',
      },
      {
        name: "duplicate mode",
        args: ["source", "source"],
        message: 'duplicate journey mode "source"',
      },
      {
        name: "packed without bin",
        args: ["packed"],
        message: "packed journey mode requires exactly one bin path",
      },
      {
        name: "packed with extra argument",
        args: ["packed", "/tmp/demo-cli", "distribution"],
        message: "packed journey mode accepts exactly one bin path",
      },
      {
        name: "packed combined with source",
        args: ["source", "packed", "/tmp/demo-cli"],
        message: "packed journey mode cannot be combined",
      },
      {
        name: "mode used as packed bin",
        args: ["packed", "source"],
        message: 'packed bin path cannot be journey mode "source"',
      },
    ] as const;

    try {
      for (const invalidCase of invalidCases) {
        const result = await execa(
          "node",
          [
            "--conditions=source",
            "test/e2e/run-journeys.ts",
            ...invalidCase.args,
          ],
          { cwd: project.packageRoot, reject: false },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(invalidCase.message);
        expect(result.stdout).not.toContain(":passed");
      }
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("installs the compiled CLI bin into a workspace consumer without a package version", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-workspace-bin-",
    );

    try {
      const consumerRoot = path.join(project.targetDir, "packages/consumer");
      await mkdir(consumerRoot);
      await writeFile(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@demo/consumer",
            private: true,
            dependencies: { "@demo/cli": "workspace:*" },
          },
          null,
          2,
        )}\n`,
      );
      await execa("pnpm", ["install"], { cwd: project.targetDir });
      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/cli", "--force"],
        { cwd: project.targetDir },
      );

      const binPath = path.join(consumerRoot, "node_modules/.bin/cli");
      await expect(stat(binPath)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      await expect(
        execa(binPath, ["--version"], { cwd: consumerRoot }).then(
          ({ stdout }) => stdout,
        ),
      ).resolves.toBe("unpublished");
      await expect(
        execa(binPath, ["greet", "Ada"], { cwd: consumerRoot }).then(
          ({ stdout }) => stdout,
        ),
      ).resolves.toBe("Hello, Ada");
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses to pack the unpublished CLI without injecting a version", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-unpublished-pack-",
    );

    try {
      await rm(path.join(project.packageRoot, "dist"), {
        recursive: true,
        force: true,
      });
      const sourceManifestPath = path.join(project.packageRoot, "package.json");
      const sourceManifestBytes = await readFile(sourceManifestPath, "utf8");
      const sourceManifest = JSON.parse(sourceManifestBytes) as Record<
        string,
        unknown
      >;
      expect(sourceManifest).toMatchObject({
        private: true,
        bin: { cli: "./dist/cli.js" },
        devDependencies: {
          "@demo/typescript-config": "workspace:*",
        },
      });
      expect(sourceManifest).not.toHaveProperty("version");
      await expect(
        stat(path.join(project.targetDir, ".pnpmfile.mjs")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const packDestination = path.join(project.workspace, "packs");
      await mkdir(packDestination);
      const pack = await execa(
        "pnpm",
        ["pack", "--pack-destination", packDestination],
        { cwd: project.packageRoot, reject: false },
      );
      expect(pack.exitCode).toBe(1);
      expect(pack.stdout).toContain("ERR_PNPM_PACKAGE_VERSION_NOT_FOUND");
      await expect(readFile(sourceManifestPath, "utf8")).resolves.toBe(
        sourceManifestBytes,
      );
      expect(await readdir(packDestination)).toEqual([]);
      await expect(
        readFile(path.join(project.packageRoot, "dist/cli.js"), "utf8"),
      ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);
      expect(
        (await stat(path.join(project.packageRoot, "dist/cli.js"))).mode &
          0o111,
      ).not.toBe(0);
      await expect(
        execa("node", ["dist/cli.js", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("unpublished");
      for (const absentField of [
        "version",
        "main",
        "types",
        "exports",
        "imports",
        "publishConfig",
      ]) {
        expect(sourceManifest).not.toHaveProperty(absentField);
      }
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
