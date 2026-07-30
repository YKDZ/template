import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import type { PackageRole } from "#template-core/project-blueprint-v2";

const publicCliPackageName = ["@ykdz", "template"].join("/");

async function packTemplateArchive(workspace: string): Promise<string> {
  const archiveDirectory = path.join(workspace, "archives");
  await rm(path.join(process.cwd(), "packages/cli/dist"), {
    recursive: true,
    force: true,
  });
  await execa(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "--filter",
      publicCliPackageName,
      "pack",
      "--pack-destination",
      archiveDirectory,
    ],
    { cwd: process.cwd() },
  );
  await expect(
    readFile(path.join(process.cwd(), "packages/cli/dist/cli.js"), "utf8"),
  ).resolves.toMatch(/^#!\/usr\/bin\/env node/u);
  const archive = (await readdir(archiveDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  expect(archive).toBeDefined();
  return path.join(archiveDirectory, archive!);
}

async function expectPackedProjectionRollback(
  consumer: string,
  workspace: string,
): Promise<void> {
  const targetRoot = path.join(workspace, "packed-projection-rollback");
  const canonicalPath = path.join(targetRoot, ".template/state.json");
  const contentPath = path.join(targetRoot, "content.txt");
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await Promise.all([
    writeFile(contentPath, "before\n"),
    writeFile(canonicalPath, '{\n  "state": "before"\n}\n'),
  ]);

  const packedProjectionModule = path.join(
    consumer,
    "node_modules",
    "@ykdz",
    "template",
    "node_modules",
    "@ykdz",
    "template-core",
    "dist",
    "project-projection.js",
  );
  const projection = (await import(
    pathToFileURL(packedProjectionModule).href
  )) as typeof import("#template-core/project-projection");
  const committedPaths: string[] = [];
  const reconcile = projection.createProjectProjectionReconciler({
    async commitMutation(options) {
      committedPaths.push(options.relativePath);
      if (committedPaths.length === 2) {
        throw new Error("injected packed projection commit failure");
      }
      await options.commit();
    },
  });
  const plan = (state: "before" | "after") => ({
    operations: [
      {
        kind: "writeText" as const,
        to: "content.txt",
        text: `${state}\n`,
      },
      {
        kind: "writeJson" as const,
        to: ".template/state.json",
        value: { state },
      },
    ],
    reconciliation: [
      {
        path: ".template/state.json",
        driver: "canonical" as const,
      },
    ],
  });

  await expect(
    reconcile({
      targetRoot,
      before: plan("before"),
      after: plan("after"),
    }),
  ).rejects.toThrow("injected packed projection commit failure");
  await expect(readFile(contentPath, "utf8")).resolves.toBe("before\n");
  await expect(readFile(canonicalPath, "utf8")).resolves.toBe(
    '{\n  "state": "before"\n}\n',
  );
  expect(committedPaths).toHaveLength(2);
}

function definitionWithPackagePath(packagePath: string) {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "package-path-selection"),
        scope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    }).blueprint.packages.some((pkg) => pkg.path === packagePath),
  );
  if (definition === undefined) {
    throw new Error(
      `Expected a Built-in Preset Definition with package path ${packagePath}`,
    );
  }
  return definition;
}

function firstAddableDefinition() {
  const definition = builtInPresetRegistry
    .all()
    .find((candidate) => candidate.planPackageAddition !== undefined);
  if (definition === undefined) {
    throw new Error("Expected an addable Built-in Preset Definition");
  }
  return definition;
}

function definitionWithInitialPackageRole(role: PackageRole) {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "role-selection"),
        scope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
        },
      }),
    }).blueprint.packages.some((pkg) => pkg.role === role),
  );
  if (definition === undefined) {
    throw new Error(`Expected a Definition for initial Package Role ${role}`);
  }
  return definition;
}

function addableDefinitionWithPackageRole(role: PackageRole) {
  const context = createGenerationContext({
    targetDir: path.join("generated-repository", "addition-role-selection"),
    scope: "demo",
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.11.0",
    },
  });
  const packageLeafName = "role-probe";
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const packagePath = candidate.defaultPackagePath?.({
      context,
      packageLeafName,
    });
    return (
      packagePath !== undefined &&
      candidate.planPackageAddition?.({
        context,
        packageLeafName,
        packagePath,
      }).definition.role === role
    );
  });
  if (definition === undefined) {
    throw new Error(`Expected an addable Definition for Package Role ${role}`);
  }
  return definition;
}

async function generatedTextFiles(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly source: string }[]> {
  const files: { path: string; source: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set([".git", "node_modules", ".turbo"]).has(entry.name)) {
        files.push(...(await generatedTextFiles(root, child)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      files.push({
        path: child,
        source: await readFile(path.join(root, child), "utf8"),
      });
    } catch {
      // Binary generated assets are outside the task-model text contract.
    }
  }
  return files;
}

async function workspaceByteSnapshot(
  root: string,
  relative = "",
): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }[]
> {
  const files: { path: string; mode: number; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", ".turbo"]).has(entry.name)) {
        files.push(...(await workspaceByteSnapshot(root, child)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(root, child);
    files.push({
      path: child.split(path.sep).join("/"),
      mode: (await stat(filePath)).mode & 0o777,
      content: (await readFile(filePath)).toString("base64"),
    });
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function expectNativeTaskModel(projectDir: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as { readonly scripts: Record<string, string> };
  const taskModel = JSON.stringify({
    scripts: manifest.scripts,
    turbo: JSON.parse(
      await readFile(path.join(projectDir, "turbo.json"), "utf8"),
    ),
  });

  expect(Object.keys(manifest.scripts)).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/:(?:run|root)$/u),
      "transit",
    ]),
  );
  for (const command of [
    manifest.scripts.check,
    manifest.scripts.fix,
    manifest.scripts["check:deployment"],
  ]) {
    if (command !== undefined) expect(command).not.toContain("--filter");
  }
  expect(taskModel).not.toMatch(/(?:Check|Fix) (?:Component|Plan)/u);
  expect(taskModel).not.toMatch(/Deployment Check Component/u);
  expect(taskModel).not.toMatch(/deployment[\s-]*(?:task[\s-]*)?owner/iu);

  const fullTree = await generatedTextFiles(projectDir);
  for (const file of fullTree) {
    expect(file.source).not.toMatch(/\b[\p{L}\p{N}_-]+:(?:run|root)\b/iu);
    expect(file.source).not.toMatch(/\btransit\b/iu);
    expect(file.source).not.toMatch(
      /(?:Check|Fix) (?:Component|Plan)|Deployment Check Component/iu,
    );
  }

  const retiredBuild = await execa("pnpm", ["run", "build:run"], {
    cwd: projectDir,
    reject: false,
  });
  expect(retiredBuild.exitCode).not.toBe(0);
}

describe("packed public CLI consumer", () => {
  it("runs the archive alone: import, help, every initialization, and package addition", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-packed-consumer-"),
    );
    try {
      const consumer = path.join(workspace, "consumer");
      const archivePath = await packTemplateArchive(workspace);
      const packedPaths = (await execa("tar", ["-tf", archivePath])).stdout
        .split("\n")
        .filter(Boolean);
      expect(
        packedPaths.every(
          (entry) =>
            entry.startsWith("package/") && !entry.split("/").includes(".."),
        ),
      ).toBe(true);
      expect(packedPaths).toEqual(
        expect.arrayContaining([
          "package/dist/application.d.ts",
          "package/dist/application.js",
          "package/dist/cli.d.ts",
          "package/dist/cli.js",
          "package/dist/main.d.ts",
          "package/dist/main.js",
          "package/node_modules/commander/package.json",
          "package/node_modules/@ykdz/template-core/package.json",
          "package/node_modules/@ykdz/template-builtin-presets/package.json",
          "package/node_modules/@ykdz/template-builtin-presets/templates/foundation/turbo.json",
          "package/node_modules/@ykdz/template-builtin-presets/dist/src/ts-cli/definition.js",
          "package/node_modules/@ykdz/template-builtin-presets/templates/ts-cli/src/cli.ts",
          "package/node_modules/typescript/package.json",
        ]),
      );
      expect(
        packedPaths.some((entry) => entry.startsWith("package/src/")),
      ).toBe(false);
      expect(
        packedPaths.some(
          (entry) =>
            entry.includes("behavior.test") ||
            entry.startsWith("package/test/") ||
            entry.includes("/.template/") ||
            entry.includes("template-checks"),
        ),
      ).toBe(false);
      const packedManifest = await execa("tar", [
        "-xOf",
        archivePath,
        "package/package.json",
      ]).then(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>);
      const packedCoreManifest = await execa("tar", [
        "-xOf",
        archivePath,
        "package/node_modules/@ykdz/template-core/package.json",
      ]).then(
        ({ stdout }) =>
          JSON.parse(stdout) as {
            readonly dependencies?: Readonly<Record<string, unknown>>;
            readonly peerDependencies?: Readonly<Record<string, unknown>>;
          },
      );
      const sourceManifest = JSON.parse(
        await readFile(
          path.join(process.cwd(), "packages/cli/package.json"),
          "utf8",
        ),
      ) as {
        readonly version: string;
        readonly scripts: Readonly<Record<string, string>>;
      };
      expect(sourceManifest.scripts.prepack).toBe(
        "pnpm exec turbo run build --filter=.",
      );
      expect(packedManifest).toMatchObject({
        version: sourceManifest.version,
        bin: { template: "dist/cli.js" },
        exports: {
          ".": {
            source: "./src/main.ts",
            types: "./dist/main.d.ts",
            default: "./dist/main.js",
          },
        },
        dependencies: { commander: expect.any(String) },
        bundleDependencies: expect.arrayContaining([
          "@ykdz/template-core",
          "@ykdz/template-builtin-presets",
          "commander",
          "typescript",
        ]),
      });
      expect(packedManifest.dependencies).toHaveProperty("typescript");
      expect(packedCoreManifest.dependencies).not.toHaveProperty("typescript");
      expect(packedCoreManifest.peerDependencies).toHaveProperty("typescript");
      await mkdir(consumer, { recursive: true });
      await execa("npm", ["init", "--yes"], { cwd: consumer });
      await execa("pnpm", ["add", archivePath], { cwd: consumer });
      const bundledCoreRenderer = path.join(
        consumer,
        "node_modules",
        "@ykdz",
        "template",
        "node_modules",
        "@ykdz",
        "template-core",
        "dist",
        "renderer.js",
      );
      const compiler = createRequire(pathToFileURL(bundledCoreRenderer))(
        "typescript",
      ) as { readonly version: string };
      expect(compiler.version).toMatch(/^6\./u);
      await expectPackedProjectionRollback(consumer, workspace);

      const installedBin = path.join(
        consumer,
        "node_modules",
        ".bin",
        "template",
      );
      const packedJourneys = await execa(
        "node",
        [
          "--conditions=source",
          path.join(process.cwd(), "packages/cli/test/e2e/run-journeys.ts"),
          "packed",
          installedBin,
        ],
        { cwd: process.cwd() },
      );
      const journeyCount = (
        await readdir(
          path.join(process.cwd(), "packages/cli/test/e2e/journeys"),
        )
      ).filter((entry) => entry.endsWith(".journey.ts")).length;
      expect(
        packedJourneys.stdout
          .split("\n")
          .filter((line) => line.endsWith(":passed")),
      ).toHaveLength(journeyCount);
      const bundledDefinitions = path.join(
        consumer,
        "node_modules",
        "@ykdz",
        "template",
        "node_modules",
        "@ykdz",
        "template-builtin-presets",
        "dist/src/index.js",
      );
      await expect(
        execa(
          "node",
          [
            "--input-type=module",
            "-e",
            "await import(process.argv[1])",
            bundledDefinitions,
          ],
          {
            cwd: consumer,
          },
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(
        execa(
          "node",
          [
            "--input-type=module",
            "-e",
            [
              `const api = await import(${JSON.stringify(publicCliPackageName)});`,
              'if (typeof api.runCli !== "function" || typeof api.createCliCommand !== "function") process.exit(1);',
            ].join(""),
          ],
          { cwd: consumer },
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const help = await execa(installedBin, ["--help"], { cwd: consumer });
      expect(help.stdout).toContain("template init <dir>");
      const addHelp = await execa(installedBin, ["add", "package", "--help"], {
        cwd: consumer,
      });
      expect(addHelp.stdout).toContain("template add package");
      expect(addHelp.stdout).toContain("--link-from <path>");
      expect(addHelp.stdout).not.toContain("template init <dir>");
      const presets = await execa(installedBin, ["presets"], {
        cwd: consumer,
      });
      const definitions = presets.stdout.split("\n").flatMap((line) => {
        const match = /^\s{2}([^:\s]+):/u.exec(line);
        return match === null ? [] : [{ name: match[1]! }];
      });
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        await execa(
          installedBin,
          [
            "init",
            path.join(consumer, "generated", definition.name),
            "--preset",
            definition.name,
            "--yes",
          ],
          {
            cwd: consumer,
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
          },
        );
        await expectNativeTaskModel(
          path.join(consumer, "generated", definition.name),
        );
      }
      const expectedAddableDefinitions = builtInPresetRegistry
        .all()
        .filter((definition) => definition.planPackageAddition !== undefined)
        .map((definition) => definition.metadata.name)
        .toSorted();
      const completedAdditions: string[] = [];
      for (const candidate of definitions) {
        const result = await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            candidate.name,
            "--name",
            "archive-addition",
            "--path",
            "packages/archive-addition",
          ],
          {
            cwd: path.join(consumer, "generated", candidate.name),
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
            reject: false,
          },
        );
        if (result.exitCode === 0) {
          completedAdditions.push(candidate.name);
          await expectNativeTaskModel(
            path.join(consumer, "generated", candidate.name),
          );
        }
      }
      expect(completedAdditions.toSorted()).toEqual(expectedAddableDefinitions);

      const rustDefinition = addableDefinitionWithPackageRole("native-package");
      const nonRustBase = builtInPresetRegistry.all().find((definition) => {
        const context = createGenerationContext({
          targetDir: path.join(consumer, "generated", definition.metadata.name),
          toolchain: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
        });
        const contributions = definition.planInitializationContributions?.(
          context,
        ) ?? [definition.planInitialization(context)];
        return contributions.every(
          (contribution) =>
            contribution.foundation.toolchains.rust === undefined,
        );
      });
      expect(nonRustBase).toBeDefined();
      const rustAdditionTarget = path.join(
        consumer,
        "generated",
        nonRustBase!.metadata.name,
      );
      const rustDockerfilePath = path.join(
        rustAdditionTarget,
        ".devcontainer/Dockerfile",
      );
      const rustDevcontainerPath = path.join(
        rustAdditionTarget,
        ".devcontainer/devcontainer.json",
      );
      const rustToolchainPath = path.join(
        rustAdditionTarget,
        "rust-toolchain.toml",
      );
      const dependabotPath = path.join(
        rustAdditionTarget,
        ".github/dependabot.yml",
      );
      const dockerfileBeforeRust = await readFile(rustDockerfilePath, "utf8");
      const devcontainerBeforeRust = JSON.parse(
        await readFile(rustDevcontainerPath, "utf8"),
      ) as {
        readonly build: { readonly args: Readonly<Record<string, string>> };
        readonly mounts: readonly { readonly target: string }[];
      };
      const dependabotBeforeRust = await readFile(dependabotPath, "utf8");
      expect(dockerfileBeforeRust).not.toContain("ARG RUST_TOOLCHAIN");
      expect(devcontainerBeforeRust.build.args).not.toHaveProperty(
        "RUST_TOOLCHAIN",
      );
      expect(devcontainerBeforeRust.mounts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: "/usr/local/cargo/registry" }),
        ]),
      );
      await expect(stat(rustToolchainPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(dependabotBeforeRust).not.toContain("package-ecosystem: cargo");

      const beforeRustPreview = await workspaceByteSnapshot(rustAdditionTarget);
      const rustPreviewResult = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          rustDefinition.metadata.name,
          "--name",
          "worker",
          "--dry-run",
          "--json",
        ],
        {
          cwd: rustAdditionTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
        },
      );
      const rustPreview = JSON.parse(rustPreviewResult.stdout) as {
        readonly status: string;
        readonly dryRun: boolean;
        readonly actions: readonly {
          readonly path: string;
          readonly action: string;
        }[];
        readonly conflicts?: readonly unknown[];
      };
      expect(rustPreview.status).toBe("success");
      expect(rustPreview.dryRun).toBe(true);
      expect(rustPreview.conflicts ?? []).toEqual([]);
      expect(rustPreview.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ".devcontainer/Dockerfile",
            action: "update",
          }),
          expect.objectContaining({
            path: ".devcontainer/devcontainer.json",
            action: "update",
          }),
          expect.objectContaining({
            path: "rust-toolchain.toml",
            action: "create",
          }),
          expect.objectContaining({
            path: ".github/dependabot.yml",
            action: "update",
          }),
          expect.objectContaining({
            path: "packages/worker/package.json",
            action: "create",
          }),
          expect.objectContaining({
            path: "packages/worker/Cargo.toml",
            action: "create",
          }),
        ]),
      );
      expect(await workspaceByteSnapshot(rustAdditionTarget)).toEqual(
        beforeRustPreview,
      );

      await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          rustDefinition.metadata.name,
          "--name",
          "worker",
        ],
        {
          cwd: rustAdditionTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
        },
      );
      await expect(
        readFile(
          path.join(rustAdditionTarget, "packages/worker/package.json"),
          "utf8",
        ).then(
          (source) =>
            JSON.parse(source) as {
              readonly name: string;
              readonly scripts: Readonly<Record<string, string>>;
            },
        ),
      ).resolves.toMatchObject({
        name: `@${nonRustBase!.metadata.name}/worker`,
        scripts: {
          "format:check": "cargo fmt --all -- --check",
          lint: "cargo clippy --workspace --all-targets -- -D warnings",
          test: "cargo test --workspace",
        },
      });
      await expect(
        readFile(
          path.join(rustAdditionTarget, "packages/worker/Cargo.toml"),
          "utf8",
        ),
      ).resolves.toContain('name = "worker"');
      const dockerfileAfterRust = await readFile(rustDockerfilePath, "utf8");
      expect(dockerfileAfterRust).toContain("ARG RUST_TOOLCHAIN");
      expect(dockerfileAfterRust).toContain(
        '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
      );
      const devcontainerAfterRust = JSON.parse(
        await readFile(rustDevcontainerPath, "utf8"),
      ) as {
        readonly build: { readonly args: Readonly<Record<string, string>> };
        readonly mounts: readonly {
          readonly type: string;
          readonly source: string;
          readonly target: string;
        }[];
      };
      expect(devcontainerAfterRust.build.args).toMatchObject({
        RUST_TOOLCHAIN: "stable",
      });
      expect(devcontainerAfterRust.mounts).toEqual(
        expect.arrayContaining([
          {
            type: "volume",
            source: "${devcontainerId}-pnpm-store",
            target: "/pnpm/store",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-git",
            target: "/usr/local/cargo/git",
          },
          {
            type: "volume",
            source: "${devcontainerId}-cargo-registry",
            target: "/usr/local/cargo/registry",
          },
        ]),
      );
      expect(devcontainerAfterRust.mounts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: expect.stringContaining("${containerWorkspaceFolder}"),
          }),
        ]),
      );
      await expect(readFile(rustToolchainPath, "utf8")).resolves.toBe(
        '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt", "clippy"]\n',
      );
      const dependabotAfterRust = parseYaml(
        await readFile(dependabotPath, "utf8"),
      ) as {
        readonly updates: readonly {
          readonly "package-ecosystem": string;
          readonly directory: string;
        }[];
      };
      expect(
        dependabotAfterRust.updates
          .filter((update) => update["package-ecosystem"] === "cargo")
          .map((update) => update.directory),
      ).toEqual(["/packages/worker"]);
      await expect(
        readFile(
          path.join(rustAdditionTarget, "packages/worker/turbo.json"),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toEqual({
        extends: ["//"],
        tags: ["native"],
      });
      const rootManifestAfterRust = JSON.parse(
        await readFile(path.join(rustAdditionTarget, "package.json"), "utf8"),
      ) as { readonly scripts: Readonly<Record<string, string>> };
      expect(rootManifestAfterRust.scripts.check).toContain(
        "turbo run boundaries format:check lint typecheck build test test:e2e",
      );

      await execa("pnpm", ["install"], { cwd: rustAdditionTarget });
      await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });

      const cliAdditionDefinition =
        addableDefinitionWithPackageRole("cli-tool");
      const cliTarget = path.join(
        consumer,
        "generated",
        cliAdditionDefinition.metadata.name,
      );
      const explicitCliManifest = JSON.parse(
        await readFile(
          path.join(cliTarget, "packages/archive-addition/package.json"),
          "utf8",
        ),
      ) as { readonly bin?: Readonly<Record<string, string>> };
      expect(explicitCliManifest.bin).toEqual({
        "archive-addition": "./dist/cli.js",
      });
      const cliBlueprint = JSON.parse(
        await readFile(
          path.join(cliTarget, ".template/blueprint.json"),
          "utf8",
        ),
      ) as {
        readonly packages: readonly {
          readonly path: string;
          readonly role: PackageRole;
        }[];
      };
      const cliConsumerPath = cliBlueprint.packages.find(
        (pkg) =>
          pkg.role === "cli-tool" && pkg.path !== "packages/archive-addition",
      )?.path;
      expect(cliConsumerPath).toBeDefined();
      const addLinkedCli = async (): Promise<void> => {
        await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            cliAdditionDefinition.metadata.name,
            "--name",
            "default-command",
            "--link-from",
            cliConsumerPath!,
          ],
          {
            cwd: cliTarget,
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
          },
        );
      };
      await addLinkedCli();
      const linkedProviderManifest = JSON.parse(
        await readFile(
          path.join(cliTarget, "packages/default-command/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly bin: Readonly<Record<string, string>>;
      };
      expect(linkedProviderManifest.bin).toEqual({
        "default-command": "./dist/cli.js",
      });
      await expect(
        readFile(
          path.join(cliTarget, cliConsumerPath!, "package.json"),
          "utf8",
        ).then(
          (source) =>
            (
              JSON.parse(source) as {
                dependencies: Readonly<Record<string, string>>;
              }
            ).dependencies[linkedProviderManifest.name],
        ),
      ).resolves.toBe("workspace:*");
      const linkedCliSnapshot = await workspaceByteSnapshot(cliTarget);
      await addLinkedCli();
      expect(await workspaceByteSnapshot(cliTarget)).toEqual(linkedCliSnapshot);

      const previewBaseDefinition =
        definitionWithInitialPackageRole("shared-library");
      const previewAdditionDefinition =
        addableDefinitionWithPackageRole("runtime-service");
      const previewTarget = path.join(
        consumer,
        "generated",
        previewBaseDefinition.metadata.name,
      );
      const reservedBefore = await workspaceByteSnapshot(previewTarget);
      const reservedPackagePath = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          previewAdditionDefinition.metadata.name,
          "--name",
          "evil",
          "--path",
          "dist/evil",
          "--dry-run",
          "--json",
        ],
        {
          cwd: previewTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
          reject: false,
        },
      );
      expect(reservedPackagePath.exitCode).not.toBe(0);
      expect(
        `${reservedPackagePath.stdout}\n${reservedPackagePath.stderr}`,
      ).toContain(
        "Package Path dist/evil uses reserved workspace collection dist",
      );
      expect(await workspaceByteSnapshot(previewTarget)).toEqual(
        reservedBefore,
      );

      await mkdir(path.join(previewTarget, "services/existing"), {
        recursive: true,
      });
      await writeFile(
        path.join(previewTarget, "services/existing/OWNER"),
        "user\n",
      );
      const existingBefore = await workspaceByteSnapshot(previewTarget);
      const existingPackagePath = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          previewAdditionDefinition.metadata.name,
          "--name",
          "existing",
          "--path",
          "services/existing",
          "--json",
        ],
        {
          cwd: previewTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
          reject: false,
        },
      );
      expect(existingPackagePath.exitCode).not.toBe(0);
      expect(JSON.parse(existingPackagePath.stdout)).toMatchObject({
        status: "conflict",
        actions: [],
        conflicts: [
          {
            path: "services/existing",
            driver: "precondition",
            reason: expect.stringContaining(
              "Package Path services/existing already exists",
            ),
          },
        ],
      });
      expect(await workspaceByteSnapshot(previewTarget)).toEqual(
        existingBefore,
      );

      const previewBefore = await workspaceByteSnapshot(previewTarget);
      const preview = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          previewAdditionDefinition.metadata.name,
          "--name",
          "dashboard",
          "--path",
          "services/dashboard",
          "--dry-run",
          "--json",
        ],
        {
          cwd: previewTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
        },
      );
      expect(JSON.parse(preview.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "add package",
        status: "success",
        dryRun: true,
        actions: expect.arrayContaining([
          {
            path: "services/dashboard/package.json",
            driver: "structured",
            action: "create",
          },
        ]),
      });
      expect(await workspaceByteSnapshot(previewTarget)).toEqual(previewBefore);

      const turboPath = path.join(previewTarget, "turbo.json");
      const originalTurbo = await readFile(turboPath, "utf8");
      const turbo = JSON.parse(originalTurbo) as {
        boundaries: { tags: Record<string, unknown> };
      };
      turbo.boundaries.tags.app = { dependencies: { allow: ["app"] } };
      await writeFile(turboPath, `${JSON.stringify(turbo, null, 2)}\n`);
      const structuredBefore = await workspaceByteSnapshot(previewTarget);
      const structuredConflict = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          previewAdditionDefinition.metadata.name,
          "--name",
          "dashboard",
          "--path",
          "services/dashboard",
          "--json",
        ],
        {
          cwd: previewTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
          reject: false,
        },
      );
      expect(structuredConflict.exitCode).not.toBe(0);
      expect(JSON.parse(structuredConflict.stdout)).toMatchObject({
        status: "conflict",
        actions: [],
        conflicts: [
          {
            path: "turbo.json",
            driver: "structured",
            location: "/boundaries/tags/app/dependencies/allow",
            context: {
              before: expect.any(String),
              current: expect.any(String),
              after: expect.any(String),
            },
          },
        ],
      });
      expect(await workspaceByteSnapshot(previewTarget)).toEqual(
        structuredBefore,
      );

      await writeFile(turboPath, originalTurbo);
      const dockerfilePath = path.join(
        previewTarget,
        ".devcontainer/Dockerfile",
      );
      const dockerfile = await readFile(dockerfilePath, "utf8");
      expect(dockerfile).toContain("ARG RUST_TOOLCHAIN");
      await writeFile(
        dockerfilePath,
        dockerfile.replace(
          "ARG RUST_TOOLCHAIN",
          "# incompatible insertion\nARG RUST_TOOLCHAIN",
        ),
      );
      const textBefore = await workspaceByteSnapshot(previewTarget);
      const textConflict = await execa(
        installedBin,
        [
          "add",
          "package",
          "--preset",
          previewAdditionDefinition.metadata.name,
          "--name",
          "dashboard",
          "--path",
          "services/dashboard",
        ],
        {
          cwd: previewTarget,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
          reject: false,
        },
      );
      expect(textConflict.exitCode).not.toBe(0);
      expect(textConflict.stderr).toContain(".devcontainer/Dockerfile (text)");
      expect(textConflict.stderr).toContain("Region:");
      expect(textConflict.stderr).toContain("Current:");
      expect(await workspaceByteSnapshot(previewTarget)).toEqual(textBefore);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it("adds a package with the packed CLI after the generated repository is installed", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-packed-ready-add-"),
    );
    try {
      const consumer = path.join(workspace, "consumer");
      const generated = path.join(workspace, "digital");
      const archivePath = await packTemplateArchive(workspace);
      const baseDefinition = definitionWithPackagePath("packages/db");
      const additionDefinition = firstAddableDefinition();
      await mkdir(consumer, { recursive: true });
      await execa("npm", ["init", "--yes"], { cwd: consumer });
      await execa("pnpm", ["add", archivePath], { cwd: consumer });

      const installedBin = path.join(
        consumer,
        "node_modules",
        ".bin",
        "template",
      );
      await execa(
        installedBin,
        [
          "init",
          generated,
          "--preset",
          baseDefinition.metadata.name,
          "--scope",
          "demo",
          "--yes",
        ],
        {
          cwd: consumer,
          env: {
            ...process.env,
            TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
          },
        },
      );
      const gitignorePath = path.join(generated, ".gitignore");
      const workspaceManifestPath = path.join(generated, "pnpm-workspace.yaml");
      await Promise.all([
        writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" }),
        writeFile(workspaceManifestPath, "# private workspace policy\n", {
          flag: "a",
        }),
      ]);
      await execa("pnpm", ["install"], { cwd: generated });
      expect(
        (
          await lstat(
            path.join(generated, "packages/db/node_modules/drizzle-orm"),
          )
        ).isSymbolicLink(),
      ).toBe(true);

      const addPackage = async (packageName: string): Promise<void> => {
        await execa(
          installedBin,
          [
            "add",
            "package",
            "--preset",
            additionDefinition.metadata.name,
            "--name",
            packageName,
            "--path",
            `services/${packageName}`,
          ],
          {
            cwd: generated,
            env: {
              ...process.env,
              TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
            },
          },
        );
      };

      await addPackage("domain");
      const firstAdditionManifest = await readFile(
        path.join(generated, "services/domain/package.json"),
        "utf8",
      );
      const firstRootManifest = await readFile(
        path.join(generated, "package.json"),
        "utf8",
      );
      const firstWorkspaceManifest = await readFile(
        workspaceManifestPath,
        "utf8",
      );
      expect(firstWorkspaceManifest).toContain("# private workspace policy");
      await expect(readFile(gitignorePath, "utf8")).resolves.toContain(
        "private-artifacts/",
      );
      const workspaceBeforeRepeat = (
        await generatedTextFiles(generated)
      ).toSorted((left, right) => left.path.localeCompare(right.path));
      expect(
        workspaceBeforeRepeat.some(
          (file) => file.path === ".template/blueprint.json",
        ),
      ).toBe(true);

      await addPackage("domain");
      expect(
        (await generatedTextFiles(generated)).toSorted((left, right) =>
          left.path.localeCompare(right.path),
        ),
      ).toEqual(workspaceBeforeRepeat);
      await expect(
        readFile(path.join(generated, "services/domain/package.json"), "utf8"),
      ).resolves.toBe(firstAdditionManifest);

      await addPackage("domain-two");
      await expect(
        readFile(
          path.join(generated, "services/domain-two/package.json"),
          "utf8",
        ),
      ).resolves.toContain('"name": "@demo/domain-two"');
      await expect(
        readFile(path.join(generated, "services/domain/package.json"), "utf8"),
      ).resolves.toBe(firstAdditionManifest);
      await expect(
        readFile(path.join(generated, "package.json"), "utf8"),
      ).resolves.toBe(firstRootManifest);
      await expect(readFile(workspaceManifestPath, "utf8")).resolves.toBe(
        firstWorkspaceManifest,
      );
      const finalGitignore = await readFile(gitignorePath, "utf8");
      expect(finalGitignore.match(/^private-artifacts\/$/gmu)).toHaveLength(1);
      expect(
        (
          await lstat(
            path.join(generated, "packages/db/node_modules/drizzle-orm"),
          )
        ).isSymbolicLink(),
      ).toBe(true);
      await execa("pnpm", ["exec", "oxfmt", "--version"], { cwd: generated });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
