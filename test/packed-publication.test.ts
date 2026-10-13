import assert from "node:assert/strict";
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
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
  loadLocalTemplateMetadata,
  type GeneratedRepositoryPlan,
} from "@ykdz/template-builtin-presets";
import {
  assertWorkflowContract,
  assertPublicationWorkflowContract,
} from "@ykdz/template-checks/workflow-contract";
import type { PackageRole } from "@ykdz/template-core/project-blueprint";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

import {
  any,
  arrayContaining,
  assertDeepStrictEqualWithMatchers,
  assertLength,
  assertNotDeepStrictEqualWithMatchers,
  assertPartialDeepStrictEqual,
  hasProperty,
  objectContaining,
  stringContaining,
  stringMatching,
} from "./assertions.ts";

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
  assert.match(
    await readFile(
      path.join(process.cwd(), "packages/cli/dist/cli.js"),
      "utf8",
    ),
    /^#!\/usr\/bin\/env node/u,
  );
  const archive = (await readdir(archiveDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  assert.notStrictEqual(archive, undefined);
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
  )) as typeof import("@ykdz/template-core/project-projection");
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

  await assert.rejects(
    reconcile({
      targetRoot,
      before: plan("before"),
      after: plan("after"),
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("injected packed projection commit failure"),
  );
  assert.strictEqual(await readFile(contentPath, "utf8"), "before\n");
  assert.strictEqual(
    await readFile(canonicalPath, "utf8"),
    '{\n  "state": "before"\n}\n',
  );
  assertLength(committedPaths, 2);
}

function definitionWithPackagePath(packagePath: string) {
  const definition = builtInPresetRegistry.all().find((candidate) =>
    planGeneratedRepositoryInitialization({
      definition: candidate,
      context: createGenerationContext({
        targetDir: path.join("generated-repository", "package-path-selection"),
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
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
        defaultPackageScope: "demo",
        toolchain: {
          nodeLtsMajor: "24",
          packageManagerPin: "pnpm@11.11.0",
          nodeVersion: releaseToolchainSnapshot.nodeVersion,
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
    defaultPackageScope: "demo",
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
  const checkCommand = manifest.scripts.check;
  if (checkCommand === undefined) {
    throw new Error("Generated Repository root manifest must define check");
  }

  assertNotDeepStrictEqualWithMatchers(
    Object.keys(manifest.scripts),
    arrayContaining([stringMatching(/:(?:run|root)$/u), "transit"]),
  );
  for (const command of [
    manifest.scripts.fix,
    manifest.scripts["check:deployment"],
  ]) {
    if (command !== undefined) assert.ok(!command.includes("--filter"));
  }
  if (manifest.scripts["publication:artifact"] === undefined) {
    assert.ok(!checkCommand.includes("--filter"));
  } else {
    const publicationExclusions = checkCommand.match(
      /--filter=!\.\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*/gu,
    );
    assertLength(publicationExclusions, 1);
    assert.ok(
      !checkCommand.replace(publicationExclusions![0], "").includes("--filter"),
    );
  }
  assert.doesNotMatch(taskModel, /(?:Check|Fix) (?:Component|Plan)/u);
  assert.doesNotMatch(taskModel, /Deployment Check Component/u);
  assert.doesNotMatch(taskModel, /deployment[\s-]*(?:task[\s-]*)?owner/iu);

  const fullTree = await generatedTextFiles(projectDir);
  for (const file of fullTree) {
    assert.doesNotMatch(file.source, /\b[\p{L}\p{N}_-]+:(?:run|root)\b/iu);
    assert.doesNotMatch(file.source, /\btransit\b/iu);
    assert.doesNotMatch(
      file.source,
      /(?:Check|Fix) (?:Component|Plan)|Deployment Check Component/iu,
    );
  }

  const retiredBuild = await execa("pnpm", ["run", "build:run"], {
    cwd: projectDir,
    reject: false,
  });
  assert.notStrictEqual(retiredBuild.exitCode, 0);
}

function configProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  return object.properties.flatMap((member) =>
    ts.isPropertyAssignment(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === name
      ? [member.initializer]
      : [],
  )[0];
}

async function expectPackedPlaywrightConfig(
  projectDir: string,
  requiresDiagnostics: boolean,
): Promise<void> {
  const config = (await generatedTextFiles(projectDir)).find(({ path: file }) =>
    file.endsWith("playwright.config.ts"),
  );
  assert.strictEqual(config === undefined, !requiresDiagnostics);
  if (config === undefined) return;

  const source = ts.createSourceFile(
    config.path,
    config.source,
    ts.ScriptTarget.Latest,
    true,
  );
  let options: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      options = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.notStrictEqual(options, undefined);
  if (options === undefined) return;
  const loadedOptions = options;
  const use = configProperty(loadedOptions, "use");
  const reporter = configProperty(loadedOptions, "reporter");
  assert.strictEqual(
    use !== undefined && ts.isObjectLiteralExpression(use),
    true,
  );
  assert.strictEqual(
    reporter !== undefined && ts.isArrayLiteralExpression(reporter),
    true,
  );
  if (
    use === undefined ||
    !ts.isObjectLiteralExpression(use) ||
    reporter === undefined ||
    !ts.isArrayLiteralExpression(reporter)
  ) {
    return;
  }
  const trace = configProperty(use, "trace");
  assert.strictEqual(
    trace !== undefined && ts.isStringLiteral(trace) && trace.text,
    "retain-on-failure",
  );
  assert.deepStrictEqual(
    reporter.elements.map((entry) =>
      ts.isArrayLiteralExpression(entry) &&
      entry.elements[0] !== undefined &&
      ts.isStringLiteral(entry.elements[0])
        ? entry.elements[0].text
        : undefined,
    ),
    ["list", "html"],
  );
  assert.strictEqual(configProperty(loadedOptions, "retries"), undefined);
  assert.strictEqual(configProperty(use, "video"), undefined);
}

async function expectPackedHardenedRootCheckWorkflow(
  projectDir: string,
  plan: GeneratedRepositoryPlan,
): Promise<void> {
  const generatedPath = ".github/workflows/check.yml";
  const source = await readFile(path.join(projectDir, generatedPath), "utf8");
  assertWorkflowContract(plan, generatedPath, source, parseYaml(source));
  if (
    plan.packageContributions.some(
      (contribution) =>
        contribution.foundation.npmPublication?.kind === "public-cli-candidate",
    )
  ) {
    const releaseSource = await readFile(
      path.join(projectDir, ".github/workflows/release.yml"),
      "utf8",
    );
    assertPublicationWorkflowContract(
      plan,
      releaseSource,
      parseYaml(releaseSource),
    );
  }
}

function initializationRequiresDiagnostics(definitionName: string): boolean {
  return (
    initializationDiagnosticPlan(definitionName).ciDiagnosticArtifacts.length >
    0
  );
}

function initializationDiagnosticPlan(definitionName: string) {
  const definition = builtInPresetRegistry.require(definitionName);
  return planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join(
        "generated-repository",
        "packed-diagnostic-expectation",
        definitionName,
      ),
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin: "pnpm@11.11.0",
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    }),
  });
}

void describe("packed public CLI consumer", () => {
  void it(
    "runs the archive alone: import, help, every initialization, and package addition",
    { timeout: 300000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-packed-consumer-"),
      );
      try {
        const consumer = path.join(workspace, "consumer");
        const archivePath = await packTemplateArchive(workspace);
        const packedPaths = (await execa("tar", ["-tf", archivePath])).stdout
          .split("\n")
          .filter(Boolean);
        assert.strictEqual(
          packedPaths.every(
            (entry) =>
              entry.startsWith("package/") && !entry.split("/").includes(".."),
          ),
          true,
        );
        assertDeepStrictEqualWithMatchers(
          packedPaths,
          arrayContaining([
            "package/dist/application.d.ts",
            "package/dist/application.js",
            "package/dist/cli.d.ts",
            "package/dist/cli.js",
            "package/dist/main.d.ts",
            "package/dist/main.js",
            "package/node_modules/@ykdz/cli-contract/package.json",
            "package/node_modules/@ykdz/template-core/package.json",
            "package/node_modules/@ykdz/template-builtin-presets/package.json",
            "package/node_modules/@ykdz/template-builtin-presets/templates/foundation/turbo.json",
            "package/node_modules/@ykdz/template-builtin-presets/dist/src/ts-cli/definition.js",
            "package/node_modules/@ykdz/template-builtin-presets/templates/ts-cli/src/cli.ts",
            "package/node_modules/typescript/package.json",
          ]),
        );
        assert.strictEqual(
          packedPaths.some((entry) => entry.startsWith("package/src/")),
          false,
        );
        assert.strictEqual(
          packedPaths.some(
            (entry) =>
              entry.includes("behavior.test") ||
              entry.startsWith("package/test/") ||
              entry.includes("/.template/") ||
              entry.includes("template-checks"),
          ),
          false,
        );
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
        assert.strictEqual(
          sourceManifest.scripts.prepack,
          "pnpm exec turbo run build --filter=.",
        );
        assertPartialDeepStrictEqual(packedManifest, {
          version: sourceManifest.version,
          bin: { template: "dist/cli.js" },
          exports: {
            ".": {
              source: "./src/main.ts",
              types: "./dist/main.d.ts",
              default: "./dist/main.js",
            },
          },
          dependencies: {
            "@ykdz/cli-contract": any(String),
            "@valibot/to-json-schema": any(String),
            valibot: any(String),
          },
          bundleDependencies: arrayContaining([
            "@ykdz/template-core",
            "@ykdz/template-builtin-presets",
            "@ykdz/cli-contract",
            "@valibot/to-json-schema",
            "typescript",
          ]),
        });
        assert.ok(hasProperty(packedManifest.dependencies, "typescript"));
        assert.ok(!hasProperty(packedCoreManifest.dependencies, "typescript"));
        assert.ok(
          hasProperty(packedCoreManifest.peerDependencies, "typescript"),
        );
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
        assert.match(compiler.version, /^6\./u);
        await expectPackedProjectionRollback(consumer, workspace);

        const installedBin = path.join(
          consumer,
          "node_modules",
          ".bin",
          "template",
        );
        const journeyEnvironment: NodeJS.ProcessEnv = {
          ...process.env,
          TEMPLATE_CLI_JOURNEY_MODE: "packed",
          TEMPLATE_CLI_PACKED_BIN: installedBin,
        };
        delete journeyEnvironment.NODE_TEST_CONTEXT;
        const packedJourneys = await execa(
          "node",
          [
            "--conditions=source",
            "--test",
            "--test-reporter=tap",
            path.join(process.cwd(), "packages/cli/test/e2e/run-journeys.ts"),
          ],
          {
            cwd: process.cwd(),
            env: journeyEnvironment,
            extendEnv: false,
          },
        );
        const journeyOutput = `${packedJourneys.stdout}\n${packedJourneys.stderr}`;
        assert.match(journeyOutput, /^# tests 5$/mu);
        assert.match(journeyOutput, /^# pass 5$/mu);
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
        assertPartialDeepStrictEqual(
          await execa(
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
          { exitCode: 0 },
        );
        assertPartialDeepStrictEqual(
          await execa(
            "node",
            [
              "--input-type=module",
              "-e",
              [
                `const api = await import(${JSON.stringify(publicCliPackageName)});`,
                'if (typeof api.runCli !== "function") process.exit(1);',
              ].join(""),
            ],
            { cwd: consumer },
          ),
          { exitCode: 0 },
        );
        const help = await execa(installedBin, ["--help"], { cwd: consumer });
        assert.ok(help.stdout.includes("init"));
        const addHelp = await execa(
          installedBin,
          ["add", "package", "--help"],
          {
            cwd: consumer,
          },
        );
        assert.ok(addHelp.stdout.includes("template add package"));
        assert.ok(addHelp.stdout.includes("--link-from"));
        assert.ok(!addHelp.stdout.includes("template init <dir>"));
        const presets = await execa(installedBin, ["presets"], {
          cwd: consumer,
        });
        const definitions = JSON.parse(presets.stdout).data.presets as {
          name: string;
        }[];
        assert.ok(definitions.length > 0);
        for (const definition of definitions) {
          await execa(
            installedBin,
            [
              "init",
              path.join(consumer, "generated", definition.name),
              "--preset",
              definition.name,
            ],
            {
              cwd: consumer,
            },
          );
          await expectNativeTaskModel(
            path.join(consumer, "generated", definition.name),
          );
          const generatedProject = path.join(
            consumer,
            "generated",
            definition.name,
          );
          const requiresDiagnostics = initializationRequiresDiagnostics(
            definition.name,
          );
          await expectPackedHardenedRootCheckWorkflow(
            generatedProject,
            initializationDiagnosticPlan(definition.name),
          );
          await expectPackedPlaywrightConfig(
            generatedProject,
            requiresDiagnostics,
          );
        }
        const expectedAddableDefinitions = builtInPresetRegistry
          .all()
          .filter((definition) => definition.planPackageAddition !== undefined)
          .map((definition) => definition.metadata.name)
          .toSorted();
        const completedAdditions: string[] = [];
        for (const candidate of definitions) {
          const definition = builtInPresetRegistry.require(candidate.name);
          const generatedProject = path.join(
            consumer,
            "generated",
            candidate.name,
          );
          const additionPlan =
            definition.planPackageAddition === undefined
              ? undefined
              : planGeneratedRepositoryPackageAddition({
                  definition,
                  localTemplateMetadata:
                    loadLocalTemplateMetadata(generatedProject),
                  packageLeafName: "archive-addition",
                  packagePath: "packages/archive-addition",
                });
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
              reject: false,
            },
          );
          if (result.exitCode === 0) {
            completedAdditions.push(candidate.name);
            await expectNativeTaskModel(
              path.join(consumer, "generated", candidate.name),
            );
            const generatedProject = path.join(
              consumer,
              "generated",
              candidate.name,
            );
            assert.notStrictEqual(additionPlan, undefined);
            const requiresDiagnostics =
              additionPlan!.ciDiagnosticArtifacts.length > 0;
            await expectPackedHardenedRootCheckWorkflow(
              generatedProject,
              additionPlan!,
            );
            await expectPackedPlaywrightConfig(
              generatedProject,
              requiresDiagnostics,
            );
          }
        }
        assert.deepStrictEqual(
          completedAdditions.toSorted(),
          expectedAddableDefinitions,
        );

        const rustDefinition =
          addableDefinitionWithPackageRole("native-package");
        const nonRustBase = builtInPresetRegistry.all().find((definition) => {
          const context = createGenerationContext({
            targetDir: path.join(
              consumer,
              "generated",
              definition.metadata.name,
            ),
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
              nodeVersion: releaseToolchainSnapshot.nodeVersion,
            },
          });
          const contributions = planGeneratedRepositoryInitialization({
            definition,
            context,
          }).packageContributions;
          return contributions.every(
            (contribution) =>
              contribution.foundation.toolchains.rust === undefined,
          );
        });
        assert.notStrictEqual(nonRustBase, undefined);
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
        assert.ok(!dockerfileBeforeRust.includes("ARG RUST_TOOLCHAIN"));
        assert.ok(
          !hasProperty(devcontainerBeforeRust.build.args, "RUST_TOOLCHAIN"),
        );
        assertNotDeepStrictEqualWithMatchers(
          devcontainerBeforeRust.mounts,
          arrayContaining([
            objectContaining({ target: "/usr/local/cargo/registry" }),
          ]),
        );
        await assert.rejects(stat(rustToolchainPath), (error) => {
          assertPartialDeepStrictEqual(error, {
            code: "ENOENT",
          });
          return true;
        });
        assert.ok(!dependabotBeforeRust.includes("package-ecosystem: cargo"));

        const beforeRustPreview =
          await workspaceByteSnapshot(rustAdditionTarget);
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
          ],
          {
            cwd: rustAdditionTarget,
          },
        );
        const rustPreview = JSON.parse(rustPreviewResult.stdout).data as {
          readonly dryRun: boolean;
          readonly actions: readonly {
            readonly path: string;
            readonly action: string;
          }[];
          readonly conflicts?: readonly unknown[];
        };
        assert.strictEqual(rustPreview.dryRun, true);
        assert.deepStrictEqual(rustPreview.conflicts ?? [], []);
        assertDeepStrictEqualWithMatchers(
          rustPreview.actions,
          arrayContaining([
            objectContaining({
              path: ".devcontainer/Dockerfile",
              action: "update",
            }),
            objectContaining({
              path: ".devcontainer/devcontainer.json",
              action: "update",
            }),
            objectContaining({
              path: "rust-toolchain.toml",
              action: "create",
            }),
            objectContaining({
              path: ".github/dependabot.yml",
              action: "update",
            }),
            objectContaining({
              path: "packages/worker/package.json",
              action: "create",
            }),
            objectContaining({
              path: "packages/worker/Cargo.toml",
              action: "create",
            }),
          ]),
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(rustAdditionTarget),
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
          },
        );
        assertPartialDeepStrictEqual(
          await readFile(
            path.join(rustAdditionTarget, "packages/worker/package.json"),
            "utf8",
          ).then(
            (source) =>
              JSON.parse(source) as {
                readonly name: string;
                readonly scripts: Readonly<Record<string, string>>;
              },
          ),
          {
            name: `@${nonRustBase!.metadata.name}/worker`,
            scripts: {
              "format:check": "cargo fmt --all -- --check",
              lint: "cargo clippy --workspace --all-targets -- -D warnings",
              test: "cargo test --workspace",
            },
          },
        );
        assert.ok(
          (
            await readFile(
              path.join(rustAdditionTarget, "packages/worker/Cargo.toml"),
              "utf8",
            )
          ).includes('name = "worker"'),
        );
        const dockerfileAfterRust = await readFile(rustDockerfilePath, "utf8");
        assert.ok(dockerfileAfterRust.includes("ARG RUST_TOOLCHAIN"));
        assert.ok(
          dockerfileAfterRust.includes(
            '"${CARGO_HOME}/bin/rustup" toolchain install ${RUST_TOOLCHAIN}',
          ),
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
        const rustToolchainAfterRust = await readFile(
          rustToolchainPath,
          "utf8",
        );
        const rootRustChannel = rustToolchainAfterRust.match(
          /^channel = "([^"]+)"$/mu,
        )?.[1];
        assert.strictEqual(
          rootRustChannel,
          releaseToolchainSnapshot.rustVersion,
        );
        assertPartialDeepStrictEqual(devcontainerAfterRust.build.args, {
          RUST_TOOLCHAIN: rootRustChannel,
        });
        assertDeepStrictEqualWithMatchers(
          devcontainerAfterRust.mounts,
          arrayContaining([
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
        assertNotDeepStrictEqualWithMatchers(
          devcontainerAfterRust.mounts,
          arrayContaining([
            objectContaining({
              target: stringContaining("${containerWorkspaceFolder}"),
            }),
          ]),
        );
        assert.strictEqual(
          rustToolchainAfterRust,
          `[toolchain]\nchannel = "${releaseToolchainSnapshot.rustVersion}"\ncomponents = ["rustfmt", "clippy"]\n`,
        );
        const dependabotAfterRust = parseYaml(
          await readFile(dependabotPath, "utf8"),
        ) as {
          readonly updates: readonly {
            readonly "package-ecosystem": string;
            readonly directory: string;
          }[];
        };
        assert.deepStrictEqual(
          dependabotAfterRust.updates
            .filter((update) => update["package-ecosystem"] === "cargo")
            .map((update) => update.directory),
          ["/packages/worker"],
        );
        assert.deepStrictEqual(
          await readFile(
            path.join(rustAdditionTarget, "packages/worker/turbo.json"),
            "utf8",
          ).then((source) => JSON.parse(source)),
          {
            extends: ["//"],
            tags: ["native"],
            tasks: {
              "format:check": {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
              "format:write": {
                dependsOn: ["//#toolchain:prepare"],
                cache: false,
              },
              lint: {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
              test: {
                dependsOn: ["//#toolchain:prepare"],
                outputs: [],
              },
            },
          },
        );
        const rootManifestAfterRust = JSON.parse(
          await readFile(path.join(rustAdditionTarget, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const rootCheckScript = rootManifestAfterRust.scripts.check;
        assert.ok(rootCheckScript !== undefined);
        assert.ok(
          rootCheckScript.includes(
            "pnpm run boundaries && turbo run format:check lint typecheck test",
          ),
        );
        assert.ok(
          rootCheckScript.includes(
            "turbo run build test:e2e --filter=!./packages/cli",
          ),
        );

        await execa("pnpm", ["install"], { cwd: rustAdditionTarget });
        await execa("pnpm", ["run", "check"], { cwd: rustAdditionTarget });
        await expectPackedHardenedRootCheckWorkflow(
          rustAdditionTarget,
          initializationDiagnosticPlan(rustDefinition.metadata.name),
        );

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
        ) as Record<string, unknown>;
        assert.deepStrictEqual(explicitCliManifest.bin, {
          "archive-addition": "./dist/cli.js",
        });
        assertPartialDeepStrictEqual(explicitCliManifest, { private: true });
        assert.ok(!hasProperty(explicitCliManifest, "version"));
        assert.ok(!hasProperty(explicitCliManifest, "exports"));
        assert.ok(!hasProperty(explicitCliManifest, "imports"));
        const addSecondCli = async (): Promise<void> => {
          await execa(
            installedBin,
            [
              "add",
              "package",
              "--preset",
              cliAdditionDefinition.metadata.name,
              "--name",
              "default-command",
            ],
            {
              cwd: cliTarget,
            },
          );
        };
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          cliTarget,
          initializationDiagnosticPlan(cliAdditionDefinition.metadata.name),
        );
        const secondCliManifest = JSON.parse(
          await readFile(
            path.join(cliTarget, "packages/default-command/package.json"),
            "utf8",
          ),
        ) as {
          readonly name: string;
          readonly bin: Readonly<Record<string, string>>;
        };
        assert.deepStrictEqual(secondCliManifest.bin, {
          "default-command": "./dist/cli.js",
        });
        assertPartialDeepStrictEqual(secondCliManifest, { private: true });
        assert.ok(!hasProperty(secondCliManifest, "version"));
        assert.ok(!hasProperty(secondCliManifest, "exports"));
        assert.ok(!hasProperty(secondCliManifest, "imports"));
        const secondCliSnapshot = await workspaceByteSnapshot(cliTarget);
        await addSecondCli();
        await expectPackedHardenedRootCheckWorkflow(
          cliTarget,
          initializationDiagnosticPlan(cliAdditionDefinition.metadata.name),
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(cliTarget),
          secondCliSnapshot,
        );

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
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        assert.strictEqual(reservedPackagePath.exitCode, 2);
        assert.strictEqual(reservedPackagePath.stdout, "");
        assertPartialDeepStrictEqual(JSON.parse(reservedPackagePath.stderr), {
          kind: "usageFailure",
        });
        assert.ok(reservedPackagePath.stderr.includes("保留工作区目录"));
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
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
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        assert.notStrictEqual(existingPackagePath.exitCode, 0);
        assertPartialDeepStrictEqual(
          JSON.parse(existingPackagePath.stderr).data,
          {
            actions: [],
            conflicts: [
              {
                path: "services/existing",
                driver: "precondition",
                reason: stringContaining(
                  "Package Path services/existing already exists",
                ),
              },
            ],
          },
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
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
          ],
          {
            cwd: previewTarget,
          },
        );
        assertPartialDeepStrictEqual(JSON.parse(preview.stdout).data, {
          dryRun: true,
          actions: arrayContaining([
            {
              path: "services/dashboard/package.json",
              driver: "structured",
              action: "create",
            },
          ]),
        });
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          previewBefore,
        );

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
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        assert.notStrictEqual(structuredConflict.exitCode, 0);
        assertPartialDeepStrictEqual(
          JSON.parse(structuredConflict.stderr).data,
          {
            actions: [],
            conflicts: [
              {
                path: "turbo.json",
                driver: "structured",
                location: "/boundaries/tags/app/dependencies/allow",
                context: {
                  before: any(String),
                  current: any(String),
                  after: any(String),
                },
              },
            ],
          },
        );
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          structuredBefore,
        );

        await writeFile(turboPath, originalTurbo);
        const dockerfilePath = path.join(
          previewTarget,
          ".devcontainer/Dockerfile",
        );
        const dockerfile = await readFile(dockerfilePath, "utf8");
        const baseToolLayerTail = '    && chmod -R a+rX "$PNPM_HOME"';
        const baseToolLayerBoundary = `${baseToolLayerTail}\n\n`;
        assert.ok(dockerfile.includes(baseToolLayerBoundary));
        await writeFile(
          dockerfilePath,
          dockerfile.replace(
            baseToolLayerBoundary,
            `${baseToolLayerBoundary}# incompatible insertion\r\n`,
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
            "--output-format",
            "text",
          ],
          {
            cwd: previewTarget,
            reject: false,
          },
        );
        assert.notStrictEqual(textConflict.exitCode, 0);
        assert.ok(
          textConflict.stderr.includes(".devcontainer/Dockerfile (text)"),
        );
        assert.ok(textConflict.stderr.includes("区域:"));
        assert.ok(textConflict.stderr.includes("当前:"));
        assert.deepStrictEqual(
          await workspaceByteSnapshot(previewTarget),
          textBefore,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  void it(
    "adds a package with the packed CLI after the generated repository is installed",
    { timeout: 120000 },
    async () => {
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
          ],
          {
            cwd: consumer,
          },
        );
        const gitignorePath = path.join(generated, ".gitignore");
        const workspaceManifestPath = path.join(
          generated,
          "pnpm-workspace.yaml",
        );
        await Promise.all([
          writeFile(gitignorePath, "private-artifacts/\n", { flag: "a" }),
          writeFile(workspaceManifestPath, "# private workspace policy\n", {
            flag: "a",
          }),
        ]);
        await execa("pnpm", ["install"], { cwd: generated });
        assert.strictEqual(
          (
            await lstat(
              path.join(generated, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );

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
        assert.ok(
          firstWorkspaceManifest.includes("# private workspace policy"),
        );
        assert.ok(
          (await readFile(gitignorePath, "utf8")).includes(
            "private-artifacts/",
          ),
        );
        const workspaceBeforeRepeat = (
          await generatedTextFiles(generated)
        ).toSorted((left, right) => left.path.localeCompare(right.path));
        assert.strictEqual(
          workspaceBeforeRepeat.some(
            (file) => file.path === ".template/blueprint.json",
          ),
          true,
        );

        await addPackage("domain");
        assert.deepStrictEqual(
          (await generatedTextFiles(generated)).toSorted((left, right) =>
            left.path.localeCompare(right.path),
          ),
          workspaceBeforeRepeat,
        );
        assert.strictEqual(
          await readFile(
            path.join(generated, "services/domain/package.json"),
            "utf8",
          ),
          firstAdditionManifest,
        );

        await addPackage("domain-two");
        assert.ok(
          (
            await readFile(
              path.join(generated, "services/domain-two/package.json"),
              "utf8",
            )
          ).includes('"name": "@demo/domain-two"'),
        );
        assert.strictEqual(
          await readFile(
            path.join(generated, "services/domain/package.json"),
            "utf8",
          ),
          firstAdditionManifest,
        );
        assert.strictEqual(
          await readFile(path.join(generated, "package.json"), "utf8"),
          firstRootManifest,
        );
        assert.strictEqual(
          await readFile(workspaceManifestPath, "utf8"),
          firstWorkspaceManifest,
        );
        const finalGitignore = await readFile(gitignorePath, "utf8");
        assertLength(finalGitignore.match(/^private-artifacts\/$/gmu), 1);
        assert.strictEqual(
          (
            await lstat(
              path.join(generated, "packages/db/node_modules/drizzle-orm"),
            )
          ).isSymbolicLink(),
          true,
        );
        await execa("pnpm", ["exec", "oxfmt", "--version"], { cwd: generated });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
