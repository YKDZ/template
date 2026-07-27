import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetRegistry,
  builtInPresetTemplateSourceCheckContexts,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  resolveBuiltInTemplateSource,
} from "@ykdz/template-builtin-presets";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { reconcileAndApplyProjectProjections } from "#template-core/project-projection";
import { renderNewProject } from "#template-core/renderer";

import {
  deriveFixtureMatrix,
  deriveInitializationScenarios,
  deriveVerificationPlans,
} from "../registry-checks.ts";
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
      scope: "demo",
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
    packageRoot: path.join(targetDir, "packages/demo-cli"),
  };
}

describe("ts-cli Preset Definition behavior", () => {
  it("plans the registered publishable CLI Tool Package", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-cli"),
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const contribution = tsCliDefinition.planInitialization(context);

    expect(resolveBuiltInTemplateSource(tsCliDefinition.source, ".")).toMatch(
      /templates[\\/]ts-cli$/,
    );
    expect(contribution.definition).toEqual({
      name: "@demo/demo-cli",
      path: "packages/demo-cli",
      role: "cli-tool",
    });
    expect(contribution.manifest).toMatchObject({
      name: "@demo/demo-cli",
      version: "0.0.0",
      publishConfig: { access: "public" },
      files: ["dist"],
      type: "module",
      bin: { "demo-cli": "./dist/cli.js" },
      exports: {
        ".": {
          source: "./src/main.ts",
          types: "./dist/main.d.ts",
          default: "./dist/main.js",
        },
      },
      imports: {
        "#main": {
          source: "./src/main.ts",
          types: "./src/main.ts",
          default: "./dist/main.js",
        },
      },
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
    expect(contribution.operations).toEqual(
      expect.arrayContaining([
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/cli.ts",
          to: "packages/demo-cli/src/cli.ts",
        },
        {
          kind: "copyFile",
          source: tsCliDefinition.source,
          from: "src/main.ts",
          to: "packages/demo-cli/src/main.ts",
        },
        {
          kind: "replaceAnchors",
          path: "packages/demo-cli/src/main.ts",
          language: "typescript",
          replacements: {
            "cli-command-name": 'const commandName = "demo-cli";',
          },
        },
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
    expect(
      deriveInitializationScenarios().map(
        (scenario) => scenario.base.metadata.name,
      ),
    ).toContain("ts-cli");
    expect(
      deriveFixtureMatrix().flatMap((scenario) => [
        scenario.base.metadata.name,
        scenario.addition?.metadata.name,
      ]),
    ).toContain("ts-cli");
  });

  it("adds a CLI Tool Package at default and explicit two-segment paths", () => {
    const context = createGenerationContext({
      targetDir: path.join("generated-repository", "demo-workspace"),
      scope: "demo",
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

  it("links a CLI Tool consumer to a CLI Tool provider across source and distribution modes", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-cli-project-link-"),
    );
    const targetDir = path.join(workspace, "consumer");
    const context = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context,
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const consumerPath = initialization.blueprint.packages[0]!.path;
      const addition = planGeneratedRepositoryPackageAddition({
        definition: tsCliDefinition,
        context,
        blueprint: initialization.blueprint,
        packageLeafName: "provider",
        linkFrom: [consumerPath],
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...addition.projectProjections,
      });
      await execa("pnpm", ["install"], { cwd: targetDir });

      const consumerRoot = path.join(targetDir, consumerPath);
      await writeFile(
        path.join(consumerRoot, "src/observe-provider.ts"),
        [
          'import { greet } from "@demo/provider";',
          "",
          'console.log(greet("Ada").message);',
          "",
        ].join("\n"),
      );
      const runSource = async (): Promise<string> =>
        await execa(
          "node",
          ["--conditions=source", "src/observe-provider.ts"],
          { cwd: consumerRoot },
        ).then(({ stdout }) => stdout);

      await expect(runSource()).resolves.toBe("Hello, Ada");
      const providerEntry = path.join(
        targetDir,
        "packages/provider/src/main.ts",
      );
      await writeFile(
        providerEntry,
        (await readFile(providerEntry, "utf8")).replace(
          "Hello,",
          "Source changed:",
        ),
      );
      await expect(runSource()).resolves.toBe("Source changed: Ada");

      await expect(
        execa("pnpm", ["--filter", `./${consumerPath}`, "run", "build"], {
          cwd: targetDir,
        }),
      ).rejects.toThrow();
      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--dry-run=json"],
        { cwd: targetDir },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          tasks: readonly {
            taskId: string;
            command: string;
            dependencies: readonly string[];
          }[];
        }
      ).tasks;
      const consumerBuild = tasks.find(
        ({ taskId }) => taskId === "@demo/consumer#build",
      );
      expect(consumerBuild?.dependencies).toContain("@demo/provider#build");
      expect(consumerBuild?.command).toBe(
        "tsc -p tsconfig.build.json --pretty false",
      );
      expect(consumerBuild?.command).not.toMatch(/pnpm|turbo/u);

      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetDir,
      });
      await expect(
        readFile(
          path.join(targetDir, "packages/provider/dist/main.d.ts"),
          "utf8",
        ),
      ).resolves.toContain("declare function greet");
      await rm(path.join(targetDir, "packages/provider/src"), {
        recursive: true,
        force: true,
      });
      await expect(
        execa("node", ["dist/observe-provider.js"], {
          cwd: consumerRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("Source changed: Ada");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("runs a linked CLI bin after its first install and build without reinstalling on POSIX", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-ts-cli-future-bin-"),
    );
    const targetDir = path.join(workspace, "consumer");
    const generationContext = createGenerationContext({
      targetDir,
      scope: "demo",
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
      },
    });
    const initialization = planGeneratedRepositoryInitialization({
      definition: tsCliDefinition,
      context: generationContext,
    });

    try {
      await renderNewProject({
        targetRoot: targetDir,
        operations: [...initialization.operations],
      });
      const consumerPath = initialization.blueprint.packages[0]!.path;
      const addition = planGeneratedRepositoryPackageAddition({
        definition: tsCliDefinition,
        context: generationContext,
        blueprint: initialization.blueprint,
        packageLeafName: "provider",
        linkFrom: [consumerPath],
      });
      await expect(
        reconcileAndApplyProjectProjections({
          targetRoot: targetDir,
          ...addition.projectProjections,
        }),
      ).resolves.toMatchObject({ ok: true });

      const providerRoot = path.join(targetDir, "packages/provider");
      await expect(stat(path.join(providerRoot, "dist"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
      await execa("pnpm", ["install"], { cwd: targetDir });

      const binPath = path.join(
        targetDir,
        consumerPath,
        "node_modules/.bin/provider",
      );
      expect((await lstat(binPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(binPath)).toContain(
        path.join("@demo", "provider", "dist", "cli.js"),
      );
      await expect(stat(path.join(providerRoot, "dist"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/provider", "--force"],
        { cwd: targetDir },
      );
      await expect(
        execa(binPath, ["greet", "Ada"], { cwd: targetDir }).then(
          ({ stdout }) => stdout,
        ),
      ).resolves.toBe("Hello, Ada");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("derives source and boundary plans from the registry", () => {
    expect(
      builtInPresetTemplateSourceCheckContexts().filter(
        (context) => context.definition.metadata.name === "ts-cli",
      ),
    ).toEqual([
      expect.objectContaining({
        contribution: expect.objectContaining({
          definition: expect.objectContaining({ role: "cli-tool" }),
        }),
        plan: expect.objectContaining({ definitionName: "ts-cli" }),
      }),
    ]);
    const verificationPlans = deriveVerificationPlans().filter(
      ({ definition }) => definition.metadata.name === "ts-cli",
    );
    expect(verificationPlans.length).toBeGreaterThan(0);
    expect(
      verificationPlans.every(({ plan }) => plan.definitionName === "ts-cli"),
    ).toBe(true);
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

  it("runs greet business tests from TypeScript source without a build", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-unit-",
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
          "test/unit/greet.test.ts",
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
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: "7.8.9" }, null, 2)}\n`,
      );
      await expect(
        execa("node", ["--conditions=source", "src/cli.ts", "--version"], {
          cwd: project.packageRoot,
        }).then(({ stdout }) => stdout),
      ).resolves.toBe("7.8.9");
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
          "--filter=@demo/demo-cli",
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
        tasks.find(({ taskId }) => taskId === "@demo/demo-cli#test")
          ?.dependencies,
      ).not.toContain("@demo/demo-cli#build");
      expect(
        tasks.find(({ taskId }) => taskId === "@demo/demo-cli#test:e2e")
          ?.dependencies,
      ).toContain("@demo/demo-cli#build");

      await execa(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=@demo/demo-cli", "--force"],
        { cwd: project.targetDir },
      );
      await expect(
        readFile(path.join(project.packageRoot, "dist/main.d.ts"), "utf8"),
      ).resolves.toContain("export declare function greet");
      await expect(
        readFile(path.join(project.packageRoot, "dist/cli.js"), "utf8"),
      ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);

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

  it("packs, installs, and runs every packed journey through the bin shim", async () => {
    const project = await renderInstalledGeneratedRepository(
      "template-ts-cli-packed-e2e-",
    );

    try {
      await rm(path.join(project.packageRoot, "dist"), {
        recursive: true,
        force: true,
      });
      const packDestination = path.join(project.workspace, "packs");
      await mkdir(packDestination);
      await execa("pnpm", ["pack", "--pack-destination", packDestination], {
        cwd: project.packageRoot,
      });
      const archives = (await readdir(packDestination)).filter((file) =>
        file.endsWith(".tgz"),
      );
      expect(archives).toHaveLength(1);
      const archivePath = path.join(packDestination, archives[0]!);
      const packedPaths = (await execa("tar", ["-tf", archivePath])).stdout
        .split("\n")
        .filter(Boolean)
        .toSorted();
      expect(packedPaths).toEqual([
        "package/dist/cli.d.ts",
        "package/dist/cli.js",
        "package/dist/main.d.ts",
        "package/dist/main.js",
        "package/package.json",
      ]);
      expect(
        await execa("tar", ["-xOf", archivePath, "package/package.json"]).then(
          ({ stdout }) => JSON.parse(stdout) as unknown,
        ),
      ).toMatchObject({
        version: "0.0.0",
        publishConfig: { access: "public" },
        files: ["dist"],
        bin: { "demo-cli": "./dist/cli.js" },
        exports: {
          ".": {
            source: "./src/main.ts",
            types: "./dist/main.d.ts",
            default: "./dist/main.js",
          },
        },
      });
      expect(
        await execa("tar", ["-xOf", archivePath, "package/dist/cli.js"]).then(
          ({ stdout }) => stdout,
        ),
      ).toMatch(/^#!\/usr\/bin\/env node/u);
      expect(
        await execa("tar", ["-tvf", archivePath, "package/dist/cli.js"]).then(
          ({ stdout }) => stdout,
        ),
      ).toMatch(/^-rwx/u);

      const consumerRoot = path.join(project.workspace, "consumer");
      await mkdir(consumerRoot);
      await writeFile(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify({ name: "consumer", private: true })}\n`,
      );
      await execa("pnpm", ["install", archivePath], { cwd: consumerRoot });
      const binPath = path.join(consumerRoot, "node_modules/.bin/demo-cli");
      await expect(stat(binPath)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      const packed = await execa(
        "node",
        ["--conditions=source", "test/e2e/run-journeys.ts", "packed", binPath],
        { cwd: project.packageRoot },
      );
      expect(packed.stdout).toBe("packed:greet:passed");
    } finally {
      await rm(project.workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
